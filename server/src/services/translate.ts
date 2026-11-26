import { currentReporter } from "../jobs/reporter-core.js";
import { complete } from "./llm.js";
import { batchIndexes, parseText, redistribute } from "./translate-utils.js";
import type { TranscriptSegment } from "./youtube.js";

const SYSTEM = `You translate video captions to English. The user sends a JSON object {"lines": [...]} holding consecutive caption lines. Return ONLY JSON {"text": "..."} where text is the whole passage translated into natural English, in order.
Rules:
- The captions are auto-generated and often Hinglish: English words written in Devanagari script (for example "थ्री इंपॉर्टेंट" is "three important"). Write those as the normal English words.
- Keep technical terms, product names, acronyms and numbers exactly as spoken, using their standard spelling (for example RAG, API, Kubernetes).
- Do not add, explain or summarise anything, and do not leave anything out.`;

/** Translate transcript segments to English, keeping their timestamps. A batch that cannot be translated keeps its original text. */
export async function translateSegments(segments: TranscriptSegment[]): Promise<TranscriptSegment[]> {
  const out = segments.map((s) => ({ ...s }));
  const batches = batchIndexes(segments.map((s) => s.text));
  let done = 0;
  for (const idx of batches) {
    currentReporter()?.detail(`Translating the transcript to English (${done + 1} of ${batches.length})…`);
    const lines = idx.map((i) => segments[i].text);
    let translated: string | null = null;
    for (let attempt = 0; attempt < 2 && !translated; attempt++) {
      try {
        const raw = await complete(
          [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ lines }) }],
          { json: true, maxTokens: 4000, patient: true },
        );
        translated = parseText(raw);
        if (!translated) console.warn(`[translate] unusable reply for batch ${done + 1}/${batches.length}: ${raw.slice(0, 80)}`);
      } catch (e: any) {
        console.warn("[translate] batch failed:", String(e?.message ?? e).slice(0, 120));
        break;
      }
    }
    if (translated) redistribute(translated, lines.map((l) => l.length)).forEach((piece, k) => { if (piece) out[idx[k]].text = piece; });
    done++;
  }
  currentReporter()?.detail("");
  return out;
}
