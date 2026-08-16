import { readFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { withTimeout } from "./with-timeout";
import { FREE_MODELS, MODEL_OPTIONS } from "./models";

function resolveKey(envVarName: string): string | undefined {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv !== "your_key_here") {
    return fromEnv;
  }

  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    const regex = new RegExp(`^${envVarName}=(.+)$`, "m");
    const match = content.match(regex);
    const key = match?.[1]?.trim();
    if (key && key !== "your_key_here") {
      return key;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Free-tier-only OpenRouter fallback chain, tried in order after each agent's
// preferred model. Every model here is a `:free` model (or the `openrouter/free`
// alias, which auto-routes to a free model), so inference cost stays $0.00 as
// long as OpenRouter answers.
const OPENROUTER_DEFAULT_CHAIN = [...FREE_MODELS.fallbacks];

// BTL (Runtime, api.rntm.sh) fallback chain — a cheap, per-use OpenAI-compatible
// gateway used only when the OpenRouter free chain is unavailable or exhausted.
// It is billed per-use (well below OpenRouter's paid tier), so a fallback run
// shows a small non-zero cost in the meter rather than the usual $0.00.
const BTL_BASE_URL = "https://api.rntm.sh/v1";
const BTL_DEFAULT_CHAIN = ["btl-2", "deepseek-v4-flash"];

// Inner cap per model attempt in the fallback chain, shorter than the outer
// per-agent timeouts (extractor 60s, others 45s): a hung model is abandoned
// and the chain proceeds to the next model instead of burning the whole
// outer budget. A timeout error has no `status`, so isRetriableModelError
// treats it as retriable and the chain advances.
// Raised from 25s to 40s (2026-08): the falsifier's full-document self-
// verification feature made its prompt ~4x larger (~104k chars in testing),
// pushing slow first responses past the old 25s cap — the chain then fell
// through to the next model (or the paid fallback gateway) instead of
// completing. Note the budget math: with the falsifier's 60s outer cap, a
// first-attempt timeout now leaves ~20s of headroom for a fallback attempt
// (see falsifier.ts FALSIFIER_CALL_TIMEOUT_MS if that needs revisiting).
const ATTEMPT_TIMEOUT_MS = 40_000;

export function getOpenRouterClient(): OpenAI | null {
  const apiKey = resolveKey("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://paperagents.app",
      "X-Title": "PaperAgents",
    },
  });
}

export function getBtlClient(): OpenAI | null {
  const apiKey = resolveKey("RUNTIME_API_KEY");
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: BTL_BASE_URL,
  });
}

export function getRuntimeClient(): OpenAI {
  const openRouter = getOpenRouterClient();
  if (openRouter) return openRouter;
  const btl = getBtlClient();
  if (btl) return btl;
  throw new Error("Neither OPENROUTER_API_KEY nor RUNTIME_API_KEY is configured.");
}

function getModelChain(preferred: string, defaultChain: string[]): string[] {
  const configured = process.env.RUNTIME_MODEL_CHAIN;
  const chain = configured
    ? configured
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultChain;

  return [preferred, ...chain].filter(
    (model, i, arr) => arr.indexOf(model) === i
  );
}

export interface RuntimeResult {
  content: string;
  usage: any;
  requestId: string | null;
  cacheTier: string | null;
  benchmarkCost: number | null;
  customerCharge: number | null;
  saved: number | null;
  model: string;
  provider: "openrouter" | "btl";
}

async function callOpenRouter(
  client: OpenAI,
  model: string,
  params: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    maxTokens?: number;
    responseFormat?: "json_object";
  }
): Promise<RuntimeResult> {
  const requestOptions: any = {
    model,
    messages: params.messages,
    usage: { include: true },
  };

  // Per-model overrides (e.g. reasoning control on the free reasoning models)
  // — see MODEL_OPTIONS in models.ts. `openrouter/free` has none by design.
  const modelOptions = MODEL_OPTIONS[model];
  if (modelOptions) {
    Object.assign(requestOptions, modelOptions);
  }

  if (params.maxTokens !== undefined) {
    requestOptions.max_tokens = params.maxTokens;
  }

  if (params.responseFormat === "json_object") {
    requestOptions.response_format = { type: "json_object" };
  }

  const { data: response, response: rawResponse } = await client.chat.completions
    .create(requestOptions)
    .withResponse();

  const content = response.choices[0]?.message?.content ?? "";
  const usage = response.usage ?? null;
  const cost = usage && (usage as any).cost !== undefined ? (usage as any).cost : null;

  const headers = rawResponse.headers;
  const requestId = headers.get("x-request-id");

  return {
    content,
    usage,
    requestId,
    cacheTier: null,
    benchmarkCost: cost,
    customerCharge: cost,
    saved: 0,
    model: response.model ?? model,
    provider: "openrouter",
  };
}

