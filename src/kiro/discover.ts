// Dynamic model discovery against Kiro's ListAvailableModels operation.
//
// Uses the legacy q.<region>.amazonaws.com endpoint which your API key
// has access to. The new management.*.kiro.dev endpoint returns 403.

import { log } from "./debug.ts";
import { kiroModels, setDiscoveredModelIds, type KiroModel } from "./models.ts";

/** Discovery blocks startup, so it gets a tight bound of its own. */
const LIST_TIMEOUT_MS = 15_000;

const DEFAULT_REGION = "us-east-1";

function getRegion(): string {
  const raw = globalThis.process?.env?.KIRO_API_REGION;
  const region = typeof raw === "string" ? raw.trim() : "";
  return region || DEFAULT_REGION;
}

/** Shape of the subset of ListAvailableModels we consume. */
interface ApiModel {
  modelId: string;
  modelName?: string;
  description?: string;
  supportedInputTypes?: string[];
  rateMultiplier?: number;
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
}

interface ListResponse {
  defaultModel?: ApiModel;
  models?: ApiModel[];
}

function buildUserAgent(): string {
  const mid = crypto.randomUUID().replace(/-/g, "");
  return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
}

/** Static per-model behavior flags the API does not report. */
const BEHAVIOR_BY_KIRO_ID: Record<string, Partial<KiroModel>> = Object.fromEntries(
  kiroModels.map((m) => [
    m.id.replace(/(\d)-(\d)/g, "$1.$2"),
    {
      ...(m.reasoningHidden ? { reasoningHidden: true } : {}),
      ...(m.firstTokenTimeout ? { firstTokenTimeout: m.firstTokenTimeout } : {}),
    },
  ]),
);

/** Convert a Kiro dot-form ID to pi's dash form (4.6 → 4-6). */
function toPiId(kiroId: string): string {
  return kiroId.replace(/(\d)\.(\d)/g, "$1-$2");
}

function toKiroModel(api: ApiModel, baseUrl: string): KiroModel {
  const piId = toPiId(api.modelId);
  const types = api.supportedInputTypes ?? ["TEXT"];
  const input: ("text" | "image")[] = types.some((t) => t.toUpperCase() === "IMAGE")
    ? ["text", "image"]
    : ["text"];

  return {
    id: piId,
    name: api.modelName ?? piId,
    api: "kiro-api",
    provider: "kiro",
    baseUrl,
    reasoning: true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: api.tokenLimits?.maxInputTokens ?? 200_000,
    maxTokens: api.tokenLimits?.maxOutputTokens ?? 8_192,
    ...BEHAVIOR_BY_KIRO_ID[api.modelId],
  };
}

/**
 * Ask Kiro which models this API key may use. Throws on any failure —
 * callers must not substitute a static list (see module header).
 */
export async function discoverKiroModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<KiroModel[]> {
  const region = getRegion();
  const baseUrl = `https://q.${region}.amazonaws.com/`;
  const ua = buildUserAgent();
  const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  log.debug("discover.request", { baseUrl, origin: "AI_EDITOR" });

  // ListAvailableModels is an AWS JSON RPC operation on the service root.
  // It is not a REST GET at /ListAvailableModels.
  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        tokentype: "API_KEY",
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
        "x-amzn-codewhisperer-optout": "true",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "x-amz-user-agent": ua,
        "user-agent": ua,
      },
      body: JSON.stringify({ origin: "AI_EDITOR" }),
      signal: combined,
    });
  } catch (err) {
    const reason = timeout.aborted
      ? `timed out after ${LIST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`Kiro model discovery failed: ${reason}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      detail = "";
    }
    log.debug("discover.error", { url: baseUrl, status: response.status, body: detail });
    throw new Error(
      `Kiro model discovery failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const payload = (await response.json()) as ListResponse;
  const apiModels = payload.models ?? [];
  const defaultModel = payload.defaultModel;

  if (apiModels.length === 0) {
    throw new Error(
      "Kiro model discovery returned no models for this API key. " +
        "The key may lack model entitlements, or be scoped to another region.",
    );
  }

  // Use runtime endpoint for inference
  const runtimeBaseUrl = `https://runtime.${region}.kiro.dev`;

  const discovered = apiModels
    .filter((m) => typeof m.modelId === "string" && m.modelId.length > 0)
    .map((m) => toKiroModel(m, runtimeBaseUrl));

  // Gate outbound requests on what discovery actually returned
  setDiscoveredModelIds(discovered.map((m) => m.id.replace(/(\d)-(\d)/g, "$1.$2")));

  log.info("discover.ok", {
    count: discovered.length,
    discovered: discovered.map((m) => m.id),
    defaultModel: defaultModel?.modelId,
  });

  return discovered;
}
