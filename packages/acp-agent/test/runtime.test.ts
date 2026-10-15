import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each scenario runs in its own process, so module mocks and workspace metadata stay isolated.
async function scenario(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "acp-runtime-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import * as acp from "@agentclientprotocol/sdk";
      const source = ${JSON.stringify(join(import.meta.dir, "../src/server"))};
      // An ACP agent with one model catalog, which records what it was asked.
      const calls = [];
      const prompts = [];
      const sessions = new Map();
      let nextSession = 0;
      const options = session => [
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode, options: [{ value: "default", name: "Ask" }, { value: "full", name: "Full access" }] },
        { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: [{ value: "default", name: "Default" }, { value: "opus", name: "Opus 5.5" }, { value: "haiku", name: "Haiku 5.5" }] },
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: session.effort, options: ["low", "medium", "high"].map(value => ({ value, name: value })) },
      ];
      const open = () => { const id = "session-" + ++nextSession; sessions.set(id, { mode: "default", model: "default", effort: "low", history: [] }); return id; };
      const updates = (client, sessionId, list) => Promise.all(list.map(update => client.notify("session/update", { sessionId, update })));
      const fake = acp.agent({ name: "fake" })
        .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { steering: { supported: true } } }))
        .onRequest("session/new", ({ params }) => { calls.push(["new", params]); const sessionId = open(); return { sessionId, configOptions: options(sessions.get(sessionId)) }; })
        .onRequest("session/load", async ({ params, client }) => { calls.push(["load", params.sessionId]); const session = sessions.get(params.sessionId); session.mode = "default"; await updates(client, params.sessionId, session.history); return { configOptions: options(session) }; })
        .onRequest("session/fork", ({ params }) => { calls.push(["fork", params.sessionId]); const sessionId = open(); sessions.get(sessionId).history = [...sessions.get(params.sessionId).history]; return { sessionId, configOptions: options(sessions.get(sessionId)) }; })
        .onRequest("session/list", () => ({ sessions: [...sessions.keys()].map(sessionId => ({ sessionId, cwd: "/work", title: sessionId })) }))
        .onRequest("session/close", ({ params }) => { calls.push(["close", params.sessionId]); return {}; })
        .onRequest("session/set_config_option", ({ params }) => {
          calls.push(["set", params.configId, params.value]);
          const session = sessions.get(params.sessionId);
          const key = { mode: "mode", model: "model", effort: "effort" }[params.configId];
          // Full model IDs resolve to the catalog's aliases.
          const value = params.value === "claude-opus-5-5" ? "opus" : params.value;
          if (!options(session).find(option => option.id === params.configId).options.some(option => option.value === value)) throw acp.RequestError.invalidParams();
          session[key] = value;
          return { configOptions: options(session) };
        })
        .onRequest("session/prompt", ({ params, client }) => new Promise(resolve => {
          sessions.get(params.sessionId).history.push({ sessionUpdate: "user_message_chunk", content: params.prompt[0] });
          prompts.push({ params, client, end: (stopReason = "end_turn") => resolve({ stopReason, usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, totalTokens: 115 } }) });
        }))
        .onNotification("session/cancel", () => prompts.at(-1).end("cancelled"))
        .onRequest("_session/steering", params => params, ({ params }) => { calls.push(["steer", params.prompt[0].text]); return { outcome: "injected" }; });
      const connections = [];
      mock.module(source + "/connection.ts", () => ({
        async openAcpConnection(workspaceId, label, launch, handlers) {
          const connection = acp.client({ name: "test" })
            .onNotification("session/update", ({ params }) => handlers.update(params))
            .onRequest("session/request_permission", ({ params }) => handlers.permission(params))
            .connect(fake);
          await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
          const opened = { launch, handlers, closed: false, agent: connection.agent, steering: true, async close() { opened.closed = true; } };
          connections.push(opened);
          return opened;
        },
      }));
      const templates = await import("@agents-in-the-cloud/agent/server/prompt-templates");
      mock.module("@agents-in-the-cloud/agent/server/prompt-templates", () => ({ ...templates, listPromptTemplates: async () => [] }));
      const agentServer = await import("@agents-in-the-cloud/agent/server");
      const busyEvents = [];
      mock.module("@agents-in-the-cloud/agent/server", () => ({ ...agentServer, publishWorkspaceAgentBusy(event) { busyEvents.push(event.busy); }, revokeAgentMcp: async () => {} }));
      const llm = await import("@agents-in-the-cloud/llm/server");
      const preferences = [];
      mock.module("@agents-in-the-cloud/llm/server", () => ({ ...llm, setAgentModelPreference: async (...args) => preferences.push(args), createPiModelRuntime: async () => ({ getModel: (provider, id) => id === "opus" ? {} : undefined }) }));
      const { createNativeAgents } = await import("@agents-in-the-cloud/native-agent/server");
      const { AcpRuntime } = await import(source + "/runtime.ts");
      const { createAcpAgentStore } = await import(source + "/store.ts");
      const harness = {
        id: "test-agent", agentTypeId: "test", label: "Test Agent", provider: "anthropic", source: "claude", modeId: "full", hiddenCommands: [],
        prepare: async () => ({ command: ["agent"], env: {}, instructions: "instructions", mcpServers: [{ type: "http", name: "mcp", url: "http://mcp", headers: [] }], sessionMeta: { systemPrompt: "instructions" } }),
      };
      const finished = [];
      const events = { on() {}, async emit(name, payload) { if (name === "workspace_agent_turn_finished") finished.push(payload.agentId); } };
      const agents = createNativeAgents({
        store: () => createAcpAgentStore("test-agents.json", "Test Agent"),
        settings: { prepare: async () => ({ model: "anthropic::claude-opus-5-5", thinkingLevel: "medium" }) },
        open: (workspaceId, record, save, events) => AcpRuntime.open(harness, () => [], workspaceId, record, save, events),
        newRecord: selected => ({ id: crypto.randomUUID(), title: "Test Agent", ...selected, submissions: [] }),
      }, () => events);
      const input = { text: "hello", images: [], attachmentNotes: [] };
      const settle = () => new Promise(resolve => setTimeout(resolve, 20));
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a launch opens a session in full access with the chosen model, and prompts run until their turn ends", () => scenario(`
  const id = await agents.create("workspace", { input });
  const runtime = await agents.ready("workspace", id);
  expect(calls.slice(0, 4)).toEqual([
    ["new", { cwd: "/work", mcpServers: [{ type: "http", name: "mcp", url: "http://mcp", headers: [] }], _meta: { systemPrompt: "instructions" } }],
    ["set", "mode", "full"], ["set", "model", "claude-opus-5-5"], ["set", "effort", "medium"],
  ]);
  expect(runtime.record).toMatchObject({ model: "anthropic::opus", thinkingLevel: "medium", acpSessionId: "session-1" });
  expect(prompts[0].params).toEqual({ sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
  expect(runtime.isBusy).toBe(true);
  await prompts[0].client.notify("session/update", { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi!" } } });
  prompts[0].end();
  await settle();
  expect(runtime.isBusy).toBe(false);
  expect(busyEvents).toEqual([true, false]);
  expect(finished).toEqual([id]);
  expect(runtime.tokens).toEqual({ input: 110, output: 5 });
  expect(runtime.state.entries.map(entry => entry.kind)).toEqual(["user", "message", "turn-end"]);
  // A retried send is delivered once; a different prompt under its ID is refused.
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  await runtime.send({ text: "again", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], attachmentNotes: ["Attached notes.md"] }, "request");
  expect(prompts).toHaveLength(2);
  expect(prompts[1].params.prompt).toEqual([{ type: "text", text: "again\\n\\nAttached notes.md" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  await expect(runtime.send({ ...input, text: "different" }, "request")).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("prompts sent while the agent works steer its turn, and stopping cancels it", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  await runtime.send(input, "first");
  await runtime.send({ ...input, text: "also this" }, "second");
  expect(calls.filter(call => call[0] === "steer")).toEqual([["steer", "also this"]]);
  expect(prompts).toHaveLength(1);
  expect(runtime.state.entries.map(entry => [entry.kind, entry.steering])).toEqual([["user", false], ["user", true]]);
  await runtime.stop();
  await settle();
  expect(runtime.isBusy).toBe(false);
  expect(runtime.state.entries.at(-1)).toMatchObject({ kind: "turn-end", stopReason: "cancelled" });
  await agents.disposeAll();
`));

test("a reconnect loads the saved session, and conversation commands switch sessions", () => scenario(`
  const id = await agents.create("workspace", { input });
  prompts[0].end();
  await settle();
  const first = await agents.ready("workspace", id);
  // A lost connection reconnects by loading the session the Agent saved.
  connections[0].handlers.failed(new Error("gone"));
  const runtime = await agents.ready("workspace", id);
  expect(runtime).toBe(first);
  expect(calls.filter(call => call[0] === "load")).toEqual([["load", "session-1"]]);
  expect(runtime.state.entries.map(entry => [entry.kind, entry.text])).toEqual([["user", "hello"]]);
  expect(runtime.state.entries[0].timestamp).toBeUndefined();
  expect(await runtime.command({ kind: "fork" }, "fork")).toEqual({ kind: "done", message: "Conversation forked." });
  expect(await runtime.command({ kind: "fork" }, "fork")).toEqual({ kind: "done", message: "Conversation forked." });
  expect(calls.filter(call => call[0] === "fork" || call[0] === "close")).toEqual([["fork", "session-1"], ["close", "session-1"]]);
  expect(runtime.record.acpSessionId).toBe("session-2");
  expect(runtime.state.entries).toHaveLength(1);
  expect(await runtime.command({ kind: "resume" }, "list")).toMatchObject({ kind: "resume", current: "session-2", sessions: [{ sessionId: "session-1" }, { sessionId: "session-2" }] });
  await runtime.command({ kind: "resume", sessionId: "session-1" }, "resume");
  expect(runtime.record.acpSessionId).toBe("session-1");
  // A switch that fails leaves the Agent to reconnect to the session it had.
  await expect(runtime.command({ kind: "resume", sessionId: "missing" }, "missing")).rejects.toThrow();
  expect(runtime.failure).toBeDefined();
  await agents.ready("workspace", id);
  expect(runtime.failure).toBeUndefined();
  expect(calls.filter(call => call[0] === "load").at(-1)).toEqual(["load", "session-1"]);
  await runtime.command({ kind: "new" }, "new");
  // A fresh session is saved with its first prompt, so a restart before it starts over.
  expect(runtime.record.acpSessionId).toBeUndefined();
  expect(runtime.state.entries).toEqual([]);
  await runtime.send(input, "fresh");
  expect(runtime.record.acpSessionId).toBe("session-3");
  await expect(runtime.command({ kind: "new" }, "busy")).rejects.toMatchObject({ code: "invalid_arguments" });
  await agents.disposeAll();
`));

test("the model and thinking level come from the agent's catalog, and the launch picker remembers models it offers", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  expect(runtime.selection.models.map(model => [model.id, model.selected])).toEqual([["default", false], ["opus", true], ["haiku", false]]);
  await runtime.configure({ model: "anthropic::haiku" });
  expect(runtime.record.model).toBe("anthropic::haiku");
  expect(preferences).toEqual([]);
  await runtime.command({ kind: "model", model: "claude-opus-5-5" }, "model");
  await expect(runtime.configure({ model: "anthropic::gpt" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(runtime.configure({ thinkingLevel: "max" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await runtime.configure({ thinkingLevel: "high" });
  expect(runtime.record).toMatchObject({ model: "anthropic::opus", thinkingLevel: "high" });
  expect(preferences).toEqual([["test", { provider: "anthropic", id: "opus" }, "medium"], ["test", { provider: "anthropic", id: "opus" }, "high"]]);
  await runtime.configure({ model: "anthropic::default" });
  expect(runtime.record.model).toBeUndefined();
  await agents.disposeAll();
`));

test("a permission request is declined and explained, since every session runs in full access", () => scenario(`
  const id = await agents.create("workspace");
  const runtime = await agents.ready("workspace", id);
  const answer = connections[0].handlers.permission({ sessionId: "session-1", toolCall: { toolCallId: "t", title: "rm -rf /" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }] });
  expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  expect(runtime.state.notices).toEqual(["Test Agent asked for permission to run “rm -rf /”. This Agent can’t answer permission requests yet, so it said no."]);
  await agents.disposeAll();
`));
