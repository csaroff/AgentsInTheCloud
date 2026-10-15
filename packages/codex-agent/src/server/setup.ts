import { agentsInTheCloudSystemPrompt } from "@agents-in-the-cloud/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@agents-in-the-cloud/agent/server";
import type { AcpLaunch } from "@agents-in-the-cloud/acp-agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { createPiModelRuntime, installCodexSubscriptionAuth, requireProviderSubscription } from "@agents-in-the-cloud/llm/server";

export const agentTypeId = "codex";
export const label = "Codex";
// The adapter pins a compatible Codex.
export const codexAcpVersion = "2.2.2";
const codexAcpExecutable = `/home/agents-in-the-cloud/.codex-acp-cli/${codexAcpVersion}/node_modules/.bin/codex-acp`;
export const settings = createCliModelSettings({ agentTypeId, provider: "openai-codex", label: "Codex", mapThinkingLevel: (level, mapped) => mapped === null ? undefined : mapped ?? (level === "off" ? "none" : level) });
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "openai-codex", "Codex");
}
function codexHome(agentId: string) { return `/home/agents-in-the-cloud/.local/share/agents-in-the-cloud-agents/${agentId}/codex`; }

export async function prepareCodex(workspaceId: string, agentId: string): Promise<AcpLaunch> {
  await installCodexSubscriptionAuth(workspaceId, codexHome(agentId), await createPiModelRuntime());
  const connection = await prepareCliAgentConnection(workspaceId, agentId, agentsInTheCloudSystemPrompt);
  await checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "codex-acp", label, npmPackage: "@agentclientprotocol/codex-acp", version: codexAcpVersion, args: ["--version"] }));
  // Codex keeps its base coding prompt, AGENTS.md discovery and native tools; only the
  // renderer-aware application guidance and the connection differ. These overrides
  // belong to this process: Codex owns config.toml, so its own settings survive reconnects.
  const config = {
    developer_instructions: connection.instructions,
    mcp_servers: { "agents-in-the-cloud": { url: connection.url, required: true, tool_timeout_sec: 3600, http_headers: { Authorization: `Bearer ${connection.token}` } } },
  };
  return {
    command: [codexAcpExecutable],
    env: { CODEX_HOME: codexHome(agentId), CODEX_CONFIG: JSON.stringify(config) },
    instructions: connection.instructions,
    mcpServers: [],
    sessionMeta: {},
  };
}
