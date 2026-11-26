import { describe, expect, it } from "vitest";
import { factsSection, findUnsupportedRates, validRepair, INTERVIEW_INSTRUCTIONS, isInterviewRequest, NOTES_LIMITS, notesSection, numberSentences } from "./interview.js";
import { isGlobalQuestion } from "./retrieval-utils.js";

const CHIP = "Interview prep: the top 5 innovative, critical, high-level thinking questions from this video";

describe("interview requests", () => {
  it("recognises the starter prompt and reworded versions", () => {
    for (const q of [CHIP, "give me 5 hard interview questions from this video", "Generate interview question ideas", "what INTERVIEW questions could come from this?"])
      expect(isInterviewRequest(q)).toBe(true);
  });
  it("does not trigger on ordinary questions", () => {
    for (const q of ["What interview did the speaker mention?", "Why is that question tricky?", "How does bcrypt work?", "Who are the speakers?"])
      expect(isInterviewRequest(q)).toBe(false);
  });
  it("is answered from the whole-video breakdown", () => {
    expect(isGlobalQuestion(CHIP)).toBe(true);
    expect(isGlobalQuestion("How does bcrypt slow hashing down?")).toBe(false);
  });
  it("the instructions carry the five-question contract", () => {
    for (const must of ["exactly 5", "innovative, critical, high-level", "Beyond the video", "Why it separates strong candidates", "A strong answer covers", "Follow-up probe", "From the video", "Never invent"])
      expect(INTERVIEW_INSTRUCTIONS).toContain(must);
  });
  it("forbids invented rates, unlabelled outside knowledge and meaningless timestamps", () => {
    expect(INTERVIEW_INSTRUCTIONS).toContain("describe the video's scenario exactly as the material does");
    expect(INTERVIEW_INSTRUCTIONS).toContain("per minute"); // the worked example of what not to do
    expect(INTERVIEW_INSTRUCTIONS).toContain('Start a bullet with "Beyond the video:"');
    expect(INTERVIEW_INSTRUCTIONS).toContain("Exact wording");
    expect(INTERVIEW_INSTRUCTIONS).toContain("Do not use quotation marks");
    expect(INTERVIEW_INSTRUCTIONS).toMatch(/never turn a problem into a goal/);
    expect(INTERVIEW_INSTRUCTIONS).toContain("different times for different parts");
  });
});

describe("the user's notes in the prompt", () => {
  it("adds nothing when there are no notes", () => {
    expect(notesSection("", "")).toBe("");
    expect(notesSection(undefined, "  ")).toBe("");
  });
  it("labels them as the user's words and includes both parts", () => {
    const s = notesSection("Login flood interview Short", "focus on trade-offs");
    expect(s).toContain("not the video's");
    expect(s).toContain("Description: Login flood interview Short");
    expect(s).toContain("Notes: focus on trade-offs");
  });
  it("caps long notes, and caps tighter in compact mode", () => {
    const big = "x".repeat(10000);
    const full = notesSection(big, big);
    expect(full.length).toBeLessThan(NOTES_LIMITS.description + NOTES_LIMITS.notes + 400);
    expect(notesSection(big, big, 0.5).length).toBeLessThan(full.length);
  });
});

describe("exact wording of numbers", () => {
  const TEXT = "When bots flood a login endpoint with 50,000 failed attempts across 30,000 IP addresses, legitimate users suddenly face ten-second delays. The bottleneck isn't the network. Bcrypt is deliberately slow. Hello again. When bots flood a login endpoint with 50,000 failed attempts across 30,000 IP addresses, legitimate users suddenly face ten-second delays.";
  it("keeps only sentences with numbers, once each, unchanged", () => {
    const out = numberSentences(TEXT);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("50,000 failed attempts across 30,000 IP addresses");
    expect(out[0]).not.toMatch(/per minute/i);
  });
  it("respects the size limits", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Item ${i} costs ${i + 1} dollars.`).join(" ");
    expect(numberSentences(many, 5)).toHaveLength(5);
    expect(numberSentences(many, 30, 100).join("").length).toBeLessThanOrEqual(100);
    expect(numberSentences("No figures here. Nothing at all.")).toEqual([]);
  });
  it("renders a section only when there is something to show", () => {
    expect(factsSection([])).toBe("");
    expect(factsSection(["A 5 s timeout."])).toContain("- A 5 s timeout.");
  });
});

describe("invented rates", () => {
  const MATERIAL = "When bots flood a login endpoint with 50,000 failed attempts across 30,000 IP addresses, legitimate users suddenly face ten-second delays. Check the error rate every minute on the dashboard.";
  it("flags a rate added to a figure the material gives without one", () => {
    expect(findUnsupportedRates("In the scenario of 50,000 login requests every minute from 30,000 IPs", "x 50,000 failed attempts across 30,000 IP addresses")).toEqual(["every minute"]);
    expect(findUnsupportedRates("a flood of 50,000 attempts/minute", "50,000 failed attempts")).toEqual(["/minute"]);
    expect(findUnsupportedRates("scale to 500,000 requests per second", "50,000 failed attempts")).toEqual(["per second"]);
  });
  it("accepts a rate phrase the material itself contains, and lines without numbers", () => {
    expect(findUnsupportedRates("alert on 5 errors every minute", MATERIAL)).toEqual([]);
    expect(findUnsupportedRates("Check the dashboard every minute", "nothing here")).toEqual([]); // no number on the line
  });
  it("only accepts a repair that kept the structure and size", () => {
    const draft = "**Q1. a** x".padEnd(1000, "y") + "\n**Q2. b** z";
    expect(validRepair(draft, draft.replace("y", "z"))).toBe(true);
    expect(validRepair(draft, "short")).toBe(false);
    expect(validRepair(draft, "**Q1. only one** " + "y".repeat(900))).toBe(false);
  });
});
