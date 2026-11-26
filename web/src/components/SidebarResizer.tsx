import { useRef } from "react";
import { clampWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "../sidebarWidth";

/** A thin draggable divider between the sidebar and the chat. Arrow keys resize it; double-click resets it. */
export function SidebarResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const dragging = useRef(false);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize (double-click to reset)"
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (dragging.current) onChange(clampWidth(e.clientX)); }}
      onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
      onDoubleClick={() => onChange(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") { e.preventDefault(); onChange(clampWidth(width - step)); }
        if (e.key === "ArrowRight") { e.preventDefault(); onChange(clampWidth(width + step)); }
        if (e.key === "Home") { e.preventDefault(); onChange(SIDEBAR_MIN); }
        if (e.key === "End") { e.preventDefault(); onChange(SIDEBAR_MAX); }
      }}
    />
  );
}
