export interface MyNotes { description: string; notes: string }

/** The two text boxes for the user's own words about a video. */
export function NotesFields({ value, onChange, disabled }: { value: MyNotes; onChange: (v: MyNotes) => void; disabled?: boolean }) {
  return (
    <div className="notesfields">
      <label>
        <span>Description</span>
        <textarea
          rows={2}
          maxLength={2000}
          disabled={disabled}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="What is this video, and what are you using it for? e.g. a login-flood interview question for senior backend roles"
        />
      </label>
      <label>
        <span>Notes</span>
        <textarea
          rows={5}
          maxLength={8000}
          disabled={disabled}
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          placeholder="Your own notes: key points you want to remember, what to focus on, gaps to practise…"
        />
      </label>
    </div>
  );
}
