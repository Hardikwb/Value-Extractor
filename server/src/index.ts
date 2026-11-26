import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { releaseJobs, startJobs } from "./jobs/index.js";
import { chats } from "./routes/chat.js";
import { videos } from "./routes/videos.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => void res.json({ ok: true }));
app.use("/api/videos", videos);
app.use("/api/chats", chats);

// When the web app has been built (pnpm bg:start does this), serve it from the same process and port as the API,
// so one background process is the whole app.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
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

// Keep the schema in step with the code. A brief network problem must not leave the app down for good,
// so connection failures are retried (with growing pauses) until the database answers.
for (let attempt = 1; ; attempt++) {
  try {
    await runMigrations(false);
    break;
  } catch (e: any) {
    if (!isConnectionProblem(e)) {
      console.error("Database migration failed, not starting:", e);
      process.exit(1);
    }
    const wait = Math.min(3000 * attempt, 30000);
    console.error(`Database not reachable yet (attempt ${attempt}). Retrying in ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
app.listen(config.PORT, () => {
  console.log(`API on http://localhost:${config.PORT}`);
  startJobs();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { releaseJobs().finally(() => process.exit(0)); });
}
