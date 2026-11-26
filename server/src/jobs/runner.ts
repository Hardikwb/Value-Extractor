import { query } from "../db/client.js";
import { createQueue } from "./queue.js";
import { createReporter, runWithReporter, type Reporter } from "./reporter-core.js";
import type { Stage } from "../services/progress.js";

// Ingest (embedding is CPU heavy) and insights (Groq has tight free-tier limits) each run one job at a time.
export const ingestQueue = createQueue(1, (id, e: any) => console.error(`Ingest job ${id} crashed:`, e?.message ?? e));
export const insightsQueue = createQueue(1, (id, e: any) => console.error(`Insights job ${id} crashed:`, e?.message ?? e));

const live = new Map<string, Reporter>();

/**
 * Runs `fn` with a progress reporter writing to the video's row. If the row is deleted while the job
 * runs, the reporter is cancelled and the job stops at its next `assertAlive()`.
 */
export async function withJob<T>(videoId: string, fn: (r: Reporter) => Promise<T>, startStage: Stage = "queued"): Promise<T> {
  const r = createReporter(
    async (row) => {
      const rows = await query(
        `UPDATE videos SET stage = $2, progress = $3, stage_label = $4, stage_detail = $5, job_heartbeat = now()
         WHERE id = $1 RETURNING id`,
        [videoId, row.stage, row.progress, row.label, row.detail],
      );
      return rows.length > 0;
    },
    { startStage },
  );
  live.set(videoId, r);
  try {
    return await runWithReporter(r, () => fn(r));
  } finally {
    await r.flush().catch(() => {});
    live.delete(videoId);
  }
}

/** Marks every queued/running job as alive (so other servers do not take them over) and notices deleted videos. */
export async function heartbeat(): Promise<void> {
  const ids = [...new Set([...ingestQueue.keys(), ...insightsQueue.keys()])];
  if (!ids.length) return;
  const rows = await query<{ id: string }>(
    `UPDATE videos SET job_heartbeat = now(), insights_started_at = CASE WHEN insights_started_at IS NOT NULL THEN now() ELSE NULL END
     WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids],
  );
  const alive = new Set(rows.map((r) => r.id));
  for (const id of ids) if (!alive.has(id)) live.get(id)?.cancel(); // deleted while waiting or running
}
