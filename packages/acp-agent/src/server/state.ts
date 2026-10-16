import type { AvailableCommand, ContentBlock, PlanEntry, SessionConfigOption, SessionUpdate, StopReason, ToolCall, ToolCallUpdate, UsageUpdate } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface AcpImage { mimeType: string; data: string }
/** A tool call as its updates have filled it in so far. */
export interface AcpToolCall extends ToolCall {
  /** Command output an adapter streams alongside the call, for clients without terminals. */
  output: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * The conversation in the order the agent reported it. Replayed history has no
 * timestamps; live updates carry the time AgentsInTheCloud received them.
 */
export type AcpEntry =
  | { kind: "user"; key: string; messageId?: string; text: string; images: AcpImage[]; steering: boolean; timestamp?: number }
  | { kind: "message" | "thought"; key: string; messageId?: string; text: string; timestamp?: number }
  | { kind: "tool"; key: string; tool: AcpToolCall }
  | { kind: "plan"; key: string; entries: PlanEntry[]; timestamp?: number }
  | { kind: "note"; key: string; text: string; tone: "warning" | "summary"; timestamp?: number }
  /** Where the agent started a subagent; its work lives in `subagents` under this key. */
  | { kind: "subagent"; key: string }
  /** The prompt's response: how its turn ended. */
  | { kind: "turn-end"; key: string; stopReason: StopReason | "error"; error?: string; timestamp: number };

const terminalOutputSchema = Type.Object({ terminal_output_delta: Type.Object({ data: Type.String() }) });
const stopReasonSchema = Type.Object({ stopReason: Type.String() });
const stopErrorSchema = Type.Object({ error: Type.Object({ message: Type.String() }) });

/** A child session the agent delegated work to, as its parent announced it. */
export interface AcpSubagent {
  conversation: AcpState;
  title?: string;
  description?: string;
  running: boolean;
  /** Whether the agent can stop this child on its own. */
  cancellable: boolean;
  stopReason?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Images a tool returned, in the order its content lists them. */
export function toolImages(tool: Pick<ToolCall, "content">): AcpImage[] {
  return (tool.content ?? []).flatMap(part => part.type === "content" && part.content.type === "image" ? [{ mimeType: part.content.mimeType, data: part.content.data }] : []);
}

function contentText(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  if (content.type === "resource_link") return content.uri;
  if (content.type === "resource") return "text" in content.resource ? content.resource.text : content.resource.uri;
  return "";
}

export class AcpState {
  entries: AcpEntry[] = [];
  /** Slash commands the agent runs itself. */
  commands: AvailableCommand[] = [];
  configOptions: SessionConfigOption[] = [];
  usage?: UsageUpdate;
  readonly notices: string[] = [];
  readonly subagents = new Map<string, AcpSubagent>();
  private nextKey = 0;
  /** Children prefix their keys, so a transcript can hold a parent's and its children's entries. */
  constructor(private readonly keyPrefix = "") {}
  /** Starts over for another session, before its history replays. */
  reset() {
    this.entries = [];
    this.commands = [];
    this.configOptions = [];
    this.usage = undefined;
    this.notices.length = 0;
    this.subagents.clear();
  }
  private key() { return `${this.keyPrefix}entry-${this.nextKey++}`; }
  /** The conversation of a session this one delegated to, at any depth. */
  subagentConversation(sessionId: string): AcpState | undefined {
    for (const [id, subagent] of this.subagents) {
      if (id === sessionId) return subagent.conversation;
      const nested = subagent.conversation.subagentConversation(sessionId);
      if (nested) return nested;
    }
    return undefined;
  }
  /** Running children at any depth, with the session each runs in. */
  runningSubagents(): Array<{ sessionId: string; subagent: AcpSubagent }> {
    return [...this.subagents].flatMap(([sessionId, subagent]) => [...subagent.running ? [{ sessionId, subagent }] : [], ...subagent.conversation.runningSubagents()]);
  }
  addPrompt(text: string, images: AcpImage[], steering: boolean, timestamp: number) {
    const entry: Extract<AcpEntry, { kind: "user" }> = { kind: "user", key: this.key(), text, images, steering, timestamp };
    this.entries.push(entry);
    return entry;
  }
  /**
   * A steered prompt that missed its turn starts the next one: it follows the end of the turn
   * it missed, and precedes anything its own turn already reported.
   */
  startNextTurn(entry: Extract<AcpEntry, { kind: "user" }>) {
    const position = this.entries.indexOf(entry);
    this.entries.splice(position, 1);
    const missed = this.entries.findIndex((next, index) => index >= position && next.kind === "turn-end");
    entry.steering = false;
    this.entries.splice(missed === -1 ? this.entries.length : missed + 1, 0, entry);
  }
  /** Whether the agent reported nothing yet for the turn this prompt started. */
  untouched(entry: Extract<AcpEntry, { kind: "user" }>) {
    return this.entries.slice(this.entries.indexOf(entry) + 1).every(next => next.kind === "user" || next.kind === "turn-end");
  }
  /** An image of a prompt, or of a tool's result by its transcript key, in this conversation or a subagent's. */
  image(entryId: string, index: number): AcpImage | undefined {
    const entry = this.entries.find(entry => entry.key === entryId || (entry.kind === "tool" && `tool:${entry.key}` === entryId));
    if (entry?.kind === "user") return entry.images[index];
    if (entry?.kind === "tool") return toolImages(entry.tool)[index];
    for (const subagent of this.subagents.values()) {
      const image = subagent.conversation.image(entryId, index);
      if (image) return image;
    }
    return undefined;
  }
  /** A prompt the agent turned down never joined the conversation. */
  removeEntry(entry: AcpEntry) {
    this.entries = this.entries.filter(existing => existing !== entry);
  }
  endTurn(stopReason: StopReason | "error", timestamp: number, error?: string) {
    this.entries.push({ kind: "turn-end", key: this.key(), stopReason, error, timestamp });
  }
  /** A tool call's updates can arrive before the call itself. */
  private tool(toolCallId: string, timestamp: number | undefined) {
    const existing = this.entries.find(entry => entry.kind === "tool" && entry.key === toolCallId);
    if (existing?.kind === "tool") return existing.tool;
    const tool: AcpToolCall = { toolCallId, title: "", output: "", startedAt: timestamp };
    this.entries.push({ kind: "tool", key: toolCallId, tool });
    return tool;
  }
  private updateTool(update: ToolCall | ToolCallUpdate, timestamp: number | undefined) {
    const tool = this.tool(update.toolCallId, timestamp);
    if (update.title != null) tool.title = update.title;
    if (update.name != null) tool.name = update.name;
    if (update.kind != null) tool.kind = update.kind;
    if (update.content != null) tool.content = update.content;
    if (update.locations != null) tool.locations = update.locations;
    if (update.rawInput != null) tool.rawInput = update.rawInput;
    if (update.rawOutput != null) tool.rawOutput = update.rawOutput;
    if (update._meta != null) {
      const { terminal_output_delta: _, ...meta } = update._meta;
      tool._meta = { ...tool._meta, ...meta };
      if (Value.Check(terminalOutputSchema, update._meta)) tool.output += update._meta.terminal_output_delta.data;
    }
    if (update.status != null) {
      tool.status = update.status;
      if ((update.status === "completed" || update.status === "failed") && timestamp !== undefined) tool.endedAt = timestamp;
    }
  }
  /** Chunks of one message share its ID; adapters that send none send a message's chunks in a row. */
  private chunk(kind: "message" | "thought", messageId: string | null | undefined, text: string, timestamp: number | undefined) {
    const last = this.entries.at(-1);
    if (last?.kind === kind && (last.messageId ?? null) === (messageId ?? null)) last.text += text;
    else this.entries.push({ kind, key: this.key(), messageId: messageId ?? undefined, text, timestamp });
  }
  receive(update: SessionUpdate, timestamp: number | undefined): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const last = this.entries.at(-1);
        const user = last?.kind === "user" && last.messageId !== undefined && last.messageId === update.messageId ? last : undefined;
        const images = update.content.type === "image" ? [{ mimeType: update.content.mimeType, data: update.content.data }] : [];
        const text = contentText(update.content);
        if (user) {
          user.text = [user.text, text].filter(Boolean).join("\n\n");
          user.images.push(...images);
        } else this.entries.push({ kind: "user", key: this.key(), messageId: update.messageId ?? undefined, text, images, steering: false, timestamp });
        break;
      }
      case "agent_message_chunk": this.chunk("message", update.messageId, contentText(update.content), timestamp); break;
      case "agent_thought_chunk": this.chunk("thought", update.messageId, contentText(update.content), timestamp); break;
      case "tool_call": case "tool_call_update": this.updateTool(update, timestamp); break;
      case "plan": {
        // A plan is revised in place until the next prompt.
        const since = this.entries.slice(this.entries.findLastIndex(entry => entry.kind === "user") + 1);
        const plan = since.findLast(entry => entry.kind === "plan");
        if (plan?.kind === "plan") plan.entries = update.entries;
        else this.entries.push({ kind: "plan", key: this.key(), entries: update.entries, timestamp });
        break;
      }
      case "notice":
        this.entries.push({ kind: "note", key: this.key(), text: [update.title, update.description].filter(Boolean).join("\n\n"), tone: "warning", timestamp });
        break;
      case "subagent_update": {
        let subagent = this.subagents.get(update.sessionId);
        if (!subagent) {
          subagent = { conversation: new AcpState(`${update.sessionId}:`), running: false, cancellable: false, startedAt: timestamp };
          this.subagents.set(update.sessionId, subagent);
          this.entries.push({ kind: "subagent", key: update.sessionId });
        }
        if (update.title != null) subagent.title = update.title;
        if (update.description != null) subagent.description = update.description;
        if (update.capabilities != null) subagent.cancellable = update.capabilities.cancel != null;
        const state = update.state;
        if (state?.state === "running" || state?.state === "requires_action") subagent.running = true;
        else if (state?.state === "idle") {
          subagent.running = false;
          subagent.stopReason = Value.Check(stopReasonSchema, state) ? state.stopReason : undefined;
          subagent.error = Value.Check(stopErrorSchema, state) ? state.error.message : undefined;
          subagent.endedAt = timestamp;
        }
        break;
      }
      case "compaction_update":
        if (update.status === "completed") this.entries.push({ kind: "note", key: this.key(), text: "Compacted the conversation.", tone: "summary", timestamp });
        break;
      case "usage_update": this.usage = update; break;
      case "available_commands_update": this.commands = update.availableCommands; break;
      case "config_option_update": this.configOptions = update.configOptions; break;
    }
  }
  /** The selected value of the option of a category, such as `model` or `thought_level`. */
  option(category: string) {
    const option = this.configOptions.find(option => option.category === category);
    return option?.type === "select" ? option : undefined;
  }
}
