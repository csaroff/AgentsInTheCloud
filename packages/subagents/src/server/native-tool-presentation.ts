import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { isJsonObject, isString } from "@agents-in-the-cloud/core";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import type { AgentToolPresentation } from "@agents-in-the-cloud/agent/server";
import { communicationCardHtml, communicationTraceHtml } from "./render-markup.ts";

const detailsValidator = Compile(Type.Object({ recipientId: Type.String(), receiptId: Type.String(), path: Type.String(), message: Type.String() }));
const communication: AgentToolPresentation = {
  summary(tool) {
    if (detailsValidator.Check(tool.details)) return tool.details.path;
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    const peer = args?.task_name ?? args?.target;
    return isString(peer) ? peer : undefined;
  },
  detail(ctx, tool) {
    if (!detailsValidator.Check(tool.details)) return undefined;
    const { recipientId, receiptId, path, message } = tool.details;
    return communicationCardHtml([
      { label: "Body", html: `<div class="agent-communication-body">${escapeHtml(message)}</div>` },
      { label: "Recipient", html: communicationTraceHtml(ctx, recipientId, receiptId, `Find message recipient · ${path}`) },
    ]);
  },
};
export const nativeToolPresentations = new Map(["spawn_agent", "send_message", "followup_task"].map(name => [name, communication]));
