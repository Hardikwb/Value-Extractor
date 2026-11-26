import { query, toVector } from "../db/client.js";
import { formatTime } from "./chunker.js";
import { EMBED_MODEL_ID, embedQuery } from "./embeddings.js";
import { complete, streamChat, type ChatMsg } from "./llm.js";
import { buildContinuation, clipHistory, isGlobalQuestion, needsRewrite, rrf, toTsQuery, type Turn } from "./retrieval-utils.js";

const DEBUG = !!process.env.DEBUG_RAG;
const CANDIDATES = 20;
const HITS = 5;
const MIN_SIMILARITY = 0.55; // bge-small: unrelated text scores ~0.35-0.55, relevant ~0.6-0.85
const CONTEXT_CHARS = 9000;
/** A smaller prompt (half the breakdown and passages, short history) for models with a small per-request token cap. */
const COMPACT = 0.5;

interface Chunk { id: string; video_id: string; idx: number; start_seconds: number; text: string; title: string }
interface VideoRow { id: string; title: string; category: string; summary: string; outline: string }

const CHUNK_COLS = "c.id::text AS id, c.video_id::text AS video_id, c.idx, c.start_seconds, c.text, v.title";
const SCOPE = "v.status = 'ready' AND ($2::uuid IS NULL OR c.video_id = $2::uuid)";

async function vectorSearch(question: string, videoId: string | null) {
  const vec = toVector(await embedQuery(question));
  return query<Chunk & { sim: number }>(
    `SELECT ${CHUNK_COLS}, 1 - (c.embedding <=> $1::vector) AS sim
     FROM transcript_chunks c JOIN videos v ON v.id = c.video_id
     WHERE ${SCOPE} AND v.embed_model = $3
     ORDER BY c.embedding <=> $1::vector LIMIT ${CANDIDATES}`,
    [vec, videoId, EMBED_MODEL_ID],
  );
}

async function keywordSearch(question: string, videoId: string | null) {
  const tsq = toTsQuery(question);
  if (!tsq) return [];
  return query<Chunk>(
    `SELECT ${CHUNK_COLS}
     FROM transcript_chunks c JOIN videos v ON v.id = c.video_id, to_tsquery('english', $1) q
     WHERE c.tsv @@ q AND ${SCOPE}
     ORDER BY ts_rank(c.tsv, q) DESC LIMIT ${CANDIDATES}`,
    [tsq, videoId],
  );
}

/** Hybrid retrieval: vector + keyword, fused with RRF, each hit widened with its neighbours. */
async function retrievePassages(question: string, videoId: string | null, hits = HITS, contextChars = CONTEXT_CHARS): Promise<string[]> {
  const [vec, kw] = await Promise.all([vectorSearch(question, videoId), keywordSearch(question, videoId)]);
  const relevantVec = vec.filter((c) => Number(c.sim) >= MIN_SIMILARITY);
  const fused = rrf([relevantVec.map((c) => c.id), kw.map((c) => c.id)]);
  const byId = new Map([...relevantVec, ...kw].map((c) => [c.id, c]));
  const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, hits).map(([id]) => byId.get(String(id))!);

  if (DEBUG) {
    console.log(`[rag] q="${question}" vec=${vec.length} (kept ${relevantVec.length}, top sim ${vec[0]?.sim?.toFixed?.(3)}) kw=${kw.length} -> ${top.length} hits`);
  }
  if (!top.length) return [];

  const neighbours = await query<Chunk>(
    `SELECT ${CHUNK_COLS}
     FROM transcript_chunks c JOIN videos v ON v.id = c.video_id
     WHERE EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::int[]) h(vid, i)
                   WHERE h.vid = c.video_id AND abs(c.idx - h.i) <= 1)`,
    [top.map((t) => t.video_id), top.map((t) => t.idx)],
  );

  const used = new Set<string>();
  const groups: { video_id: string; first: number; start: number; title: string; text: string }[] = [];
  let chars = 0;
  for (const hit of top) {
    const members = neighbours
      .filter((n) => n.video_id === hit.video_id && Math.abs(n.idx - hit.idx) <= 1 && !used.has(n.id))
      .sort((a, b) => a.idx - b.idx);
    if (!members.length) continue;
    const text = members.map((m) => m.text).join(" ");
    if (chars + text.length > contextChars && groups.length) break;
    members.forEach((m) => used.add(m.id));
    chars += text.length;
    groups.push({ video_id: hit.video_id, first: members[0].idx, start: members[0].start_seconds, title: hit.title, text });
  }
  groups.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.first - b.first);
  return groups.map((g) => `[${videoId ? "" : g.title + " @ "}${formatTime(g.start)}]\n${g.text}`);
}

