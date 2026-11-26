import { query } from "../db/client.js";
import { runWithReporter, type Reporter } from "../jobs/reporter-core.js";
import { createQueue } from "../jobs/queue.js";
import { complete, friendlyError } from "../services/llm.js";
import { findUnsupportedRates, REPAIR_SYSTEM, validRepair } from "../services/interview.js";
import { effectiveMode, parseMode, type Mode } from "../services/modes.js";
import { answer, interviewMaterial } from "../services/rag.js";
import type { Turn } from "../services/retrieval-utils.js";
import { cleanTitle, defaultTitle, finalStatus, modelHistory, shouldAutoContinue, type MsgStatus } from "./generation-utils.js";

// An answer is written by the server in the background. The browser can subscribe to watch it live, but
// closing the page only removes the subscriber: generation continues and the result is saved to the database.

export type GenEvent = { delta: string } | { replace: string } | { done: true; status: MsgStatus; error: string };

export interface Live {
  id: number;
  chatId: string;
  content: string;
  status: MsgStatus;
  error: string;
  abort: AbortController;
  listeners: Set<(ev: GenEvent) => void>;
  stopRequested: boolean;
  /** transient note while generating (e.g. waiting for a rate limit); stored in the row's error column */
  note: string;
}

export interface GenParams {
  assistantId: number;
  chatId: string;
  videoId: string | null;
  question: string;
  history: Turn[];
  continueFrom?: string;
  firstAnswer?: boolean;
  /** answer-type tag chosen with the question; stored with it so Continue, recovery and Edit keep it */
  mode?: Mode | null;
}

const live = new Map<number, Live>();
const generationQueue = createQueue(3, (id, e: any) => console.error(`Answer ${id} crashed:`, e?.message ?? e));
const FLUSH_MS = 1500;
const FIRST_FLUSH_MS = 300; // save the first text quickly so a page opened mid-answer shows it

export const liveIds = () => [...live.keys()];

export function subscribe(id: number, fn: (ev: GenEvent) => void): (() => void) | null {
  const g = live.get(id);
  if (!g) return null;
  g.listeners.add(fn);
  return () => g.listeners.delete(fn);
}

export function startGeneration(p: GenParams): Live {
  const g: Live = {
    id: p.assistantId, chatId: p.chatId, content: p.continueFrom ?? "", status: "generating", error: "",
    abort: new AbortController(), listeners: new Set(), stopRequested: false, note: "",
  };
  live.set(g.id, g);
  generationQueue.add(String(g.id), () => run(g, p));
  return g;
}

const emit = (g: Live, ev: GenEvent) => g.listeners.forEach((fn) => { try { fn(ev); } catch { /* a closed connection must not affect the answer */ } });

/** The retry helper reports rate-limit waits through this; they become a note on the message while it is generating. */
function noteReporter(g: Live, schedule: () => void): Reporter {
  return {
    report() {}, assertAlive() {}, flush: async () => {}, cancel() {}, cancelled: false,
    detail(text: string) { if (text !== g.note) { g.note = text; schedule(); } },
  };
}

