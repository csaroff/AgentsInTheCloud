import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { agentPath, type AgentRenderContext } from "@agents-in-the-cloud/agent/server/render-context";
import type { AcpCommandResult } from "./commands.ts";

export function renderCommandDialog(ctx: AgentRenderContext, result: Exclude<AcpCommandResult, { kind: "done" }>): string {
  const action = agentPath(ctx, "/commands");
  const rows = result.sessions.map(session => {
    const current = session.sessionId === result.current;
    const updated = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "";
    return `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="text" value="${escapeHtml(`/resume ${session.sessionId}`)}">${contentRowHtml({
      kind: "multiline", width: "fill", label: { kind: "text", text: session.title || session.sessionId },
      description: [updated, current ? "Current conversation" : ""].filter(Boolean).join(" · "),
      element: { tag: "button", attributesHtml: `type="submit"${current ? " disabled" : ""}` },
    })}</form>`;
  }).join("");
  const body = `<p>Pick up an earlier conversation with this Agent. Your current one stays saved.</p>${rows || "<p>No saved conversations yet.</p>"}`;
  return dialogHtml({ element: { id: "acp_command_dialog", attributesHtml: "data-dialog-auto-show" }, titleCaption: "Resume a conversation", iconHtml: Icons.Code, bodyHtml: `<div class="form-stack">${body}</div>` });
}
