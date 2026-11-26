import { describe, expect, it } from "vitest";
import type { KV } from "./chatCache";
import { clampWidth, readWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, writeWidth } from "./sidebarWidth";

const fake = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("sidebar width", () => {
  it("is limited to the allowed range and rounded", () => {
    expect(clampWidth(100)).toBe(SIDEBAR_MIN);
    expect(clampWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampWidth(333.6)).toBe(334);
    expect(clampWidth("400")).toBe(400);
  });
  it("falls back to the default for junk", () => {
    for (const bad of [NaN, "abc", undefined, null, {}]) expect(clampWidth(bad)).toBe(SIDEBAR_DEFAULT);
  });
  it("remembers the width and clamps what it reads back", () => {
    const kv = fake();
    expect(readWidth(kv)).toBe(SIDEBAR_DEFAULT);
    writeWidth(410, kv);
    expect(readWidth(kv)).toBe(410);
    kv.setItem("vc.sidebarW.v1", "99999");
    expect(readWidth(kv)).toBe(SIDEBAR_MAX);
  });
  it("works without storage", () => {
    expect(readWidth(null)).toBe(SIDEBAR_DEFAULT);
    expect(() => writeWidth(400, null)).not.toThrow();
    const throwing: KV = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readWidth(throwing)).toBe(SIDEBAR_DEFAULT);
    expect(() => writeWidth(400, throwing)).not.toThrow();
  });
});
