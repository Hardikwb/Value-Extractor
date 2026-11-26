import { complete } from "./llm.js";
import { sampleText } from "./retrieval-utils.js";

export const CATEGORIES = [
  "AI & Machine Learning", "Web Development", "Backend & APIs", "DevOps & Cloud",
  "Databases & Data Engineering", "Cybersecurity", "Systems & Low-Level", "Mobile Development",
  "Programming Languages", "Software Engineering & Architecture", "Career & Productivity in Tech", "Other Tech",
] as const;

export interface Categorization { category: string; tags: string[]; summary: string }

export async function categorize(title: string, transcriptText: string): Promise<Categorization> {
  const sample = sampleText(transcriptText);
  const raw = await complete(
    [
      {
        role: "system",
        content:
          `You classify TECHNICAL YouTube videos (software, IT, AI, engineering). Respond ONLY with JSON: ` +
          `{"category": string, "tags": string[], "summary": string}.\n` +
          `- "category": exactly one of: ${CATEGORIES.join(" | ")}. Pick the most specific fit; use "Other Tech" only if none apply.\n` +
          `- "tags": 3-6 concrete technologies or concepts mentioned (e.g. "Docker", "React hooks", "REST", "CI/CD"), not generic words.\n` +
          `- "summary": 2-3 sentences naming the main technologies and what a viewer will be able to do or understand afterwards.`,
      },
      { role: "user", content: `Title: ${title}\n\nTranscript (may be truncated):\n${sample}` },
    ],
    { json: true },
  );
  try {
    const p = JSON.parse(raw);
    const category = (CATEGORIES as readonly string[]).includes(p.category) ? p.category : "Other Tech";
    return {
      category,
      tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 6) : [],
      summary: String(p.summary ?? ""),
    };
  } catch {
    return { category: "Other Tech", tags: [], summary: "" };
  }
}
