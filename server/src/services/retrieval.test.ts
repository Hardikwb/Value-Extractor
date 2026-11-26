import { describe, expect, it } from "vitest";
import { chunkTranscript } from "./chunker.js";
import { clipHistory, isGlobalQuestion, needsRewrite, rrf, sampleText, toTsQuery } from "./retrieval-utils.js";
import { cleanCaption, decodeEntities, latinRatio, offsetsAreMs } from "./youtube.js";

describe("caption cleaning", () => {
  it("decodes single and double-encoded entities", () => {
    expect(decodeEntities("it&#39;s")).toBe("it's");
    expect(decodeEntities("it&amp;#39;s &quot;x&quot; a &lt; b")).toBe('it\'s "x" a < b');
  });
  it("removes sound tags and speaker markers", () => {
    expect(cleanCaption("[Music] >> hello   world")).toBe("hello world");
  });
});

describe("language guard", () => {
  it("accepts English and rejects Arabic or Chinese text", () => {
    expect(latinRatio("We set up a CI/CD pipeline with Docker")).toBeGreaterThan(0.9);
    expect(latinRatio("البحث الثنائي. من المحتمل أنك لعبت نسخة")).toBeLessThan(0.1);
    expect(latinRatio("二分查找是一种高效的算法")).toBe(0);
    expect(latinRatio("12345 !!!")).toBe(0);
  });
});

describe("timestamp units", () => {
  it("detects the millisecond (srv3) format", () => {
    expect(offsetsAreMs([{ text: "a", offset: 1200, duration: 3400 }, { text: "b", offset: 4600, duration: 2000 }])).toBe(true);
  });
  it("detects the classic seconds format", () => {
    expect(offsetsAreMs([{ text: "a", offset: 1.2, duration: 3.4 }, { text: "b", offset: 4.6, duration: 2 }])).toBe(false);
  });
});

describe("chunker", () => {
  const segs = Array.from({ length: 200 }, (_, i) => ({ text: `segment ${i} ` + "x".repeat(40), start: i * 4 }));
  it("keeps chunks near the target size, overlaps them, and terminates", () => {
    const chunks = chunkTranscript(segs, 900, 120);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks.slice(0, -1)) expect(c.text.length).toBeLessThan(1100);
    const lastSegOfFirst = "segment " + (chunks[1].text.match(/^segment (\d+)/)![1]);
    expect(chunks[0].text).toContain(lastSegOfFirst); // chunk 1 starts inside chunk 0 (overlap)
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i));
  });
});

describe("retrieval helpers", () => {
  it("flags whole-video questions", () => {
    for (const q of ["Summarize the video", "List every tool mentioned", "What should I learn next?", "what is this course about"])
      expect(isGlobalQuestion(q)).toBe(true);
    for (const q of ["How does the CI/CD pipeline work?", "why is git rebase risky"])
      expect(isGlobalQuestion(q)).toBe(false);
  });
  it("fuses rankings so items in both lists win", () => {
    const s = rrf([["a", "b", "c"], ["c", "d", "a"]]);
    const order = [...s.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order.slice(0, 2).sort()).toEqual(["a", "c"]);
  });
  it("rewrites only follow-ups", () => {
    expect(needsRewrite("How does the CI/CD pipeline deploy the application to production?", true)).toBe(false);
    expect(needsRewrite("Why is that needed?", true)).toBe(true);
    expect(needsRewrite("and the second one?", true)).toBe(true);
    expect(needsRewrite("capital of France", true)).toBe(true); // 3 words: too terse to trust
    expect(needsRewrite("What is the capital of France?", true)).toBe(false);
    expect(needsRewrite("Why is that needed?", false)).toBe(false);
  });
  it("builds a safe OR tsquery", () => {
    expect(toTsQuery("How does the CI/CD pipeline work?")).toBe("ci | cd | pipeline | work");
    expect(toTsQuery("what is the")).toBeNull();
    expect(toTsQuery("'; drop table--")).toBe("drop | table");
  });
  it("clips history length and long assistant replies", () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "y".repeat(3000) }));
    const out = clipHistory(h);
    expect(out).toHaveLength(6);
    expect(out.find((t) => t.role === "assistant")!.content.length).toBeLessThan(1600);
    expect(out.find((t) => t.role === "user")!.content.length).toBe(3000);
  });
  it("samples start, middle and end of long text", () => {
    const t = "A".repeat(5000) + "M".repeat(50000) + "Z".repeat(5000);
    const s = sampleText(t);
    for (const ch of ["A", "M", "Z"]) expect(s).toContain(ch);
    expect(s.length).toBeLessThan(10000);
  });
});
