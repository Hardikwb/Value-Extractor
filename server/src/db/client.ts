import { neon } from "@neondatabase/serverless";
import { config } from "../config.js";

// HTTPS (port 443) query mode: no WebSocket / raw Postgres port needed.
const sql = neon(config.DATABASE_URL);

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.query(text, params as any[])) as T[];
}

/** pgvector literal, e.g. "[0.1,0.2]" */
export const toVector = (v: number[]) => `[${v.join(",")}]`;
