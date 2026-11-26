import Groq from "groq-sdk";
import { config } from "../config.js";
import { currentReporter } from "../jobs/reporter-core.js";
import { estimateTokens, fitMaxTokens, parseTpmError, shrinkForExcess } from "./tokens.js";

const groq = new Groq({ apiKey: config.GROQ_API_KEY, maxRetries: 0 });

// Free-tier token budgets are per model (about 200k tokens/day each), so bulk background work goes to
// cheaper models and the main model is kept for the answers the user is waiting for.
// Answers try these in order; a model whose free daily budget is spent is skipped (budgets are per model).
export const CHAT_MODELS = (process.env.CHAT_MODELS ?? process.env.CHAT_MODEL ?? "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b")
  .split(",").map((m) => m.trim()).filter(Boolean);
export const CHAT_MODEL = CHAT_MODELS[0];
export const BULK_MODELS = (process.env.BULK_MODELS ?? "openai/gpt-oss-20b,qwen/qwen3.8-27b").split(",").map((m) => m.trim()).filter(Boolean);
export const FAST_MODEL = BULK_MODELS[0];

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export class LlmError extends Error {}

const isDailyLimit = (e: any) => e?.status === 429 && /tokens per day|\(TPD\)/i.test(String(e?.message ?? ""));

/** Turn provider errors into messages that are safe and useful to show in the UI. */
export function friendlyError(e: any): string {
  if (e?.name === "AbortError") return "Request cancelled.";
  if (isDailyLimit(e)) {
    const m = /try again in ([0-9hms.]+)/i.exec(String(e.message));
    const when = m ? ` It frees up in about ${m[1].replace(/\.\d+s/, "s")}.` : "";
    return `Groq's free daily token limit for this model is used up.${when} Try again then.`;
  }
  if (e?.status === 429) return "Groq's free-tier rate limit was hit. Wait a few seconds and try again.";
  if (e?.status === 413) return "That request was too large for the model's limit. Try a narrower question.";
  if (e?.status === 401) return "The Groq API key was rejected. Check GROQ_API_KEY.";
  return e?.message ?? "Something went wrong while contacting the model.";
}

/** Sleep that ends early (and throws) if `signal` aborts, so Stop is responsive even during a rate-limit wait. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const isConnectionError = (e: any) =>
  e?.name !== "AbortError" && !e?.status && /connection|ETIMEDOUT|ECONNRESET|fetch failed|socket/i.test(`${e?.name} ${e?.message} ${e?.cause?.code ?? ""}`);

/**
 * Retries rate limits (waiting exactly as long as Retry-After says) and transient connection errors.
 * If the wait would exceed `maxWaitMs` (e.g. a daily limit) it fails straight away instead of hanging.
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 6, maxWaitMs = 30000, signal?: AbortSignal): Promise<T> {
  let noted = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      if (noted) currentReporter()?.detail(""); // the wait is over
      return out;
    } catch (e: any) {
      const rateLimited = e?.status === 429;
      if ((!rateLimited && !isConnectionError(e)) || attempt >= tries - 1) throw e;
      const header = Number(e?.headers?.["retry-after"]);
      let wait: number;
      if (rateLimited) {
        wait = Number.isFinite(header) && header > 0 ? header * 1000 + 500 : Math.min(2000 * 2 ** attempt, maxWaitMs);
        if (wait > maxWaitMs) throw e;
      } else {
        wait = 1500 * (attempt + 1);
      }
      console.warn(`[llm] ${rateLimited ? "rate limited (429)" : "connection error"}, retrying in ${wait}ms (attempt ${attempt + 1}/${tries})`);
      if (wait >= 4000) { currentReporter()?.detail(`${rateLimited ? "Waiting for Groq's rate limit" : "Reconnecting"} (about ${Math.ceil(wait / 1000)} s)…`); noted = true; }
      await sleep(wait, signal);
    }
  }
}

// gpt-oss spends part of max tokens on hidden reasoning, so leave headroom. Answers use "medium":
// at "low" the model padded process descriptions with steps the video never states. Background
// summarising keeps "low" to save time and free-tier tokens. Override answers with REASONING_EFFORT.
const ANSWER_EFFORT = process.env.REASONING_EFFORT ?? "medium";

/** Reasoning options differ by model family: gpt-oss takes an effort level; Qwen needs its thinking hidden from the text. */
const modelParams = (model: string, effort: string) =>
  model.includes("gpt-oss") ? { reasoning_effort: effort } : model.includes("qwen") ? { reasoning_format: "hidden" } : {};

