import { AsyncLocalStorage } from "node:async_hooks";
import { stageLabel, stageProgress, type Stage } from "../services/progress.js";

// Reports a job's progress. Updates are merged and written at most every `minIntervalMs`, in order,
// without ever blocking the job. A write that reports the row is gone means the video was deleted,
// which cancels the job. Pure apart from the injected `write`, so it can be unit tested.

export class JobCancelled extends Error {
  constructor() { super("job cancelled"); }
}

export interface ProgressRow { stage: Stage; progress: number; label: string; detail: string }

export interface Reporter {
  /** Merge an update. Changing the stage resets the counts unless they are given. */
  report(p: { stage?: Stage; done?: number; total?: number; detail?: string }): void;
  /** Set only the side note (e.g. waiting for a rate limit). */
  detail(text: string): void;
  /** Throws JobCancelled if the video was deleted. Call between steps. */
  assertAlive(): void;
  /** Write whatever is pending now and wait for it. */
  flush(): Promise<void>;
  cancel(): void;
  readonly cancelled: boolean;
}

export function createReporter(
  write: (row: ProgressRow) => Promise<boolean>, // false = the row no longer exists
  opts: { minIntervalMs?: number; stageChangeIntervalMs?: number; startStage?: Stage } = {},
): Reporter {
  const minInterval = opts.minIntervalMs ?? 1500;
  const stageInterval = opts.stageChangeIntervalMs ?? 300;
  let stage: Stage = opts.startStage ?? "queued";
  let done = 0, total = 0, detail = "";
  let best = 0; // progress never goes backwards within one job
  let dirty = false, cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWrite = 0;
  let chain: Promise<void> = Promise.resolve();

  const snapshot = (): ProgressRow => {
    let progress = stageProgress(stage, done, total);
    if (stage !== "failed") { best = Math.max(best, progress); progress = best; }
    return { stage, progress, label: stageLabel(stage, done, total), detail };
  };

  const writeNow = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || cancelled) return chain;
    dirty = false;
    const row = snapshot();
    lastWrite = Date.now();
    chain = chain.then(async () => {
      try { if (!(await write(row))) cancelled = true; } catch { /* progress is best effort */ }
    });
    return chain;
  };

  const schedule = (urgent: boolean) => {
    dirty = true;
    if (timer) return;
    const wait = Math.max(0, (urgent ? stageInterval : minInterval) - (Date.now() - lastWrite));
    timer = setTimeout(() => { timer = null; void writeNow(); }, wait);
  };

  return {
    report(p) {
      const changed = p.stage !== undefined && p.stage !== stage;
      if (changed) { stage = p.stage!; done = 0; total = 0; detail = ""; }
      if (p.done !== undefined) done = p.done;
      if (p.total !== undefined) total = p.total;
      if (p.detail !== undefined) detail = p.detail;
      schedule(changed);
    },
    detail(text) {
      if (text === detail) return;
      detail = text;
      schedule(true);
    },
    assertAlive() { if (cancelled) throw new JobCancelled(); },
    flush: () => { dirty = true; return writeNow(); },
    cancel() { cancelled = true; if (timer) { clearTimeout(timer); timer = null; } },
    get cancelled() { return cancelled; },
  };
}

const als = new AsyncLocalStorage<Reporter>();
export const currentReporter = (): Reporter | undefined => als.getStore();
export const runWithReporter = <T>(r: Reporter, fn: () => Promise<T>): Promise<T> => als.run(r, fn);
