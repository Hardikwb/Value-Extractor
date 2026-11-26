// Answer-type tags for the chat bar. Keep the labels and default questions in step with server/src/services/modes.ts.
export type Mode = "interview" | "summary" | "cheatsheet" | "quiz";

export const MODE_LIST: { id: Mode; label: string; hint: string }[] = [
  { id: "interview", label: "Interview", hint: "A deep bullet-point summary, then the top 5 innovative, critical, high-level thinking questions" },
  { id: "summary", label: "Deep summary", hint: "A thorough summary in bullet points" },
  { id: "cheatsheet", label: "Cheat sheet", hint: "Key terms, numbers, rules and mistakes to remember" },
  { id: "quiz", label: "Quiz", hint: "8 flashcards plus 3 self-test questions" },
];

export const modeLabel = (m: Mode | null | undefined) => MODE_LIST.find((x) => x.id === m)?.label ?? "";

/** What the message reads as when a tag is sent without any text (the server stores the same wording). */
export function defaultQuestion(mode: Mode): string {
  switch (mode) {
    case "interview": return "Interview prep: a deep summary, then the top 5 innovative, critical, high-level thinking questions from this video";
    case "summary": return "Give me a deep summary of this video in bullet points";
    case "cheatsheet": return "Make me a cheat sheet from this video";
    case "quiz": return "Quiz me on this video";
  }
}