async function run(g: Live, p: GenParams): Promise<void> {
  let dirty = false, removed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  // Saves the text so far (and doubles as the heartbeat). It also notices the message was changed elsewhere:
  // deleted (edit / chat removed) means stop quietly; stopped by another server means stop and keep the text.
  const writeNow = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return chain;
    dirty = false;
    const content = g.content, note = g.note;
    chain = chain.then(async () => {
      try {
        const rows = await query("UPDATE messages SET content = $2, error = $3, updated_at = now() WHERE id = $1 AND status = 'generating' RETURNING id", [g.id, content, note]);
        if (!rows.length) {
          const [now] = await query<{ status: string }>("SELECT status FROM messages WHERE id = $1", [g.id]);
          if (!now) removed = true;
          else g.stopRequested = true; // stopped elsewhere
          g.abort.abort();
        }
      } catch { /* best effort */ }
    });
    return chain;
  };
  let wrote = false;
  const schedule = () => { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; wrote = true; void writeNow(); }, wrote ? FLUSH_MS : FIRST_FLUSH_MS); };

  let reason = "";
  let failure = "";
  let compact = false; // switched on if the model rejects the prompt as too large for its per-request token cap
  try {
    await runWithReporter(noteReporter(g, schedule), async () => {
      for (let attempts = 0; ; attempts++) {
        reason = "";
        const continueFrom = g.content.trim() ? g.content : undefined;
        try {
          for await (const delta of answer({
            videoId: p.videoId, question: p.question, history: p.history, signal: g.abort.signal, continueFrom, compact, mode: p.mode,
            onFinish: (r) => { reason = r; },
          })) {
            if (g.note) { g.note = ""; schedule(); } // tokens are flowing again
            g.content += delta;
            emit(g, { delta });
            schedule();
          }
        } catch (e: any) {
          if (e?.status === 413 && !compact) { compact = true; attempts--; console.warn(`Answer ${g.id}: prompt too large, retrying with a compact prompt`); continue; }
          throw e;
        }
        if (!shouldAutoContinue(reason, attempts)) break; // finished, or still cut off after the automatic continuations
      }
    });
  } catch (e: any) {
    if (!g.stopRequested && !removed) {
      failure = friendlyError(e);
      console.error(`Answer ${g.id} failed:`, String(e?.message ?? e).slice(0, 300));
    }
  }

  // Interview answers: models invent rates ("50,000 per minute"). Check against the video's own text and fix once.
  if (!failure && !g.stopRequested && !removed && reason !== "length" && p.videoId && effectiveMode(p.mode, p.question) === "interview") {
    try {
      const { text: material, facts } = await interviewMaterial(p.videoId);
      const bad = findUnsupportedRates(g.content, material);
      if (bad.length) {
        console.warn(`Answer ${g.id}: unsupported rate phrases (${bad.join(", ")}); running a correction pass`);
        const fixed = await complete(
          [
            { role: "system", content: REPAIR_SYSTEM },
            { role: "user", content: `Exact wording from the source:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nPhrases to remove: ${bad.join(", ")}\n\nDRAFT:\n${g.content}` },
          ],
          { maxTokens: 6000 },
        );
        if (validRepair(g.content, fixed) && findUnsupportedRates(fixed, material).length === 0) {
          g.content = fixed.trim();
          emit(g, { replace: g.content });
          dirty = true;
        }
      }
    } catch (e: any) {
      console.warn(`Answer ${g.id}: correction pass skipped:`, String(e?.message ?? e).slice(0, 160)); // keep the original answer
    }
  }

  if (timer) { clearTimeout(timer); timer = null; }
  await chain;

  const status = finalStatus({ reason, stopped: g.stopRequested, failed: !!failure });
  const error = failure || (reason === "length" ? "The answer was cut off by the model's length limit." : "");
  g.status = status;
  g.error = error;
  if (!removed) {
    await query(
      "UPDATE messages SET content = $2, status = $3, error = $4, finish_reason = $5, updated_at = now() WHERE id = $1",
      [g.id, g.content, status, error, reason],
    ).catch((e) => console.error("Could not save the answer:", e?.message ?? e));
    await query("UPDATE chats SET updated_at = now() WHERE id = $1", [g.chatId]).catch(() => {});
  }
  live.delete(g.id); // only now: until the result is saved, the answer still counts as running here
  emit(g, { done: true, status, error });
  if (status === "done" && p.firstAnswer && !removed) void autoTitle(g.chatId, p.question);
}

/** After the first answer, replace the "first 60 characters of the question" title with a short descriptive one. */
async function autoTitle(chatId: string, question: string): Promise<void> {
  try {
    const current = defaultTitle(question);
    const raw = await complete(
      [
        { role: "system", content: "Write a title of 3 to 6 words for a conversation that starts with this question about a video. Output only the title." },
        { role: "user", content: question.slice(0, 500) },
      ],
      { maxTokens: 200 },
    );
    const title = cleanTitle(raw);
    if (title.length >= 3) await query("UPDATE chats SET title = $2 WHERE id = $1 AND title = $3", [chatId, title, current]);
  } catch { /* keep the question as the title */ }
}

