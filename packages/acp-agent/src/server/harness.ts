import type { McpServer } from "@agentclientprotocol/sdk";
import type { JsonObject } from "@agents-in-the-cloud/core";
import type { SlashCommandSource } from "@agents-in-the-cloud/agent/server/builtin-slash-commands";
import type { createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import type { AcpToolCall } from "./state.ts";

/** How to start a harness's ACP adapter in the workspace, and what every session it opens gets. */
export interface AcpLaunch {
  command: string[];
  /** Passed to the adapter by name, so values never reach a command line. */
  env: Record<string, string>;
  /** AgentsInTheCloud's guidance for the agent, as shown in the transcript. */
  instructions: string;
  mcpServers: McpServer[];
  /** Adapter-specific session options, such as how the instructions reach the agent. */
  sessionMeta: JsonObject;
}

/** A tool call as one of AgentsInTheCloud's own tools, such as `bash` or `edit`. */
export interface ToolCallPresentation { name: string; args: unknown }

/** A coding agent AgentsInTheCloud drives through its ACP adapter. */
export interface AcpHarness {
  /** Workspace module ID, such as `claude-agent`. */
  id: string;
  agentTypeId: string;
  label: string;
  iconHtml: string;
  /** The model provider whose subscription the agent uses. */
  provider: string;
  source: SlashCommandSource;
  /** Path segment under the workspace for this Agent type's routes, such as `codex-agents`. */
  routeSegment: string;
  /** Workspace metadata file keeping this type's Agents. */
  storeFile: string;
  /** The session mode that gives the agent the workspace's full access; no client surface answers permission requests. */
  modeId: string;
  /** Agent commands not offered, such as signing out of the app-owned subscription. */
  hiddenCommands: readonly string[];
  settings: ReturnType<typeof createCliModelSettings>;
  requireSetup(): Promise<void>;
  prepare(workspaceId: string, agentId: string): Promise<AcpLaunch>;
  /** Native tool calls that render like AgentsInTheCloud's own. */
  toolCall?(tool: AcpToolCall): ToolCallPresentation | undefined;
}