/** One-shot completion on the bulk models. If a model's daily budget is spent, the next one is tried. */
export async function complete(
  messages: ChatMsg[],
  opts: { json?: boolean; maxTokens?: number; signal?: AbortSignal; patient?: boolean; models?: string[] } = {},
): Promise<string> {
  const models = opts.models ?? BULK_MODELS;
  let lastError: unknown;
  for (const model of models) {
    try {
      const res = await withRetry(
        () =>
          groq.chat.completions.create(
            {
              model,
              ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
              messages,
              temperature: 0.2,
              max_tokens: opts.maxTokens ?? 1500,
              ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
            } as any,
            { signal: opts.signal },
          ),
        opts.patient ? 14 : 6,
        opts.patient ? 20 * 60000 : 30000, // background jobs may wait out a per-minute limit; never hang on a daily one
      );
      return stripThinking((res as any).choices[0]?.message?.content ?? "");
    } catch (e: any) {
      lastError = e;
      if (!isDailyLimit(e) || model === models[models.length - 1]) throw e;
      console.warn(`[llm] daily limit reached on ${model}, trying the next model`);
    }
  }
  throw lastError;
}

/** Some models put reasoning in <think> tags inside the content. */
const stripThinking = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export interface StreamOptions {
  signal?: AbortSignal;
  /** reasoning effort for gpt-oss models ("low" for answers built from a ready-made summary) */
  effort?: string;
  maxTokens?: number;
  /** why the model stopped: "stop" (finished) or "length" (hit the token limit) */
  onFinish?: (reason: string) => void;
}

/** Test/override hook: cap on answer tokens (forces "length" endings when set small). */
const MAX_ANSWER_TOKENS = Number(process.env.MAX_ANSWER_TOKENS) || 0;

/** Per-request token limit learned from "request too large" errors, per model. */
const tpmLimit = new Map<string, number>();

/** Opens the answer stream on one model, shrinking max_tokens if the request is "too large". */
async function openStream(model: string, messages: ChatMsg[], opts: StreamOptions, wanted: number): Promise<{ stream: AsyncIterable<any>; model: string }> {
  let maxTokens = wanted;
  const known = tpmLimit.get(model);
  if (known) maxTokens = Math.min(maxTokens, fitMaxTokens(known, estimateTokens(messages)) ?? maxTokens);

  // Answers are written in the background, so a per-minute rate limit is simply waited out (up to 2 minutes
  // per wait, 12 tries). A daily limit would wait far longer, so it fails straight away.
  const open = () =>
    withRetry(
      () =>
        groq.chat.completions.create(
          { model, ...modelParams(model, opts.effort ?? ANSWER_EFFORT), messages, temperature: 0.2, max_tokens: maxTokens, stream: true } as any,
          { signal: opts.signal },
        ),
      12, 120000, opts.signal,
    );

  // "Request too large": input + max_tokens exceeds the per-request cap. Shrink the output budget by the excess
  // reported in each error (up to 3 times). If that leaves too little room, the prompt itself is too big and the
  // error is thrown so the caller can retry with a smaller prompt.
  for (let fit = 0; ; fit++) {
    try {
      return { stream: (await open()) as unknown as AsyncIterable<any>, model };
    } catch (e: any) {
      const tpm = e?.status === 413 ? parseTpmError(String(e.message)) : null;
      const next = tpm && fit < 3 ? shrinkForExcess(String(e.message), maxTokens) : null;
      if (!tpm || !next) throw e;
      tpmLimit.set(model, tpm.limit);
      console.warn(`[llm] request too large for ${model} (limit ${tpm.limit}); retrying with max_tokens ${next}`);
      maxTokens = next;
    }
  }
}

/** Test hook: slows the stream so Stop can be exercised deterministically. */
const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS) || 0;

export async function* streamChat(messages: ChatMsg[], opts: StreamOptions = {}): AsyncGenerator<string> {
  const wanted = MAX_ANSWER_TOKENS || opts.maxTokens || 6000;
  let opened: { stream: AsyncIterable<any>; model: string } | undefined;
  for (const [i, model] of CHAT_MODELS.entries()) {
    try {
      opened = await openStream(model, messages, opts, wanted);
      break;
    } catch (e: any) {
      if (!isDailyLimit(e) || i === CHAT_MODELS.length - 1) throw e;
      console.warn(`[llm] daily limit reached on ${model}, answering with ${CHAT_MODELS[i + 1]} instead`);
    }
  }
  for await (const part of opened!.stream) {
    const choice = part.choices[0];
    const delta = choice?.delta?.content;
    if (delta) {
      yield delta;
      if (STREAM_DELAY_MS) await new Promise((r) => setTimeout(r, STREAM_DELAY_MS));
    }
    if (choice?.finish_reason) opts.onFinish?.(choice.finish_reason);
  }
}
