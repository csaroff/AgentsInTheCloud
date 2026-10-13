import { disclosureHtml, type DisclosureSummary } from "@agents-in-the-cloud/design-system/disclosure";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { renderStreamingMarkdownSnapshot } from "@agents-in-the-cloud/markdown";
import type { ModelRef } from "@agents-in-the-cloud/llm/server";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { agentPath, commentaryContext, ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, markdown, renderMarkdownRow, transcriptRowContent, transcriptRow } from "./render-markup.ts";
import { renderToolCard, renderToolDetail } from "./render-tool.ts";
import { formatDuration, formatTokens, type TranscriptItem, type WorkingTranscriptItem } from "./transcript.ts";

interface AgentToolDefinitionView {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AgentModelContextView {
  systemPrompt: string;
  tools: AgentToolDefinitionView[];
}

export function renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): string {
  return `${renderModelContextEntries(ctx, modelContext)}${items.map((item) => renderTranscriptItem(ctx, item)).join("")}<div class="agent-notices" id="${ids.notices(ctx)}"></div>`;
}

export function renderModelContextEntries(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim()
    ? renderLazyTranscriptEntry(ctx, "system-prompt", "System prompt") : "";
  const tools = modelContext.tools.length
    ? renderLazyTranscriptEntry(ctx, "tool-definitions", "Tool definitions") : "";
  return `${prompt}${tools}`;
}

function renderLazyTranscriptEntry(ctx: AgentRenderContext, key: string, label: string): string {
  const frame = `<turbo-frame id="${ids.detailFrame(ctx, key)}" data-turbo-permanent data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
  return transcriptRow(disclosureHtml({ element: { attributesHtml: 'data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"' }, summary: transcriptRowContent({ kind: "text", text: label }), bodyHtml: frame }));
}

export function renderModelContextDetailFrame(ctx: AgentRenderContext, modelContext: AgentModelContextView, key: "system-prompt" | "tool-definitions"): string {
  const content = key === "system-prompt"
    ? renderMarkdownRow(ctx, modelContext.systemPrompt, "markdown agent-itext-md")
    : `<div class="agent-tool-detail">${detailFullscreen("Tool definitions", codeBlockHtml(JSON.stringify(modelContext.tools, null, 2), "tools.json"))}</div>`;
  return `<turbo-frame id="${ids.detailFrame(ctx, key)}">${content}</turbo-frame>`;
}

function renderUserMessage(ctx: AgentRenderContext, user: Extract<TranscriptItem, { type: "user" }>): string {
  const images = user.images.length ? `<div class="agent-user-attachments">${user.images.map((image) => `<img${fullscreenAttributes("attachment", "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="attachment" loading="lazy">`).join("")}</div>` : "";
  const label = user.pending ? "Queued · awaiting consumption" : user.steering ? "Steering" : "";
  const cancel = user.queuedSubmissionId && !ctx.readOnly
    ? `<form method="post" action="${escapeHtml(agentPath(ctx, `/queued-inputs/${encodeURIComponent(user.queuedSubmissionId)}/cancel`))}">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Cancel queued message" } })}</form>` : "";
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble markdown">${label ? `<div class="agent-user-label">${label}${cancel}</div>` : ""}${markdown(ctx, user.text)}${images}</div></div>`);
}

function renderStreamingTextBody(ctx: AgentRenderContext, key: string, text: string, className: string): string {
  const snapshot = ctx.streamingText?.(key, text) ?? renderStreamingMarkdownSnapshot(ctx.workspaceId, text);
  // Live streaming text is owned by its own regions; morphing the row must not blank it.
  const island = ctx.streamingText ? " data-turbo-permanent" : "";
  return `<div class="${className} agent-stream-markdown" data-controller="agent-streaming-text" id="${ids.itemText(ctx, key)}"><div id="${ids.itemTextStable(ctx, key)}"${island}>${snapshot.stableHtml}</div><div id="${ids.itemTextTail(ctx, key)}"${island}>${snapshot.tailHtml}</div></div>`;
}

