import type { AvailableCommand, SessionInfo } from "@agentclientprotocol/sdk";
import { invalidArguments } from "@agents-in-the-cloud/core";
import type { BuiltinSlashCommand, SlashCommandSource } from "@agents-in-the-cloud/agent/server/builtin-slash-commands";

/** Commands AgentsInTheCloud runs itself through ACP, besides /name and /park; every other slash command goes to the agent. */
export function acpAgentCommands(source: SlashCommandSource, label: string): BuiltinSlashCommand[] {
  return [
    { kind: "builtin", source, name: "new", trigger: "/new", description: `Start a fresh ${label} conversation.` },
    { kind: "builtin", source, name: "resume", trigger: "/resume", description: `Choose a saved ${label} conversation.`, argumentHint: "[session-id]", preserveArguments: true },
    { kind: "builtin", source, name: "fork", trigger: "/fork", description: "Continue in a copy of this conversation." },
    { kind: "builtin", source, name: "model", trigger: "/model", description: `Switch ${label}’s model.`, argumentHint: "<model>", preserveArguments: true },
  ];
}
const handledElsewhere = new Set(["new", "resume", "fork", "name", "park", "model"]);

/** The agent's own commands for the completion menu; the repository's Prompt templates replace same-named ones. */
export function acpNativeCommands(source: SlashCommandSource, commands: readonly AvailableCommand[], hidden: readonly string[], templateNames: ReadonlySet<string>): BuiltinSlashCommand[] {
  // Names that are not plain words, such as Codex's `$skill` mentions, are written into prompts rather than run.
  return commands.filter(command => /^[\w:.-]+$/.test(command.name) && !handledElsewhere.has(command.name) && !hidden.includes(command.name) && !templateNames.has(command.name)).map(command => ({
    kind: "builtin", source, name: command.name, trigger: `/${command.name}`, description: command.description, argumentHint: command.input?.hint || undefined, preserveArguments: true,
  }));
}

export type AcpCommand = { kind: "new" | "fork" } | { kind: "resume"; sessionId?: string } | { kind: "model"; model: string };
export type AcpCommandResult = { kind: "done"; message: string } | { kind: "resume"; sessions: SessionInfo[]; current?: string };

export function parseAcpCommand(text: string): AcpCommand | undefined {
  const match = text.trim().match(/^\/(new|fork|resume|model)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const args = match[2]?.trim() ?? "";
  // The model control below the prompt owns the selection; typing /model uses the same path.
  if (match[1] === "model") {
    if (!/^[\w.:[\]-]+$/.test(args)) throw invalidArguments("Use /model with a model name, such as /model opus");
    return { kind: "model", model: args };
  }
  if (match[1] === "resume") {
    if (args && !/^[\w-]{1,128}$/.test(args)) throw invalidArguments("Use /resume with a session ID, or on its own to choose a conversation");
    return { kind: "resume", sessionId: args || undefined };
  }
  if (args) throw invalidArguments(`/${match[1]} doesn’t take arguments`);
  return { kind: match[1] === "new" ? "new" : "fork" };
}
