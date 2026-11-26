import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueue } from "./queue.js";
import { createReporter, JobCancelled, type ProgressRow } from "./reporter-core.js";
import { STAGE_ORDER, stageLabel, stageProgress } from "../services/progress.js";

describe("stage progress", () => {
  it("rises monotonically through the stages and stays within 0-100", () => {
    const marks = STAGE_ORDER.map((s) => stageProgress(s, 1, 1)); // end of each stage
    for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThanOrEqual(marks[i - 1]);
    expect(Math.min(...marks)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...marks)).toBe(100);
  });
  it("interpolates inside a stage and clamps bad counts", () => {
    expect(stageProgress("embedding", 0, 100)).toBe(22);
    expect(stageProgress("embedding", 50, 100)).toBe(37);
    expect(stageProgress("embedding", 100, 100)).toBe(52);
    expect(stageProgress("embedding", 500, 100)).toBe(52);
    expect(stageProgress("analyzing", -3, 18)).toBe(60);
    expect(stageProgress("analyzing", 5, 0)).toBe(60);
  });
  it("labels stages with their counts", () => {
    expect(stageLabel("embedding", 120, 208)).toBe("Indexing transcript (120 of 208 chunks)");
    expect(stageLabel("analyzing", 7, 18)).toBe("Analysing chapters (7 of 18)");
    expect(stageLabel("transcript")).toBe("Fetching transcript");
    expect(stageLabel("done")).toBe("Ready");
  });
});

describe("queue", () => {
  it("never runs more than the concurrency limit, and keeps order", async () => {
    let active = 0, peak = 0;
    const order: string[] = [];
    const q = createQueue(2);
    for (const k of ["a", "b", "c", "d"]) {
      q.add(k, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); order.push(k); active--; });
    }
    await q.idle();
    expect(peak).toBe(2);
    expect(order).toHaveLength(4);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
  });
  it("ignores a key that is already queued or running, then accepts it again", async () => {
    const q = createQueue(1);
    let runs = 0;
    expect(q.add("x", async () => { runs++; await new Promise((r) => setTimeout(r, 5)); })).toBe(true);
    expect(q.add("x", async () => { runs++; })).toBe(false);
    expect(q.keys()).toEqual(["x"]);
    await q.idle();
    expect(q.add("x", async () => { runs++; })).toBe(true);
    await q.idle();
    expect(runs).toBe(2);
  });
  it("keeps going after a task fails and reports the error", async () => {
    const errors: string[] = [];
    const q = createQueue(1, (k) => errors.push(k));
    let ran = false;
    q.add("bad", async () => { throw new Error("boom"); });
    q.add("good", async () => { ran = true; });
    await q.idle();
    expect(errors).toEqual(["bad"]);
    expect(ran).toBe(true);
  });
});

describe("reporter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces rapid updates into few writes, newest values winning", async () => {
    const writes: ProgressRow[] = [];
    const r = createReporter(async (row) => { writes.push(row); return true; });
    r.report({ stage: "embedding", total: 100 });
    for (let i = 1; i <= 50; i++) r.report({ done: i });
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes[writes.length - 1]).toMatchObject({ stage: "embedding", label: "Indexing transcript (50 of 100 chunks)" });
  });
  it("never reports progress going backwards", async () => {
    const writes: ProgressRow[] = [];
    const r = createReporter(async (row) => { writes.push(row); return true; });
    r.report({ stage: "analyzing", done: 10, total: 10 });
    await r.flush();
    r.report({ done: 2 }); // e.g. a retry restarting the count
    await r.flush();
    expect(writes[1].progress).toBeGreaterThanOrEqual(writes[0].progress);
  });
  it("shows a wait note and clears it when the stage changes", async () => {
    const writes: ProgressRow[] = [];
    const r = createReporter(async (row) => { writes.push(row); return true; });
    r.report({ stage: "analyzing", total: 5 });
    r.detail("Waiting for Groq rate limit (~20 s)");
    await r.flush();
    expect(writes.at(-1)!.detail).toContain("Groq rate limit");
    r.report({ stage: "overview" });
    await r.flush();
    expect(writes.at(-1)!.detail).toBe("");
  });
  it("cancels the job when the row is gone", async () => {
    const r = createReporter(async () => false);
    r.report({ stage: "transcript" });
    await r.flush();
    expect(r.cancelled).toBe(true);
    expect(() => r.assertAlive()).toThrow(JobCancelled);
  });
  it("survives a failing write", async () => {
    const r = createReporter(async () => { throw new Error("db down"); });
    r.report({ stage: "transcript" });
    await expect(r.flush()).resolves.toBeUndefined();
    expect(r.cancelled).toBe(false);
  });
});
