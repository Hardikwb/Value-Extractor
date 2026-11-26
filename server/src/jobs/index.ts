import { query } from "../db/client.js";
import { processVideo } from "../services/ingest.js";
import { INSIGHTS_VERSION } from "../services/insights-utils.js";
import { backfillInsights, releaseClaims } from "../services/insights.js";
import { heartbeatGenerations, releaseGenerations, resumeStaleGenerations } from "../chat/generation.js";
import { heartbeat, ingestQueue, insightsQueue } from "./runner.js";

/**
 * Picks up work nobody is doing: videos whose processing stopped (server restart or crash; their heartbeat went
 * stale) and videos whose detailed breakdown is unfinished. Claims are atomic, so several servers never double up.
 */
export async function recoverJobs(): Promise<void> {
  const stale = await query<{ id: string }>(
    `UPDATE videos SET job_heartbeat = now()
     WHERE status = 'processing' AND (job_heartbeat IS NULL OR job_heartbeat < now() - interval '3 minutes')
     RETURNING id`,
  );
  for (const v of stale) {
    console.log(`Resuming interrupted processing for video ${v.id}`);
    ingestQueue.add(v.id, () => processVideo(v.id));
  }
  // Self-heal: a finished video must not be left showing an old stage (e.g. a job that was cut short).
  await query(
    `UPDATE videos SET stage = 'done', progress = 100, stage_label = 'Ready', stage_detail = ''
     WHERE status = 'ready' AND insights_version >= $1 AND stage <> 'done'
       AND (job_heartbeat IS NULL OR job_heartbeat < now() - interval '3 minutes')`,
    [INSIGHTS_VERSION],
  );
  await resumeStaleGenerations();
  await backfillInsights();
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startJobs(): void {
  const safe = (label: string, fn: () => Promise<void>) => fn().catch((e) => console.error(`${label} failed:`, e?.message ?? e));
  void safe("Job recovery", recoverJobs);
  let tick = 0;
  timer ??= setInterval(() => {
    void safe("Heartbeat", async () => { await heartbeat(); await heartbeatGenerations(); });
    if (++tick % 2 === 0) void safe("Job recovery", recoverJobs); // every minute
  }, 30000);
  timer.unref?.();
}

/** On shutdown, let the next start take over immediately instead of waiting for the heartbeat to go stale. */
export async function releaseJobs(): Promise<void> {
  const ids = [...new Set([...ingestQueue.keys(), ...insightsQueue.keys()])];
  if (ids.length) await query("UPDATE videos SET job_heartbeat = NULL WHERE id = ANY($1::uuid[])", [ids]).catch(() => {});
  await releaseGenerations();
  await releaseClaims();
}
