import { useEffect, useState } from "react";
import { api, type Video } from "../api";
import { NotesFields, type MyNotes } from "./NotesFields";

/** View and edit the user's own description and notes for a video. They are used as context when answering. */
export function NotesEditor({ video, onSaved }: { video: Video; onSaved?: () => void }) {
  const initial: MyNotes = { description: video.user_description ?? "", notes: video.user_notes ?? "" };
  const [value, setValue] = useState<MyNotes>(initial);
  const [saved, setSaved] = useState<MyNotes>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  // pick up the saved values once the full video has loaded (the list view does not carry them)
  useEffect(() => {
    const fresh = { description: video.user_description ?? "", notes: video.user_notes ?? "" };
    setSaved(fresh);
    setValue((v) => (v.description === saved.description && v.notes === saved.notes ? fresh : v)); // never overwrite unsaved typing
  }, [video.user_description, video.user_notes]);

  const dirty = value.description !== saved.description || value.notes !== saved.notes;

  const save = async () => {
    setState("saving");
    setError("");
    try {
      const out = await api.saveNotes(video.id, value);
      const now = { description: out.user_description, notes: out.user_notes };
      setSaved(now);
      setValue(now);
      setState("saved");
      onSaved?.();
      setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 2000);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="mynotes">
      <div className="mynotes-head">
        <strong>My notes</strong>
        <span className="hint">Used as context in this video's chat, for example when you ask for interview questions.</span>
      </div>
      <NotesFields value={value} onChange={setValue} disabled={state === "saving"} />
      {error && <p className="banner">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={!dirty || state === "saving"} onClick={save}>{state === "saving" ? "Saving…" : "Save notes"}</button>
        {state === "saved" && <span className="hint">Saved ✓</span>}
        {dirty && state !== "saving" && <span className="hint">Unsaved changes</span>}
      </div>
    </div>
  );
}
