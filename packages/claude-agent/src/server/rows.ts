import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentsInTheCloudRuntimeContext, isNotFoundError, readTextIfExists } from "@agents-in-the-cloud/core";
import { nativeImageTypes, nativeJsonlRows, nativeTimestamp } from "@agents-in-the-cloud/cli-agent/server";
import type { SessionImageRef } from "@agents-in-the-cloud/agent/server/transcript";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

const sourceSchema = Type.Object({ type: Type.String(), media_type: Type.Optional(Type.String()), data: Type.Optional(Type.String()) });
const resultBlockSchema = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()), source: Type.Optional(sourceSchema) });
const blockSchema = Type.Object({
  type: Type.String(), text: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), source: Type.Optional(sourceSchema),
  id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), input: Type.Optional(Type.Unknown()),
  tool_use_id: Type.Optional(Type.String()), is_error: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.Union([Type.String(), Type.Array(resultBlockSchema)])),
});
const usageSchema = Type.Object({
  input_tokens: Type.Number(), output_tokens: Type.Number(),
  cache_creation_input_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])), cache_read_input_tokens: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
const rowValidator = Compile(Type.Object({
  type: Type.String(), subtype: Type.Optional(Type.String()), uuid: Type.Optional(Type.String()), timestamp: Type.Optional(Type.String()),
  isSidechain: Type.Optional(Type.Boolean()), isMeta: Type.Optional(Type.Boolean()), isCompactSummary: Type.Optional(Type.Boolean()), isApiErrorMessage: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.Unknown()),
  message: Type.Optional(Type.Object({
    id: Type.Optional(Type.String()), content: Type.Union([Type.String(), Type.Array(blockSchema)]),
    stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])), usage: Type.Optional(usageSchema),
  })),
  attachment: Type.Optional(Type.Object({ type: Type.String(), prompt: Type.Optional(Type.Union([Type.String(), Type.Array(blockSchema)])), source_uuid: Type.Optional(Type.String()) })),
  customTitle: Type.Optional(Type.String()), aiTitle: Type.Optional(Type.String()),
}));
const blockValidator = Compile(blockSchema);
export type ClaudeBlock = Static<typeof blockSchema>;
/** Message content as blocks. Live SDK content uses the API's wider block types; keep only the shapes history also records. */
export function claudeBlocks(content: string | object[]): ClaudeBlock[] {
  return Array.isArray(content) ? content.filter(block => blockValidator.Check(block)) : [{ type: "text", text: content }];
}

/** The conversation as Claude Code records it, reduced to what the transcript shows. */
export type ClaudeRow =
  | { kind: "user"; uuid: string; timestamp: number; content: ClaudeBlock[]; meta: boolean }
  | { kind: "assistant"; uuid: string; timestamp: number; messageId: string; content: ClaudeBlock[]; stopReason: string | null; usage?: Static<typeof usageSchema>; error: boolean }
  /** A prompt sent while Claude worked, absorbed into its running turn. */
  | { kind: "steer"; uuid: string; timestamp: number; text: string }
  | { kind: "compact"; uuid: string; timestamp: number };

/** Claude Code's native JSONL is untrusted, append-only input. Sidechains belong to its own subagents. */
export function claudeRows(jsonl: string): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  for (const row of nativeJsonlRows(jsonl, rowValidator)) {
    if (row.isSidechain === true) continue;
    const timestamp = nativeTimestamp(row.timestamp);
    if (row.type === "attachment" && row.attachment?.type === "queued_command" && row.uuid) {
      rows.push({ kind: "steer", uuid: row.attachment.source_uuid ?? row.uuid, timestamp, text: claudeText(claudeBlocks(row.attachment.prompt ?? "")) });
    } else if (!row.uuid || !row.message) {
      if (row.type === "system" && row.subtype === "compact_boundary" && row.uuid) rows.push({ kind: "compact", uuid: row.uuid, timestamp });
    } else if (row.type === "user") {
      rows.push({ kind: "user", uuid: row.uuid, timestamp, content: claudeBlocks(row.message.content), meta: row.isMeta === true || row.isCompactSummary === true });
    } else if (row.type === "assistant") {
      rows.push({ kind: "assistant", uuid: row.uuid, timestamp, messageId: row.message.id ?? row.uuid, content: claudeBlocks(row.message.content), stopReason: row.message.stop_reason ?? null, usage: row.message.usage, error: row.isApiErrorMessage === true });
    }
  }
  return rows;
}

