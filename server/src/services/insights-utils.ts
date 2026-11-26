// Pure helpers for the insights pipeline (no DB / env access) so they can be unit tested.

/** Bump to force every video to be re-analysed on the next start. */
export const INSIGHTS_VERSION = 1;

export interface Chapter { start: number; title: string }
export interface LinkInfo { label: string; url: string; resolved_url?: string; is_github?: boolean }
export interface Segment { text: string; start: number }
export interface Section { title: string; start: number; text: string }

export interface SectionInsight {
  title: string;
  start: number;
  summary: string;
  key_points: string[];
  tools: { name: string; what: string }[];
  people: string[];
  resources: string[];
  numbers: { value: string; what: string }[];
  practices: string[];
}

export interface Insights {
  /** True while the overview is only a stopgap built from chapter summaries (its step was rate limited). */
  overview_pending?: boolean;
  overview: string;
  framework: { name: string; line: string }[];
  takeaways: string[];
  speakers: { name: string; role: string }[];
  sections: SectionInsight[];
  tools: { name: string; start: number; what?: string }[];
  people: { name: string; start: number }[];
  resources: { name: string; start: number }[];
  numbers: { value: string; what: string; start: number }[];
  practices: { text: string; start: number }[];
}

/* ---------------------------------------------------------------- description parsing */

const toSeconds = (t: string) => t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);

/** Creator chapters from lines like "10:33 - Title" (or H:MM:SS). Needs at least 3 to count. */
export function parseChapters(description: string): Chapter[] {
  const found: Chapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—:)]*\s*(\S.*?)\s*$/.exec(line);
    if (m && !/https?:\/\//.test(m[2])) found.push({ start: toSeconds(m[1]), title: m[2] });
  }
  const seq: Chapter[] = [];
  for (const c of found) if (!seq.length || c.start > seq[seq.length - 1].start) seq.push(c);
  return seq.length >= 3 ? seq : [];
}

/** Removes tracking parameters and trailing punctuation. */
export function cleanUrl(raw: string): string {
  const trimmed = raw.replace(/[).,;\]>]+$/, "");
  try {
    const u = new URL(trimmed);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || k === "si") u.searchParams.delete(k);
    return u.toString();
  } catch {
    return trimmed;
  }
}

/** Links with their labels, e.g. "Agent skills specification → https://g.dev/ai/github-skills". */
export function parseLinks(description: string): LinkInfo[] {
  const out: LinkInfo[] = [];
  const seen = new Set<string>();
  for (const line of description.split(/\r?\n/)) {
    const urls = line.match(/https?:\/\/[^\s)>\]]+/g);
    if (!urls) continue;
    for (const raw of urls) {
      const url = cleanUrl(raw);
      if (seen.has(url)) continue;
      seen.add(url);
      let label = line.slice(0, line.indexOf(raw)).replace(/[→\-–—:|>•\s🔔]+$/u, "").replace(/^[\s•\-–—🔔]+/u, "").trim();
      if (!label) {
        try { label = new URL(url).hostname.replace(/^www\./, ""); } catch { label = url; }
      }
      out.push({ label, url });
    }
  }
  return out;
}

export function parseProductsMentioned(description: string): string[] {
  const m = /Products?\s+Mentioned\s*:\s*(.+)/i.exec(description);
  return m ? m[1].split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean) : [];
}

/* ---------------------------------------------------------------- fuzzy name checks */

export const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
const wordSim = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length);

/** Words match if equal, or (both long enough) similar above `minSim`. Short words must match exactly. */
function wordsMatch(a: string, b: string, minSim: number): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && wordSim(a, b) >= minSim;
}

export interface Corpus { text: string; tokens: string[] }
export function buildCorpus(text: string): Corpus {
  const n = norm(text);
  return { text: ` ${n} `, tokens: n ? n.split(" ") : [] };
}

