// Token budgeting helpers (pure). Groq counts input tokens + max_tokens against a per-request cap.

export interface TokenMsg { content: string }

/** Rough token count (about 3.5 characters per token for English prose and markdown). */
export const estimateTokens = (messages: TokenMsg[]): number =>
  Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5) + 20 * messages.length;

/** Reads "Limit 8000, Requested 10391" out of a Groq "request too large" error message. */
export function parseTpmError(message: string): { limit: number; requested: number } | null {
  if (!/request too large|tokens per minute/i.test(message)) return null;
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(message);
  return m ? { limit: Number(m[1]), requested: Number(m[2]) } : null;
}

export const MIN_ANSWER_TOKENS = 700;

/** The largest max_tokens that still fits under the limit, or null if even a short answer cannot fit. */
export function fitMaxTokens(limit: number, inputTokens: number, margin = 250): number | null {
  const room = limit - inputTokens - margin;
  return room >= MIN_ANSWER_TOKENS ? room : null;
}

/** Given the failed request's max_tokens, work out its input size from the error and return a max_tokens that fits. */
export function refitFromError(message: string, usedMaxTokens: number): { limit: number; maxTokens: number } | null {
  const p = parseTpmError(message);
  if (!p) return null;
  const fitted = fitMaxTokens(p.limit, p.requested - usedMaxTokens);
  return fitted ? { limit: p.limit, maxTokens: fitted } : null;
}

/**
 * After a "request too large" error, the output budget that removes the excess, or null if that would leave
 * too little room for an answer (then the prompt itself must shrink).
 */
export function shrinkForExcess(message: string, usedMaxTokens: number, margin = 250): number | null {
  const p = parseTpmError(message);
  if (!p) return null;
  const excess = p.requested - (p.limit - margin);
  if (excess <= 0) return usedMaxTokens;
  const next = usedMaxTokens - excess;
  return next >= MIN_ANSWER_TOKENS ? next : null;
}
