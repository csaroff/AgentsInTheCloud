import { expect, test } from "bun:test";
import { parseAcpAgentRecords } from "../src/server/store.ts";

const submission = { id: "launch", digest: "d" };

test("keeps the conversation of Agents saved before ACP", () => {
  expect(parseAcpAgentRecords({ agents: [
    // Claude Code named its session before creating it.
    { id: "claude-fresh", title: "Claude Code", sessionId: "unused", submissions: [] },
    { id: "claude", title: "Claude Code", sessionId: "s1", model: "anthropic::claude-opus-5-5", submissions: [submission], commandSubmissions: [{ id: "c", digest: "d", message: "Conversation resumed." }] },
    // An unstarted fork continues its original conversation.
    { id: "claude-fork", title: "Claude Code", sessionId: "s2", forkedFrom: "s1", submissions: [submission] },
    { id: "codex", title: "Codex", threadId: "t1", submissions: [{ ...submission, accepted: true }], commandSubmissions: [{ id: "c", digest: "d", result: "{}" }] },
    { id: "acp", title: "Codex", acpSessionId: "a1", submissions: [] },
  ] })).toEqual([
    { id: "claude-fresh", title: "Claude Code", submissions: [] },
    { id: "claude", title: "Claude Code", acpSessionId: "s1", model: "anthropic::claude-opus-5-5", submissions: [submission], commandSubmissions: [{ id: "c", digest: "d", message: "Conversation resumed." }] },
    { id: "claude-fork", title: "Claude Code", acpSessionId: "s1", submissions: [submission] },
    { id: "codex", title: "Codex", acpSessionId: "t1", submissions: [submission], commandSubmissions: [] },
    { id: "acp", title: "Codex", acpSessionId: "a1", submissions: [] },
  ]);
});
