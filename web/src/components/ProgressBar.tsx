/** A thin accessible progress bar. `busy` adds a moving shimmer (e.g. while waiting out a rate limit). */
export function ProgressBar({ value, busy = false, size = "sm", label }: { value: number; busy?: boolean; size?: "sm" | "lg"; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`pbar ${size} ${busy ? "busy" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label ?? "Progress"}>
      <div className="pfill" style={{ width: `${pct}%` }} />
    </div>
  );
}
