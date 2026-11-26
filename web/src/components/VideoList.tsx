import { useState } from "react";
import type { Video } from "../api";
import { ProgressBar } from "./ProgressBar";

interface Props {
  videos: Video[];
  activeVideoId: string | null;
  onSelect: (v: Video) => void;
  onDelete: (v: Video) => void;
  onRetry: (v: Video) => void;
}

const isReady = (v: Video) => v.status === undefined || v.status === "ready";

function Row({ v, active, onSelect, onDelete, onRetry }: { v: Video; active: boolean; onSelect: () => void; onDelete: () => void; onRetry: () => void }) {
  const failed = v.status === "failed";
  const working = v.status === "processing" || (isReady(v) && v.insights_ready === false);
  const title = v.title === "Loading video…" ? `Video ${v.youtube_id}` : v.title;
  return (
    <div className={`video ${active ? "active" : ""} ${working || failed ? "tall" : ""}`}>
      <div className="vmain">
        <button className="vtitle" onClick={onSelect} title={title}>{title}</button>
        {working && (
          <div className="vprog">
            <ProgressBar value={v.progress ?? 0} busy={!!v.stage_detail} label={v.stage_label} />
            <span className="vlabel">{v.stage_label} · {v.progress ?? 0}%</span>
          </div>
        )}
        {failed && <span className="vlabel err" title={v.error}>{v.error || "Failed"}</span>}
      </div>
      {failed && <button className="del show" title="Try again" onClick={onRetry}>↻</button>}
      <button className="del" title="Delete" onClick={() => confirm(working ? "Stop processing and delete this video?" : "Delete this video?") && onDelete()}>×</button>
    </div>
  );
}

export function VideoList({ videos, activeVideoId, onSelect, onDelete, onRetry }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inProgress = videos.filter((v) => !isReady(v));
  const groups = videos.filter(isReady).reduce<Record<string, Video[]>>((acc, v) => {
    (acc[v.category] ??= []).push(v);
    return acc;
  }, {});

  if (!videos.length) return <p className="hint pad">Your videos will appear here, grouped by topic.</p>;

  const row = (v: Video) => (
    <Row key={v.id} v={v} active={v.id === activeVideoId} onSelect={() => onSelect(v)} onDelete={() => onDelete(v)} onRetry={() => onRetry(v)} />
  );

  return (
    <nav className="videos">
      {inProgress.length > 0 && (
        <section>
          <div className="group static">In progress<span className="count">{inProgress.length}</span></div>
          {inProgress.map(row)}
        </section>
      )}
      {Object.entries(groups).map(([category, items]) => (
        <section key={category}>
          <button className="group" onClick={() => setCollapsed((c) => ({ ...c, [category]: !c[category] }))}>
            <span className={`chev ${collapsed[category] ? "" : "open"}`}>›</span>
            {category}
            <span className="count">{items.length}</span>
          </button>
          {!collapsed[category] && items.map(row)}
        </section>
      ))}
    </nav>
  );
}
