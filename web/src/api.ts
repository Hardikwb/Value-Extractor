export interface VideoLink { label: string; url: string; resolved_url?: string; is_github?: boolean }
export interface Video {
  id: string; youtube_id: string; url: string; title: string;
  category: string; tags: string[]; summary: string;
  author?: string; duration_seconds?: number;
  links?: VideoLink[]; chapters?: { start: number; title: string }[];
  insights_ready?: boolean; deep_summary?: string;
  user_description?: string; user_notes?: string;
  status?: "processing" | "ready" | "failed";
  stage?: string; progress?: number; stage_label?: string; stage_detail?: string; error?: string;
}
export interface Chat { id: string; video_id: string | null; title: string; created_at?: string; updated_at: string; generating?: boolean }
export type MsgStatus = "generating" | "done" | "incomplete" | "stopped";
import type { Mode } from "./modes";
export interface Message { id?: string; role: "user" | "assistant"; content: string; status?: MsgStatus; error?: string; mode?: Mode | null }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? res.statusText);
  return res.status === 204 ? (undefined as T) : res.json();
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  video: (id: string) => fetch(`/api/videos/${id}`).then((r) => json<Video>(r)),
  videos: () => fetch("/api/videos").then((r) => json<Video[]>(r)),
  addVideo: (url: string, mine?: { description?: string; notes?: string }) =>
    post("/api/videos", { url, ...(mine?.description?.trim() ? { description: mine.description } : {}), ...(mine?.notes?.trim() ? { notes: mine.notes } : {}) }).then((r) => json<Video>(r)),
  saveNotes: (id: string, mine: { description: string; notes: string }) =>
    fetch(`/api/videos/${id}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mine) })
      .then((r) => json<{ user_description: string; user_notes: string }>(r)),
  retryVideo: (id: string) => post(`/api/videos/${id}/retry`, {}).then((r) => json<unknown>(r)),
  deleteVideo: (id: string) => fetch(`/api/videos/${id}`, { method: "DELETE" }).then((r) => json<void>(r)),
  chats: () => fetch("/api/chats").then((r) => json<Chat[]>(r)),
  deleteChat: (id: string) => fetch(`/api/chats/${id}`, { method: "DELETE" }).then((r) => json<void>(r)),
  stopAnswer: (chatId: string, messageId: string) => post(`/api/chats/${chatId}/messages/${messageId}/stop`, {}).then((r) => json<void>(r)),
  newChat: (videoId: string | null) => post("/api/chats", { videoId }).then((r) => json<Chat>(r)),
  messages: (chatId: string) => fetch(`/api/chats/${chatId}/messages`).then((r) => json<Message[]>(r)),
};

export interface StreamHandlers {
  onMeta?: (m: { userId?: string; assistantId: string }) => void;
  onDelta: (d: string) => void;
  /** the server corrected the finished answer: replace everything shown so far */
  onReplace?: (text: string) => void;
}
export interface StreamEnd { status: MsgStatus; error: string }

/**
 * Watches an answer that the server writes in the background. Events: {meta}, {delta}, {done, status, error}.
 * Returns the final event, or null if the connection ended before it (closing the page does not stop the answer:
 * the server keeps writing and saves it, so the caller can poll for the result).
 */
export async function streamAnswer(url: string, body: unknown, h: StreamHandlers): Promise<StreamEnd | null> {
  const res = await post(url, body);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? res.statusText);
  if (!res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const ev of events) {
        if (!ev.startsWith("data: ")) continue;
        const p = JSON.parse(ev.slice(6));
        if (p.meta) h.onMeta?.(p.meta);
        else if (p.delta) h.onDelta(p.delta);
        else if (typeof p.replace === "string") h.onReplace?.(p.replace);
        else if (p.done) return { status: p.status, error: p.error ?? "" };
      }
    }
  } catch {
    return null; // connection dropped: the answer continues on the server
  }
}

export const sendMessage = (chatId: string, content: string, h: StreamHandlers, opts: { editFromId?: string; mode?: Mode | null } = {}) =>
  streamAnswer(`/api/chats/${chatId}/messages`, { content, ...(opts.editFromId ? { editFromId: opts.editFromId } : {}), ...(opts.mode ? { mode: opts.mode } : {}) }, h);

export const continueMessage = (chatId: string, messageId: string, h: StreamHandlers) =>
  streamAnswer(`/api/chats/${chatId}/messages/${messageId}/continue`, {}, h);
