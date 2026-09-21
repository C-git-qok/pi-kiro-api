// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu) and adapted for
// API-key auth. See NOTICE.
//
// pi Message[] → Kiro history transformation.
//
// Kiro uses an alternating userInputMessage/assistantResponseMessage shape.
// We merge consecutive user messages (and tool-result entries) into the
// preceding user message to satisfy alternation without synthetic padding —
// the padding used to cause echo-loop bugs downstream.

import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

/** Drop assistant messages that ended in error/aborted — partial turns
 *  shouldn't be replayed. */
export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter(
    (msg) =>
      msg.role !== "assistant" ||
      (msg.stopReason !== "error" && msg.stopReason !== "aborted"),
  );
}

// ---- Kiro wire format --------------------------------------------------

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: string;
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

// ---- Utilities ---------------------------------------------------------

export const TOOL_RESULT_LIMIT = 250_000;

/**
 * Origin tag sent on every userInputMessage. The API-key provider uses the
 * same `AI_EDITOR` origin for discovery and GenerateAssistantResponse.
 */
export const KIRO_ORIGIN = "AI_EDITOR";

/** Middle-ellipsis truncation: preserve start and end. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

// ---- Tool ID normalization -----------------------------------------------

/**
 * Kiro rejects tool-use IDs that contain `|` or exceed 64 chars
 * (`REQUEST_BODY_INVALID`). Cross-provider IDs (e.g. OpenAI Responses
 * `call_…|fc_…`) must be normalized. Native Kiro IDs pass through unchanged.
 */
const KIRO_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

export function toKiroToolUseId(toolUseId: string): string {
  if (KIRO_TOOL_USE_ID_PATTERN.test(toolUseId)) return toolUseId;
  const digest = createHash("sha256").update(toolUseId).digest("base64url").slice(0, 32);
  return `pi_${digest}`;
}

// ---- Tool result relocation ----------------------------------------------

/**
 * Reorder messages so that each toolResult immediately follows its
 * corresponding assistant turn. Concurrent tool execution can interleave
 * results across turns; this is a pure reorder (no generate/discard).
 */
export function relocateDisplacedToolResults(messages: Message[]): Message[] {
  const out: Message[] = [];
  const pending = [...messages];
  while (pending.length > 0) {
    const msg = pending.shift() as Message;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const am = msg as AssistantMessage;
    if (!Array.isArray(am.content)) continue;
    for (const block of am.content) {
      if (block.type !== "toolCall") continue;
      const id = (block as ToolCall).id;
      const at = pending.findIndex(
        (p) => p.role === "toolResult" && (p as ToolResultMessage).toolCallId === id,
      );
      if (at >= 0) out.push(...pending.splice(at, 1));
    }
  }
  return out;
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") {
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((c) => {
      if (c.type === "text") return (c as TextContent).text;
      if (c.type === "thinking") return (c as ThinkingContent).thinking;
      return "";
    })
    .join("");
}

/**
 * Parse tool-call arguments defensively. Historical messages (including
 * those from other providers via cross-provider handoff) may carry args
 * that aren't valid JSON. Fall back to {} rather than crashing the stream.
 */
export function parseToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  if (typeof input !== "string") return {};
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters as Record<string, unknown> },
    },
  }));
}

export function convertImagesToKiro(
  images: Array<{ mimeType: string; data: string }>,
): KiroImage[] {
  return images.map((img) => ({
    format: img.mimeType.split("/")[1] || "png",
    source: { bytes: img.data },
  }));
}

// ---- History builder ---------------------------------------------------

/**
 * Split messages into history + current turn. The current turn is the trailing
 * user message (+ any following tool results) or the trailing assistant
 * message when it carries tool calls. Everything before goes into history.
 *
 * System prompt is prepended to the first user message in history, not sent
 * as a separate field (Kiro doesn't have one).
 */
export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;

  // Walk backwards to find where the "current turn" begins.
  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx]?.role === "toolResult") {
    currentMsgStartIdx--;
  }
  const anchor = messages[currentMsgStartIdx];
  if (anchor?.role === "assistant") {
    const hasToolCall =
      Array.isArray(anchor.content) && anchor.content.some((b) => b.type === "toolCall");
    if (!hasToolCall) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (!msg) continue;

    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content,
        modelId,
        origin: KIRO_ORIGIN,
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };

      const prev = history[history.length - 1];
      if (prev?.userInputMessage) {
        // Merge into previous user message — Kiro alternates user/assistant.
        const prevUim = prev.userInputMessage;
        prevUim.content =
          prevUim.content && uim.content
            ? `${prevUim.content}\n\n${uim.content}`
            : prevUim.content || uim.content;
        if (uim.images) {
          prevUim.images = [...(prevUim.images ?? []), ...uim.images];
        }
      } else {
        history.push({ userInputMessage: uim });
      }
      continue;
    }

    if (msg.role === "assistant") {
      let armContent = "";
      let armHadBlocks = false;
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            armContent += (block as TextContent).text;
            armHadBlocks = true;
          } else if (block.type === "thinking") {
            // Do not serialize reasoning into Kiro assistant text history.
            armHadBlocks = true;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: toKiroToolUseId(tc.id),
              input: parseToolArgs(tc.arguments),
            });
            armHadBlocks = true;
          }
        }
      }
      if (!armContent && armToolUses.length === 0 && !armHadBlocks) continue;
      history.push({
        assistantResponseMessage: {
          content: armContent,
          ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
        },
      });
      continue;
    }

    // toolResult — batch consecutive results
    const trMsg = msg as ToolResultMessage;
    const toolResults: KiroToolResult[] = [
      {
        content: [{ text: truncate(getContentText(msg), TOOL_RESULT_LIMIT) }],
        status: trMsg.isError ? "error" : "success",
        toolUseId: toKiroToolUseId(trMsg.toolCallId),
      },
    ];
    const trImages: ImageContent[] = [];
    if (Array.isArray(trMsg.content)) {
      for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
    }

    let j = i + 1;
    while (j < historyMessages.length && historyMessages[j]?.role === "toolResult") {
      const next = historyMessages[j] as ToolResultMessage;
      toolResults.push({
        content: [{ text: truncate(getContentText(next), TOOL_RESULT_LIMIT) }],
        status: next.isError ? "error" : "success",
        toolUseId: toKiroToolUseId(next.toolCallId),
      });
      if (Array.isArray(next.content)) {
        for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
      }
      j++;
    }
    i = j - 1;

    const prev = history[history.length - 1];
    if (prev?.userInputMessage) {
      // Merge tool results into previous user message to preserve alternation.
      if (trImages.length > 0) {
        prev.userInputMessage.images = [
          ...(prev.userInputMessage.images ?? []),
          ...convertImagesToKiro(trImages),
        ];
      }
      if (!prev.userInputMessage.userInputMessageContext) {
        prev.userInputMessage.userInputMessageContext = {};
      }
      prev.userInputMessage.userInputMessageContext.toolResults = [
        ...(prev.userInputMessage.userInputMessageContext.toolResults ?? []),
        ...toolResults,
      ];
    } else {
      history.push({
        userInputMessage: {
          content: "",
          modelId,
          origin: KIRO_ORIGIN,
          ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
          userInputMessageContext: { toolResults },
        },
      });
    }
  }

  return { history, systemPrepended, currentMsgStartIdx };
}
