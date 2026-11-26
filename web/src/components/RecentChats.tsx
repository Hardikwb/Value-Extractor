import { useState } from "react";
import type { Chat, Video } from "../api";

const VISIBLE_GROUPS = 8;

/**
 * Recent chats, one row per video (its latest chat), newest first. A "+N" button opens the video's older chats.
 * A pulsing dot marks a chat whose answer is being written by the server right now.
 */
export function RecentChats({ chats, videos, activeId, onOpen, onDelete }: {
  chats: Chat[];
  videos: Video[];
  activeId: string | null;
  onOpen: (c: Chat) => void;
  onDelete: (c: Chat) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  if (!chats.length) return null;

  // `chats` is newest first, so the first chat seen for a video is its latest one
  const groups: { key: string; chats: Chat[] }[] = [];
  for (const c of chats) {
    const key = c.video_id ?? "all";
    const g = groups.find((x) => x.key === key);
    g ? g.chats.push(c) : groups.push({ key, chats: [c] });
  }
  const shown = all ? groups : groups.slice(0, VISIBLE_GROUPS);
  const videoName = (c: Chat) => videos.find((v) => v.id === c.video_id)?.title ?? (c.video_id ? "Video" : "All videos");

  const row = (c: Chat, extra?: React.ReactNode, nested = false) => (
    <div key={c.id} className={`chatrow ${c.id === activeId ? "active" : ""} ${nested ? "nested" : ""}`}>
      <button className="chatbtn" onClick={() => onOpen(c)} title={c.title}>
        <span className="ctitle">{c.generating && <span className="dot" title="Writing an answer…" />}{c.title}</span>
        {!nested && <span className="csub">{videoName(c)}</span>}
      </button>
      {extra}
      <button className="del" title="Delete chat" onClick={() => confirm("Delete this chat?") && onDelete(c)}>×</button>
    </div>
  );

  return (
    <div className="recent">
      <div className="label">Recent chats</div>
      {shown.map((g) => {
        const [latest, ...older] = g.chats;
        const expanded = !!open[g.key];
        return (
          <div key={g.key}>
            {row(latest, older.length > 0 && (
              <button className="morechats" title={expanded ? "Hide older chats" : "Show older chats"} onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>
                {expanded ? "−" : `+${older.length}`}
              </button>
            ))}
            {expanded && older.map((c) => row(c, null, true))}
          </div>
        );
      })}
      {groups.length > VISIBLE_GROUPS && (
        <button className="textbtn more" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all videos (${groups.length})`}</button>
      )}
    </div>
  );
}
