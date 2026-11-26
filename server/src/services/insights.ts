import { query } from "../db/client.js";
import { insightsQueue, withJob } from "../jobs/runner.js";
import { currentReporter, JobCancelled } from "../jobs/reporter-core.js";
import { categorize } from "./categorize.js";
import { complete } from "./llm.js";
import { fetchVideoMeta, resolveLinks } from "./metadata.js";
import {
  appearsIn, assembleMarkdown, buildCorpus, buildSections, canonicalize, firstSentences, formatTime,
  INSIGHTS_VERSION, mergeNamed, norm, numberIsGrounded, parseChapters, parseLinks, parseProductsMentioned,
  type Insights, type LinkInfo, type Section, type SectionInsight,
} from "./insights-utils.js";
import { fetchTranscript, type TranscriptSegment } from "./youtube.js";

const DEBUG = !!process.env.DEBUG_RAG;
const SECTION_CHARS = 7000;

const strings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x as any).name ?? "" : "")).map((s) => String(s).trim()).filter(Boolean).slice(0, max);

function parseJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

/* ---------------------------------------------------------------- LLM steps */

async function extractSection(title: string, glossary: string[], s: Section) {
  const raw = await complete(
    [
      {
        role: "system",
        content:
          `You extract facts from one chapter of a technical video. Return ONLY JSON:\n` +
          `{"summary": string (3-5 sentences), "key_points": string[] (up to 6, each a concrete, specific statement), "tools": [{"name": string, "what": string}], ` +
          `"people": string[], "resources": string[], "numbers": [{"value": string, "what": string}], "practices": string[]}\n` +
          `Rules:\n` +
          `- Use only what the text states. Never add tools, products, people or numbers that are merely typical for the topic.\n` +
          `- "tools": products, libraries, languages, frameworks and services NAMED in the text; "what" is what the speaker says it is or does, in at most 12 words, or "" if the text does not say (never guess). Do not list generic capabilities such as "command line" or "file system access". "resources": named docs, repos, papers, books, courses or websites mentioned. ` +
          `"numbers": figures with what they measure (counts, percentages, limits, versions, durations). "practices": explicit rules or recommendations the speaker gives.\n` +
          `- Captions are auto-generated and garble names. If a garbled name matches one in the glossary, use the glossary spelling.\n` +
          `- Empty arrays are fine.\n\nVideo: ${title}\nGlossary: ${glossary.join(", ") || "(none)"}\nChapter: ${s.title}`,
      },
      { role: "user", content: s.text.slice(0, SECTION_CHARS) },
    ],
    { json: true, maxTokens: 1500, patient: true },
  );
  return parseJson(raw);
}

async function extractSpeakers(description: string): Promise<{ name: string; role: string }[]> {
  if (!description.trim()) return [];
  const raw = await complete(
    [
      {
        role: "system",
        content:
          `From this video description list the speakers or presenters and what each one covers. Return ONLY JSON: ` +
          `{"speakers":[{"name": string, "role": string}]}. Use only names that appear in the text. Empty array if none.`,
      },
      { role: "user", content: description.slice(0, 3500) },
    ],
    { json: true, maxTokens: 600, patient: true },
  );
  const corpus = buildCorpus(description);
  return (parseJson(raw).speakers ?? [])
    .filter((p: any) => p?.name && appearsIn(String(p.name), corpus))
    .map((p: any) => ({ name: String(p.name).trim(), role: String(p.role ?? "").trim() }))
    .slice(0, 12);
}

async function reduce(title: string, description: string, sections: SectionInsight[]) {
  const body = sections.map((s) => `[${formatTime(s.start)}] ${s.title}: ${s.summary}`).join("\n").slice(0, 9000);
  const raw = await complete(
    [
      {
        role: "system",
        content:
          `Given chapter summaries of a technical video, return ONLY JSON: {"overview": string (6-8 sentences covering the whole video and who it is for), ` +
          `"framework": [{"name": string, "line": string}] (the main structure the video teaches, such as numbered layers, steps or patterns, in order; empty if none), ` +
          `"takeaways": string[] (up to 8)}. Use only the summaries and the description. Do not add tools, names or numbers that are not in them.`,
      },
      { role: "user", content: `Title: ${title}\nDescription: ${description.slice(0, 1500)}\n\nChapters:\n${body}` },
    ],
    { json: true, maxTokens: 1500, patient: true },
  );
  const p = parseJson(raw);
  return {
    overview: typeof p.overview === "string" ? p.overview.trim() : "",
    framework: (Array.isArray(p.framework) ? p.framework : [])
      .filter((f: any) => f?.name)
      .map((f: any) => ({ name: String(f.name).trim(), line: String(f.line ?? "").trim() }))
      .slice(0, 12),
    takeaways: strings(p.takeaways, 8),
  };
}

