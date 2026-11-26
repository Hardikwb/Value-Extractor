/** "hi" -> "Hindi" (falls back to the code if the browser cannot name it). */
export function languageName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code.replace("_", "-")) ?? code; } catch { return code; }
}
