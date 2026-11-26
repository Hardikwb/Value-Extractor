import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { z } from "zod";

// Node's default 250ms per-address connect attempt is too short on slower links
// (causes ETIMEDOUT even though the host is reachable).
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const schema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().default(3001),
});

export const config = schema.parse(process.env);
