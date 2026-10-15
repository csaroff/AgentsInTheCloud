import { createNativeAgentModule, createNativeAgentRendering, createNativeAgentRoutes, createNativeAgents, nativeAgentParameters as agentParameters } from "@agents-in-the-cloud/native-agent/server";
import { nativeImageResponse } from "@agents-in-the-cloud/cli-agent/server";
import { parseAcpCommand } from "./commands.ts";
import type { AcpHarness } from "./harness.ts";
import { renderCommandDialog } from "./render-command.ts";
import { AcpRuntime } from "./runtime.ts";
import { createAcpAgentStore, type AcpAgentRecord } from "./store.ts";
import { projectAcpTranscript } from "./transcript.ts";

/** Registers an Agent type that AgentsInTheCloud drives through the agent's ACP adapter. */
export function createAcpAgentModule(harness: AcpHarness) {
  const { label, routeSegment } = harness;
  const rendering = createNativeAgentRendering<AcpRuntime>({
    channelName: harness.id, routeSegment,
    transcript: runtime => projectAcpTranscript(runtime.state.entries, runtime.isBusy, harness),
    stats(runtime) {
      const { usage } = runtime.state;
      const selection = runtime.selection;
      return {
        contextPercent: usage?.size ? usage.used / usage.size * 100 : null, compactAvailable: !runtime.isBusy,
        inputTokens: runtime.tokens?.input ?? null, outputTokens: runtime.tokens?.output ?? null,
        cost: null, modelName: runtime.selectedModel?.name, thinkingLevel: runtime.record.thinkingLevel ?? "", thinkingLevels: selection.thinkingLevels, models: selection.models, connectedProvider: true,
      };
    },
  });
  const path = `/workspaces/{id}/${routeSegment}/{agentId}`;
  return createNativeAgentModule<AcpRuntime>({
    id: harness.id, agentTypeId: harness.agentTypeId, label, iconHtml: harness.iconHtml,
    createAgents: getEvents => createNativeAgents({
      store: () => createAcpAgentStore(harness.storeFile, label), settings: harness.settings,
      open: (workspaceId, record, save, events) => AcpRuntime.open(harness, runtime => rendering.liveRegions(runtime), workspaceId, record, save, events),
      newRecord: (selected): AcpAgentRecord => ({ id: crypto.randomUUID(), title: label, ...selected, submissions: [] }),
    }, getEvents),
    rendering,
    routes: agents => createNativeAgentRoutes(agents, rendering, {
      unknownCommand: `Choose a ${label} command`,
      parseCommand: parseAcpCommand,
      runCommand: (runtime, command, { requestId }) => runtime.command(command, requestId),
      renderCommandDialog: (runtime, result) => result.kind === "done" ? "" : renderCommandDialog(rendering.renderContext(runtime), result),
      promptText: runtime => runtime.state.entries.flatMap(entry => entry.kind === "user" ? [entry.text] : []).join("\n\n"),
      delivered: (runtime, requestId) => runtime.record.submissions.some(item => item.id === requestId),
      isHarnessCommand: (runtime, text) => runtime.isAgentCommand(text),
      sessionImage(runtime, entryId, index) {
        const entry = runtime.state.entries.find(entry => entry.key === entryId);
        const image = entry?.kind === "user" ? entry.images[index] : undefined;
        return image ? nativeImageResponse(image.data, image.mimeType) : new Response("Image not found", { status: 404 });
      },
    }),
    requireSetup: harness.requireSetup, settings: harness.settings,
    openApiPaths: {
      [`${path}/messages`]: { post: { summary: `Send or steer a prompt, or run a ${label} slash command`, parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, requestId: { type: "string" } } } } } }, responses: { "200": { description: "Command picker data" }, "202": { description: `${label} accepted the message or command` } } } },
      [`${path}/commands`]: {
        post: {
          summary: `Run /new, /fork, /resume or /model for a ${label} Agent`, parameters: agentParameters,
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, argument: { type: "string" } } } } } },
          responses: { "200": { description: "Saved conversations to resume" }, "202": { description: "Command accepted" } },
        },
      },
      [`${path}/abort`]: { post: { summary: `Interrupt ${label}'s active turn`, parameters: agentParameters, responses: { "200": { description: "Interrupt requested" } } } },
      [`${path}/model`]: { post: { summary: `Choose a model from ${label}'s catalog`, parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model"], properties: { model: { type: "string" } } } } } }, responses: { "200": { description: "Model selected" }, "422": { description: "Unsupported model or Agent is working" } } } },
      [`${path}/thinking-level`]: { post: { summary: `Choose ${label}'s thinking level`, parameters: agentParameters, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["thinkingLevel"], properties: { thinkingLevel: { type: "string" } } } } } }, responses: { "200": { description: "Thinking level selected" }, "422": { description: "Unsupported thinking level or Agent is working" } } } },
    },
  });
}