/** The Agent's own Claude config directory keeps its conversations apart from the Claude Code CLI's. */
export function claudeSessionDirectory(workspaceId: string, agentId: string): string {
  return join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspaces", workspaceId, "home-local", ".local", "share", "agents-in-the-cloud-agents", agentId, "claude", "projects", workspaceRoot.replaceAll("/", "-"));
}

export async function readClaudeRows(directory: string, sessionId: string): Promise<ClaudeRow[] | undefined> {
  const text = await readTextIfExists(join(directory, `${sessionId}.jsonl`));
  return text === undefined ? undefined : claudeRows(text);
}

export async function hasClaudeSession(directory: string, sessionId: string): Promise<boolean> {
  return Bun.file(join(directory, `${sessionId}.jsonl`)).exists();
}

export interface ClaudeSessionSummary { id: string; title: string; updatedAt: number }

/** The Agent's saved conversations, newest first. */
export async function listClaudeSessions(directory: string, limit: number): Promise<ClaudeSessionSummary[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")); }
  catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const files = await Promise.all(names.map(async name => ({ id: name.slice(0, -".jsonl".length), updatedAt: (await stat(join(directory, name))).mtimeMs })));
  const recent = files.toSorted((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
  const sessions = await Promise.all(recent.map(async file => {
    const text = await readTextIfExists(join(directory, `${file.id}.jsonl`)) ?? "";
    let title = "";
    let prompt = "";
    for (const row of nativeJsonlRows(text, rowValidator)) {
      title = row.customTitle ?? row.aiTitle ?? title;
      if (!prompt && row.type === "user" && row.isMeta !== true && row.isSidechain !== true && row.message) prompt = claudeText(claudeBlocks(row.message.content)).trim();
    }
    return { id: file.id, title: title || prompt.split("\n")[0]!.slice(0, 120), updatedAt: file.updatedAt };
  }));
  // Sessions without any conversation are only empty launches.
  return sessions.filter(session => session.title);
}

const interruption = /^\[Request interrupted by user[^\]]*\]$/;
/** Messages Claude Code writes into the conversation for itself, never shown as prompts. */
const internalMessages = new Set(["local-command-caveat", "system-reminder", "task-notification"]);

/** Images in a row's order, including those inside tool results. */
export function claudeImageSources(content: ClaudeBlock[]): Array<{ media_type: string; data: string }> {
  return content.flatMap(block => [block, ...Array.isArray(block.content) ? block.content : []]).flatMap(block => {
    const source = block.type === "image" ? block.source : undefined;
    return source?.type === "base64" && source.media_type && source.data && nativeImageTypes.has(source.media_type) ? [{ media_type: source.media_type, data: source.data }] : [];
  });
}

export function claudeText(content: ClaudeBlock[]): string {
  return content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

function tag(value: string, name: string): string | undefined {
  return value.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
}

/** Commands AgentsInTheCloud issues for its own controls; their echoes are not the user's prompts. */
const controlCommands = new Set(["/model"]);

/** What a user row means: a prompt or command, command output, or an interruption. */
export function claudeUserIntent(row: Extract<ClaudeRow, { kind: "user" }>): { kind: "prompt"; text: string; images: SessionImageRef[] } | { kind: "output"; text: string } | { kind: "control" | "interrupted"; text?: never } | undefined {
  if (row.meta || row.content.some(block => block.type === "tool_result")) return undefined;
  const value = claudeText(row.content).trim();
  if (interruption.test(value)) return { kind: "interrupted" };
  // Claude's own messages start with its tags; a prompt may contain them anywhere.
  const leading = value.match(/^<([a-z-]+)>/)?.[1];
  if (leading === "local-command-stdout" || leading === "local-command-stderr") {
    const output = tag(value, leading)?.trim();
    return output ? { kind: "output", text: output } : undefined;
  }
  if (leading && internalMessages.has(leading)) return undefined;
  const images = claudeImageSources(row.content).map((source, contentIndex) => ({ entryId: row.uuid, contentIndex, mimeType: source.media_type }));
  const command = leading === "command-name" || leading === "command-message" ? tag(value, "command-name") : undefined;
  if (command && controlCommands.has(command)) return { kind: "control" };
  if (command) return { kind: "prompt", text: [command, tag(value, "command-args")?.trim()].filter(Boolean).join(" "), images };
  return value || images.length ? { kind: "prompt", text: value, images } : undefined;
}

