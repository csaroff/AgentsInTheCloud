import type { JsonValue } from "@agents-in-the-cloud/core";
import { createNativeAgentStore } from "@agents-in-the-cloud/native-agent/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const recordSchema = Type.Object({
  id: Type.String(), title: Type.String(),
  /** Saved once the session has a conversation to load. */
  acpSessionId: Type.Optional(Type.String()),
  /**
   * Conversations an Agent saved before ACP may continue, preferred first. Only the agent
   * knows which of them exist, so the first connection loads the first it still has.
   */
  savedBeforeAcp: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
  submissions: Type.Array(Type.Object({ id: Type.String(), digest: Type.String() })),
  // Switching conversations records its outcome with the switch, so a retried request replays it.
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), message: Type.String() }))),
});
export type AcpAgentRecord = Static<typeof recordSchema>;

/**
 * Agents saved before ACP. Claude Code named a session before creating it, and kept an
 * unstarted fork apart until the fork's first message; Codex named its sessions threads.
 */
const savedSchema = Type.Object({ agents: Type.Array(Type.Object({
  ...recordSchema.properties,
  sessionId: Type.Optional(Type.String()), forkedFrom: Type.Optional(Type.String()), threadId: Type.Optional(Type.String()),
  commandSubmissions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), digest: Type.String(), message: Type.Optional(Type.String()) }))),
})) });

export function parseAcpAgentRecords(value: JsonValue): AcpAgentRecord[] {
  return Value.Parse(savedSchema, value).agents.map(({ sessionId, forkedFrom, threadId, commandSubmissions, ...record }) => {
    // Codex marked whether each prompt was accepted; a saved submission now always was.
    const parsed: AcpAgentRecord = { ...record, submissions: record.submissions.map(({ id, digest }) => ({ id, digest })) };
    // A fork continues in its own session once that has a message, and in its parent until then.
    const candidates = [sessionId, forkedFrom, threadId].flatMap(id => id === undefined ? [] : [id]);
    if (!record.acpSessionId && candidates.length) parsed.savedBeforeAcp = candidates;
    // Codex recorded command results in its own shape; only replayable messages carry over.
    if (commandSubmissions) parsed.commandSubmissions = commandSubmissions.flatMap(entry => entry.message === undefined ? [] : [{ ...entry, message: entry.message }]);
    return parsed;
  });
}

export const createAcpAgentStore = (filename: string, label: string) => createNativeAgentStore(filename, label, parseAcpAgentRecords);
