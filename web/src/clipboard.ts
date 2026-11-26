/** Copy text, falling back to the old execCommand route when the async clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

/** Read the clipboard; null when the browser blocks it (the user can still press Ctrl+V). */
export async function readClipboard(): Promise<string | null> {
  try { return await navigator.clipboard.readText(); } catch { return null; }
}
