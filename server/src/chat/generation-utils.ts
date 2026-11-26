// Pure helpers for background answer generation (no DB / env access) so they can be unit tested.

export type MsgStatus = "generating" | "done" | "incomplete" | "stopped";

/** How many times a cut-off answer is continued automatically before it is flagged as incomplete. */
export const MAX_AUTO_CONTINUES = 2;

export const shouldAutoContinue = (finishReason: string, attempts: number): boolean =>
  finishReason === "length" && attempts < MAX_AUTO_CONTINUES;

/** The state an answer ends in. A cut-off or failed answer is never presented as finished. */
export function finalStatus(o: { reason: string; stopped: boolean; failed: boolean }): MsgStatus {
  if (o.stopped) return "stopped";
  if (o.failed || o.reason === "length") return "incomplete";
  return "done";
}

/** What the model should see as earlier conversation: only finished messages, newest `limit`. */
export function modelHistory<T extends { status: string }>(rows: T[], limit = 12): T[] {
  return rows.filter((r) => r.status === "done").slice(-limit);
}

export const defaultTitle = (question: string) => question.replace(/\s+/g, " ").trim().slice(0, 60);

/** Tidy a model-written chat title: single line, no quotes or trailing punctuation, at most 60 chars. */
export function cleanTitle(raw: string): string {
  const t = raw.split("\n")[0]
    .replace(/^\s*title\s*:\s*/i, "")
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, "")
    .trim();
  return t.length > 60 ? t.slice(0, 57).trimEnd() + "…" : t;
}
