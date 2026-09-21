// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu). See NOTICE.
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
 * same AI_EDITOR origin for discovery and GenerateAssistantResponse.
 */
export const KIRO_ORIGIN = "AI_EDITOR";

/** Middle-ellipsis truncation: preserve start and end. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
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

// ---- Tool ID normalization ---------------------------------------------

/**
 * Kiro rejects cross-provider tool-use IDs that exceed 64 characters or
 * contain unsupported characters (for example OpenAI Responses IDs such as
 * `call_…|fc_…`). Native Kiro IDs pass through unchanged; other IDs are
 * deterministically remapped so the matching tool result gets the same ID.
 */
const KIRO_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

export function toKiroToolUseId(toolUseId: string): string {
  if (KIRO_TOOL_USE_ID_PATTERN.test(toolUseId)) return toolUseId;
  const digest = createHash("sha256").update(toolUseId).digest("base64url").slice(0, 32);
  return `pi_${digest}`;
}

/**
 * Reorder displaced tool results so each result follows the assistant turn
 * that issued it. Pi can finish concurrent tool calls out of transcript order;
 * Kiro validates the pairing by turn and rejects the interleaved shape.
 */
export function relocateDisplacedToolResults(messages: Message[]): Message[] {
  const out: Message[] = [];
  const pending = [...messages];
  while (pending.length > 0) {
    const msg = pending.shift() as Message;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const assistant = msg as AssistantMessage;
    if (!Array.isArray(assistant.content)) continue;
    for (const block of assistant.content) {
      if (block.type !== "toolCall") continue;
      const id = (block as ToolCall).id;
      const index = pending.findIndex(
        (candidate) =>
          candidate.role === "toolResult" &&
          (candidate as ToolResultMessage).toolCallId === id,
      );
      if (index >= 0) out.push(...pending.splice(index, 1));
    }
  }
  return out;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/**
 * Kiro's runtime accepts a restricted object-oriented JSON Schema dialect for
 * tool inputs. Pi/MCP schemas legitimately use unions (`anyOf`/`oneOf`) and
 * draft metadata (`$schema`), but Kiro recently started rejecting those with
 * the unhelpful REQUEST_BODY_INVALID / "Invalid tool use format" response.
 *
 * This is only a wire-schema adaptation. Pi still executes and validates the
 * original tool definition, so the conversion deliberately favors a schema
 * Kiro can ingest over trying to express every union branch losslessly.
 */
function sanitizeKiroSchema(value: unknown, root = false): JsonObject {
  if (!isJsonObject(value)) {
    return root ? { type: "object", properties: {} } : {};
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    const alternatives = value[unionKey];
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const branches = alternatives.map((branch) => sanitizeKiroSchema(branch));
      const objectBranches = branches.filter(
        (branch) => branch.type === "object" || isJsonObject(branch.properties),
      );

      if (objectBranches.length > 0) {
        const properties: JsonObject = {};
        for (const branch of objectBranches) {
          if (!isJsonObject(branch.properties)) continue;
          for (const [name, schema] of Object.entries(branch.properties)) {
            properties[name] = sanitizeKiroSchema(schema);
          }
        }
        return {
          type: "object",
          properties,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
        };
      }

      const first = branches[0] ?? {};
      const types = uniqueValues(branches.map((branch) => branch.type).filter((type) => typeof type === "string"));
      const enums = branches.flatMap((branch) => {
        if (Array.isArray(branch.enum)) return branch.enum;
        if (Object.prototype.hasOwnProperty.call(branch, "const")) return [branch.const];
        return [];
      });

      // A union of same-typed scalar branches can be represented faithfully.
      // For mixed scalar types Kiro's schema validator is less permissive, so
      // retain the first branch as the safest model-facing approximation.
      if (types.length === 1 && enums.length > 0) {
        return {
          ...first,
          type: types[0],
          enum: uniqueValues(enums),
        };
      }
      return root && first.type !== "object"
        ? { type: "object", properties: {} }
        : first;
    }
  }

  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    // Draft identifiers and references are not resolvable by Kiro's runtime.
    if (key === "$schema" || key === "$id" || key === "$ref" || key === "$defs" || key === "definitions") {
      continue;
    }
    // Convert `const` into the widely-supported enum form.
    if (key === "const") {
      result.enum = [child];
      continue;
    }
    if (key === "properties" && isJsonObject(child)) {
      const properties: JsonObject = {};
      for (const [name, schema] of Object.entries(child)) {
        properties[name] = sanitizeKiroSchema(schema);
      }
      result.properties = properties;
      continue;
    }
    if (key === "items") {
      result.items = Array.isArray(child)
        ? child.map((item) => sanitizeKiroSchema(item))
        : sanitizeKiroSchema(child);
      continue;
    }
    if (key === "additionalProperties" && isJsonObject(child)) {
      result.additionalProperties = sanitizeKiroSchema(child);
      continue;
    }
    if (key === "type" && Array.isArray(child)) {
      const firstType = child.find((type): type is string => typeof type === "string");
      if (firstType) result.type = firstType;
      continue;
    }
    if (key === "required" && Array.isArray(child)) {
      result.required = child.filter((name): name is string => typeof name === "string");
      continue;
    }
    result[key] = child;
  }

  if (root) {
    // Bedrock/Kiro tool inputSchema.json must always be an object, even when
    // a caller's generic JSON Schema describes a scalar or array root.
    result.type = "object";
    if (!isJsonObject(result.properties)) result.properties = {};
    delete result.items;
    delete result.enum;
  }

  return result;
}

export function sanitizeKiroToolSchema(parameters: unknown): Record<string, unknown> {
  return sanitizeKiroSchema(parameters, true);
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description?.trim() || `Tool ${tool.name}`,
      inputSchema: { json: sanitizeKiroToolSchema(tool.parameters) },
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
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            armContent += (block as TextContent).text;
          } else if (block.type === "thinking") {
            armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: toKiroToolUseId(tc.id),
              input: parseToolArgs(tc.arguments),
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
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