/** Does `name` occur in the corpus (exactly, or as a close misspelling)? */
export function appearsIn(name: string, corpus: Corpus, minSim = 0.85): boolean {
  const n = norm(name);
  if (!n) return false;
  if (corpus.text.includes(` ${n} `)) return true;
  const words = n.split(" ");
  const k = words.length;
  for (let i = 0; i + k <= corpus.tokens.length; i++) {
    const t = corpus.tokens[i];
    if (t[0] !== words[0][0] || Math.abs(t.length - words[0].length) > 2) continue;
    if (words.every((w, j) => wordsMatch(w, corpus.tokens[i + j], minSim))) return true;
  }
  return false;
}

/** Map a (possibly caption-garbled) name onto the glossary spelling, e.g. "Cloud Code" -> "Claude Code". */
export function canonicalize(name: string, glossary: string[]): string | null {
  const words = norm(name).split(" ").filter(Boolean);
  if (!words.length) return null;
  for (const g of glossary) {
    const gw = norm(g).split(" ").filter(Boolean);
    if (gw.length === words.length && gw.every((w, i) => wordsMatch(words[i], w, 0.65))) return g;
  }
  return null;
}

const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion";
/** A figure is kept only if every number in it also appears in the section text. */
export function numberIsGrounded(value: string, sectionText: string): boolean {
  const tokens = value.toLowerCase().match(new RegExp(`\\d+(?:[.,]\\d+)?|\\b(?:${NUMBER_WORDS})\\b`, "g"));
  if (!tokens?.length) return false;
  const hay = sectionText.toLowerCase().replace(/,/g, "");
  return tokens.every((t) => hay.includes(t.replace(/,/g, "")));
}

/* ---------------------------------------------------------------- sections */

const MIN_SECTION = 800;
const MAX_SECTION = 6000;
const WINDOW = 5500;
const MAX_WINDOWS = 40;

const joinText = (segs: Segment[]) => segs.map((s) => s.text).join(" ");

/** Split a long run of segments into pieces of about `size` chars at segment boundaries. */
function splitLong(segs: Segment[], title: string, size: number): Section[] {
  const parts: Section[] = [];
  let cur: Segment[] = [];
  let len = 0;
  for (const s of segs) {
    if (len >= size && cur.length) {
      parts.push({ title: "", start: cur[0].start, text: joinText(cur) });
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += s.text.length + 1;
  }
  if (cur.length) parts.push({ title: "", start: cur[0].start, text: joinText(cur) });
  return parts.map((p, i) => ({ ...p, title: parts.length > 1 ? `${title} (part ${i + 1})` : title }));
}

interface Draft { title: string; start: number; segs: Segment[] }
const draftLen = (d: Draft) => d.segs.reduce((n, s) => n + s.text.length + 1, 0);

/** One section per creator chapter (tiny ones merged, huge ones split); otherwise fixed windows. */
export function buildSections(segments: Segment[], chapters: Chapter[]): Section[] {
  if (!segments.length) return [];
  if (chapters.length < 3) {
    const total = segments.reduce((n, s) => n + s.text.length + 1, 0);
    const size = Math.max(WINDOW, Math.ceil(total / MAX_WINDOWS));
    return splitLong(segments, "Part", size).map((s, i) => ({ ...s, title: `Part ${i + 1}` }));
  }
  const bounds = chapters.map((c, i) => ({ ...c, end: chapters[i + 1]?.start ?? Infinity }));
  const drafts: Draft[] = [];
  const lead = segments.filter((s) => s.start < bounds[0].start);
  if (lead.length && joinText(lead).length >= MIN_SECTION) drafts.push({ title: "Introduction", start: lead[0].start, segs: lead });
  for (const b of bounds) {
    const segs = segments.filter((s) => s.start >= b.start && s.start < b.end);
    if (segs.length) drafts.push({ title: b.title, start: b.start, segs });
  }
  // merge chapters that are too small to say anything into the next one
  const merged: Draft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    let cur = drafts[i];
    while (draftLen(cur) < MIN_SECTION && i + 1 < drafts.length) {
      i++;
      cur = { title: `${cur.title} / ${drafts[i].title}`, start: cur.start, segs: [...cur.segs, ...drafts[i].segs] };
    }
    merged.push(cur);
  }
  // split chapters that are too big to read in one go
  return merged.flatMap((d) =>
    draftLen(d) <= MAX_SECTION
      ? [{ title: d.title, start: d.start, text: joinText(d.segs) }]
      : splitLong(d.segs, d.title, Math.ceil(MAX_SECTION * 0.85)),
  );
}

