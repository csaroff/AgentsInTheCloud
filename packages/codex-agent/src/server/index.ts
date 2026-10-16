import { Type } from "typebox";
import { Value } from "typebox/value";
import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";
import { createAcpAgentModule } from "@agents-in-the-cloud/acp-agent/server";
import { agentTypeId, label, prepareCodex, requireSetup, settings } from "./setup.ts";

const threadStatusSchema = Type.Object({ codex: Type.Object({ threadStatus: Type.Object({ type: Type.String() }) }) });

export const agentsInTheCloudServerModule = createAcpAgentModule({
  id: "codex-agent", agentTypeId, label, iconHtml: providerBrandIconHtml("openai"),
  provider: "openai-codex", source: "codex",
  routeSegment: "codex-agents",
  storeFile: "codex-agents.json",
  modeId: "agent-full-access",
  // The subscription belongs to AgentsInTheCloud, not to this Agent.
  hiddenCommands: ["logout"],
  settings, requireSetup, prepare: prepareCodex,
  // Codex runs a steered prompt that missed its turn as a turn of its own, and reports its thread active and idle around each turn.
  agentTurnStatus(update) {
    if (update.sessionUpdate !== "session_info_update" || !Value.Check(threadStatusSchema, update._meta)) return undefined;
    const status = update._meta.codex.threadStatus.type;
    return status === "active" || status === "idle" ? status : undefined;
  },
});