export function renderTranscriptItem(ctx: AgentRenderContext, item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  if (item.type === "working") return renderWorkingSection(ctx, item);
  const id = ids.item(ctx, item.key);
  let body = "";
  if (item.type === "inherited-context") {
    const label = `Inherited context from ${item.source} · ${item.messageCount} ${item.messageCount === 1 ? "message" : "messages"} · filtered`;
    body = renderLazyTranscriptEntry(ctx, item.key, label);
  } else if (item.type === "user") body = renderUserMessage(ctx, item);
  else if (item.type === "thinking") body = renderThinkingItem(ctx, item);
  else if (item.type === "text") {
    const className = item.final ? "markdown agent-final" : "markdown agent-itext-md";
    body = item.live
      ? transcriptRow(renderStreamingTextBody(ctx, item.key, item.text, className))
      : renderMarkdownRow(ctx, item.text, className);
  } else if (item.type === "tool") body = transcriptRow(renderToolCard(ctx, item.key, item.tool, { ...options, open: options.open || Boolean(ctx.revealTarget && (item.anchor === ctx.revealTarget || item.key === ctx.revealTarget)) }));
  else if (item.type === "extension") body = item.render(ctx);
  else if (item.type === "note") {
    body = item.tone === "summary"
      ? transcriptRow(disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Compaction summary" } }, bodyHtml: `<div class="markdown">${markdown(ctx, item.text)}</div>` }))
      : renderMarkdownRow(ctx, item.text, `agent-note ${escapeHtml(item.tone)}`);
  }
  else body = transcriptRow(`<div class="agent-error">${escapeHtml(item.text)}</div>`);
  return `<div class="agent-item" id="${id}" data-transcript-key="${escapeHtml(item.key)}"${item.anchor ? ` data-transcript-anchor="${escapeHtml(item.anchor)}"` : ""}>${body}</div>`;
}

function renderWorkingContent(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const content = section.items.map((item) => renderTranscriptItem(ctx, item, options)).join("");
  const finished = section.completedAt !== undefined || section.stoppedAt !== undefined;
  return !content && finished ? '<p class="agent-working-empty">No intermediate activity for this turn.</p>' : content;
}

function renderWorkingItems(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const items = renderWorkingContent(ctx, section, options);
  return `<div id="${ids.workingItems(ctx, section.key)}">${items}</div>`;
}

export function workingCommentaryItems(section: WorkingTranscriptItem): TranscriptItem[] {
  if (section.completedAt !== undefined && section.hasFinalAnswer) return [];
  return section.items.filter((item) => item.type === "text");
}

/** Live renderers pass the commentary collection's islands so morphing the turn keeps its rows mounted. */
export function renderWorkingSection(ctx: AgentRenderContext, section: WorkingTranscriptItem, commentaryHtml?: string): string {
  if (section.completedAt !== undefined && section.items.length === 0 && !section.timing) return "";
  const summary = workingSummary(ctx, section);
  const commentary = commentaryContext(ctx);
  commentaryHtml ??= workingCommentaryItems(section).map((item) => renderTranscriptItem(commentary, item)).join("");
  const revealing = Boolean(ctx.revealTarget && section.items.some((item) => item.anchor === ctx.revealTarget || item.key === ctx.revealTarget));
  const attributes = ctx.readOnly ? "" : ctx.inlineWorkingItems ? `data-agent-turn-turn-id-value="${escapeHtml(section.key)}"` : `data-controller="agent-turn" data-agent-turn-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-turn-agent-id-value="${escapeHtml(ctx.agentId)}" data-agent-turn-turn-id-value="${escapeHtml(section.key)}" data-agent-turn-branch-id-value="${escapeHtml(ctx.branchId ?? "")}"${revealing ? ` data-agent-turn-reveal-value="${escapeHtml(ctx.revealTarget!)}"` : ""} data-action="toggle->agent-turn#toggle"`;
  const items = ctx.readOnly || ctx.inlineWorkingItems ? renderWorkingContent(ctx, section) : "";
  return `<div class="agent-working-block" id="${ids.item(ctx, section.key)}">${disclosureHtml({
    element: { attributesHtml: attributes }, summary, open: revealing,
    bodyAttributesHtml: `id="${ids.workingItems(ctx, section.key)}"${ctx.readOnly || ctx.inlineWorkingItems ? "" : ' data-agent-turn-target="items" data-turbo-permanent'}`,
    bodyHtml: items,
  })}<div class="disclosure-content agent-working-commentary" id="${ids.workingItems(commentary, section.key)}">${commentaryHtml}</div></div>`;
}

function workingSummary(ctx: AgentRenderContext, section: WorkingTranscriptItem): DisclosureSummary {
  const steeringCount = section.items.filter((item) => item.type === "user" && item.steering).length;
  const endedAt = section.completedAt ?? section.stoppedAt;
  const active = endedAt === undefined;
  const duration = formatDuration(active ? Date.now() - section.startedAt : section.timing?.elapsedMs ?? (endedAt! - section.startedAt));
  const stateLabel = active ? "Working" : section.completedAt !== undefined ? "Completed" : "Stopped";
  const activityLabel = section.durationUnavailable ? stateLabel : `${stateLabel} · ${duration}`;
  const status = active ? `<i class="status-dot running${ctx.readOnly ? " static" : ""} content-row__status" aria-label="In progress"></i>` : "";
  return { ...transcriptRowContent({ kind: "text", text: activityLabel,
    attributesHtml: active && !ctx.readOnly && !section.durationUnavailable ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${section.startedAt}" data-agent-elapsed-prefix-value="Working · " data-agent-elapsed-format-value="duration"` : undefined,
    textAttributesHtml: active && !ctx.readOnly && !section.durationUnavailable ? 'data-agent-elapsed-target="time"' : undefined,
  }, {
    leadingHtml: status, trailingHtml: `${steeringCount ? `<span class="agent-working-timing">${steeringCount} steering ${steeringCount === 1 ? "message" : "messages"}</span>` : ""}${active ? "" : renderWorkingTiming(section)}`,
  }), attributesHtml: `id="${ids.itemSummaryContent(ctx, section.key)}"` };
}

function renderWorkingTiming(section: Omit<WorkingTranscriptItem, "items">): string {
  if (!section.timing) return "";
  const timing = section.timing;
  const rate = timing.usageComplete && timing.inferenceMs > 0
    ? `${(timing.outputTokens / (timing.inferenceMs / 1000)).toFixed(0)} tps`
    : "tps unavailable";
  const toolDuration = formatDuration(timing.toolMs);
  const toolsLabel = toolDuration === "0s" ? "" : `${toolDuration} tools, `;
  return ` <span class="agent-working-timing" title="Wall-clock tool wait (parallel calls counted once). Output-token count and tokens per inference second, including reported thinking tokens.">(${escapeHtml(toolsLabel)}${timing.usageComplete ? `${formatTokens(timing.outputTokens)} tok` : "tokens unavailable"} @ ${escapeHtml(rate)})</span>`;
}

/** These models write short, final-quality thoughts, so they render in full rather than clamped until expanded. */
function showsFullThinking(model?: ModelRef): boolean {
  return model?.provider === "openai-codex" && /^gpt-5\.(?:5|6)(?:$|[-.])/.test(model.id);
}

function renderThinkingItem(ctx: AgentRenderContext, item: Extract<TranscriptItem, { type: "thinking" }>): string {
  const contentId = escapeHtml(ids.itemText(ctx, item.key));
  const text = escapeHtml(item.text.trimEnd());
  return transcriptRow(showsFullThinking(ctx.model)
    ? `<div class="agent-thinking-text expanded"><span id="${contentId}">${text}</span></div>`
    : `<div class="agent-thinking-text" data-controller="agent-thinking" data-action="click->agent-thinking#expand keydown->agent-thinking#keydown"><span id="${contentId}" data-agent-thinking-target="content">${text}</span><span data-agent-thinking-target="preview" hidden></span><button class="agent-thinking-more" type="button" data-agent-thinking-target="more" tabindex="-1" hidden>...(show more)</button></div>`);
}

export function renderTranscriptItemDetailFrame(ctx: AgentRenderContext, item: TranscriptItem, options: { count?: number } = {}): string {
  const frameId = ids.detailFrame(ctx, item.key);
  let html = "";
  if (item.type === "working") html = renderWorkingItems(ctx, item);
  else if (item.type === "inherited-context") html = `<div class="agent-inherited-content"><p class="agent-inherited-explanation">Copied from ${escapeHtml(item.source)} at spawn time. Only selected user messages, final assistant text, and context summaries are retained; tool activity, reasoning, and intermediate messages are omitted.</p>${item.items.map((child) => renderTranscriptItem(ctx, child)).join("")}</div>`;
  else if (item.type === "tool") html = renderToolDetail(ctx, item.key, item.tool, options.count ?? 100);
  return `<turbo-frame id="${frameId}">${html}</turbo-frame>`;
}
