import { describe, expect, it } from "vitest";
import { INTERVIEW_INSTRUCTIONS } from "./interview.js";
import { defaultQuestion, effectiveMode, MODE_LABELS, MODES, modeInstructions, modelQuestion, parseMode } from "./modes.js";

describe("tags", () => {
  it("accepts only known tags", () => {
    for (const m of MODES) expect(parseMode(m)).toBe(m);
    for (const bad of ["", "Interview", "other", null, undefined, 5, {}]) expect(parseMode(bad)).toBeNull();
  });
  it("has a label and a default question for every tag", () => {
    for (const m of MODES) {
      expect(MODE_LABELS[m].length).toBeGreaterThan(2);
      expect(defaultQuestion(m).length).toBeGreaterThan(10);
    }
  });
});

describe("which tag is in effect", () => {
  it("prefers the tag chosen in the chat bar", () => {
    expect(effectiveMode("quiz", "Give me interview questions")).toBe("quiz");
  });
  it("falls back to Interview when the wording asks for interview questions", () => {
    expect(effectiveMode(null, "give me 5 hard interview questions")).toBe("interview");
    expect(effectiveMode(undefined, defaultQuestion("interview"))).toBe("interview");
  });
  it("is no tag for an ordinary question", () => {
    expect(effectiveMode(null, "How does bcrypt work?")).toBeNull();
  });
});

describe("the question the model sees", () => {
  it("is the tag's request, plus the user's text as a focus", () => {
    expect(modelQuestion("interview", defaultQuestion("interview"))).toBe(defaultQuestion("interview"));
    expect(modelQuestion("interview", "")).toBe(defaultQuestion("interview"));
    const withFocus = modelQuestion("summary", "focus on security");
    expect(withFocus).toContain(defaultQuestion("summary"));
    expect(withFocus).toContain("focus on security");
  });
  it("leaves an untagged question alone", () => {
    expect(modelQuestion(null, "How does bcrypt work?")).toBe("How does bcrypt work?");
  });
});

describe("tag instructions", () => {
  it("Interview: bullet summary first, then exactly five questions", () => {
    const t = modeInstructions("interview");
    expect(t).toContain("## Summary");
    expect(t).toContain("## Top 5 interview questions");
    expect(t.indexOf("## Summary")).toBeLessThan(t.indexOf("## Top 5 interview questions"));
    for (const must of ["Bullet points only", "**Overview**", "**How it works**", "**Takeaways**", "exactly 5 questions", "Why it separates strong candidates", "Follow-up probe", "Beyond the video"]) expect(t).toContain(must);
    expect(t).toContain(INTERVIEW_INSTRUCTIONS.slice(0, 60));
    expect(t).toContain("never a pasted sentence"); // the numbers bullets stay short
  });
  it("Deep summary is the summary only", () => {
    const t = modeInstructions("summary");
    expect(t).toContain("Bullet points only");
    expect(t).not.toContain("Top 5 interview questions");
  });
  it("Cheat sheet and Quiz have their own formats", () => {
    expect(modeInstructions("cheatsheet")).toContain("**Key terms**");
    expect(modeInstructions("cheatsheet")).toContain("**Numbers to remember**");
    expect(modeInstructions("quiz")).toContain("exactly 8");
    expect(modeInstructions("quiz")).toContain("**Self-test**");
  });
  it("every tag forbids quotation marks and invented units, and asks for the exact-wording numbers", () => {
    for (const m of MODES) {
      const t = modeInstructions(m);
      expect(t).toContain("do not use quotation marks");
      expect(t).toContain("Exact wording");
    }
  });
});
