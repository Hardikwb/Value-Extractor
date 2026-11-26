import { describe, expect, it } from "vitest";
import {
  appearsIn, assembleMarkdown, buildCorpus, buildSections, canonicalize, cleanUrl, firstSentences,
  mergeNamed, numberIsGrounded, parseChapters, parseLinks, parseProductsMentioned, type Insights,
} from "./insights-utils.js";
import { isGlobalQuestion } from "./retrieval-utils.js";

const DESC = `Google Antigravity → https://g.dev/ai/try-antigravity
Agent skills specification → https://g.dev/ai/github-skills

Chapters: 
0:00 - Why demos fail
0:44 - From prompts to harnesses
 10:33 - Enforcing Red-Green-Refactor & git hooks
1:02:05 - Late chapter

More resources: 
Agent Evaluation → https://g.dev/ai/evaluation?utm_source=youtube&x=1
🔔 Subscribe to Google Cloud Tech → https://goo.gle/GoogleCloudTech

Products Mentioned: Gemini, Gemma, Model Context Protocol, Claude Code, Codex`;

describe("description parsing", () => {
  it("parses chapters, including leading spaces and H:MM:SS", () => {
    const c = parseChapters(DESC);
    expect(c.map((x) => x.start)).toEqual([0, 44, 633, 3725]);
    expect(c[2].title).toBe("Enforcing Red-Green-Refactor & git hooks");
  });
  it("needs at least three chapters", () => {
    expect(parseChapters("0:00 - a\n1:00 - b")).toEqual([]);
  });
  it("ignores timestamps that are really links", () => {
    expect(parseChapters("0:00 - a\n1:00 - b\n2:00 https://x.y/z")).toEqual([]);
  });
  it("parses labelled links and strips tracking params", () => {
    const l = parseLinks(DESC);
    expect(l[1]).toEqual({ label: "Agent skills specification", url: "https://g.dev/ai/github-skills" });
    expect(l.find((x) => x.label === "Agent Evaluation")!.url).toBe("https://g.dev/ai/evaluation?x=1");
    expect(l.find((x) => x.url.includes("GoogleCloudTech"))!.label).toBe("Subscribe to Google Cloud Tech");
    expect(cleanUrl("https://a.b/c?utm_campaign=1&si=2&k=v).")).toBe("https://a.b/c?k=v");
  });
  it("parses the products list", () => {
    expect(parseProductsMentioned(DESC)).toEqual(["Gemini", "Gemma", "Model Context Protocol", "Claude Code", "Codex"]);
  });
});

describe("name grounding", () => {
  const corpus = buildCorpus("the agent skills work in Cloud Code and Codex. We use gemini 3 for review");
  it("finds exact names, ignoring case and punctuation", () => {
    expect(appearsIn("Codex", corpus)).toBe(true);
    expect(appearsIn("GEMINI", corpus)).toBe(true);
  });
  it("rejects names that are not there, including typical-but-absent tools", () => {
    for (const n of ["Jenkins", "GitHub Actions", "Prometheus", "Kubernetes"]) expect(appearsIn(n, corpus)).toBe(false);
  });
  it("does not fuzz short words into other words", () => {
    expect(appearsIn("Gem", corpus)).toBe(false);
  });
  it("maps garbled caption names onto the description's spelling", () => {
    const glossary = ["Claude Code", "Codex", "Gemini", "Cloud Run"];
    expect(canonicalize("Cloud Code", glossary)).toBe("Claude Code");
    expect(canonicalize("Codecs", glossary)).toBe("Codex");
    expect(canonicalize("Jenkins", glossary)).toBeNull();
    expect(canonicalize("Cloud Run", glossary)).toBe("Cloud Run");
  });
  it("only keeps numbers that appear in the section text", () => {
    const text = "there are over 150 skills and the pass rate must be 100 percent, in three stages";
    expect(numberIsGrounded("150+", text)).toBe(true);
    expect(numberIsGrounded("three stages", text)).toBe(true);
    expect(numberIsGrounded("200", text)).toBe(false);
    expect(numberIsGrounded("no digits here", text)).toBe(false);
  });
});