/** The same figure is often restated in a later chapter; keep its first appearance. */
function dedupeNumbers<T extends { value: string; what: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((n) => {
    const key = `${norm(n.value)}|${norm(n.what)}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/* ---------------------------------------------------------------- pipeline */

interface VideoRow { id: string; youtube_id: string; title: string }

async function buildInsights(video: VideoRow, given?: TranscriptSegment[]): Promise<void> {
  // 1. What the description adds: chapters, links (resolved), correct product names.
  const meta = await fetchVideoMeta(video.youtube_id);
  const chapters = parseChapters(meta.description);
  const links: LinkInfo[] = await resolveLinks(parseLinks(meta.description));
  const products = parseProductsMentioned(meta.description);
  await query(
    `UPDATE videos SET author = $2, duration_seconds = $3, description = $4, links = $5::jsonb, chapters = $6::jsonb WHERE id = $1`,
    [video.id, meta.author, meta.durationSeconds, meta.description, JSON.stringify(links), JSON.stringify(chapters)],
  );

  // 2. Transcript, speakers, glossary and the text every extracted name is checked against.
  const segments = given ?? (await fetchTranscript(video.youtube_id));
  const speakers = await extractSpeakers(meta.description).catch(() => []);
  const glossary = [...new Set([...products, ...speakers.map((s) => s.name)])];
  const fullText = segments.map((s) => s.text).join(" ");
  const corpus = buildCorpus(`${fullText} ${meta.description}`);
  const sections = buildSections(segments, chapters);
  const r = currentReporter();
  r?.report({ stage: "analyzing", done: 0, total: sections.length });
  if (DEBUG) console.log(`[insights] "${video.title}": ${sections.length} sections, ${chapters.length} chapters, ${links.length} links, ${speakers.length} speakers`);

  // 3. Extract per section, then drop anything the sources do not support.
  // Each finished chapter is saved, so a restart or rate limit resumes instead of paying for it again.
  const [saved] = await query<{ insights_partial: { v?: number; items?: Record<string, any> } }>(
    "SELECT insights_partial FROM videos WHERE id = $1", [video.id]);
  const partial: { v: number; items: Record<string, any> } =
    saved?.insights_partial?.v === INSIGHTS_VERSION ? { v: INSIGHTS_VERSION, items: saved.insights_partial.items ?? {} } : { v: INSIGHTS_VERSION, items: {} };
  const done: SectionInsight[] = [];
  const dropped: string[] = [];
  const check = (name: string): string | null => {
    const fixed = canonicalize(name, glossary) ?? name;
    if (glossary.includes(fixed) || appearsIn(fixed, corpus)) return fixed;
    dropped.push(name);
    return null;
  };
  let finished = 0;
  for (const s of sections) {
    r?.assertAlive(); // stops quietly if the video was deleted
    const key = `${s.start}|${s.title}`;
    let p: any = partial.items[key];
    if (!p) {
      try {
        p = await extractSection(video.title, glossary, s);
      } catch (e: any) {
        if (e instanceof JobCancelled) throw e;
        console.error(`Insights: skipped "${s.title}":`, e?.message ?? e); // one bad section must not lose the rest
        r?.report({ done: ++finished });
        continue;
      }
      partial.items[key] = p;
      // doubles as the heartbeat: tells other servers this claim is alive (a crashed run goes stale after 6 minutes)
      await query("UPDATE videos SET insights_started_at = now(), insights_partial = $2::jsonb WHERE id = $1", [video.id, JSON.stringify(partial)]).catch(() => {});
    } else if (DEBUG) console.log(`[insights] reusing saved result for "${s.title}"`);
    done.push({
      title: s.title,
      start: s.start,
      summary: typeof p.summary === "string" ? p.summary.trim() : "",
      key_points: strings(p.key_points, 6),
      tools: (Array.isArray(p.tools) ? p.tools : [])
        .map((t: any) => (typeof t === "string" ? { name: t, what: "" } : { name: String(t?.name ?? "").trim(), what: String(t?.what ?? "").trim() }))
        .filter((t: { name: string }) => t.name)
        .slice(0, 30)
        .map((t: { name: string; what: string }) => {
          const name = check(t.name);
          return name ? { name, what: t.what } : null;
        })
        .filter((t: { name: string; what: string } | null): t is { name: string; what: string } => !!t),
      people: strings(p.people, 20).map(check).filter((x): x is string => !!x),
      resources: strings(p.resources, 20).map(check).filter((x): x is string => !!x),
      numbers: (Array.isArray(p.numbers) ? p.numbers : [])
        .map((n: any) => ({ value: String(n?.value ?? "").trim(), what: String(n?.what ?? "").trim() }))
        .filter((n: { value: string; what: string }) => n.value && n.what && numberIsGrounded(n.value, s.text))
        .slice(0, 12),
      practices: strings(p.practices, 8),
    });
    r?.report({ done: ++finished });
  }
  if (!done.length) throw new Error("no section could be analysed");
  if (DEBUG) console.log(`[insights] dropped unsupported names: ${dropped.length ? dropped.join(", ") : "none"}`);

  // 4. Merge across sections (products from the description are authoritative and listed first).
  const at = (pick: (s: SectionInsight) => string[]) =>
    mergeNamed(done.flatMap((s) => pick(s).map((name) => ({ name, start: s.start }))));
  const sectionTools = done.flatMap((s) => s.tools.map((t) => ({ name: t.name, start: s.start, what: t.what })));
  const firstSeen = new Map(sectionTools.map((t) => [norm(t.name), t.start]).reverse() as [string, number][]);
  const tools = mergeNamed([...products.map((name) => ({ name, start: -1, what: "" })), ...sectionTools]);
  r?.report({ stage: "overview" });
  r?.assertAlive();
  // The overview step is a nicety: if it fails, keep all the extracted work and fall back to the chapter summaries.
  let degraded = false;
  const overview = await reduce(video.title, meta.description, done).catch((e: any) => {
    degraded = true;
    console.error("Insights: overview step failed, using chapter summaries for now:", String(e?.message ?? e).slice(0, 160));
    return { overview: done.slice(0, 3).map((s) => firstSentences(s.summary, 1)).join(" "), framework: [], takeaways: [], overview_pending: true };
  });
  const insights: Insights = {
    ...overview,
    speakers,
    sections: done,
    tools: tools.map((t) => ({ name: t.name, start: t.start >= 0 ? t.start : firstSeen.get(norm(t.name)) ?? 0, what: t.what ?? "" })),
    people: at((s) => s.people),
    resources: at((s) => s.resources),
    numbers: dedupeNumbers(done.flatMap((s) => s.numbers.map((n) => ({ ...n, start: s.start })))),
    practices: done.flatMap((s) => s.practices.map((text) => ({ text, start: s.start }))),
  };

  // 5. Store the breakdown, and refresh the short summary / category / tags from the whole video.
  const markdown = assembleMarkdown({
    youtubeId: video.youtube_id, title: video.title, author: meta.author,
    durationSeconds: meta.durationSeconds, links, insights,
  });
  const cat = await categorize(video.title, `${insights.overview}\nTools: ${insights.tools.map((t) => t.name).slice(0, 15).join(", ")}`)
    .catch(() => ({ category: "Other Tech", tags: [] as string[], summary: "" }));
  await query(
    `UPDATE videos SET deep_summary = $2, insights = $3::jsonb, summary = $4, category = $5, tags = $6,
       insights_version = CASE WHEN $8::boolean THEN insights_version ELSE $7 END,
       insights_started_at = NULL,
       insights_partial = CASE WHEN $8::boolean THEN insights_partial ELSE '{}'::jsonb END
     WHERE id = $1`,
    [video.id, markdown, JSON.stringify(insights), firstSentences(insights.overview || cat.summary, 3), cat.category, cat.tags, INSIGHTS_VERSION, degraded],
  );
  if (degraded) console.log(`Insights for "${video.title}" saved without the overview; the saved chapters will be reused when it is retried.`);
  console.log(`Insights ready for "${video.title}" (${markdown.length} chars, ${done.length}/${sections.length} sections)`);
  if (degraded) r?.report({ stage: "overview", detail: "Rate limited. The overview will be retried automatically." });
  else r?.report({ stage: "done" });
  await r?.flush();
}

const activeClaims = new Set<string>();

/** Called on shutdown so a restart (e.g. tsx watch) does not leave videos claimed. */
export async function releaseClaims(): Promise<void> {
  await Promise.all([...activeClaims].map((id) => query("UPDATE videos SET insights_started_at = NULL WHERE id = $1 AND insights_version < $2", [id, INSIGHTS_VERSION]).catch(() => {})));
}

/** Repairs a video whose overview step failed: re-runs only that step from the stored chapters (about 5k tokens). */
export async function refreshOverview(videoId: string): Promise<boolean> {
  const [v] = await query<any>(
    "SELECT id, youtube_id, title, author, duration_seconds, description, links, insights FROM videos WHERE id = $1 AND status = 'ready'", [videoId]);
  const sections: SectionInsight[] | undefined = v?.insights?.sections;
  if (!v || !sections?.length) return false;
  return withJob(videoId, async (r) => {
  r.report({ stage: "overview" });
  const o = await reduce(v.title, v.description, sections);
  const insights: Insights = { ...v.insights, ...o, overview_pending: false };
  const markdown = assembleMarkdown({
    youtubeId: v.youtube_id, title: v.title, author: v.author, durationSeconds: v.duration_seconds, links: v.links, insights,
  });
  const cat = await categorize(v.title, `${insights.overview}\nTools: ${insights.tools.map((t) => t.name).slice(0, 15).join(", ")}`)
    .catch(() => null);
  await query(
    `UPDATE videos SET deep_summary = $2, insights = $3::jsonb, summary = $4, insights_version = $5, insights_partial = '{}'::jsonb,
       category = COALESCE($6, category), tags = COALESCE($7, tags) WHERE id = $1`,
    [videoId, markdown, JSON.stringify(insights), firstSentences(insights.overview, 3), INSIGHTS_VERSION, cat?.category ?? null, cat?.tags ?? null],
  );
  console.log(`Overview refreshed for "${v.title}"`);
  r.report({ stage: "done" });
  await r.flush();
  return true;
  }, "overview");
}

/** Claims the video (so two servers never do the same work) and builds its detailed breakdown. */
export async function runInsights(videoId: string, segments?: TranscriptSegment[], force = false, fresh = false): Promise<boolean> {
  const rows = await query<VideoRow>(
    `UPDATE videos SET insights_started_at = now(), insights_partial = CASE WHEN $4::boolean THEN '{}'::jsonb ELSE insights_partial END
     WHERE id = $1 AND status = 'ready'
       AND ($3::boolean OR (insights_version < $2 AND (insights_started_at IS NULL OR insights_started_at < now() - interval '6 minutes')))
     RETURNING id, youtube_id, title`,
    [videoId, INSIGHTS_VERSION, force, fresh],
  );
  if (!rows[0]) return false;
  activeClaims.add(videoId);
  try {
    await withJob(videoId, () => buildInsights(rows[0], segments), "analyzing");
    return true;
  } catch (e: any) {
    if (e instanceof JobCancelled) return false; // the video was deleted
    // cooldown: the claim looks stale (and is retried) after 6 minutes, not immediately
    await query("UPDATE videos SET insights_started_at = now(), stage_detail = $2 WHERE id = $1",
      [videoId, `Paused: ${String(e?.message ?? e).slice(0, 120)}. Retrying automatically.`]).catch(() => {});
    throw e;
  } finally {
    activeClaims.delete(videoId);
  }
}

/** Queues every video whose detailed breakdown is missing, stale or lacks an overview (newest first). Cheap to call often. */
export async function backfillInsights(): Promise<void> {
  const missing = await query<{ id: string; title: string }>(
    `SELECT id, title FROM videos WHERE status = 'ready' AND insights_version >= $1
       AND (coalesce(insights->>'overview', '') = '' OR insights->>'overview_pending' = 'true')
       AND jsonb_array_length(coalesce(insights->'sections', '[]'::jsonb)) > 0`, [INSIGHTS_VERSION]);
  for (const v of missing) {
    insightsQueue.add(v.id, async () => {
      console.log(`Repairing overview for "${v.title}"`);
      await refreshOverview(v.id).catch((e) => console.error("Overview repair failed:", String(e?.message ?? e).slice(0, 160)));
    });
  }
  const rows = await query<{ id: string; title: string }>(
    `SELECT id, title FROM videos
     WHERE status = 'ready' AND insights_version < $1 AND (insights_started_at IS NULL OR insights_started_at < now() - interval '6 minutes')
     ORDER BY created_at DESC`,
    [INSIGHTS_VERSION],
  );
  for (const v of rows) {
    insightsQueue.add(v.id, async () => {
      console.log(`Building detailed breakdown for "${v.title}"`);
      await runInsights(v.id).catch((e) => console.error("Insights failed:", e?.message ?? e));
    });
  }
}
