import { createHash } from "node:crypto";
import { RequestError, type ContentBlock, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionConfigOption, type SessionNotification, type StopReason } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createKeyedOperationQueue, invalidArguments, type AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { createLivePresentation, type LiveRegion, type WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { createPiModelRuntime, parseModelRef, setAgentModelPreference } from "@agents-in-the-cloud/llm/server";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import { publishWorkspaceAgentBusy } from "@agents-in-the-cloud/agent/server";
import { listPromptTemplates } from "@agents-in-the-cloud/agent/server/prompt-templates";
import { renderSlashCommandCatalog } from "@agents-in-the-cloud/agent/server/slash-commands";
import { acpAgentCommands, acpNativeCommands, type AcpCommand, type AcpCommandResult } from "./commands.ts";
import { openAcpConnection, type AcpConnection } from "./connection.ts";
import type { AcpHarness, AcpLaunch } from "./harness.ts";
import { AcpState } from "./state.ts";
import type { AcpAgentRecord } from "./store.ts";

const steeringResultSchema = Type.Object({ outcome: Type.String() });

/** The values of a select option, flattening grouped options. */
export function selectValues(option: SessionConfigOption | undefined) {
  if (option?.type !== "select") return [];
  return option.options.flatMap(entry => "group" in entry ? entry.options : [entry]);
}

/** One Agent: an ACP adapter process in the workspace and the session it has open. */
export class AcpRuntime {
  readonly state = new AcpState();
  instructions = "";
  /** Slash commands and prompt templates; turns can add templates, so each finished turn reloads them. */
  completionCatalog = "";
  failure?: Error;
  /** Tokens the turns of this session used, as their prompts report them. */
  tokens?: { input: number; output: number };
  private connection?: AcpConnection;
  private launch?: AcpLaunch;
  private sessionId?: string;
  /** History replays while a session loads; it carries no times. */
  private replaying = false;
  /** Updates that arrived before the session they belong to was known. */
  private early: SessionNotification[] = [];
  /** Prompts whose turns have not ended. */
  private prompts = 0;
  private busy = false;
  private disposed = false;
  private closing = false;
  /** Prompt templates win over the agent's own same-named commands. */
  private templateNames = new Set<string>();
  private readonly serialize = createKeyedOperationQueue();
  readonly presentation: ReturnType<typeof createLivePresentation>;
  private constructor(readonly harness: AcpHarness, readonly workspaceId: string, readonly record: AcpAgentRecord, private readonly save: () => void, private readonly events: AgentsInTheCloudEventBus, liveRegions: (runtime: AcpRuntime) => LiveRegion[]) {
    this.presentation = createLivePresentation(() => liveRegions(this), 50);
  }
  get agentId() { return this.record.id; }
  get isBusy() { return !this.failure && this.prompts > 0; }
  private get label() { return this.harness.label; }
  private changed() {
    if (this.disposed) return;
    const busy = this.isBusy;
    if (busy !== this.busy) {
      this.busy = busy;
      publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy });
      if (!busy) {
        void this.events.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, agentId: this.agentId }).catch(error => console.error(`Could not publish ${this.label} turn completion`, error));
        void this.refreshCompletionCatalog().catch(error => console.error(`Could not refresh ${this.label} completions`, error));
      }
    }
    this.presentation.invalidate();
  }
  async refreshCompletionCatalog() {
    const templates = await listPromptTemplates(this.workspaceId);
    this.templateNames = new Set(templates.map(template => template.name));
    this.completionCatalog = renderSlashCommandCatalog(templates, [], "cli", [...acpAgentCommands(this.harness.source, this.label), ...acpNativeCommands(this.harness.source, this.state.commands, this.harness.hiddenCommands, this.templateNames)]);
    this.presentation.invalidate();
  }
  /** The agent's own commands are sent as prompts, never expanded as prompt templates. */
  isAgentCommand(text: string) {
    const name = text.trim().match(/^\/(\S+)/)?.[1];
    return Boolean(name && !this.templateNames.has(name) && !this.harness.hiddenCommands.includes(name) && this.state.commands.some(command => command.name === name));
  }
  static async open(harness: AcpHarness, liveRegions: (runtime: AcpRuntime) => LiveRegion[], workspaceId: string, record: AcpAgentRecord, save: () => void, events: AgentsInTheCloudEventBus) {
    const runtime = new AcpRuntime(harness, workspaceId, record, save, events, liveRegions);
    try { await runtime.connect(); return runtime; }
    catch (error) { await runtime.dispose(); throw error; }
  }
  async reconnect() {
    return this.serialize(this.agentId, async () => {
      if (!this.failure) return;
      if (this.disposed || this.closing) throw new Error(`${this.label} Agent is closed`);
      await this.connection?.close();
      this.failure = undefined;
      await this.connect();
    });
  }
  private async connect() {
    this.prompts = 0;
    try {
      const launch = this.launch = await this.harness.prepare(this.workspaceId, this.agentId);
      this.instructions = launch.instructions;
      const connection = this.connection = await openAcpConnection(this.workspaceId, this.label, launch, {
        update: notification => this.receive(notification),
        permission: request => this.permission(request),
        failed: error => { if (this.connection === connection) { this.failure = error; this.changed(); } },
      });
      await this.openSession(this.record.acpSessionId ? { load: this.record.acpSessionId } : {});
      this.changed();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.changed();
      await this.connection?.close();
      throw error;
    }
  }
  /** Opens a fresh, saved or forked session in place of the current one, which the agent then closes. */
  private async openSession(target: { load?: string; fork?: string }) {
    const { agent } = this.connection!;
    const parameters = { cwd: workspaceRoot, mcpServers: this.launch!.mcpServers, _meta: this.launch!.sessionMeta };
    const previous = this.sessionId;
    this.sessionId = target.load;
    this.early = [];
    // A fork continues the conversation already on screen.
    if (!target.fork) {
      this.state.reset();
      this.tokens = undefined;
    }
    let configOptions: SessionConfigOption[] | null | undefined;
    if (target.load) {
      this.replaying = true;
      try { ({ configOptions } = await agent.request("session/load", { sessionId: target.load, ...parameters })); }
      finally { this.replaying = false; }
    } else {
      if (target.fork) ({ sessionId: this.sessionId, configOptions } = await agent.request("session/fork", { sessionId: target.fork, ...parameters }));
      else ({ sessionId: this.sessionId, configOptions } = await agent.request("session/new", parameters));
      for (const notification of this.early) this.receive(notification);
    }
    this.early = [];
    if (configOptions) this.state.configOptions = configOptions;
    if (previous && previous !== this.sessionId) await agent.request("session/close", { sessionId: previous });
    const mode = this.state.option("mode");
    if (mode && mode.currentValue !== this.harness.modeId) await this.setOption(mode.id, this.harness.modeId);
    await this.applySelection(this.record.model, this.record.thinkingLevel);
    await this.refreshCompletionCatalog();
  }
  /** A switch that fails midway leaves no session open; reconnecting reopens the saved one. */
  private async switchSession(target: { load?: string; fork?: string }) {
    try { await this.openSession(target); }
    catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.changed();
      throw error;
    }
  }
  private async setOption(configId: string, value: string) {
    const { configOptions } = await this.connection!.agent.request("session/set_config_option", { sessionId: this.sessionId!, configId, value });
    this.state.configOptions = configOptions;
  }
  /** Restores the Agent's model and thinking level in a session that opened with the agent's defaults. */
  private async applySelection(model: string | undefined, thinkingLevel: string | undefined) {
    const id = model ? parseModelRef(model)?.id : undefined;
    const option = this.state.option("model");
    if (id && option && option.currentValue !== id) {
      try { await this.setOption(option.id, id); }
      catch (error) {
        if (!(error instanceof RequestError)) throw error;
        this.state.notices.push(`${id} isn’t available in ${this.label} right now, so this conversation uses ${this.selectedModel?.name ?? "its default model"}.`);
      }
    }
    const effort = this.state.option("thought_level");
    if (thinkingLevel && effort && effort.currentValue !== thinkingLevel && selectValues(effort).some(entry => entry.value === thinkingLevel)) await this.setOption(effort.id, thinkingLevel);
    this.saveSelection();
  }
  private saveSelection() {
    const model = this.state.option("model")?.currentValue;
    const effort = this.state.option("thought_level")?.currentValue;
    if (model && model !== "default") this.record.model = `${this.harness.provider}::${model}`; else delete this.record.model;
    if (effort && effort !== "default") this.record.thinkingLevel = effort; else delete this.record.thinkingLevel;
    this.save();
  }
  async send(input: WorkspaceAgentInput, requestId: string) {
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      const text = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
      const prompt: ContentBlock[] = [...text ? [{ type: "text" as const, text }] : [], ...input.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: image.data }))];
      const digest = createHash("sha256").update(JSON.stringify(prompt)).digest("hex");
      if (this.record.commandSubmissions?.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a command");
      const previous = this.record.submissions.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different prompt");
        return;
      }
      this.record.submissions.push({ id: requestId, digest });
      this.record.acpSessionId = this.sessionId;
      this.save();
      const images = input.images.map(image => ({ mimeType: image.mimeType, data: image.data }));
      if (this.prompts > 0 && this.connection!.steering) {
        this.state.addPrompt(text, images, true, Date.now());
        this.changed();
        const result = await this.connection!.agent.request<unknown>("_session/steering", { sessionId: this.sessionId, prompt, _meta: { steering: { idleBehavior: "promptRequired" } } });
        if (!Value.Check(steeringResultSchema, result)) throw new Error(`${this.label} answered steering with an unexpected result`);
        if (result.outcome === "injected") return;
        if (result.outcome !== "promptRequired") throw new Error(`${this.label} could not add this prompt to its running turn (${result.outcome})`);
        // The turn ended meanwhile, so this prompt starts the next one.
        const entry = this.state.entries.findLast(entry => entry.kind === "user");
        if (entry?.kind === "user") entry.steering = false;
      } else this.state.addPrompt(text, images, false, Date.now());
      this.prompt(prompt);
      this.changed();
    });
  }
  /** A prompt's turn runs until its response; updates stream meanwhile. */
  private prompt(prompt: ContentBlock[]) {
    const connection = this.connection!;
    const sessionId = this.sessionId!;
    this.prompts++;
    void connection.agent.request("session/prompt", { sessionId, prompt }).then(
      response => this.turnEnded(connection, sessionId, response.stopReason, response.usage),
      error => this.turnEnded(connection, sessionId, "error", undefined, error instanceof Error ? error.message : String(error)),
    );
  }
  private turnEnded(connection: AcpConnection, sessionId: string, stopReason: StopReason | "error", usage: PromptResponse["usage"], error?: string) {
    if (this.disposed || connection !== this.connection || sessionId !== this.sessionId) return;
    this.prompts--;
    // A lost connection shows as the Agent's failure, not as each turn's.
    if (!this.failure) this.state.endTurn(stopReason, Date.now(), error);
    if (usage) {
      const tokens = this.tokens ??= { input: 0, output: 0 };
      tokens.input += usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
      tokens.output += usage.outputTokens;
    }
    this.changed();
  }
  /** Every session runs in a mode that never asks, so a request means the agent wants something this Agent can’t show. */
  private permission(request: RequestPermissionRequest): RequestPermissionResponse {
    this.state.notices.push(`${this.label} asked for permission to ${request.toolCall.title ? `run “${request.toolCall.title}”` : "use a tool"}. This Agent can’t answer permission requests yet, so it said no.`);
    this.changed();
    const reject = request.options.find(option => option.kind === "reject_once") ?? request.options.find(option => option.kind === "reject_always");
    return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  private receive(notification: SessionNotification) {
    if (this.disposed) return;
    if (this.sessionId === undefined) { this.early.push(notification); return; }
    if (notification.sessionId !== this.sessionId) return;
    this.state.receive(notification.update, this.replaying ? undefined : Date.now());
    if (notification.update.sessionUpdate === "available_commands_update" && !this.replaying) void this.refreshCompletionCatalog().catch(error => console.error(`Could not refresh ${this.label} completions`, error));
    this.changed();
  }
  async command(command: AcpCommand, requestId: string): Promise<AcpCommandResult> {
    if (command.kind === "model") {
      await this.configure({ model: `${this.harness.provider}::${command.model}` });
      return { kind: "done", message: `Using ${this.selectedModel?.name ?? command.model}.` };
    }
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      if (command.kind === "resume" && !command.sessionId) {
        this.requireIdle("switching conversations");
        const { sessions } = await this.connection!.agent.request("session/list", { cwd: workspaceRoot });
        return { kind: "resume", sessions, current: this.record.acpSessionId };
      }
      if (this.record.submissions.some(entry => entry.id === requestId)) throw invalidArguments("This request ID was already used for a prompt");
      const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const previous = this.record.commandSubmissions?.find(entry => entry.id === requestId);
      if (previous) {
        if (previous.digest !== digest) throw invalidArguments("This request ID was already used for a different command");
        return { kind: "done", message: previous.message };
      }
      const done = (message: string): AcpCommandResult => {
        (this.record.commandSubmissions ??= []).push({ id: requestId, digest, message });
        this.save();
        this.changed();
        return { kind: "done", message };
      };
      switch (command.kind) {
        case "new":
          this.requireIdle("starting a fresh conversation");
          await this.switchSession({});
          // The fresh session is saved with its first prompt.
          delete this.record.acpSessionId;
          return done(`New ${this.label} conversation started.`);
        case "fork": {
          this.requireIdle("forking the conversation");
          if (!this.record.acpSessionId) throw invalidArguments("Send a prompt before forking the conversation");
          await this.switchSession({ fork: this.record.acpSessionId });
          this.record.acpSessionId = this.sessionId;
          this.state.notices.push("Continuing in a fork. The original conversation is available through /resume.");
          return done("Conversation forked.");
        }
        case "resume":
          this.requireIdle("switching conversations");
          await this.switchSession({ load: command.sessionId });
          this.record.acpSessionId = this.sessionId;
          return done("Conversation resumed.");
      }
    });
  }
  private requireIdle(action: string) {
    if (this.isBusy) throw invalidArguments(`Stop ${this.label} before ${action}`);
  }
  async stop() {
    this.assertOpen();
    if (this.prompts > 0) await this.connection!.agent.notify("session/cancel", { sessionId: this.sessionId! });
  }
  /** The selected entry of the agent's own model catalog. */
  get selectedModel() {
    const option = this.state.option("model");
    return selectValues(option).find(entry => entry.value === option?.currentValue);
  }
  get selection() {
    const option = this.state.option("model");
    return {
      models: selectValues(option).map(entry => ({ provider: this.harness.provider, id: entry.value, name: entry.name, selected: entry.value === option?.currentValue, available: true })),
      thinkingLevels: selectValues(this.state.option("thought_level")).map(entry => entry.value),
    };
  }
  async configure(parameters: { model?: string; thinkingLevel?: string }) {
    return this.serialize(this.agentId, async () => {
      this.assertOpen();
      if (this.isBusy) throw invalidArguments(`Stop ${this.label} before changing its model or thinking level`);
      if (parameters.model) {
        const requested = parseModelRef(parameters.model);
        const option = this.state.option("model");
        if (requested?.provider !== this.harness.provider || !option) throw invalidArguments(`Choose an available ${this.label} model`);
        // Agents can resolve names they don't list, such as a full model ID for an alias.
        try { await this.setOption(option.id, requested.id); }
        catch (error) {
          if (error instanceof RequestError) throw invalidArguments(`Choose an available ${this.label} model`);
          throw error;
        }
      }
      if (parameters.thinkingLevel) {
        const option = this.state.option("thought_level");
        if (!option || !selectValues(option).some(entry => entry.value === parameters.thinkingLevel)) throw invalidArguments(`Unsupported ${this.label} thinking level`);
        await this.setOption(option.id, parameters.thinkingLevel);
      }
      this.saveSelection();
      const model = this.record.model ? parseModelRef(this.record.model) : undefined;
      // The launch picker remembers models it offers; agents also list aliases, such as Claude Code's `opus`.
      if (model && (await createPiModelRuntime()).getModel(model.provider, model.id)) await setAgentModelPreference(this.harness.agentTypeId, model, this.record.thinkingLevel);
      this.changed();
    });
  }
  async rename(title: string) {
    this.record.title = title;
    this.save();
    await this.events.emit("workspace_agent_title_changed", { workspaceId: this.workspaceId, agentId: this.agentId, title });
  }
  async close() {
    this.closing = true;
    await this.serialize(this.agentId, async () => {
      if (this.prompts > 0 && !this.failure) await this.connection!.agent.notify("session/cancel", { sessionId: this.sessionId! });
      await this.dispose();
    });
  }
  private assertOpen() { if (this.failure) throw this.failure; if (this.disposed || this.closing) throw new Error(`${this.label} Agent is closed`); }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.connection?.close();
    if (this.busy) publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.agentId}`, busy: false });
    this.presentation.dispose();
  }
}
