import { expect, test } from "bun:test";
import { parseAcpAgentRecords } from "../src/server/store.ts";

const submission = { id: "launch", digest: "d" };

test("Agents saved before ACP keep the conversations they may continue, for the agent to tell which exist", () => {
  expect(parseAcpAgentRecords({ agents: [
    // Claude Code named its session before creating it.
    { id: "claude", title: "Claude Code", sessionId: "s1", model: "anthropic::claude-opus-5-5", submissions: [submission], commandSubmissions: [{ id: "c", digest: "d", message: "Conversation resumed." }] },
    // A fork continues in its own session once that has a message, and in its parent until then.
    { id: "claude-fork", title: "Claude Code", sessionId: "s2", forkedFrom: "s1", submissions: [submission] },
    { id: "codex", title: "Codex", threadId: "t1", submissions: [{ ...submission, accepted: true }], commandSubmissions: [{ id: "c", digest: "d", result: "{}" }] },
    { id: "codex-fresh", title: "Codex", submissions: [] },
    { id: "acp", title: "Codex", acpSessionId: "a1", submissions: [] },
  ] })).toEqual([
    { id: "claude", title: "Claude Code", savedBeforeAcp: ["s1"], model: "anthropic::claude-opus-5-5", submissions: [submission], commandSubmissions: [{ id: "c", digest: "d", message: "Conversation resumed." }] },
    { id: "claude-fork", title: "Claude Code", savedBeforeAcp: ["s2", "s1"], submissions: [submission] },
    { id: "codex", title: "Codex", savedBeforeAcp: ["t1"], submissions: [submission], commandSubmissions: [] },
    { id: "codex-fresh", title: "Codex", submissions: [] },
    { id: "acp", title: "Codex", acpSessionId: "a1", submissions: [] },
  ]);
});
