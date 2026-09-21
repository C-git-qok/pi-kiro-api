// Dynamic model discovery against Kiro's ListAvailableModels operation.
//
// Uses the legacy q.<region>.amazonaws.com endpoint which your API key
// has access to. The new management.*.kiro.dev endpoint returns 403.

import { createHash } from "node:crypto";
import { log } from "./debug.ts";
import { KIRO_ORIGIN } from "./transform.ts";
import { kiroModels, setDiscoveredModelIds, type KiroModel } from "./models.ts";

/** Discovery blocks startup, so it gets a tight bound of its own. */
const LIST_TIMEOUT_MS = 15_000;
const LIST_TARGET = "AmazonCodeWhispererService.ListAvailableModels";

/**
 * Child pi sessions load extensions independently. Keep the catalog in a
 * process-global cache so every child does not repeat the same discovery RPC.
 * The global store is intentional: pi's extension loader disables jiti's
 * module cache, so module-local state is not sufficient for this use case.
 */
const DISCOVERY_CACHE_TTL_MS = 5 * 60_000;
const DISCOVERY_STATE_KEY = "__pi_kiro_api_discovery_state_v1__";

interface DiscoveryCacheEntry {
  models: KiroModel[];
  expiresAt: number;
}

interface DiscoveryState {
  cache: Map<string, DiscoveryCacheEntry>;
  inFlight: Map<string, Promise<KiroModel[]>>;
}

function getDiscoveryState(): DiscoveryState {
  const globalStore = globalThis as typeof globalThis & {
    __pi_kiro_api_discovery_state_v1__?: DiscoveryState;
  };

  if (!globalStore[DISCOVERY_STATE_KEY]) {
    globalStore[DISCOVERY_STATE_KEY] = {
      cache: new Map(),
      inFlight: new Map(),
    };
  }

  return globalStore[DISCOVERY_STATE_KEY]!;
}

/** Do not retain or log the API key itself as part of the cache key. */
function makeDiscoveryKey(apiKey: string, region: string): string {
  const keyFingerprint = createHash("sha256").update(apiKey).digest("hex");
  return `${region}:${keyFingerprint}`;
}

function applyDiscoveredModels(models: KiroModel[]): void {
  setDiscoveredModelIds(models.map((m) => m.id.replace(/(\d)-(\d)/g, "$1.$2")));
}

/**
 * Wait for a shared discovery without allowing one caller to abort the
 * underlying request for all sibling sessions.
 */
async function waitForDiscovery<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Kiro model discovery aborted");

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Kiro model discovery aborted"));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

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
 * Long-context variants are a client-side convention. ListAvailableModels
 * confirms the base model, but does not return the `-1m` companion IDs.
 * Derive only from confirmed bases so org/entitlement scoping remains intact.
 */
const ONE_M_SUFFIX = "-1m";
const ONE_M_CONTEXT = 1_000_000;

function deriveLongContextVariants(discovered: KiroModel[], baseUrl: string): KiroModel[] {
  const present = new Set(discovered.map((m) => m.id));
  const variants: KiroModel[] = [];

  for (const staticModel of kiroModels) {
    if (!staticModel.id.endsWith(ONE_M_SUFFIX) || present.has(staticModel.id)) continue;
    const baseId = staticModel.id.slice(0, -ONE_M_SUFFIX.length);
    const base = discovered.find((m) => m.id === baseId);
    if (!base) continue;

    variants.push({
      ...base,
      baseUrl,
      id: staticModel.id,
      name: `${base.name} (1M)`,
      contextWindow: ONE_M_CONTEXT,
      ...BEHAVIOR_BY_KIRO_ID[staticModel.id.replace(/(\d)-(\d)/g, "$1.$2")],
    });
  }

  return variants;
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
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Kiro model discovery aborted");
  }

  const state = getDiscoveryState();
  const cacheKey = makeDiscoveryKey(apiKey, region);
  const now = Date.now();
  const cached = state.cache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    applyDiscoveredModels(cached.models);
    log.debug("discover.cache_hit", { region, count: cached.models.length });
    return cached.models;
  }

  if (cached) state.cache.delete(cacheKey);

  let request = state.inFlight.get(cacheKey);
  if (request) {
    log.debug("discover.inflight_join", { region });
  } else {
    request = fetchDiscoveredModels(apiKey, region).then((models) => {
      state.cache.set(cacheKey, {
        models,
        expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
      });
      return models;
    });
    state.inFlight.set(cacheKey, request);
    const cleanup = () => {
      if (state.inFlight.get(cacheKey) === request) state.inFlight.delete(cacheKey);
    };
    void request.then(cleanup, cleanup);
  }

  const discovered = await waitForDiscovery(request, signal);
  applyDiscoveredModels(discovered);
  return discovered;
}

async function fetchDiscoveredModels(apiKey: string, region: string): Promise<KiroModel[]> {
  const baseUrl = `https://q.${region}.amazonaws.com/`;
  const ua = buildUserAgent();
  const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);

  log.debug("discover.request", { baseUrl, origin: KIRO_ORIGIN });

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
        "X-Amz-Target": LIST_TARGET,
        "x-amzn-codewhisperer-optout": "true",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "amz-sdk-request": "attempt=1; max=1",
        "x-amz-user-agent": ua,
        "user-agent": ua,
      },
      body: JSON.stringify({ origin: KIRO_ORIGIN }),
      signal: timeout,
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

  const discovered = apiModels
    .filter((m) => typeof m.modelId === "string" && m.modelId.length > 0)
    .map((m) => toKiroModel(m, baseUrl));
  const models = [...discovered, ...deriveLongContextVariants(discovered, baseUrl)];

  log.info("discover.ok", {
    count: models.length,
    discovered: discovered.map((m) => m.id),
    derived: models.length - discovered.length,
    defaultModel: defaultModel?.modelId,
  });

  return models;
}
