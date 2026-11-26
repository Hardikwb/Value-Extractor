import {
  YoutubeTranscript, YoutubeTranscriptDisabledError, YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError, YoutubeTranscriptTooManyRequestError, YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

export interface TranscriptSegment { text: string; start: number }

export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.hostname.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}

/** Find a YouTube link inside free text. */
export function findVideoIdInText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/g);
  for (const link of m ?? []) {
    const id = extractVideoId(link);
    if (id) return id;
  }
  return null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode HTML entities; runs twice because captions are sometimes double-encoded (&amp;#39;). */
export function decodeEntities(input: string): string {
  const once = (t: string) =>
    t
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
  return once(once(input));
}

/** Strip caption noise: [Music], >> speaker markers, repeated whitespace. */
export function cleanCaption(text: string): string {
  return decodeEntities(text)
    .replace(/\[[^\]]{1,30}\]/g, " ")
    .replace(/^\s*(>>|-)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawSegment { text: string; offset: number; duration: number }

/**
 * youtube-transcript returns milliseconds for the srv3 caption format and seconds for the
 * classic format. srv3 gives integer offsets AND integer durations (>= 100 ms typically);
 * classic durations are fractional seconds, so integers >= 100 never occur there.
 */
export function offsetsAreMs(raw: RawSegment[]): boolean {
  return (
    raw.every((r) => Number.isInteger(r.offset) && Number.isInteger(r.duration)) &&
    raw.some((r) => r.duration >= 100)
  );
}

/** Share of letters that are Latin (a-z). Used to catch a wrong-language transcript. */
export function latinRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[a-z]/i.test(c)).length / letters.length;
}

/**
 * Without an explicit language youtube-transcript takes the FIRST caption track YouTube lists,
 * which can be any language (it was Arabic for an English video). Always ask for English,
 * accepting regional variants such as en-US / en-GB.
 */
async function fetchEnglish(videoId: string): Promise<RawSegment[]> {
  try {
    return (await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" })) as RawSegment[];
  } catch (e: any) {
    if (!(e instanceof YoutubeTranscriptNotAvailableLanguageError)) throw e;
    const listed = /Available languages:\s*(.*)$/.exec(e.message)?.[1]?.split(",").map((l: string) => l.trim()) ?? [];
    const variant = listed.find((l: string) => /^en([-_]|$)/i.test(l));
    if (!variant) {
      throw new Error(`no English captions on this video (available: ${listed.join(", ") || "none"})`);
    }
    return (await YoutubeTranscript.fetchTranscript(videoId, { lang: variant })) as RawSegment[];
  }
}

export async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
  const raw = await fetchEnglish(videoId);
  const ms = offsetsAreMs(raw);
  const segments = raw
    .map((r) => ({ text: cleanCaption(r.text), start: ms ? r.offset / 1000 : r.offset }))
    .filter((s) => s.text);
  if (!segments.length) throw new Error("Transcript is empty");
  if (latinRatio(segments.map((s) => s.text).join(" ")) < 0.7) {
    throw new Error("the captions are not in English");
  }
  return segments;
}

export async function fetchTitle(videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    );
    if (res.ok) return ((await res.json()) as { title: string }).title;
  } catch { /* ignore */ }
  return `YouTube video ${videoId}`;
}

/** Plain-language reason for a failed transcript fetch (the library's own messages carry emoji and prefixes). */
export function friendlyTranscriptError(e: any): string {
  if (e instanceof YoutubeTranscriptDisabledError) return "Captions are turned off for this video.";
  if (e instanceof YoutubeTranscriptNotAvailableError) return "This video has no captions to read.";
  if (e instanceof YoutubeTranscriptVideoUnavailableError) return "This video is unavailable (it may be private, removed or age-restricted).";
  if (e instanceof YoutubeTranscriptTooManyRequestError) return "YouTube is limiting requests right now. Try again in a few minutes.";
  const msg = String(e?.message ?? e).replace(/^\[YoutubeTranscript\]\s*\S*\s*/, "");
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}