/** Turn a follow-up like "why is that needed?" into a standalone search query. */
async function standaloneQuestion(question: string, history: Turn[]): Promise<string> {
  if (!needsRewrite(question, history.length > 0)) return question;
  try {
    const convo = history.slice(-4).map((t) => `${t.role}: ${t.content.slice(0, 400)}`).join("\n");
    const out = await complete(
      [
        {
          role: "system",
          content:
            "Rewrite the user's last message as one standalone search query, resolving pronouns and references using the conversation. " +
            "Output only the query, no quotes or explanation. If it is already standalone, repeat it unchanged.",
        },
        { role: "user", content: `${convo}\nuser: ${question}` },
      ],
      { maxTokens: 200 },
    );
    return out.trim().replace(/^["']|["']$/g, "") || question;
  } catch {
    return question;
  }
}

const BREAKDOWN_MARKER = "Detailed breakdown";
const BREAKDOWN_CHARS = 14000;

interface OverviewRow extends VideoRow {
  deep_summary: string;
  author: string;
  links: { label: string; url: string; resolved_url?: string; is_github?: boolean }[];
  speakers: { name: string; role: string }[] | null;
}

async function videoOverview(videoId: string | null, withBreakdown: boolean, breakdownChars = BREAKDOWN_CHARS): Promise<string> {
  if (videoId) {
    const [v] = await query<OverviewRow>(
      `SELECT id, title, category, summary, outline, deep_summary, author, links, insights->'speakers' AS speakers
       FROM videos WHERE id = $1`, [videoId]);
    if (!v) return "";
    const lines = [`Video: ${v.title}`];
    if (v.author) lines.push(`Channel: ${v.author}`);
    lines.push(`Topic: ${v.category}`, `Summary: ${v.summary}`);
    if (v.speakers?.length) lines.push("Speakers: " + v.speakers.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join("; "));
    if (v.links?.length) {
      lines.push("Links from the video description:");
      for (const l of v.links.slice(0, 10)) lines.push(`- ${l.label}: ${l.resolved_url ?? l.url}${l.is_github ? " (GitHub repository)" : ""}`);
    }
    if (withBreakdown) {
      if (v.deep_summary) lines.push(`\n${BREAKDOWN_MARKER} (from the transcript and description):\n${v.deep_summary.slice(0, breakdownChars)}`);
      else if (v.outline) lines.push(`\n${BREAKDOWN_MARKER} (approximate section summaries):\n${v.outline}`);
    }
    return lines.join("\n");
  }
  const vs = await query<VideoRow>(
    "SELECT id, title, category, summary, outline FROM videos WHERE status = 'ready' ORDER BY created_at DESC LIMIT 20");
  return vs.length ? "Videos in the library:\n" + vs.map((v) => `- ${v.title} (${v.category}): ${v.summary}`).join("\n") : "";
}

const SYSTEM = `You answer questions about technical YouTube videos for a developer. The material below is all you know about what the video says.

- Lead with the direct answer. No preamble, and don't restate the question.
- Match length to the question: a sentence or two for simple ones, more only when it needs it. EXCEPTION: when asked to summarize, break down, give details or extract everything, ignore this limit and give a thorough, well-structured answer built from the detailed breakdown: the core framework, the points for each chapter with timestamps, tools, people, resources with their links, numbers, practices and takeaways. Present each category once (no recap table), keep links exactly as written, and point out any GitHub repository. Use lists, headings or tables only when they genuinely help. Put code and commands in fenced blocks.
- Cite a timestamp like (12:40) only for specific claims taken from a passage.
- Only name a tool, product, library, number or quote if it appears in the material below. If asked which tools the video uses and the material names none, say so. Likewise describe only the steps, features and details the material states; don't add ones that are typical or likely.
- If the video doesn't cover the question, say so in one sentence. Only if it helps, add a short note starting "Outside the video:" with accurate general knowledge.
- Don't present your own suggestions, estimates (such as durations) or roadmaps as if the video said them. For "what next?" questions give at most 6 short bullets and say they are suggestions based on the topics covered.
- Captions are auto-generated and may garble words; correct a term only when it is obvious from context.
- Never describe what a tool, product or person does unless the material says so; a name alone is fine. Do not add notes about your sources or claim the answer is "taken directly" from them.`;

const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  try { return await fn(); } finally { if (DEBUG) console.log(`[rag] ${label}: ${Date.now() - t}ms`); }
};

export async function* answer(opts: {
  videoId: string | null;
  question: string;
  history: Turn[];
  signal?: AbortSignal;
  /** the part of this answer that is already written (continuing after a cut-off, a stop or a restart) */
  continueFrom?: string;
  onFinish?: (reason: string) => void;
  /** use a smaller prompt (after a "request too large" error) */
  compact?: boolean;
}): AsyncGenerator<string> {
  const scale = opts.compact ? COMPACT : 1;
  const history = clipHistory(opts.history, opts.compact ? 4 : 6);
  const global = isGlobalQuestion(opts.question);
  const overviewP = timed("overview", () => videoOverview(opts.videoId, global, Math.round(BREAKDOWN_CHARS * scale))); // outline only for whole-video questions // runs while we rewrite/search
  const search = global ? opts.question : await timed("rewrite", () => standaloneQuestion(opts.question, history));

  let overview: string;
  let passages: string[];
  if (global && opts.videoId) {
    // Whole-video questions are answered from the stored outline; a few chunks add little.
    overview = await overviewP;
    passages = overview.includes(BREAKDOWN_MARKER) ? [] : await timed("retrieve", () => retrievePassages(search, opts.videoId, 3, Math.round(CONTEXT_CHARS * scale)));
  } else {
    [overview, passages] = await Promise.all([overviewP, timed("retrieve", () => retrievePassages(search, opts.videoId, HITS, Math.round(CONTEXT_CHARS * scale)))]);
  }
  const haveOutline = global && opts.videoId !== null && overview.includes(BREAKDOWN_MARKER);

  const parts = [SYSTEM];
  if (overview) parts.push(`## About the video\n${overview}`);
  if (passages.length) parts.push(`## Transcript passages\n${passages.join("\n\n")}`);
  else if (!haveOutline) parts.push("## Transcript passages\n(no passage matched this question closely)");
  const system: ChatMsg = { role: "system", content: parts.join("\n\n") };

  if (DEBUG) {
    console.log(`[rag] global=${global} search="${search}" passages=${passages.length} systemChars=${system.content.length}`);
  }
  const base: ChatMsg[] = [system, ...history, { role: "user", content: opts.question }];
  const messages = opts.continueFrom ? (buildContinuation(base, opts.continueFrom) as ChatMsg[]) : base;
  const t0 = Date.now();
  let first = true;
  // Whole-video answers are assembled from a ready-made breakdown, so they need little reasoning and a bigger budget.
  const streamOpts = { signal: opts.signal, onFinish: opts.onFinish, effort: global ? "low" : undefined, maxTokens: global ? 8000 : 6000 };
  for await (const d of streamChat(messages, streamOpts)) {
    if (first && DEBUG) { console.log(`[rag] first token after ${Date.now() - t0}ms`); first = false; }
    yield d;
  }
  if (DEBUG) console.log(`[rag] stream done after ${Date.now() - t0}ms`);
}
