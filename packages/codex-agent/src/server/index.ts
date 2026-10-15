import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";
import { createAcpAgentModule } from "@agents-in-the-cloud/acp-agent/server";
import { agentTypeId, label, prepareCodex, requireSetup, settings } from "./setup.ts";

export const agentsInTheCloudServerModule = createAcpAgentModule({
  id: "codex-agent", agentTypeId, label, iconHtml: providerBrandIconHtml("openai"),
  provider: "openai-codex", source: "codex",
  routeSegment: "codex-agents",
  storeFile: "codex-agents.json",
  modeId: "agent-full-access",
  // The subscription belongs to AgentsInTheCloud, not to this Agent.
  hiddenCommands: ["logout"],
  settings, requireSetup, prepare: prepareCodex,
});
