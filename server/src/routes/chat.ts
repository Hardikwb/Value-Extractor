import { Router, type Response } from "express";
import { z } from "zod";
import { query } from "../db/client.js";
import {
  abortChatGenerations, continueGeneration, startGeneration, stopGeneration, subscribe, type Live,
} from "../chat/generation.js";
import { defaultTitle, modelHistory } from "../chat/generation-utils.js";
import { defaultQuestion, MODES } from "../services/modes.js";

export const chats = Router();

chats.post("/", async (req, res, next) => {
  try {
    const { videoId, title } = z
      .object({ videoId: z.string().uuid().nullish(), title: z.string().optional() })
      .parse(req.body);
    // "New chat" must not pile up empty chats: reuse an existing empty one for the same video.
    const [empty] = await query(
      `SELECT c.* FROM chats c WHERE c.video_id IS NOT DISTINCT FROM $1::uuid
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id) ORDER BY c.created_at DESC LIMIT 1`,
      [videoId ?? null],
    );
    if (empty) return void res.status(200).json(empty);
    const [chat] = await query(
      "INSERT INTO chats (video_id, title) VALUES ($1,$2) RETURNING *",
      [videoId ?? null, title ?? "New chat"],
    );
    res.status(201).json(chat);
  } catch (e) { next(e); }
});

// Latest first. `generating` lets the sidebar show which chats are being answered right now.
chats.get("/", async (_req, res, next) => {
  try {
    res.json(await query(
      `SELECT c.id, c.video_id, c.title, c.created_at, c.updated_at,
              EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.status = 'generating') AS generating
       FROM chats c ORDER BY c.updated_at DESC`));
  } catch (e) { next(e); }
});

chats.get("/:id/messages", async (req, res, next) => {
  try {
    res.json(await query(
      "SELECT id, role, content, status, error, mode, created_at FROM messages WHERE chat_id = $1 ORDER BY id", [req.params.id]));
  } catch (e) { next(e); }
});

chats.delete("/:id", async (req, res, next) => {
  try {
    abortChatGenerations(req.params.id);
    await query("DELETE FROM chats WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

/**
 * Streams a background answer to this response as SSE. Closing the connection only unsubscribes:
 * the answer keeps being written by the server and saved. Events: {meta}, {delta}, {done, status, error}.
 */
function watch(res: Response, g: Live, meta?: Record<string, unknown>): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (meta) send({ meta });
  const unsubscribe = subscribe(g.id, (ev) => {
    send(ev);
    if ("done" in ev) res.end();
  });
  if (!unsubscribe) { send({ done: true, status: g.status, error: g.error }); return void res.end(); }
  res.on("close", () => unsubscribe());
}

chats.post("/:id/messages", async (req, res, next) => {
  try {
    const body = z
      .object({
        content: z.string().max(20000).default(""),
        editFromId: z.coerce.number().int().positive().optional(),
        mode: z.enum(MODES as [string, ...string[]]).nullish(),
      })
      .parse(req.body);
    const mode = (body.mode ?? null) as import("../services/modes.js").Mode | null;
    const editFromId = body.editFromId;
    // A tag can be sent with no text; then the tag's own request is stored as the question.
    const content = body.content.trim() || (mode ? defaultQuestion(mode) : "");
    if (!content) return void res.status(400).json({ error: "Write a question or choose a tag." });
    const chatId = req.params.id;

    // Editing a message removes it and everything after it, then asks again.
    if (editFromId) {
      abortChatGenerations(chatId, editFromId);
      await query("DELETE FROM messages WHERE chat_id = $1 AND id >= $2", [chatId, editFromId]);
      await query(
        "UPDATE chats SET title = CASE WHEN NOT EXISTS (SELECT 1 FROM messages WHERE chat_id = $1) THEN 'New chat' ELSE title END WHERE id = $1", [chatId]);
    }

    // History is read BEFORE the new messages are stored, so the question does not appear twice in the prompt.
    const [chatRows, rows] = await Promise.all([
      query<{ id: string; video_id: string | null; title: string; video_status: string | null; pending: number }>(
        `SELECT c.id, c.video_id, c.title, v.status AS video_status,
                (SELECT count(*)::int FROM messages m WHERE m.chat_id = c.id AND m.status = 'generating') AS pending
         FROM chats c LEFT JOIN videos v ON v.id = c.video_id WHERE c.id = $1`, [chatId]),
      query<{ role: "user" | "assistant"; content: string; status: string }>(
        "SELECT role, content, status FROM messages WHERE chat_id = $1 ORDER BY id DESC LIMIT 30", [chatId]),
    ]);
    const chat = chatRows[0];
    if (!chat) return void res.status(404).json({ error: "Chat not found" });
    if (chat.video_id && chat.video_status !== "ready") {
      return void res.status(409).json({ error: "This video is still being processed. Chat opens as soon as its transcript is indexed." });
    }
    if (chat.pending > 0) return void res.status(409).json({ error: "The previous answer is still being written. Wait for it or stop it first." });

    const history = modelHistory(rows.reverse()).map(({ role, content }) => ({ role, content }));
    const [saved, , ] = await Promise.all([
      query<{ id: number; role: string }>(
        `INSERT INTO messages (chat_id, role, content, status, mode) VALUES ($1, 'user', $2, 'done', $3::text), ($1, 'assistant', '', 'generating', NULL) RETURNING id, role`,
        [chatId, content, mode]),
      query("UPDATE chats SET updated_at = now(), title = CASE WHEN title = 'New chat' THEN $2 ELSE title END WHERE id = $1", [chatId, defaultTitle(content)]),
    ]);
    const userId = saved.find((r) => r.role === "user")!.id;
    const assistantId = saved.find((r) => r.role === "assistant")!.id;

    const g = startGeneration({ assistantId, chatId, videoId: chat.video_id, question: content, history, firstAnswer: history.length === 0, mode });
    watch(res, g, { userId, assistantId });
  } catch (e) { next(e); }
});

// Stopping is the only thing that cancels an answer; closing the page does not.
chats.post("/:id/messages/:mid/stop", async (req, res, next) => {
  try {
    await stopGeneration(Number(req.params.mid));
    res.status(204).end();
  } catch (e) { next(e); }
});

// Continue an answer that was cut off, failed or stopped.
chats.post("/:id/messages/:mid/continue", async (req, res, next) => {
  try {
    const g = await continueGeneration(Number(req.params.mid));
    if (!g) return void res.status(409).json({ error: "This answer can't be continued." });
    watch(res, g, { assistantId: g.id });
  } catch (e) { next(e); }
});
