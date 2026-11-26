import { describe, expect, it } from "vitest";
import { cleanTitle, defaultTitle, finalStatus, MAX_AUTO_CONTINUES, modelHistory, shouldAutoContinue } from "./generation-utils.js";
import { buildContinuation, CONTINUE_PROMPT, tailOf } from "../services/retrieval-utils.js";

describe("answer status", () => {
  it("only a normal finish counts as done", () => {
    expect(finalStatus({ reason: "stop", stopped: false, failed: false })).toBe("done");
    expect(finalStatus({ reason: "length", stopped: false, failed: false })).toBe("incomplete");
    expect(finalStatus({ reason: "", stopped: false, failed: true })).toBe("incomplete");
    expect(finalStatus({ reason: "stop", stopped: true, failed: false })).toBe("stopped");
    expect(finalStatus({ reason: "length", stopped: true, failed: true })).toBe("stopped"); // the user's stop wins
  });
  it("continues a length cut-off a limited number of times, and nothing else", () => {
    expect(shouldAutoContinue("length", 0)).toBe(true);
    expect(shouldAutoContinue("length", MAX_AUTO_CONTINUES)).toBe(false);
    expect(shouldAutoContinue("stop", 0)).toBe(false);
    expect(shouldAutoContinue("", 0)).toBe(false);
  });
});

describe("model history", () => {
  const rows = [
    { role: "user", status: "done", content: "q1" },
    { role: "assistant", status: "done", content: "a1" },
    { role: "user", status: "done", content: "q2" },
    { role: "assistant", status: "incomplete", content: "half" },
    { role: "assistant", status: "generating", content: "so far" },
    { role: "assistant", status: "stopped", content: "stopped" },
  ];
  it("never feeds unfinished answers back to the model", () => {
    expect(modelHistory(rows).map((r) => r.content)).toEqual(["q1", "a1", "q2"]);
  });
  it("keeps only the newest messages", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: "user", status: "done", content: `m${i}` }));
    const out = modelHistory(many, 12);
    expect(out).toHaveLength(12);
    expect(out[11].content).toBe("m29");
  });
});

describe("continuation prompt", () => {
  it("appends the partial answer and a continue instruction after the original conversation", () => {
    const base = [{ role: "system", content: "S" }, { role: "user", content: "Q" }];
    const out = buildContinuation(base, "Part one…");
    expect(out.slice(0, 2)).toEqual(base);
    expect(out[2]).toEqual({ role: "assistant", content: "Part one…" });
    expect(out[3].role).toBe("user");
    expect(out[3].content).toContain(CONTINUE_PROMPT);
    expect(out[3].content).toContain("Part one…"); // quotes where it stopped
    expect(base).toHaveLength(2); // input not mutated
  });
});

describe("continuation anchor", () => {
  it("quotes only the last characters of a long partial answer, without trailing whitespace", () => {
    expect(tailOf("a".repeat(500) + "end   \n")).toMatch(/aaend$/); // whitespace at the end is dropped
    expect(tailOf("short text ")).toBe("short text");
    expect(tailOf("x".repeat(500)).length).toBe(120);
  });
});

describe("chat titles", () => {
  it("uses the first 60 characters of the question as the immediate title", () => {
    expect(defaultTitle("  Give a   detailed breakdown\nwith every tool, person, resource and number please  ")).toHaveLength(60);
    expect(defaultTitle("Short?")).toBe("Short?");
  });
  it("cleans a model-written title", () => {
    expect(cleanTitle('"Senior developer habits."')).toBe("Senior developer habits");
    expect(cleanTitle("Title: **Edge cases and consent**\nextra line")).toBe("Edge cases and consent");
    expect(cleanTitle("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});
