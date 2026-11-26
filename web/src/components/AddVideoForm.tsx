import { useState } from "react";
import { api, type Video } from "../api";

/** Adding is instant: the video is queued and processed on the server, with progress shown in the sidebar. */
export function AddVideoForm({ onAdded }: { onAdded: (v: Video) => void | Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const v = await api.addVideo(url);
      setUrl("");
      await onAdded(v);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="add">
      <div className="add-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link…" disabled={busy} />
        <button className="primary" disabled={busy || !url.trim()}>{busy ? <span className="spinner" /> : "Add"}</button>
      </div>
      {error && <p className="banner">{error}</p>}
    </form>
  );
}
