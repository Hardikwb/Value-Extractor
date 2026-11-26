import { describe, expect, it } from "vitest";
import { estimateTokens, fitMaxTokens, parseTpmError, refitFromError, shrinkForExcess } from "./tokens.js";

const MSG = "413 {\"error\":{\"message\":\"Request too large for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 10391, please reduce your message size and try again.\"}}";

describe("token budgeting", () => {
  it("reads the limit and requested size from Groq's message", () => {
    expect(parseTpmError(MSG)).toEqual({ limit: 8000, requested: 10391 });
    expect(parseTpmError("some other error")).toBeNull();
    // a daily-limit message is a different error (handled by the retry logic), not a "request too large" one
    expect(parseTpmError("429 Rate limit reached ... tokens per day (TPD): Limit 200000, Used 199109, Requested 2135")).toBeNull();
  });
  it("shrinks max_tokens so input + output fits under the limit", () => {
    // 10391 requested with max_tokens 8000 means 2391 input tokens
    const r = refitFromError(MSG, 8000)!;
    expect(r.limit).toBe(8000);
    expect(2391 + r.maxTokens).toBeLessThanOrEqual(8000);
    expect(r.maxTokens).toBeGreaterThan(5000);
  });
  it("gives up when the input alone leaves no room for an answer", () => {
    expect(fitMaxTokens(8000, 7500)).toBeNull();
    expect(refitFromError(MSG.replace("Requested 10391", "Requested 15000"), 6000)).toBeNull();
  });
  it("estimates tokens from text length", () => {
    expect(estimateTokens([{ content: "x".repeat(3500) }])).toBeGreaterThanOrEqual(1000);
    expect(estimateTokens([{ content: "x".repeat(3500) }])).toBeLessThan(1100);
  });
  it("reduces the output budget by exactly the excess, and gives up when the prompt itself is too big", () => {
    const m = MSG.replace("Requested 10391", "Requested 9750"); // limit 8000
    expect(shrinkForExcess(m, 5359)).toBe(5359 - (9750 - 7750));
    expect(shrinkForExcess(m.replace("Requested 9750", "Requested 7000"), 5000)).toBe(5000); // already fits
    expect(shrinkForExcess(m.replace("Requested 9750", "Requested 16000"), 5000)).toBeNull();
  });
});
