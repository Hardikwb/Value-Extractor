import { runMigrations } from "./migrations.js";

await runMigrations();
console.log("Migration complete");
