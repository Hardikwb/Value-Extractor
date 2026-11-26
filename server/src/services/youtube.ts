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

/** Where a transcript came from: its language, and whether YouTube translated it to English for us. */
export interface TranscriptSource { lang: string; translated: boolean }
export interface TranscriptResult { segments: TranscriptSegment[]; source: TranscriptSource }

export const isTimedTextUrl = (url: string) => /\/api\/timedtext/.test(url);

/** Asks YouTube for its machine translation of a caption track (only caption-download requests are changed). */
export function withTranslation(url: string, to = "en"): string {
  return isTimedTextUrl(url) && !/[?&]tlang=/.test(url) ? `${url}${url.includes("?") ? "&" : "?"}tlang=${to}` : url;
}

/** YouTube throttles caption requests (HTTP 429) and sometimes errors (5xx): worth waiting and trying again. A 200/404 is a real answer. */
export const isThrottled = (status: number) => status === 0 || status === 429 || status >= 500;

/** Pauses between translation attempts (milliseconds); the last attempt has no pause after it. */
export const TRANSLATION_WAITS = [4000, 10000, 20000];

/** A fetch that asks for the English translation and records the status of the caption download. */
function translatingFetch(seen: { status: number }): typeof fetch {
  return (async (url: any, init: any) => {
    const u = String(url);
    try {
      const res = await fetch(withTranslation(u), init);
      if (isTimedTextUrl(u)) seen.status = res.status;
      return res;
    } catch (e) {
      if (isTimedTextUrl(u)) seen.status = 0;
      throw e;
    }
  }) as typeof fetch;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The English translation of a track, retrying while YouTube is throttling us. Null if it is not offered. */
async function fetchTranslated(videoId: string, lang: string): Promise<RawSegment[] | null> {
  for (let attempt = 0; ; attempt++) {
    const seen = { status: -1 };
    try {
      const raw = (await YoutubeTranscript.fetchTranscript(videoId, { lang, fetch: translatingFetch(seen) })) as RawSegment[];
      if (raw.length) return raw;
      return null;
    } catch {
      if (!isThrottled(seen.status) || attempt >= TRANSLATION_WAITS.length) return null;
      console.warn(`[captions] YouTube throttled the translated captions for ${videoId} (HTTP ${seen.status}); retrying in ${TRANSLATION_WAITS[attempt] / 1000}s`);
      await pause(TRANSLATION_WAITS[attempt]);
    }
  }
}

/** Language codes the library lists in its "not available in en" error, e.g. "Available languages: hi, ta". */
export function listedLanguages(message: string): string[] {
  return (/Available languages:\s*(.*)$/.exec(message)?.[1] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
}

export const isEnglish = (lang: string) => /^en([-_]|$)/i.test(lang);

/**
 * Without an explicit language youtube-transcript takes the FIRST caption track YouTube lists, which can be any
 * language (it was Arabic for an English video), so English is requested explicitly. If there is no English track
 * (a Hindi video, or an English one that YouTube labelled Hindi because it is written in Devanagari), YouTube's own
 * English translation of the available track is used. Only if that is not offered is the original text kept.
 */
async function fetchBestTranscript(videoId: string): Promise<{ raw: RawSegment[]; source: TranscriptSource }> {
  try {
    return { raw: (await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" })) as RawSegment[], source: { lang: "en", translated: false } };
  } catch (e: any) {
    if (!(e instanceof YoutubeTranscriptNotAvailableLanguageError)) throw e;
    const listed = listedLanguages(e.message);
    const variant = listed.find(isEnglish);
    if (variant) {
      return { raw: (await YoutubeTranscript.fetchTranscript(videoId, { lang: variant })) as RawSegment[], source: { lang: variant, translated: false } };
    }
    if (!listed.length) throw new Error("no captions on this video");
    const lang = listed[0];
    const raw = await fetchTranslated(videoId, lang);
    if (raw && latinRatio(raw.map((r) => cleanCaption(r.text)).join(" ")) >= 0.7) return { raw, source: { lang, translated: true } };
    // translation is not offered for this track (or kept being throttled): use the original-language text
    return { raw: (await YoutubeTranscript.fetchTranscript(videoId, { lang })) as RawSegment[], source: { lang, translated: false } };
  }
}

export async function fetchTranscriptInfo(videoId: string): Promise<TranscriptResult> {
  const { raw, source } = await fetchBestTranscript(videoId);
  const ms = offsetsAreMs(raw);
  const segments = raw
    .map((r) => ({ text: cleanCaption(r.text), start: ms ? r.offset / 1000 : r.offset }))
    .filter((s) => s.text);
  if (!segments.length) throw new Error("Transcript is empty");
  // An "English" track that is not Latin text means the wrong track was returned. Other languages are kept as they are.
  if (isEnglish(source.lang) && latinRatio(segments.map((s) => s.text).join(" ")) < 0.7) {
    throw new Error("the captions are not in English");
  }
  return { segments, source };
}

export async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
  return (await fetchTranscriptInfo(videoId)).segments;
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