async function callBtlRuntime(
  client: OpenAI,
  model: string,
  params: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    maxTokens?: number;
    promptCacheKey?: string;
    responseFormat?: "json_object";
  }
): Promise<RuntimeResult> {
  const requestOptions: any = {
    model,
    messages: params.messages,
  };

  if (params.maxTokens !== undefined) {
    requestOptions.max_tokens = params.maxTokens;
  }

  if (params.promptCacheKey) {
    requestOptions.metadata = { prompt_cache_key: params.promptCacheKey };
  }

  if (params.responseFormat === "json_object") {
    requestOptions.response_format = { type: "json_object" };
  }

  const { data: response, response: rawResponse } = await client.chat.completions
    .create(requestOptions)
    .withResponse();

  const content = response.choices[0]?.message?.content ?? "";
  const usage = response.usage ?? null;

  const headers = rawResponse.headers;
  const requestId = headers.get("x-request-id");
  const cacheTier = headers.get("x-btl-cache-tier");
  const benchmarkCostRaw = headers.get("x-btl-benchmark-cost");
  const customerChargeRaw = headers.get("x-btl-customer-charge");
  const savedRaw = headers.get("x-btl-saved");

  const parseFloatOrNull = (raw: string | null): number | null => {
    if (raw === null || raw === undefined) return null;
    const value = parseFloat(raw);
    return Number.isNaN(value) ? null : value;
  };

  return {
    content,
    usage,
    requestId,
    cacheTier,
    benchmarkCost: parseFloatOrNull(benchmarkCostRaw),
    customerCharge: parseFloatOrNull(customerChargeRaw),
    saved: parseFloatOrNull(savedRaw),
    model: response.model ?? model,
    provider: "btl",
  };
}

function isRetriableModelError(error: any): boolean {
  const status = error?.status;
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return false;
  }
  return true;
}

export async function callRuntime(params: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  promptCacheKey?: string;
  responseFormat?: "json_object";
}): Promise<RuntimeResult> {
  const openRouterClient = getOpenRouterClient();
  const btlClient = getBtlClient();

  if (!openRouterClient && !btlClient) {
    throw new Error(
      "Neither OPENROUTER_API_KEY nor RUNTIME_API_KEY is configured — add them to .env.local"
    );
  }

  let openRouterError: Error | null = null;

  // ── Primary: OpenRouter free-tier chain ($0.00) ──────────────────────────
  if (openRouterClient) {
    const preferredModel = params.model === "deepseek-v4-flash" ? "deepseek/deepseek-chat" : params.model;
    const chain = getModelChain(preferredModel, OPENROUTER_DEFAULT_CHAIN);

    for (const model of chain) {
      try {
        const openRouterParams = {
          messages: params.messages,
          maxTokens: params.maxTokens,
          responseFormat: params.responseFormat,
        };
        const result = await withTimeout(
          callOpenRouter(openRouterClient, model, openRouterParams),
          ATTEMPT_TIMEOUT_MS,
          `openrouter/${model}`
        );
        console.log(`[runtime-client] OpenRouter responded via ${result.model}`);
        return result;
      } catch (error: any) {
        openRouterError = error;
        if (!isRetriableModelError(error)) {
          break;
        }
      }
    }
  }

  // ── Fallback: BTL Runtime gateway (cheap per-use alternative) ────────────
  if (btlClient) {
    if (openRouterClient) {
      console.warn(
        `[runtime-client] OpenRouter failed, falling back to BTL Runtime: ${openRouterError?.message || openRouterError}`
      );
    }

    // OpenRouter `:free` model IDs (and the legacy deepseek/deepseek-chat
    // default) don't exist on the BTL gateway — map them to its default model
    // so the fallback chain doesn't burn an attempt on a nonexistent model.
    const preferredModel =
      params.model.endsWith(":free") || params.model === "deepseek/deepseek-chat"
        ? "deepseek-v4-flash"
        : params.model;
    const chain = getModelChain(preferredModel, BTL_DEFAULT_CHAIN);

    let btlError: Error | null = null;
    for (const model of chain) {
      try {
        const result = await withTimeout(
          callBtlRuntime(btlClient, model, params),
          ATTEMPT_TIMEOUT_MS,
          `btl/${model}`
        );
        console.log(`[runtime-client] BTL Runtime responded via ${result.model}`);
        return result;
      } catch (error: any) {
        btlError = error;
        if (!isRetriableModelError(error)) {
          break;
        }
      }
    }

    if (openRouterError) {
      throw new Error(
        `Both providers failed.\nOpenRouter error: ${openRouterError.message}\nBTL Runtime error: ${btlError?.message || btlError}`
      );
    } else {
      throw btlError ?? new Error("BTL Runtime attempt failed");
    }
  }

  throw openRouterError ?? new Error("All provider attempts failed");
}
