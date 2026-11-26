import { MODE_LIST, type Mode } from "../modes";

/** Answer-type tags: pick one to change what the answer is (click again to clear). */
export function ModeTags({ value, onChange, disabled }: { value: Mode | null; onChange: (m: Mode | null) => void; disabled?: boolean }) {
  return (
    <div className="modetags" role="group" aria-label="Answer type">
      {MODE_LIST.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`modetag ${value === m.id ? "on" : ""}`}
          aria-pressed={value === m.id}
          title={m.hint}
          disabled={disabled}
          onClick={() => onChange(value === m.id ? null : m.id)}
        >
          {value === m.id ? "✓ " : ""}{m.label}
        </button>
      ))}
    </div>
  );
}
