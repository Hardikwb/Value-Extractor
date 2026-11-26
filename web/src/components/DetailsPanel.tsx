import { useEffect, useState } from "react";
import { api, type Video } from "../api";
import { Markdown } from "./Markdown";
import { NotesEditor } from "./NotesEditor";

/** Full breakdown of a video: resources (with GitHub flagged) and the detailed, timestamped summary. */
export function DetailsPanel({ video, onUpdated }: { video: Video; onUpdated: () => void }) {
  const [full, setFull] = useState<Video>(video);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const v = await api.video(video.id);
        if (!alive) return;
        setFull(v);
        if (!v.insights_ready) timer = setTimeout(load, 10000); // still being built in the background
        else if (!video.insights_ready) onUpdated(); // refresh sidebar: category / tags may have changed
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [video.id]);

  const links = full.links ?? [];
  return (
    <div className="details">
      <NotesEditor video={full} />
      {links.length > 0 && (
        <div className="reslinks">
          {links.map((l) => (
            <a key={l.url} href={l.resolved_url ?? l.url} target="_blank" rel="noopener noreferrer" className={l.is_github ? "reslink gh" : "reslink"} title={l.resolved_url ?? l.url}>
              {l.is_github ? "GitHub · " : ""}{l.label}
            </a>
          ))}
        </div>
      )}
      {error && <p className="banner">{error}</p>}
      {!full.insights_ready && (
        <p className="building"><span className="spinner dark" /> {full.deep_summary ? "Still finishing the overview…" : "The detailed breakdown is being built in the background (progress is shown above). You can close this page; it keeps running."}</p>
      )}
      {full.deep_summary ? <Markdown text={full.deep_summary} /> : full.summary && <p className="summary">{full.summary}</p>}
    </div>
  );
}
