// Pure helpers (no DB / env access) so they can be unit tested.

export interface Turn { role: "user" | "assistant"; content: string }

const GLOBAL_RE = new RegExp(
  "\\b(" +
    [
      "summari[sz]e", "summary", "overview", "outline", "tl;?dr", "table of contents", "agenda", "chapters?",
      "key (points|takeaways|ideas)", "main (points|ideas|topics|takeaways)", "takeaways?", "learn next",
      "what (is|does|do) (this|the) (video|course|tutorial|talk|lecture|episode) (about|cover|teach)",
      "what('s| is) covered", "(list|name|extract|give me) (all|every)", "(every|all( the)?) (tools?|technologies|topics|concepts|values|numbers|links|resources|names|people|steps)",
      "links?", "urls?", "resources?", "repos?", "repositor(y|ies)", "github", "references?",
      "speakers?", "presenters?", "who (is|are|was|were) (the )?(speaker|presenter|host|guest|people|engineers)s?",
      "in detail", "detailed", "deep dive", "thorough(ly)?", "comprehensive(ly)?", "everything", "break ?down",
    ].join("|") +
    ")\\b",
  "i",
);

/** Questions about the whole video, which similarity search over a few chunks cannot answer. */
export function isGlobalQuestion(q: string): boolean {
  return GLOBAL_RE.test(q);
}

/** Keep the last `maxTurns` messages and clip long assistant replies to protect the token budget. */
export function clipHistory(history: Turn[], maxTurns = 6, maxAssistantChars = 1500): Turn[] {
  return history.slice(-maxTurns).map((t) =>
    t.role === "assistant" && t.content.length > maxAssistantChars
      ? { ...t, content: t.content.slice(0, maxAssistantChars) + " […]" }
      : t,
  );
}

/** Reciprocal rank fusion over several best-first lists of ids. */
export function rrf(lists: (string | number)[][], k = 60): Map<string | number, number> {
  const scores = new Map<string | number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

const STOP = new Set(
  "the and for are but not you your with this that from have has had was were what when where which who whom how why does did can could would should about into over than then them they their there here also just like some any all its it's is in on of to a an or as at by be do if so we me my i".split(" "),
);

/** Safe OR-tsquery string built from the meaningful words of a question, or null. */
export function toTsQuery(q: string): string | null {
  const terms = [...new Set((q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2 && !STOP.has(w)))];
  return terms.length ? terms.slice(0, 12).join(" | ") : null;
}

/** Long transcripts: take the start, middle and end so the result reflects the whole video. */
export function sampleText(text: string, part = 3000): string {
  if (text.length <= part * 3) return text;
  const mid = Math.floor(text.length / 2) - part / 2;
  return [text.slice(0, part), text.slice(mid, mid + part), text.slice(-part)].join("\n[…]\n");
}

const FOLLOW_UP_RE = /\b(it|its|that|this|these|those|they|them|their|he|she|there|then|above|previous|earlier|former|latter|same|other|one)\b/i;

/** Only questions that lean on earlier turns need an LLM rewrite before searching. */
export function needsRewrite(q: string, hasHistory: boolean): boolean {
  if (!hasHistory) return false;
  const words = q.trim().split(/\s+/).length;
  return words <= 3 || FOLLOW_UP_RE.test(q);
}

export const CONTINUE_PROMPT = "Continue exactly where you stopped. Do not repeat anything you already wrote and do not start over.";

/** The text to quote so the model resumes at the exact spot (not mid-word, not from an earlier point). */
export const tailOf = (partial: string, n = 120): string => partial.slice(-n).replace(/\s+$/, "");

/** The model's input for continuing an interrupted answer: the original conversation, the partial answer, then a nudge. */
export function buildContinuation<T extends { role: string; content: string }>(base: T[], partial: string): (T | { role: "assistant" | "user"; content: string })[] {
  const nudge = `${CONTINUE_PROMPT} Your answer so far ended with:\n\n"""${tailOf(partial)}"""\n\nWrite only what comes next, starting with the very next character after that text.`;
  return [...base, { role: "assistant", content: partial }, { role: "user", content: nudge }];
}
