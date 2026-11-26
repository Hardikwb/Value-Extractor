// Interview-prep mode and the user's own notes (pure: no DB / env access, so it can be unit tested).

/** "5 hard interview questions", "Interview prep: the top 5 ... questions" and similar wordings. */
export function isInterviewRequest(q: string): boolean {
  return /\binterview/i.test(q) && /\bquestions?\b/i.test(q);
}

/**
 * Added to the END of the system prompt, after the video's material, only for interview requests.
 * It overrides the usual "keep it short" guidance.
 */
/** Rules for the "Summary" part: bullet points only, concrete, and limited to what the material says. */
export const SUMMARY_RULES = `Bullet points only (no paragraphs). Use these bold sub-headings, each followed by bullets:
- **Overview**: 2 to 3 bullets on what the video is about and who it is for.
- **How it works**: the main idea step by step, or the problem, the cause and the fix kept apart.
- **Key concepts and terms**: each with its meaning as the video explains it.
- **Numbers, tools and names**: copy numbers from the exact-wording list unchanged; include only tools and names the material mentions.
- **Takeaways**: 3 to 5 bullets.
Every bullet must be concrete and specific to this video: no filler and no generic advice. Say only what the material says in this part; outside knowledge belongs in the questions part, where it is marked "Beyond the video:".`;

/**
 * Added to the END of the system prompt, after the video's material, for the Interview tag.
 * Two parts, in order: a bullet-point summary, then the five questions. It overrides the usual length guidance.
 */
export const INTERVIEW_INSTRUCTIONS = `## Interview-prep mode (these instructions apply to your answer)
The user is preparing for senior engineering interviews. Write the answer in TWO parts, in this order, using exactly these two headings. This format overrides the usual length guidance.

## Summary
${SUMMARY_RULES}

## Top 5 interview questions
Act as a staff engineer designing a hiring interview from this video. Write exactly 5 questions: the most innovative, critical, high-level thinking questions this material supports.

Rules:
- Go beyond recall. No definitions, trivia or "what did the video say" questions. Each question must force the candidate to reason: trade-offs and alternatives, failure modes and abuse, scale and cost, security and privacy, how to prove a fix worked, or how the design changes at 10x load.
- Use five different angles. No two questions may test the same idea.
- Base every question on this video's material and, if the user gave notes, on what they want to practise.
- Numbers: when you mention a number or the scenario, reuse the wording from the "Exact wording" list above, unchanged. Never add a unit, rate or time window that wording does not contain (no "per minute" unless it says so). Do not use quotation marks anywhere in your answer; describe the video in your own words except for those numbers.
- Scenario: describe the video's scenario exactly as the material does. Keep apart what it presents as the problem, the cause and the fix; never turn a problem into a goal or the reverse.
- Never invent facts, numbers, tools or claims about the video.

Format, for each question:
**Q1. <the question>** (difficulty: Senior, Staff or Principal)
- **Why it separates strong candidates:** one sentence.
- **A strong answer covers:** 3 to 5 bullets. Start a bullet with "Beyond the video:" whenever it relies on a tool, technique, standard or regulation that the video never mentions. Bullets that only use ideas from the video need no label.
- **Follow-up probe:** one harder question.
- **From the video:** the part it builds on, in a few words of your own (no quotation marks). Add a timestamp like (0:45) only when the breakdown shows different times for different parts; if it has a single part or everything is at 0:00, give no timestamp.

After the fifth question add one line on how to practise (for example: answer each aloud in two minutes, then compare with the bullets). No preamble and no recap table.`;

/** Sentences that carry numbers, to be copied verbatim: models invent units and rates when they paraphrase figures. */
export function numberSentences(text: string, max = 8, maxChars = 1400): string[] {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) ?? [];
  const hasNumber = (x: string) => /\d/.test(x) || /\b(one|two|three|four|five|ten|twenty|thirty|fifty|hundred|thousand|million|billion)\b/i.test(x);
  const seen = new Set<string>();
  const out: string[] = [];
  let chars = 0;
  for (const raw of sentences) {
    const sent = raw.trim();
    const key = sent.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!hasNumber(sent) || seen.has(key)) continue;
    const clipped = sent.length > 300 ? sent.slice(0, 300).trimEnd() + "…" : sent;
    if (out.length >= max || chars + clipped.length > maxChars) break;
    seen.add(key);
    out.push(clipped);
    chars += clipped.length;
  }
  return out;
}

export function factsSection(sentences: string[]): string {
  if (!sentences.length) return "";
  return ["## Exact wording of the video's numbers and scenario", "Copy this wording unchanged when you mention a figure or the scenario.", ...sentences.map((x) => `- ${x}`)].join("\n");
}

const RATE_RE = /\b(?:per|every|each|a)[ -](?:second|minute|hour|day)\b|\/\s?(?:sec|second|s|min|minute|hr|hour)\b/gi;
const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();

/**
 * Rate or time-window phrases ("every minute", "per second", "/min") that appear on a line with a number in the
 * answer but nowhere in the video's own text. Models like to turn "50,000 failed attempts" into "50,000 per minute".
 */
export function findUnsupportedRates(answer: string, material: string): string[] {
  const src = ` ${squash(material)} `;
  const found = new Set<string>();
  for (const line of answer.split("\n")) {
    if (!/\d/.test(line)) continue;
    for (const m of line.matchAll(RATE_RE)) {
      if (!src.includes(` ${squash(m[0])} `)) found.add(m[0].toLowerCase());
    }
  }
  return [...found];
}

export const REPAIR_SYSTEM = `You correct a draft set of interview questions. The draft added a rate or time window (such as "every minute" or "per second") to a figure that the source material states without one. Rewrite ONLY the sentences affected so that figures are used exactly as in the source's exact wording, or refer to the situation without a rate (for example "the attack described in the video"). Keep every other word, the five-question structure and the formatting identical. Output the complete corrected answer and nothing else.`;

/** A repaired answer is accepted only if it kept the five-question structure and most of its length. */
export function validRepair(draft: string, fixed: string): boolean {
  const count = (t: string) => (t.match(/\*\*Q\d/g) ?? []).length;
  return count(fixed) === count(draft) && count(fixed) >= 1 && fixed.length >= draft.length * 0.7 && fixed.length <= draft.length * 1.4;
}

export const NOTES_LIMITS = { description: 1000, notes: 2000 };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

/** The user's own words about the video, as a prompt section ("" when they gave none). */
export function notesSection(description: string | null | undefined, notes: string | null | undefined, scale = 1): string {
  const d = (description ?? "").trim();
  const n = (notes ?? "").trim();
  if (!d && !n) return "";
  const lines = [
    "## The user's own notes and description",
    "These are the user's words, not the video's. Use them to understand what the user wants to practise and to steer your answer; never present them as things the video said.",
  ];
  if (d) lines.push(`Description: ${clip(d, Math.round(NOTES_LIMITS.description * scale))}`);
  if (n) lines.push(`Notes: ${clip(n, Math.round(NOTES_LIMITS.notes * scale))}`);
  return lines.join("\n");
}
