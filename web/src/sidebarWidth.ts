// The left sidebar can be dragged wider or narrower; its width is remembered in the browser.
// Pure apart from the injected storage, so it can be unit tested.
import { defaultStorage, type KV } from "./chatCache";

export const SIDEBAR_MIN = 260;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_DEFAULT = 340;
const KEY = "vc.sidebarW.v1";

/** Whole pixels within the allowed range; anything that is not a number falls back to the default. */
export function clampWidth(n: unknown, min = SIDEBAR_MIN, max = SIDEBAR_MAX): number {
  if (n === null || n === undefined || (typeof n === "string" && n.trim() === "")) return SIDEBAR_DEFAULT; // Number(null) would be 0
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return SIDEBAR_DEFAULT;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function readWidth(kv: KV | null = defaultStorage()): number {
  try {
    const raw = kv?.getItem(KEY);
    return raw == null ? SIDEBAR_DEFAULT : clampWidth(raw);
  } catch { return SIDEBAR_DEFAULT; }
}

export function writeWidth(width: number, kv: KV | null = defaultStorage()): void {
  try { kv?.setItem(KEY, String(clampWidth(width))); } catch { /* the width is only a convenience */ }
}
