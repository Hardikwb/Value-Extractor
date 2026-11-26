// Pure helpers for translating a transcript to English with the language model (no DB / env access).
import { isEnglish, latinRatio, type TranscriptSource } from "./youtube.js";
import type { TranscriptSegment } from "./youtube.js";

/** Above this size translating with the model would use too much of the free token budget; keep the original text. */
export const MAX_TRANSLATE_CHARS = 60000;

/** Only transcripts that are in another language (and were not already translated by YouTube) need this. */
export function needsTranslation(segments: TranscriptSegment[], source: TranscriptSource): boolean {
  if (source.translated || isEnglish(source.lang)) return false;
  return latinRatio(segments.map((s) => s.text).join(" ")) < 0.7;
}

export const fitsBudget = (segments: TranscriptSegment[]) => segments.reduce((n, s) => n + s.text.length, 0) <= MAX_TRANSLATE_CHARS;

/** Group segment indexes into batches of at most `maxLines` lines and `maxChars` characters. */
export function batchIndexes(texts: string[], maxLines = 40, maxChars = 3500): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= maxLines || chars + t.length > maxChars)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

/** The model's reply must be JSON with a non-empty "text". */
export function parseText(raw: string): string | null {
  try {
    const text = JSON.parse(raw)?.text;
    return typeof text === "string" && text.trim() ? text.replace(/\s+/g, " ").trim() : null;
  } catch { return null; }
}

/**
 * Spread translated text back over the original lines in proportion to their lengths, so every segment keeps its
 * timestamp. Translation merges and reorders lines, so a line-for-line match cannot be demanded; this keeps each
 * piece within a few words of where it was spoken. Never returns an empty piece while words remain.
 */
export function redistribute(translated: string, weights: number[]): string[] {
  const words = translated.split(/\s+/).filter(Boolean);
  const n = weights.length;
  if (!n) return [];
  const total = weights.reduce((a, b) => a + Math.max(1, b), 0);
  const out: string[] = [];
  let cum = 0, taken = 0;
  for (let i = 0; i < n; i++) {
    cum += Math.max(1, weights[i]);
    const wordsLeft = words.length - taken;
    const piecesAfter = n - 1 - i;
    let take: number;
    if (piecesAfter === 0) take = wordsLeft; // the last piece takes everything left
    else {
      const target = Math.round((cum / total) * words.length) - taken; // proportional share
      const min = wordsLeft > 0 ? 1 : 0; // never an empty piece while words remain
      const max = Math.max(min, wordsLeft - piecesAfter); // leave a word for each later piece when there are enough
      take = Math.min(Math.max(target, min), max, wordsLeft);
    }
    out.push(words.slice(taken, taken + take).join(" "));
    taken += take;
  }
  return out;
}
