import type { TranscriptSegment } from "./youtube.js";

export interface Chunk { idx: number; startSeconds: number; text: string }

/**
 * Group segments into chunks of about `maxChars`. Each new chunk starts by re-including the
 * trailing segments of the previous one (at least `overlapChars`), so a sentence cut at a
 * boundary still appears whole in one chunk.
 */
export function chunkTranscript(segments: TranscriptSegment[], maxChars = 900, overlapChars = 120): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < segments.length) {
    let len = 0;
    let j = i;
    while (j < segments.length && (len < maxChars || j === i)) {
      len += segments[j].text.length + 1;
      j++;
    }
    chunks.push({
      idx: chunks.length,
      startSeconds: Math.floor(segments[i].start),
      text: segments.slice(i, j).map((s) => s.text).join(" "),
    });
    if (j >= segments.length) break;
    // walk back from j until we've re-included overlapChars, but always make forward progress
    let back = j;
    let carried = 0;
    while (back - 1 > i && carried < overlapChars) {
      back--;
      carried += segments[back].text.length + 1;
    }
    i = back;
  }
  return chunks;
}

export function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
