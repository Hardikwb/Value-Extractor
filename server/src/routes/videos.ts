import { Router } from "express";
import { z } from "zod";
import { LIST_COLS } from "../db/columns.js";
import { query } from "../db/client.js";
import { IngestError, requeue, startIngest } from "../services/ingest.js";
import { refreshOverview, runInsights } from "../services/insights.js";

export const videos = Router();

// Adding a video returns at once; the work (and its progress) lives in the background and in the video's row.
videos.post("/", async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
    res.status(202).json(await startIngest(url));
  } catch (e) {
    if (e instanceof IngestError) return void res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Includes videos still processing or failed, so the UI can show their progress.
videos.get("/", async (req, res, next) => {
  try {
    const category = typeof req.query.category === "string" ? req.query.category : null;
    res.json(await query(
      `SELECT ${LIST_COLS} FROM videos WHERE ($1::text IS NULL OR category = $1) ORDER BY created_at DESC`,
      [category]));
  } catch (e) { next(e); }
});

// One video including the full breakdown.
videos.get("/:id", async (req, res, next) => {
  try {
    const [v] = await query(`SELECT ${LIST_COLS}, deep_summary FROM videos WHERE id = $1`, [req.params.id]);
    v ? res.json(v) : res.status(404).json({ error: "Not found" });
  } catch (e) { next(e); }
});

// Deleting a video that is still processing cancels its job (the progress writer notices the missing row).
videos.delete("/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM videos WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

// Try a failed video again from the start.
videos.post("/:id/retry", async (req, res, next) => {
  try {
    const [v] = await query<{ id: string; status: string }>("SELECT id, status FROM videos WHERE id = $1", [req.params.id]);
    if (!v) return void res.status(404).json({ error: "Not found" });
    if (v.status === "processing") return void res.status(409).json({ error: "This video is already being processed." });
    await requeue(v.id);
    res.status(202).json({ status: "queued" });
  } catch (e) { next(e); }
});

// Rebuilds the detailed breakdown in the background (re-reads transcript, description and chapters).
// Reuses saved chapter results unless ?fresh=1; ?overview=1 re-runs only the overview step.
const rebuild = async (req: any, res: any, next: any) => {
  try {
    const [v] = await query("SELECT id FROM videos WHERE id = $1 AND status = 'ready'", [req.params.id]);
    if (!v) return void res.status(404).json({ error: "Not found" });
    if (req.query.overview === "1") {
      refreshOverview(v.id).catch((e: any) => console.error("Overview refresh failed:", e?.message ?? e));
      return void res.status(202).json({ status: "overview refresh started" });
    }
    runInsights(v.id, undefined, true, req.query.fresh === "1").catch((e: any) => console.error("Insights rebuild failed:", e?.message ?? e));
    res.status(202).json({ status: "detailed breakdown started" });
  } catch (e) { next(e); }
};
videos.post("/:id/insights", rebuild);
videos.post("/:id/outline", rebuild); // old name
