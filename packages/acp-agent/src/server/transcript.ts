import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { SessionImageRef, ToolView, TranscriptItem, WorkingTranscriptItem } from "@agents-in-the-cloud/agent/server/transcript";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AcpHarness, ToolCallPresentation } from "./harness.ts";
import { nativeImageTypes } from "@agents-in-the-cloud/cli-agent/server";
import { toolImages, type AcpEntry, type AcpState, type AcpSubagent, type AcpToolCall } from "./state.ts";

const commandSchema = Type.Object({ command: Type.Union([Type.String(), Type.Array(Type.String())]) });
const terminalExitSchema = Type.Object({ terminal_exit: Type.Object({ exit_code: Type.Number() }) });

/** Agents report their shell invocation as a wrapped script; show the script. */
export function bashStatement(command: string): string {
  const wrapper = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)\s+-[il]*c\s+(['"])([\s\S]*)\1$/.exec(command);
  if (!wrapper) return command;
  const quote = wrapper[1]!;
  const script = wrapper[2]!;
  let statement = "";
  for (let index = 0; index < script.length; index++) {
    const character = script[index]!;
    if (character === quote) return command; // Not a single quoted script argument.
    if (quote === '"' && character === "\\" && index + 1 < script.length) {
      const next = script[index + 1]!;
      if ('"\\$`\n'.includes(next)) {
        if (next !== "\n") statement += next;
        index++;
        continue;
      }
    }
    statement += character;
  }
  return statement;
}

function textContent(content: readonly ToolCallContent[] | undefined): string {
  return (content ?? []).flatMap(part => part.type === "content" && part.content.type === "text" ? [part.content.text] : []).join("\n");
}

/** The call as AgentsInTheCloud's own tools: shell commands, file reads and edits. */
function toolCall(tool: AcpToolCall): ToolCallPresentation {
  const diff = tool.content?.find(part => part.type === "diff");
  if (diff?.type === "diff") return diff.oldText == null ? { name: "write", args: { path: diff.path, content: diff.newText } } : { name: "edit", args: { path: diff.path, oldText: diff.oldText, newText: diff.newText } };
  if (tool.kind === "execute") {
    const input = Value.Check(commandSchema, tool.rawInput) ? tool.rawInput.command : tool.title;
    return { name: "bash", args: { command: bashStatement(Array.isArray(input) ? input.join(" ") : input) } };
  }
  const path = tool.locations?.[0]?.path;
  if (tool.kind === "read" && path) return { name: "read", args: { path } };
  return { name: tool.title || tool.name || "tool", args: tool.rawInput ?? {} };
}

function resultText(tool: AcpToolCall): string {
  if (Value.Check(Type.String(), tool.rawOutput)) return tool.rawOutput;
  // An agent's own record of an image result repeats the image's data.
  if (toolImages(tool).length) return textContent(tool.content);
  return textContent(tool.content) || tool.output || (tool.rawOutput === undefined ? "" : JSON.stringify(tool.rawOutput, null, 2));
}

/** Images the tool returned, served by the Agent's image route under the tool's transcript key. */
function resultImages(tool: AcpToolCall): SessionImageRef[] | undefined {
  const images = toolImages(tool).flatMap((image, contentIndex) => nativeImageTypes.has(image.mimeType) ? [{ entryId: `tool:${tool.toolCallId}`, contentIndex, mimeType: image.mimeType }] : []);
  return images.length ? images : undefined;
}

function toolView(tool: AcpToolCall, harness: Pick<AcpHarness, "toolCall">, live: boolean): ToolView {
  const call = harness.toolCall?.(tool) ?? toolCall(tool);
  const done = tool.status === "completed" || tool.status === "failed";
  return {
    callId: tool.toolCallId, name: call.name, args: call.args,
    status: tool.status === "failed" ? "error" : tool.status === "completed" ? "ok" : live ? "running" : "error",
    resultText: done ? resultText(tool) : tool.output || undefined,
    issuedAt: tool.startedAt,
    resultImages: done ? resultImages(tool) : undefined,
    durationMs: tool.startedAt !== undefined && tool.endedAt !== undefined ? Math.max(0, tool.endedAt - tool.startedAt) : undefined,
    details: Value.Check(terminalExitSchema, tool._meta) ? { exitCode: tool._meta.terminal_exit.exit_code } : undefined,
  };
}

function planText(entries: Extract<AcpEntry, { kind: "plan" }>["entries"]): string {
  return entries.map(entry => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`).join("\n");
}

/** An entry as an item of the work it belongs to; prompts and turn ends shape the turns instead. */
function activityItem(entry: AcpEntry, live: boolean, conversation: Pick<AcpState, "subagents">, harness: Pick<AcpHarness, "toolCall">): TranscriptItem | undefined {
  switch (entry.kind) {
    case "user": return { type: "user", key: entry.key, text: entry.text, images: entry.images.map((image, contentIndex) => ({ entryId: entry.key, contentIndex, mimeType: image.mimeType })), steering: true, timestamp: entry.timestamp };
    case "message": return entry.text.trim() ? { type: "text", key: entry.key, text: entry.text, final: false, live, timestamp: entry.timestamp } : undefined;
    case "thought": return entry.text.trim() ? { type: "thinking", key: entry.key, text: entry.text, live, timestamp: entry.timestamp } : undefined;
    case "tool": return { type: "tool", key: `tool:${entry.key}`, tool: toolView(entry.tool, harness, live), timestamp: entry.tool.startedAt };
    case "plan": return { type: "text", key: entry.key, text: planText(entry.entries), final: false, timestamp: entry.timestamp };
    case "note": return { type: "note", key: entry.key, text: entry.text, tone: entry.tone, timestamp: entry.timestamp };
    case "subagent": return subagentSection(entry.key, conversation.subagents.get(entry.key)!, harness);
    case "turn-end": return undefined;
  }
}

/** A subagent's work, nested where its parent started it; its last reply stays inside with the rest. */
function subagentSection(sessionId: string, subagent: AcpSubagent, harness: Pick<AcpHarness, "toolCall">): WorkingTranscriptItem {
  const { conversation, running } = subagent;
  const items = conversation.entries.flatMap(entry => activityItem(entry, running, conversation, harness) ?? []);
  if (subagent.error) items.push({ type: "error", key: `subagent:${sessionId}:error`, text: subagent.error });
  const startedAt = subagent.startedAt ?? 0;
  const working: WorkingTranscriptItem = {
    type: "working", key: `subagent:${sessionId}`, title: [subagent.title, subagent.description].filter(Boolean).join(" · ") || "Subagent",
    startedAt, items, live: running, hasFinalAnswer: !running && items.findLast(item => item.type !== "note")?.type === "text",
  };
  if (!startedAt) working.durationUnavailable = true;
  if (!running) {
    const endedAt = Math.max(startedAt, subagent.endedAt ?? 0, ...items.flatMap(item => item.timestamp === undefined ? [] : [item.timestamp]));
    if (subagent.stopReason && subagent.stopReason !== "end_turn") working.stoppedAt = endedAt;
    else working.completedAt = endedAt;
  }
  return working;
}

interface Turn { prompt?: TranscriptItem; working: WorkingTranscriptItem; end?: Extract<AcpEntry, { kind: "turn-end" }>; live: boolean }

/** ACP entries grouped like every other Agent's turns: a prompt, the work it caused, then the answer. */
export function projectAcpTranscript(conversation: Pick<AcpState, "entries" | "subagents">, busy: boolean, harness: Pick<AcpHarness, "toolCall"> = {}): TranscriptItem[] {
  const { entries } = conversation;
  const items: TranscriptItem[] = [];
  let turn: Turn | undefined;
  const lastPrompt = entries.findLastIndex(entry => entry.kind === "user" && !entry.steering);
  const finish = () => {
    if (!turn) return;
    const { working, end } = turn;
    // The last reply after the final tool call answers the prompt; earlier text was commentary.
    const index = working.items.findLastIndex(item => item.type !== "note");
    const answered = !turn.live && (end === undefined || end.stopReason === "end_turn");
    const final = answered && working.items[index]?.type === "text" ? working.items.splice(index, 1)[0] : undefined;
    if (final?.type === "text") final.final = true;
    working.hasFinalAnswer = Boolean(final);
    working.live = turn.live;
    // A subagent's work counts toward the turn that started it.
    const stamps = [working.startedAt, ...working.items.flatMap(item => item.type === "working" ? [item.completedAt ?? item.stoppedAt ?? 0] : item.timestamp === undefined ? [] : [item.timestamp]), end?.timestamp ?? 0].filter(Boolean);
    // Replayed history has no times; it shows how a turn ended, not how long it took.
    if (!working.startedAt) working.durationUnavailable = true;
    // A subagent can keep working after its parent's turn ends; the turn shows live until it finishes.
    const delegating = working.items.some(item => item.type === "working" && item.live);
    if (delegating) working.live = true;
    else if (!turn.live) {
      const endedAt = Math.max(working.startedAt, ...stamps);
      if (end && end.stopReason !== "end_turn") working.stoppedAt = endedAt;
      else working.completedAt = endedAt;
    }
    const error: TranscriptItem[] = end?.error ? [{ type: "error", key: `${end.key}:error`, text: end.error }] : [];
    items.push(...turn.prompt ? [turn.prompt] : [], working, ...final ? [final] : [], ...error);
    turn = undefined;
  };
  const start = (key: string, timestamp: number | undefined, prompt: TranscriptItem | undefined, index: number) => {
    turn = { prompt, working: { type: "working", key: `${key}:working`, startedAt: timestamp ?? 0, items: [] }, live: busy && index >= lastPrompt };
  };
  entries.forEach((entry, index) => {
    if (entry.kind === "user" && !(entry.steering && turn)) {
      finish();
      start(entry.key, entry.timestamp, { type: "user", key: entry.key, text: entry.text, images: entry.images.map((image, contentIndex) => ({ entryId: entry.key, contentIndex, mimeType: image.mimeType })), timestamp: entry.timestamp }, index);
      return;
    }
    if (entry.kind === "turn-end") {
      if (turn) turn.end = entry;
      finish();
      return;
    }
    // The agent can start work of its own, such as reporting on a finished background task.
    if (!turn) start(entry.key, entry.kind === "tool" ? entry.tool.startedAt : entry.kind === "subagent" ? conversation.subagents.get(entry.key)!.startedAt : entry.timestamp, undefined, index);
    const item = activityItem(entry, turn!.live, conversation, harness);
    if (item) turn!.working.items.push(item);
  });
  finish();
  return items;
}