/** Stop is the only thing that cancels an answer (closing the page does not). */
export async function stopGeneration(id: number): Promise<boolean> {
  const g = live.get(id);
  if (g) { g.stopRequested = true; g.abort.abort(); return true; }
  // Not running here (another server, or already finished): mark it, and its writer will notice and stop.
  const rows = await query("UPDATE messages SET status = 'stopped' WHERE id = $1 AND status = 'generating' RETURNING id", [id]);
  return rows.length > 0;
}

/** Abort answers being written in a chat (from `fromId` on); used by edit and chat delete. */
export function abortChatGenerations(chatId: string, fromId = 0): void {
  for (const g of live.values()) if (g.chatId === chatId && g.id >= fromId) { g.stopRequested = true; g.abort.abort(); }
}

/** Everything needed to (re)generate an assistant message: its question, the video and the earlier finished messages. */
async function loadContext(assistantId: number) {
  const [a] = await query<{ id: number; chat_id: string; content: string; video_id: string | null }>(
    `SELECT m.id, m.chat_id, m.content, c.video_id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = $1 AND m.role = 'assistant'`, [assistantId]);
  if (!a) return null;
  const [q] = await query<{ id: number; content: string; mode: string | null }>(
    "SELECT id, content, mode FROM messages WHERE chat_id = $1 AND role = 'user' AND id < $2 ORDER BY id DESC LIMIT 1", [a.chat_id, a.id]);
  if (!q) return null;
  const earlier = await query<{ role: "user" | "assistant"; content: string; status: string }>(
    "SELECT role, content, status FROM messages WHERE chat_id = $1 AND id < $2 ORDER BY id", [a.chat_id, q.id]);
  return {
    assistantId: a.id, chatId: a.chat_id, videoId: a.video_id, question: q.content, content: a.content, mode: parseMode(q.mode),
    history: modelHistory(earlier).map(({ role, content }) => ({ role, content })) as Turn[],
  };
}

/** Continue an answer that was cut off, failed or stopped, from the text already written. */
export async function continueGeneration(assistantId: number): Promise<Live | null> {
  const claimed = await query(
    "UPDATE messages SET status = 'generating', error = '', updated_at = now() WHERE id = $1 AND status IN ('incomplete', 'stopped') RETURNING id", [assistantId]);
  if (!claimed.length) return null;
  const ctx = await loadContext(assistantId);
  if (!ctx) return null;
  return startGeneration({ ...ctx, continueFrom: ctx.content.trim() ? ctx.content : undefined });
}

/** Answers left "generating" by a stopped server are continued from their saved text (claimed atomically). */
export async function resumeStaleGenerations(): Promise<void> {
  const own = liveIds();
  const stale = await query<{ id: number }>(
    `UPDATE messages SET updated_at = now()
     WHERE role = 'assistant' AND status = 'generating' AND updated_at < now() - interval '2 minutes' AND NOT (id = ANY($1::bigint[]))
     RETURNING id`, [own]);
  for (const m of stale) {
    const ctx = await loadContext(m.id);
    if (!ctx) { await query("UPDATE messages SET status = 'incomplete', error = 'Interrupted' WHERE id = $1", [m.id]); continue; }
    console.log(`Resuming interrupted answer ${m.id}`);
    startGeneration({ ...ctx, continueFrom: ctx.content.trim() ? ctx.content : undefined });
  }
}

export async function heartbeatGenerations(): Promise<void> {
  const ids = liveIds();
  if (ids.length) await query("UPDATE messages SET updated_at = now() WHERE id = ANY($1::bigint[]) AND status = 'generating'", [ids]);
}

/** On shutdown, make running answers look stale so the next start resumes them immediately. */
export async function releaseGenerations(): Promise<void> {
  const ids = liveIds();
  if (ids.length) await query("UPDATE messages SET updated_at = now() - interval '1 day' WHERE id = ANY($1::bigint[]) AND status = 'generating'", [ids]).catch(() => {});
}
