import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "./client.js";

/** Applies schema.sql. Every statement is idempotent (IF NOT EXISTS), so this is safe on every start. */
export async function runMigrations(log = true): Promise<void> {
  const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  // HTTP mode runs one statement per request, so split the script.
  const statements = schema.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await query(stmt);
    if (log) console.log("migrate ok:", stmt.split("\n")[0].slice(0, 70));
  }
}