/* ---------------------------------------------------------------- merging + markdown */

/** Dedupe by name (case-insensitive). Keeps the first sighting, but fills in a missing description from later ones. */
export function mergeNamed<T extends { name: string; start: number; what?: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const it of items) {
    const key = norm(it.name);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { ...it });
    else if (!prev.what && it.what) prev.what = it.what;
  }
  return [...seen.values()];
}

export function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function firstSentences(text: string, max = 3): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return parts ? parts.slice(0, max).join("").trim() : text.trim();
}

export interface MarkdownInput {
  youtubeId: string;
  title: string;
  author: string;
  durationSeconds: number;
  links: LinkInfo[];
  insights: Insights;
}

/** The detailed breakdown. Lists come first so truncation (for the model) only cuts the chapter detail. */
export function assembleMarkdown(d: MarkdownInput): string {
  const { insights: I } = d;
  const at = (sec: number) => `[${formatTime(sec)}](https://www.youtube.com/watch?v=${d.youtubeId}&t=${Math.floor(sec)}s)`;
  const out: string[] = [];
  out.push(`# ${d.title}`);
  const meta = [d.author, d.durationSeconds ? formatTime(d.durationSeconds) : ""].filter(Boolean).join(" · ");
  if (meta) out.push(`_${meta}_`);
  if (I.overview) out.push(`## Overview\n${I.overview}`);
  if (I.framework.length) out.push("## Core framework\n" + I.framework.map((f, i) => `${i + 1}. **${f.name}**${f.line ? ` — ${f.line}` : ""}`).join("\n"));
  if (I.takeaways.length) out.push("## Key takeaways\n" + I.takeaways.map((t) => `- ${t}`).join("\n"));
  if (I.speakers.length) out.push("## People\n" + I.speakers.map((p) => `- **${p.name}**${p.role ? ` — ${p.role}` : ""}`).join("\n"));
  if (I.tools.length) out.push("## Tools & technologies\n" + I.tools.map((t) => `- **${t.name}**${t.what ? ` — ${t.what}` : ""} (${at(t.start)})`).join("\n"));
  const linkLines = d.links.map((l) => `- **${l.label}** — ${l.resolved_url ?? l.url}${l.is_github ? " (GitHub)" : ""}`);
  const spoken = I.resources.map((r) => `- ${r.name} (${at(r.start)}, mentioned in the video)`);
  if (linkLines.length || spoken.length) out.push("## Resources & links\n" + [...linkLines, ...spoken].join("\n"));
  if (I.numbers.length) out.push("## Key numbers\n" + I.numbers.map((n) => `- **${n.value}** — ${n.what} (${at(n.start)})`).join("\n"));
  if (I.practices.length) out.push("## Practices & rules\n" + I.practices.map((p) => `- ${p.text} (${at(p.start)})`).join("\n"));
  if (I.sections.length) {
    out.push(
      "## Chapter by chapter\n" +
        I.sections
          .map((s) => `### ${at(s.start)} ${s.title}\n${s.summary}` + (s.key_points.length ? "\n" + s.key_points.map((k) => `- ${k}`).join("\n") : ""))
          .join("\n\n"),
    );
  }
  return out.join("\n\n");
}
