import { describe, expect, it } from "vitest";
import { CACHE_LIMIT, readActiveId, readChats, sortChats, upsertChat, writeActiveId, writeChats, type KV } from "./chatCache.js";

const fakeStorage = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const chat = (id: string, t: string, updated_at: string, video_id: string | null = null) => ({ id, title: t, updated_at, video_id });

describe("chat cache", () => {
  it("stores chat names and returns them newest first", () => {
    const kv = fakeStorage();
    writeChats([chat("a", "Old", "2026-11-01T10:00:00Z"), chat("b", "Newest", "2026-11-26T10:00:00Z"), chat("c", "Middle", "2026-11-10T10:00:00Z")], kv);
    expect(readChats(kv).map((c) => c.title)).toEqual(["Newest", "Middle", "Old"]);
  });
  it("keeps only the latest entries", () => {
    const kv = fakeStorage();
    const many = Array.from({ length: CACHE_LIMIT + 20 }, (_, i) => chat(`id${i}`, `t${i}`, new Date(2026, 0, 1, 0, i).toISOString()));
    writeChats(many, kv);
    const back = readChats(kv);
    expect(back).toHaveLength(CACHE_LIMIT);
    expect(back[0].id).toBe(`id${CACHE_LIMIT + 19}`); // the newest survived
  });
  it("remembers and forgets the last open chat", () => {
    const kv = fakeStorage();
    expect(readActiveId(kv)).toBeNull();
    writeActiveId("abc", kv);
    expect(readActiveId(kv)).toBe("abc");
    writeActiveId(null, kv);
    expect(readActiveId(kv)).toBeNull();
  });
  it("ignores corrupt or hostile cache contents", () => {
    const kv = fakeStorage();
    kv.setItem("vc.chats.v1", "{not json");
    expect(readChats(kv)).toEqual([]);
    kv.setItem("vc.chats.v1", JSON.stringify([{ id: 5 }, null, "x", { id: "ok", title: "Fine", updated_at: "2026-01-01T00:00:00Z" }]));
    expect(readChats(kv).map((c) => c.id)).toEqual(["ok"]);
  });
  it("works without any storage (private window, blocked)", () => {
    expect(readChats(null)).toEqual([]);
    expect(() => writeChats([chat("a", "x", "2026-01-01T00:00:00Z")], null)).not.toThrow();
    const throwing: KV = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readChats(throwing)).toEqual([]);
    expect(() => writeChats([], throwing)).not.toThrow();
    expect(readActiveId(throwing)).toBeNull();
  });
  it("upserts a renamed chat and re-sorts", () => {
    const list = [chat("a", "First", "2026-11-01T10:00:00Z"), chat("b", "Second", "2026-11-02T10:00:00Z")];
    const out = upsertChat(list, chat("a", "First, renamed", "2026-11-26T10:00:00Z"));
    expect(out.map((c) => c.title)).toEqual(["First, renamed", "Second"]);
    expect(sortChats([chat("x", "bad date", "nope"), chat("y", "ok", "2026-01-01T00:00:00Z")])[0].id).toBe("y");
  });
});
