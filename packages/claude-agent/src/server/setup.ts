import { agentsInTheCloudSystemPrompt } from "@agents-in-the-cloud/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@agents-in-the-cloud/agent/server";
import type { AcpLaunch } from "@agents-in-the-cloud/acp-agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { createPiModelRuntime, installClaudeSubscriptionAuth, requireProviderSubscription } from "@agents-in-the-cloud/llm/server";

export const agentTypeId = "claude";
export const label = "Claude Code";
// The adapter pins the Claude Agent SDK, which brings its own Claude Code.
export const claudeAcpVersion = "0.91.0";
const claudeAcpExecutable = `/home/agents-in-the-cloud/.claude-agent-acp-cli/${claudeAcpVersion}/node_modules/.bin/claude-agent-acp`;
export const settings = createCliModelSettings({
  agentTypeId, provider: "anthropic", label,
  mapThinkingLevel: (level, mapped) => mapped !== null && ["low", "medium", "high", "xhigh", "max"].includes(mapped ?? level) ? mapped ?? level : undefined,
});
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "anthropic", "Claude");
}
/** Claude's own config directory for this Agent, so its conversations stay apart from the Claude Code CLI's. */
function claudeConfigDirectory(agentId: string) { return `/home/agents-in-the-cloud/.local/share/agents-in-the-cloud-agents/${agentId}/claude`; }

/** Claude Code's own prompt assumes a terminal. This Agent renders its replies. */
export const renderedTranscriptInstructions = "Your replies are rendered as rich Markdown in AgentsInTheCloud's web transcript, not in a terminal. Where Claude Code's guidance about terminal output conflicts with this, follow AgentsInTheCloud's guidance.";

export async function prepareClaude(workspaceId: string, agentId: string): Promise<AcpLaunch> {
  await installClaudeSubscriptionAuth(workspaceId, claudeConfigDirectory(agentId), await createPiModelRuntime());
  const connection = await prepareCliAgentConnection(workspaceId, agentId, agentsInTheCloudSystemPrompt);
  const instructions = [connection.instructions, renderedTranscriptInstructions].join("\n\n");
  await checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "claude-agent-acp", label, npmPackage: "@agentclientprotocol/claude-agent-acp", version: claudeAcpVersion, args: ["--version"] }));
  return {
    command: [claudeAcpExecutable],
    env: { CLAUDE_CONFIG_DIR: claudeConfigDirectory(agentId) },
    instructions,
    // Claude Code options travel with each session, so the bearer token never reaches a command line.
    mcpServers: [],
    sessionMeta: {
      systemPrompt: { append: instructions },
      claudeCode: {
        options: {
          // Claude waits for alwaysLoad servers at startup and includes their tools in turn one.
          mcpServers: { "agents-in-the-cloud": { type: "http", url: connection.url, headers: { Authorization: `Bearer ${connection.token}` }, alwaysLoad: true } },
          // No client surface answers plan approval yet; Claude asks in its reply instead.
          disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    },
  };
}
