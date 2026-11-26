import type { Video } from "../api";
import { ProgressBar } from "./ProgressBar";

const STEPS: { stage: string; label: string }[] = [
  { stage: "transcript", label: "Fetch the transcript" },
  { stage: "metadata", label: "Read the video details" },
  { stage: "categorizing", label: "Categorize the video" },
  { stage: "embedding", label: "Index the transcript" },
  { stage: "saving", label: "Save the index (chat opens here)" },
  { stage: "analyzing", label: "Analyse chapters" },
  { stage: "overview", label: "Write the overview" },
];
const ORDER = ["queued", ...STEPS.map((s) => s.stage), "done"];

/** Shown instead of the chat while a video is still being processed (or if processing failed). */
export function ProcessingView({ video, onRetry, onDelete }: { video: Video; onRetry: () => void; onDelete: () => void }) {
  const failed = video.status === "failed";
  const at = ORDER.indexOf(video.stage ?? "queued");
  return (
    <div className="processing">
      <h2>{video.title === "Loading video…" ? `Video ${video.youtube_id}` : video.title}</h2>
      {failed ? (
        <>
          <p className="banner">{video.error || "Processing failed."}</p>
          <div className="actions">
            <button className="primary wide" onClick={onRetry}>Try again</button>
            <button className="ghost" onClick={onDelete}>Remove</button>
          </div>
        </>
      ) : (
        <>
          <div className="pstatus">
            <strong>{video.stage_label || "Starting…"}</strong>
            <span>{video.progress ?? 0}%</span>
          </div>
          <ProgressBar value={video.progress ?? 0} size="lg" busy={!!video.stage_detail} />
          {video.stage_detail && <p className="hint">{video.stage_detail}</p>}
          <ol className="steps">
            {STEPS.map((s, i) => {
              const idx = ORDER.indexOf(s.stage);
              const state = at > idx ? "done" : at === idx ? "current" : "todo";
              return (
                <li key={s.stage} className={state}>
                  <span className="mark">{state === "done" ? "✓" : state === "current" ? <span className="spinner dark" /> : i + 1}</span>
                  {s.label}
                </li>
              );
            })}
          </ol>
          <p className="hint">You can close this page. This keeps running on the server, and the progress will be here when you come back.</p>
        </>
      )}
    </div>
  );
}
