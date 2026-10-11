import { describe, expect, it } from "vitest";
import { createMessage, lastTextBlock, runWithConcurrency, AiError } from "../src/ai/client.js";

const SCHEMA = { type: "object", additionalProperties: false, required: ["x"], properties: { x: { type: "string" } } };
const REQ = { system: "sys", user: "usr", schema: SCHEMA, maxTokens: 100 };
const noSleep = async (): Promise<void> => {};

function ok(json: object, stop = "end_turn", extraBlocks: object[] = []): Response {
  return new Response(
    JSON.stringify({
      content: [...extraBlocks, { type: "text", text: JSON.stringify(json) }],
      stop_reason: stop,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );
}

function apiError(status: number, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message: `${type} happened` }, request_id: "req_123" }), { status, headers });
}

describe("ai client", () => {
  it("parses the LAST text block (adaptive thinking prepends blocks)", async () => {
    const fetchFn = (async () => ok({ x: "real" }, "end_turn", [{ type: "thinking", thinking: '{"x":"decoy"}' }])) as unknown as typeof fetch;
    const res = await createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep });
    expect(res.json).toEqual({ x: "real" });
  });

  it("lastTextBlock returns null when no text block exists", () => {
    expect(lastTextBlock([{ type: "thinking", thinking: "..." }])).toBeNull();
    expect(lastTextBlock(undefined)).toBeNull();
  });

  it("never sends sampling params or a thinking key; sets cache_control on system", async () => {
    let sentBody = "";
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body);
      return ok({ x: "y" });
    }) as unknown as typeof fetch;
    await createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep });
    const body = JSON.parse(sentBody);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("retries 429 honouring retry-after, then succeeds", async () => {
    const waits: number[] = [];
    let call = 0;
    const fetchFn = (async () => (call++ === 0 ? apiError(429, "rate_limit_error", { "retry-after": "2" }) : ok({ x: "y" }))) as unknown as typeof fetch;
    const res = await createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: async (ms) => void waits.push(ms) });
    expect(res.json).toEqual({ x: "y" });
    expect(waits).toEqual([2000]); // retry-after seconds → ms
  });

  it("retries 529/500 with backoff then succeeds; 400 throws immediately with request_id", async () => {
    let call = 0;
    const fetchFn = (async () => (call++ < 2 ? apiError(529, "overloaded_error") : ok({ x: "y" }))) as unknown as typeof fetch;
    const res = await createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep });
    expect(res.json).toEqual({ x: "y" });

    const bad = (async () => apiError(400, "invalid_request_error")) as unknown as typeof fetch;
    await expect(createMessage(REQ, { apiKey: "k", model: "m", fetchFn: bad, sleepFn: noSleep })).rejects.toMatchObject({
      status: 400,
      retryable: false,
      requestId: "req_123",
    });
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fetchFn = (async () => apiError(529, "overloaded_error")) as unknown as typeof fetch;
    await expect(
      createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it("stop_reason max_tokens / refusal fail the call - never a half proposal", async () => {
    for (const stop of ["max_tokens", "refusal"]) {
      const fetchFn = (async () => ok({ x: "truncated" }, stop)) as unknown as typeof fetch;
      await expect(createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({ apiType: stop });
    }
  });

  it("accumulates usage from the response", async () => {
    const fetchFn = (async () => ok({ x: "y" })) as unknown as typeof fetch;
    const res = await createMessage(REQ, { apiKey: "k", model: "m", fetchFn, sleepFn: noSleep });
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("runWithConcurrency preserves order and isolates failures", async () => {
    const tasks = [async () => 1, async () => { throw new Error("boom"); }, async () => 3];
    const settled = await runWithConcurrency(2, tasks);
    expect(settled[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(settled[1]?.status).toBe("rejected");
    expect(settled[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
