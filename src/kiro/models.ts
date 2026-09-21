// Vendored from pi-kiro (MIT, Copyright (c) 2026 Hongyi Lyu) and extended for
// API-key auth. See NOTICE.
//
// Kiro model catalog + ID conversion + region mapping.
//
// Model IDs use dashes in pi (e.g. "claude-sonnet-4-6") and dots in the Kiro
// API (e.g. "claude-sonnet-4.6"). Everything in this file is in the pi/dash
// form except KIRO_MODEL_IDS and the output of resolveKiroModel.

/**
 * Static snapshot of Kiro API IDs (dot form). No longer the source of truth:
 * discover.ts queries ListAvailableModels at startup and that result gates
 * requests. This set remains only as a fallback for `resolveKiroModel` when
 * discovery has not run, and as the source of the client-side behavior flags
 * and `-1m` variants the API does not report. Expect it to lag the service.
 */
export const KIRO_MODEL_IDS = new Set<string>([
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-1m",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "kimi-k2.5",
  "minimax-m2.1",
  "minimax-m2.5",
  "glm-4.7",
  "glm-4.7-flash",
  "qwen3-coder-next",
  "agi-nova-beta-1m",
  "qwen3-coder-480b",
  "auto",
]);

/**
 * IDs confirmed by ListAvailableModels at startup (dot form). Populated by
 * discover.ts. Discovery is authoritative for what this key may use, so once
 * it has run these IDs — not the static snapshot above — gate requests.
 */
const discoveredModelIds = new Set<string>();

/** Record the dot-form IDs discovery accepted. */
export function setDiscoveredModelIds(kiroIds: Iterable<string>): void {
  discoveredModelIds.clear();
  for (const id of kiroIds) discoveredModelIds.add(id);
}

/** Convert pi's dash form to the Kiro API's dot form (e.g. 4-6 → 4.6). */
export function resolveKiroModel(modelId: string): string {
  const kiroId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  // Prefer the discovered set; fall back to the static snapshot only when
  // discovery has not run (e.g. a direct streamKiro call in a test).
  const known = discoveredModelIds.size > 0 ? discoveredModelIds : KIRO_MODEL_IDS;
  if (!known.has(kiroId)) {
    throw new Error(`Unknown Kiro model ID: ${modelId}`);
  }
  return kiroId;
}

// The former MODELS_BY_REGION allowlist is gone. ListAvailableModels is
// queried against the regional endpoint with the caller's key, so the server
// already scopes the result by region, org, and entitlement — a hand-kept
// region map could only drift out of agreement with it.

/**
 * Legacy fallback base URL — only used when discovery has not run.
 * At startup, discover.ts queries the management API and each model
 * receives its own runtime.*.kiro.dev baseUrl.
 */
const FALLBACK_BASE_URL = "https://runtime.us-east-1.kiro.dev";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Fields every Kiro model shares. Spread into each literal below. */
const KIRO_DEFAULTS = {
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl: FALLBACK_BASE_URL,
  cost: ZERO_COST,
} as const;

type Input = ("text" | "image")[];
const MULTIMODAL: Input = ["text", "image"];
const TEXT_ONLY: Input = ["text"];

export interface KiroModel {
  id: string;
  name: string;
  api: "kiro-api";
  provider: "kiro";
  baseUrl: string;
  reasoning: boolean;
  input: Input;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** Optional per-model override for the first-token timeout (ms). */
  firstTokenTimeout?: number;
  /**
   * Upstream hides reasoning from clients — no `<thinking>` tags, no native
   * reasoning event. We emit a redacted ThinkingContent shim so downstream
   * UIs can surface a "reasoning hidden" marker. Also disables the
   * `<thinking_mode>` system-prompt directive, which the provider ignores.
   *
   * Applies to Claude Opus 4.7, which flipped Anthropic's adaptive-thinking
   * default from "summarized" to "omitted".
   * See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
   */
  reasoningHidden?: boolean;
  /** Profile ARN from GetProfile — required by runtime.*.kiro.dev. */
  profileArn?: string;
}

export const kiroModels: KiroModel[] = [
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    reasoningHidden: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    firstTokenTimeout: 180_000,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-6-1m",
    name: "Claude Opus 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-6-1m",
    name: "Claude Sonnet 4.6 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4-5-1m",
    name: "Claude Sonnet 4.5 (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "deepseek-3-2",
    name: "DeepSeek 3.2",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "minimax-m2-1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7",
    name: "GLM 4.7",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "glm-4-7-flash",
    name: "GLM 4.7 Flash",
    reasoning: false,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    reasoning: true,
    input: TEXT_ONLY,
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    ...KIRO_DEFAULTS,
    id: "agi-nova-beta-1m",
    name: "AGI Nova Beta (1M)",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    ...KIRO_DEFAULTS,
    id: "auto",
    name: "Auto",
    reasoning: true,
    input: MULTIMODAL,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
];
