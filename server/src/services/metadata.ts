import { cleanUrl, type LinkInfo } from "./insights-utils.js";

export interface VideoMeta { title: string; author: string; durationSeconds: number; description: string }

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const EMPTY: VideoMeta = { title: "", author: "", durationSeconds: 0, description: "" };

/** Title, channel, length and description from the watch page. Best effort: failures return empty metadata. */
export async function fetchVideoMeta(videoId: string): Promise<VideoMeta> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return EMPTY;
    const html = await res.text();
    const m = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var|<\/script>)/.exec(html);
    if (!m) return EMPTY;
    const d = JSON.parse(m[1])?.videoDetails ?? {};
    return {
      title: String(d.title ?? ""),
      author: String(d.author ?? ""),
      durationSeconds: Number(d.lengthSeconds ?? 0) || 0,
      description: String(d.shortDescription ?? ""),
    };
  } catch (e: any) {
    console.warn("Could not read video metadata:", e?.message ?? e);
    return EMPTY;
  }
}

/** Follow short links (g.dev/..., goo.gle/...) to their real destination, so a GitHub repo is recognisable. */
export async function resolveLinks(links: LinkInfo[], max = 12): Promise<LinkInfo[]> {
  return Promise.all(
    links.slice(0, max).map(async (l) => {
      try {
        const res = await fetch(l.url, { redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
        res.body?.cancel().catch(() => {});
        const resolved = cleanUrl(res.url);
        const host = new URL(resolved).hostname.replace(/^www\./, "");
        return { ...l, resolved_url: resolved, is_github: host === "github.com" || host.endsWith(".github.io") };
      } catch {
        return { ...l, is_github: /github\.com/i.test(l.url) };
      }
    }),
  );
}
