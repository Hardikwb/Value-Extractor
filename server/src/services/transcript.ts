import { translateSegments } from "./translate.js";
import { fitsBudget, needsTranslation } from "./translate-utils.js";
import { fetchTranscriptInfo, latinRatio, type TranscriptResult } from "./youtube.js";

/**
 * The transcript in English whenever possible. Order of preference: an English caption track, YouTube's own English
 * translation of another track, then the language model's translation (for videos small enough to afford it).
 * Anything else is kept in its original language.
 */
export async function loadTranscript(videoId: string): Promise<TranscriptResult> {
  const info = await fetchTranscriptInfo(videoId);
  if (needsTranslation(info.segments, info.source) && fitsBudget(info.segments)) {
    const segments = await translateSegments(info.segments);
    // count it as translated only if it now reads as English
    if (latinRatio(segments.map((s) => s.text).join(" ")) >= 0.7) return { segments, source: { ...info.source, translated: true } };
  }
  return info;
}
