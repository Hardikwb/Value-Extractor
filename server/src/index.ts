import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { recoverJobs, releaseJobs, startJobs } from "./jobs/index.js";
import { setKeepAlive } from "./jobs/queue.js";
import { chats } from "./routes/chat.js";
import { videos } from "./routes/videos.js";

const app = express();
app.use(cors());
app.use(express.json());

const onVercel = !!process.env.VERCEL;
if (onVercel) {
  // Serverless: no listen(). Migrate lazily once per instance, keep background work alive with waitUntil,
  // and let the cron route resume anything that stalled.
  const { waitUntil } = await import("@vercel/functions");
  setKeepAlive(waitUntil);
  let ready: Promise<void> | undefined;
  app.use((_req, _res, next) => { (ready ??= migrate().catch((e) => { ready = undefined; throw e; })).then(() => next(), next); });
  app.get("/api/cron/recover", (req, res, next) => {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return void res.status(401).json({ error: "Unauthorized" });
    const job = recoverJobs();
    waitUntil(job.catch(() => {}));
    job.then(() => res.json({ ok: true }), next);
  });
}

app.get("/api/health", (_req, res) => void res.json({ ok: true }));
app.use("/api/videos", videos);
app.use("/api/chats", chats);

// Locally, serve a built web app from the same process. On Vercel the web is its own service.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (!onVercel && existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(`${webDist}/index.html`));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return void res.status(400).json({ error: err.issues.map((i) => i.message).join("; ") });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

/** True for "could not reach the database" problems (worth retrying), false for real SQL errors. */
const isConnectionProblem = (e: any) =>
  /Error connecting to database|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|Connect Timeout|UND_ERR/i.test(
    `${e?.message} ${e?.sourceError?.cause?.code ?? ""} ${e?.cause?.code ?? ""}`);

async function migrate(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations(false);
      return;
    } catch (e: any) {
      if (!isConnectionProblem(e)) throw e;
      const wait = Math.min(3000 * attempt, 30000);
      console.error(`Database not reachable yet (attempt ${attempt}). Retrying in ${wait / 1000}s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

if (!onVercel) {
  try { await migrate(); } catch (e) { console.error("Database migration failed, not starting:", e); process.exit(1); }
  app.listen(config.PORT, () => {
    console.log(`API on http://localhost:${config.PORT}`);
    startJobs();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { releaseJobs().finally(() => process.exit(0)); });
  }
}

export default app;
