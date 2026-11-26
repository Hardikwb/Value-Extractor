import { LIST_COLS } from "../db/columns.js";
import { query, toVector } from "../db/client.js";
import { ingestQueue, insightsQueue, withJob } from "../jobs/runner.js";
import { JobCancelled } from "../jobs/reporter-core.js";
import { stageLabel } from "./progress.js";
import { categorize } from "./categorize.js";
import { chunkTranscript } from "./chunker.js";
import { EMBED_MODEL_ID, embedDocs } from "./embeddings.js";
import { INSIGHTS_VERSION } from "./insights-utils.js";
import { runInsights } from "./insights.js";
import { loadTranscript } from "./transcript.js";
import { extractVideoId, fetchTitle, friendlyTranscriptError } from "./youtube.js";

export class IngestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const BATCH = 25;

const queueIngest = (id: string) => ingestQueue.add(id, () => processVideo(id));

/** Puts a video back at the start of the queue (used for retries and re-indexing). */
export async function requeue(id: string): Promise<void> {
  await query(
    `UPDATE videos SET status = 'processing', stage = 'queued', progress = 0, stage_label = $2, stage_detail = '',
       error = '', job_heartbeat = now() WHERE id = $1`,
    [id, stageLabel("queued")],
  );
  queueIngest(id);
}

/**
 * Fast part of adding a video: validate, create the row (or re-queue an existing one) and hand the work to
 * the background queue. Returns the video row straight away; progress is read from it afterwards.
 */
export async function startIngest(url: string, mine: { description?: string; notes?: string } = {}): Promise<Record<string, any>> {
  const youtubeId = extractVideoId(url);
  if (!youtubeId) throw new IngestError("Not a valid YouTube URL");

  // One round trip for a new video. ON CONFLICT also closes the race between two simultaneous requests.
  const [created] = await query(
    `INSERT INTO videos (youtube_id, url, title, status, embed_model, stage, progress, stage_label, job_heartbeat, user_description, user_notes)
     VALUES ($1, $2, 'Loading video…', 'processing', $3, 'queued', 0, $4, now(), $5, $6)
     ON CONFLICT (youtube_id) DO NOTHING RETURNING ${LIST_COLS}`,
    [youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`, EMBED_MODEL_ID, stageLabel("queued"), mine.description ?? "", mine.notes ?? ""],
  );
  if (created) {
    queueIngest(created.id);
    return created;
  }

  const [existing] = await query(`SELECT ${LIST_COLS}, embed_model FROM videos WHERE youtube_id = $1`, [youtubeId]);
  if (!existing || existing.status === "processing") throw new IngestError("This video is already being processed.", 409);
  const { embed_model, ...row } = existing;
  // Adding a video that is already in the library with notes attaches the notes to it.
  if (mine.description || mine.notes) {
    await query("UPDATE videos SET user_description = $2, user_notes = $3 WHERE id = $1", [row.id, mine.description ?? "", mine.notes ?? ""]);
  }
  // Failed earlier, or indexed with an older embedding model: process again in place (chats are kept).
  if (row.status === "failed" || embed_model !== EMBED_MODEL_ID) {
    await requeue(row.id);
    return { ...row, status: "processing", stage: "queued", progress: 0, stage_label: stageLabel("queued"), stage_detail: "", error: "" };
  }
  return row;
}

/** The slow part, run by the queue: fetch, categorize, embed, store. Reports each stage as it goes. */
export async function processVideo(id: string): Promise<void> {
  const [v] = await query<{ youtube_id: string; status: string }>("SELECT youtube_id, status FROM videos WHERE id = $1", [id]);
  if (!v || v.status !== "processing") return; // deleted, or already handled

  await withJob(id, async (r) => {
    try {
      r.report({ stage: "transcript" });
      let segments, source;
      try {
        ({ segments, source } = await loadTranscript(v.youtube_id));
      } catch (e: any) {
        throw new IngestError(`Could not read the transcript. ${friendlyTranscriptError(e)}`, 422);
      }
      r.assertAlive();

      r.report({ stage: "metadata" });
      const title = await fetchTitle(v.youtube_id);
      r.assertAlive();

      r.report({ stage: "categorizing" });
      const meta = await categorize(title, segments.map((s) => s.text).join(" "));
      await query("UPDATE videos SET title = $2, category = $3, tags = $4, summary = $5, transcript_lang = $6, transcript_translated = $7 WHERE id = $1", [id, title, meta.category, meta.tags, meta.summary, source.lang, source.translated]);
      r.assertAlive();

      const chunks = chunkTranscript(segments);
      r.report({ stage: "embedding", done: 0, total: chunks.length });
      const vectors = await embedDocs(chunks.map((c) => c.text), 16, (done) => { r.report({ done }); r.assertAlive(); });

      r.report({ stage: "saving", done: 0, total: chunks.length });
      await query("DELETE FROM transcript_chunks WHERE video_id = $1", [id]); // re-processing replaces the old index
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        await query(
          `INSERT INTO transcript_chunks (video_id, idx, start_seconds, text, embedding)
           SELECT $1::uuid, t.idx, t.s, t.txt, t.emb::vector
           FROM unnest($2::int[], $3::int[], $4::text[], $5::text[]) AS t(idx, s, txt, emb)`,
          [id, slice.map((c) => c.idx), slice.map((c) => c.startSeconds), slice.map((c) => c.text), vectors.slice(i, i + BATCH).map(toVector)],
        );
        r.report({ done: Math.min(i + BATCH, chunks.length) });
        r.assertAlive();
      }

      // Chat works from here on. If the detailed breakdown already exists (re-indexing in place) we are done;
      // otherwise it continues in the background.
      const [ready] = await query<{ insights_version: number }>(
        "UPDATE videos SET status = 'ready', embed_model = $2, error = '' WHERE id = $1 RETURNING insights_version", [id, EMBED_MODEL_ID]);
      if (ready && ready.insights_version >= INSIGHTS_VERSION) {
        r.report({ stage: "done" });
        await r.flush();
      } else {
        r.report({ stage: "analyzing", detail: "Chat is ready. Building the detailed breakdown…" });
        await r.flush();
        insightsQueue.add(id, async () => { await runInsights(id, segments).catch((e) => console.error("Insights failed:", e?.message ?? e)); });
      }
    } catch (e: any) {
      if (e instanceof JobCancelled || r.cancelled) return; // the video was deleted: nothing left to report
      // A write racing with a delete (for example a foreign-key error) also means "cancelled", not "failed".
      const [still] = await query("SELECT 1 AS ok FROM videos WHERE id = $1", [id]).catch(() => [{ ok: 1 }]);
      if (!still) return;
      r.cancel(); // stop pending progress writes from overwriting the failure
      const message = e instanceof IngestError ? e.message : `Something went wrong while processing: ${e?.message ?? e}`;
      console.error(`Processing failed for ${v.youtube_id}:`, message);
      await query(
        "UPDATE videos SET status = 'failed', stage = 'failed', stage_label = 'Failed', stage_detail = '', error = $2 WHERE id = $1",
        [id, message],
      );
    }
  });
}
