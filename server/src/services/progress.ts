// Stages of adding a video and how far along each one is. Pure (no DB / env) so it can be unit tested.

export type Stage =
  | "queued" | "transcript" | "metadata" | "categorizing" | "embedding"
  | "saving" | "analyzing" | "overview" | "done" | "failed";

/** Where each stage sits on the 0-100 bar. Chat becomes available at the end of "saving" (60). */
const RANGES: Record<Exclude<Stage, "failed">, [number, number]> = {
  queued: [0, 0],
  transcript: [0, 10],
  metadata: [10, 15],
  categorizing: [15, 22],
  embedding: [22, 52],
  saving: [52, 60],
  analyzing: [60, 96],
  overview: [96, 99],
  done: [100, 100],
};

export const STAGE_ORDER: Exclude<Stage, "failed">[] = [
  "queued", "transcript", "metadata", "categorizing", "embedding", "saving", "analyzing", "overview", "done",
];

/** 0-100 for a stage plus how many of its items are finished. Never outside the stage's own range. */
export function stageProgress(stage: Stage, done = 0, total = 0): number {
  if (stage === "failed") return 0;
  const [a, b] = RANGES[stage];
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return Math.round(a + (b - a) * frac);
}

export function stageLabel(stage: Stage, done = 0, total = 0): string {
  const count = total > 0 ? ` (${Math.min(done, total)} of ${total}${stage === "embedding" ? " chunks" : ""})` : "";
  switch (stage) {
    case "queued": return "Waiting in queue";
    case "transcript": return "Fetching transcript";
    case "metadata": return "Reading video details";
    case "categorizing": return "Categorizing the video";
    case "embedding": return `Indexing transcript${count}`;
    case "saving": return `Saving the index${count}`;
    case "analyzing": return `Analysing chapters${count}`;
    case "overview": return "Writing the overview";
    case "done": return "Ready";
    case "failed": return "Failed";
  }
}

/** Chat works once the transcript is indexed (progress reached the end of "saving"). */
export const isChatReady = (status: string) => status === "ready";
