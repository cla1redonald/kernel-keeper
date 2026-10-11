import type { AiCallOptions } from "./types.js";

/**
 * Raw-fetch client for the Anthropic Messages API. Zero-dep by design.
 *
 * Sonnet-5 specifics this client encodes (verified against API docs, 2026-07):
 * - NEVER send temperature/top_p/top_k - the model rejects them.
 * - `thinking` is omitted → adaptive thinking runs by default and the response
 *   content array may START with thinking blocks; always read the LAST text block.
 * - Structured outputs via `output_config.format` (json_schema) - the API
 *   guarantees schema-valid JSON on the happy path.
 * - Check `stop_reason` BEFORE parsing: "max_tokens" means a truncated draft
 *   (fail the cluster - never write half a proposal), "refusal" likewise.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const RETRYABLE = new Set([429, 500, 529]);

export class AiError extends Error {
  status: number;
  apiType: string;
  requestId: string | null;
  retryable: boolean;
  constructor(message: string, status: number, apiType: string, requestId: string | null) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.apiType = apiType;
    this.requestId = requestId;
    this.retryable = RETRYABLE.has(status) || status === 0;
  }
}

export interface MessagesRequest {
  system: string;
  user: string;
  /** JSON schema the response must conform to (flat, additionalProperties:false). */
  schema: object;
  maxTokens: number;
}

export interface MessagesResult {
  json: unknown;
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract the LAST text block - adaptive thinking may prepend thinking blocks. */
export function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

export async function createMessage(req: MessagesRequest, opts: AiCallOptions): Promise<MessagesResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const sleep = opts.sleepFn ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: req.maxTokens,
    // cache_control on the system block: every cluster in a run shares the prefix.
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.user }],
    output_config: { format: { type: "json_schema", schema: req.schema } },
    // No temperature/top_p/top_k (rejected by sonnet-5); no thinking key (adaptive default).
  });

  let lastErr: AiError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network / timeout - retryable, no request id. Never include headers (the key) in errors.
      lastErr = new AiError(err instanceof Error ? err.message : String(err), 0, "network_error", null);
      if (attempt < maxRetries) await sleep(backoffMs(attempt, null));
      continue;
    }

    if (!res.ok) {
      let apiType = "unknown";
      let message = `HTTP ${res.status}`;
      let requestId: string | null = res.headers.get("request-id");
      try {
        const payload = (await res.json()) as { error?: { type?: string; message?: string }; request_id?: string };
        apiType = payload.error?.type ?? apiType;
        message = payload.error?.message ?? message;
        requestId = payload.request_id ?? requestId;
      } catch {
        /* non-JSON error body */
      }
      lastErr = new AiError(`${message} (request_id: ${requestId ?? "n/a"})`, res.status, apiType, requestId);
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw lastErr;
    }

    const payload = (await res.json()) as {
      content?: unknown;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const stopReason = payload.stop_reason ?? "unknown";
    if (stopReason === "max_tokens" || stopReason === "refusal") {
      // Truncated or refused draft - the caller fails this cluster; never half a proposal.
      throw new AiError(`generation ended with stop_reason=${stopReason}`, 200, stopReason, null);
    }
    const text = lastTextBlock(payload.content);
    if (text === null) throw new AiError("response contained no text block", 200, "empty_response", null);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiError("response text was not valid JSON", 200, "bad_json", null);
    }
    return {
      json,
      stopReason,
      usage: {
        input_tokens: payload.usage?.input_tokens ?? 0,
        output_tokens: payload.usage?.output_tokens ?? 0,
      },
    };
  }
  throw lastErr ?? new AiError("exhausted retries", 0, "network_error", null);
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return s * 1000;
  }
  const base = 1000 * 2 ** attempt;
  return base + Math.floor(base * 0.25 * pseudoJitter(attempt));
}

/** Deterministic "jitter" - keeps retry tests reproducible without Math.random. */
function pseudoJitter(attempt: number): number {
  return ((attempt * 2654435761) % 100) / 100;
}

/** Bounded-concurrency runner (hand-rolled semaphore - zero-dep). */
export async function runWithConcurrency<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i] as () => Promise<T>;
      try {
        results[i] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}
