// Answer-type tags for the chat bar (pure: no DB / env access, so it can be unit tested).
import { INTERVIEW_INSTRUCTIONS, isInterviewRequest, SUMMARY_RULES } from "./interview.js";

export type Mode = "interview" | "summary" | "cheatsheet" | "quiz";
export const MODES: Mode[] = ["interview", "summary", "cheatsheet", "quiz"];

export const MODE_LABELS: Record<Mode, string> = {
  interview: "Interview",
  summary: "Deep summary",
  cheatsheet: "Cheat sheet",
  quiz: "Quiz",
};

export const parseMode = (x: unknown): Mode | null => (typeof x === "string" && (MODES as string[]).includes(x) ? (x as Mode) : null);

/** The question stored (and shown) when a tag is sent without any text. */
export function defaultQuestion(mode: Mode): string {
  switch (mode) {
    case "interview": return "Interview prep: a deep summary, then the top 5 innovative, critical, high-level thinking questions from this video";
    case "summary": return "Give me a deep summary of this video in bullet points";
    case "cheatsheet": return "Make me a cheat sheet from this video";
    case "quiz": return "Quiz me on this video";
  }
}

/** The tag in effect: the one chosen in the chat bar, else Interview if the wording asks for interview questions. */
export function effectiveMode(mode: Mode | null | undefined, question: string): Mode | null {
  return mode ?? (isInterviewRequest(question) ? "interview" : null);
}

/** What the model is asked: the tag's request, plus the user's own text as a focus. */
export function modelQuestion(mode: Mode | null, stored: string): string {
  if (!mode) return stored;
  const base = defaultQuestion(mode);
  const text = stored.trim();
  return !text || text === base ? base : `${base}. The user's focus: ${text}`;
}

const COMMON = `Rules for every part of the answer: use only what the material says about the video; do not use quotation marks; when you mention a number, copy it from the "Exact wording" list unchanged and never add a unit, rate or time window it does not contain; keep the video's problem, cause and fix apart. If the user gave a focus, emphasise it. No preamble and no recap table.`;

const SUMMARY_MODE = `## Deep summary mode (these instructions apply to your answer)
Write a deep summary of the video. This format overrides the usual length guidance.

${SUMMARY_RULES}

${COMMON}`;

const CHEATSHEET_MODE = `## Cheat-sheet mode (these instructions apply to your answer)
Write a cheat sheet to revise from. This format overrides the usual length guidance. Short lines only, no paragraphs. Use these bold sections, leaving out any the material has nothing for:
- **Key terms**: term, then its meaning as the video explains it.
- **Numbers to remember**: each with what it measures.
- **Rules and best practices**: the explicit recommendations.
- **Commands or snippets**: only ones the material actually shows.
- **Common mistakes**: pitfalls the material points out.
Mark anything from outside the material with "Beyond the video:".

${COMMON}`;

const QUIZ_MODE = `## Quiz mode (these instructions apply to your answer)
Write a revision quiz. This format overrides the usual length guidance.
- **Flashcards**: exactly 8, each as **Q:** a question, then **A:** the answer in one or two lines, all answerable from the material.
- **Self-test**: 3 harder questions that need reasoning, each with a one-line hint (not the answer).
Base the cards on the material only.

${COMMON}`;

/** The prompt block appended after the video's material for a tag. */
export function modeInstructions(mode: Mode): string {
  switch (mode) {
    case "interview": return `${INTERVIEW_INSTRUCTIONS}\n\n${COMMON}`;
    case "summary": return SUMMARY_MODE;
    case "cheatsheet": return CHEATSHEET_MODE;
    case "quiz": return QUIZ_MODE;
  }
}
