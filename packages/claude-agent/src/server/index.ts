import { Type } from "typebox";
import { Value } from "typebox/value";
import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";
import { createAcpAgentModule } from "@agents-in-the-cloud/acp-agent/server";
import { claudeToolCall } from "@agents-in-the-cloud/claude-cli-agent/transcript";
import { agentTypeId, label, prepareClaude, requireSetup, settings } from "./setup.ts";

const toolMetaSchema = Type.Object({ claudeCode: Type.Object({ toolName: Type.String() }) });

export const agentsInTheCloudServerModule = createAcpAgentModule({
  id: "claude-agent", agentTypeId, label, iconHtml: providerBrandIconHtml("anthropic"),
  provider: "anthropic", source: "claude",
  routeSegment: "claude-code-agents",
  // The Claude Code CLI agent keeps claude-agents.json from before this agent existed.
  storeFile: "claude-code-agents.json",
  modeId: "bypassPermissions",
  hiddenCommands: [],
  settings, requireSetup, prepare: prepareClaude,
  // Claude's file and shell tools render like AgentsInTheCloud's own.
  toolCall: tool => Value.Check(toolMetaSchema, tool._meta) ? claudeToolCall({ name: tool._meta.claudeCode.toolName, input: tool.rawInput }) : undefined,
});
