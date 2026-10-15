import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpState } from "../src/server/state.ts";
import { projectAcpTranscript } from "../src/server/transcript.ts";

/** Builds a conversation; updates arrive at `timestamp`, or replay without one. */
function state(timestamp: number | undefined, build: (current: AcpState, receive: (...updates: SessionUpdate[]) => void) => void) {
  const current = new AcpState();
  build(current, (...updates) => { for (const update of updates) current.receive(update, timestamp); });
  return current;
}
const text = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk", value: string, messageId?: string): SessionUpdate => ({ sessionUpdate, messageId, content: { type: "text", text: value } });

test("a prompt's work groups its thinking and tools, and its last reply answers it", () => {
  const conversation = state(2000, (current, receive) => {
    current.addPrompt("Fix it", [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], false, 1000);
    receive(text("agent_thought_chunk", "Let me ", "m1"), text("agent_thought_chunk", "look.", "m1"),
    text("agent_message_chunk", "Running the suite.", "m2"),
    { sessionUpdate: "tool_call", toolCallId: "run", title: "Terminal", kind: "execute", status: "in_progress", rawInput: { command: "bash -lc 'bun test'" } },
    { sessionUpdate: "tool_call_update", toolCallId: "run", _meta: { terminal_output_delta: { data: "1 pass\n" } } },
    { sessionUpdate: "tool_call_update", toolCallId: "run", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
    { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "completed", content: [{ type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" }] },
    { sessionUpdate: "tool_call", toolCallId: "write", title: "Write", kind: "edit", status: "failed", content: [{ type: "diff", path: "/work/b.ts", newText: "c" }] },
    { sessionUpdate: "tool_call", toolCallId: "read", title: "Read a.ts", kind: "read", status: "completed", locations: [{ path: "/work/a.ts" }], rawOutput: "b" },
    text("agent_message_chunk", "All ", "m3"), text("agent_message_chunk", "fixed.", "m3"));
    current.endTurn("end_turn", 5000);
  });
  expect(projectAcpTranscript(conversation.entries, false)).toEqual([
    { type: "user", key: "entry-0", text: "Fix it", images: [{ entryId: "entry-0", contentIndex: 0, mimeType: "image/png" }], timestamp: 1000 },
    { type: "working", key: "entry-0:working", startedAt: 1000, live: false, hasFinalAnswer: true, completedAt: 5000, items: [
      { type: "thinking", key: "entry-1", text: "Let me look.", live: false, timestamp: 2000 },
      { type: "text", key: "entry-2", text: "Running the suite.", final: false, live: false, timestamp: 2000 },
      { type: "tool", key: "tool:run", timestamp: 2000, tool: { callId: "run", name: "bash", args: { command: "bun test" }, status: "ok", resultText: "1 pass\n", issuedAt: 2000, durationMs: 0, details: { exitCode: 0 } } },
      { type: "tool", key: "tool:edit", timestamp: 2000, tool: { callId: "edit", name: "edit", args: { path: "/work/a.ts", oldText: "a", newText: "b" }, status: "ok", resultText: "", issuedAt: 2000, durationMs: 0, details: undefined } },
      { type: "tool", key: "tool:write", timestamp: 2000, tool: { callId: "write", name: "write", args: { path: "/work/b.ts", content: "c" }, status: "error", resultText: "", issuedAt: 2000, durationMs: 0, details: undefined } },
      { type: "tool", key: "tool:read", timestamp: 2000, tool: { callId: "read", name: "read", args: { path: "/work/a.ts" }, status: "ok", resultText: "b", issuedAt: 2000, durationMs: 0, details: undefined } },
    ] },
    { type: "text", key: "entry-3", text: "All fixed.", final: true, live: false, timestamp: 2000 },
  ]);
});

test("a running turn is live and shows prompts that steer it", () => {
  const conversation = state(1200, (current, receive) => {
    current.addPrompt("Start", [], false, 1000);
    receive({ sessionUpdate: "tool_call", toolCallId: "run", title: "sleep 9", kind: "execute", status: "in_progress" });
    current.addPrompt("Also this", [], true, 1500);
    receive(text("agent_message_chunk", "Working on both", "m1"));
  });
  const [prompt, working, ...rest] = projectAcpTranscript(conversation.entries, true);
  expect(prompt).toMatchObject({ type: "user", text: "Start" });
  expect(rest).toEqual([]);
  expect(working).toMatchObject({ type: "working", live: true, hasFinalAnswer: false, items: [
    { type: "tool", tool: { name: "bash", args: { command: "sleep 9" }, status: "running" } },
    { type: "user", text: "Also this", steering: true },
    { type: "text", text: "Working on both", live: true },
  ] });
  expect(working).not.toHaveProperty("completedAt");
});

test("replayed history shows how turns ended without timing them, and the agent's own turns stand apart", () => {
  const conversation = state(undefined, (_, receive) => receive(
    text("user_message_chunk", "First", "u1"), { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } },
    { sessionUpdate: "tool_call", toolCallId: "run", title: "ls", kind: "execute", status: "pending" },
    text("agent_message_chunk", "Done.", "a1"),
    text("user_message_chunk", "Second", "u2"),
  ));
  conversation.endTurn("cancelled", 9000);
  conversation.receive(text("agent_message_chunk", "The background task finished.", "a2"), 9500);
  const items = projectAcpTranscript(conversation.entries, false);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text", "user", "working", "working", "text"]);
  expect(items[0]).toMatchObject({ text: "First", images: [{ entryId: "entry-0", contentIndex: 0 }] });
  expect(items[1]).toMatchObject({ durationUnavailable: true, completedAt: 0, items: [{ type: "tool", tool: { status: "error" } }] });
  expect(items[2]).toMatchObject({ text: "Done.", final: true });
  expect(items[4]).toMatchObject({ durationUnavailable: true, stoppedAt: 9000, hasFinalAnswer: false });
  expect(items[5]).toMatchObject({ startedAt: 9500, completedAt: 9500, hasFinalAnswer: true });
});

test("a failed prompt shows its error, and the agent's notices and plans join the turn", () => {
  const conversation = state(2000, (current, receive) => {
    current.addPrompt("Plan it", [], false, 1000);
    receive({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "high", status: "completed" }, { content: "Write", priority: "high", status: "pending" }] },
    { sessionUpdate: "plan", entries: [{ content: "Read", priority: "high", status: "completed" }, { content: "Write", priority: "high", status: "completed" }] },
    { sessionUpdate: "notice", severity: "warning", title: "Rate limited", description: "Retrying soon." });
    current.endTurn("error", 3000, "Overloaded");
  });
  expect(projectAcpTranscript(conversation.entries, false)).toEqual([
    { type: "user", key: "entry-0", text: "Plan it", images: [], timestamp: 1000 },
    { type: "working", key: "entry-0:working", startedAt: 1000, live: false, hasFinalAnswer: false, stoppedAt: 3000, items: [
      { type: "text", key: "entry-1", text: "- [x] Read\n- [x] Write", final: false, timestamp: 2000 },
      { type: "note", key: "entry-2", text: "Rate limited\n\nRetrying soon.", tone: "warning", timestamp: 2000 },
    ] },
    { type: "error", key: "entry-3:error", text: "Overloaded" },
  ]);
});
