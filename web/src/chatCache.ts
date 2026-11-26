// Remembers the chat names (latest first) and the last open chat in the browser, so the sidebar shows
// instantly on load and the last conversation reopens. The server stays the source of truth: the cache
// is shown first, then replaced by the fresh list. Pure apart from the injected storage, so it is testable.

export interface CachedChat { id: string; video_id: string | null; title: string; updated_at: string }
export interface KV { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void }

const LIST_KEY = "vc.chats.v1";
const ACTIVE_KEY = "vc.activeChat.v1";
export const CACHE_LIMIT = 50;

/** localStorage when available (it can be missing or throw in private windows or when blocked). */
export function defaultStorage(): KV | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export const sortChats = <T extends { updated_at: string }>(chats: T[]): T[] =>
  [...chats].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));

export function readChats(kv: KV | null = defaultStorage()): CachedChat[] {
  try {
    const raw = kv?.getItem(LIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return sortChats(
      list.filter((c) => c && typeof c.id === "string" && typeof c.title === "string")
        .map((c) => ({ id: c.id, video_id: typeof c.video_id === "string" ? c.video_id : null, title: c.title, updated_at: String(c.updated_at ?? "") })),
    );
  } catch { return []; }
}

export function writeChats(chats: CachedChat[], kv: KV | null = defaultStorage(), limit = CACHE_LIMIT): void {
  try {
    const slim = sortChats(chats).slice(0, limit).map(({ id, video_id, title, updated_at }) => ({ id, video_id, title, updated_at }));
    kv?.setItem(LIST_KEY, JSON.stringify(slim));
  } catch { /* storage full or blocked: the cache is only a convenience */ }
}

export function readActiveId(kv: KV | null = defaultStorage()): string | null {
  try { return kv?.getItem(ACTIVE_KEY) || null; } catch { return null; }
}

export function writeActiveId(id: string | null, kv: KV | null = defaultStorage()): void {
  try { id ? kv?.setItem(ACTIVE_KEY, id) : kv?.removeItem?.(ACTIVE_KEY); } catch { /* ignore */ }
}

/** Insert or replace one chat and keep the list newest first. */
export function upsertChat(list: CachedChat[], chat: CachedChat): CachedChat[] {
  return sortChats([chat, ...list.filter((c) => c.id !== chat.id)]);
}