describe("sections", () => {
  const seg = (start: number, n = 300) => ({ start, text: "x".repeat(n) });
  const segs = Array.from({ length: 100 }, (_, i) => seg(i * 10)); // 0..990s, 300 chars each (30k total)
  it("uses one section per chapter and merges tiny ones into the next", () => {
    const small = Array.from({ length: 100 }, (_, i) => seg(i * 10, 100)); // 100 chars every 10s
    const chapters = [{ start: 0, title: "tiny" }, { start: 30, title: "B" }, { start: 330, title: "C" }, { start: 630, title: "D" }];
    const s = buildSections(small, chapters);
    expect(s.map((x) => x.title)).toEqual(["tiny / B", "C", "D"]);
    expect(s[0].start).toBe(0);
  });
  it("splits chapters that are too large", () => {
    const big = Array.from({ length: 100 }, (_, i) => seg(i * 10, 300)).concat(Array.from({ length: 100 }, (_, i) => seg(1000 + i * 10, 300)));
    const s = buildSections(big, [{ start: 0, title: "Huge" }, { start: 5000, title: "b" }, { start: 6000, title: "c" }]);
    expect(s.length).toBeGreaterThan(4);
    expect(s[0].title).toBe("Huge (part 1)");
    expect(s.every((x) => x.text.length <= 6500)).toBe(true);
  });
  it("falls back to fixed windows when there are no chapters", () => {
    const s = buildSections(segs, []);
    expect(s.length).toBeGreaterThan(3);
    expect(s[0].title).toBe("Part 1");
    expect(s.reduce((n, x) => n + x.text.length, 0)).toBeGreaterThan(29000);
  });
});

describe("merge and markdown", () => {
  it("fills a missing description from a later sighting", () => {
    const m = mergeNamed([{ name: "Antigravity", start: 5, what: "" }, { name: "antigravity", start: 90, what: "Google's agent IDE" }]);
    expect(m).toEqual([{ name: "Antigravity", start: 5, what: "Google's agent IDE" }]);
  });
  it("dedupes names case-insensitively, keeping the first sighting", () => {
    expect(mergeNamed([{ name: "Gemini", start: 5 }, { name: "gemini", start: 90 }, { name: "Codex", start: 7 }]))
      .toEqual([{ name: "Gemini", start: 5 }, { name: "Codex", start: 7 }]);
  });
  it("assembles a breakdown with the lists before the chapter detail and GitHub flagged", () => {
    const insights: Insights = {
      overview: "A long video.", framework: [{ name: "Learn", line: "context" }], takeaways: ["Gate everything"],
      speakers: [{ name: "Logan", role: "harness" }],
      sections: [{ title: "Intro", start: 0, summary: "Sum.", key_points: ["p1"], tools: [], people: [], resources: [], numbers: [], practices: [] }],
      tools: [{ name: "Claude Code", start: 335, what: "a coding agent" }], people: [], resources: [{ name: "SKILL.md", start: 340 }],
      numbers: [{ value: "150+", what: "skills", start: 430 }], practices: [{ text: "Keep commits small", start: 650 }],
    };
    const md = assembleMarkdown({
      youtubeId: "abc", title: "T", author: "Ch", durationSeconds: 1651, insights,
      links: [{ label: "Agent skills specification", url: "https://g.dev/x", resolved_url: "https://github.com/google/skills", is_github: true }],
    });
    expect(md).toContain("https://github.com/google/skills (GitHub)");
    expect(md).toContain("**Claude Code** — a coding agent");
    expect(md).toContain("[5:35](https://www.youtube.com/watch?v=abc&t=335s)");
    expect(md.indexOf("## Tools & technologies")).toBeLessThan(md.indexOf("## Chapter by chapter"));
    expect(firstSentences("One. Two. Three. Four.", 2)).toBe("One. Two.");
  });
});

describe("question routing for the detailed breakdown", () => {
  it("sends link, speaker and detail questions to the whole-video path", () => {
    for (const q of ["Is there a GitHub repo shown?", "What links are mentioned?", "Who are the speakers?",
      "Give me a detailed breakdown", "extract all the values", "List every tool, person and number"])
      expect(isGlobalQuestion(q)).toBe(true);
    for (const q of ["How does retry limiting work?", "Why do agents delete tests?"]) expect(isGlobalQuestion(q)).toBe(false);
  });
});
