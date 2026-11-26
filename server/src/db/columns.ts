import { INSIGHTS_VERSION } from "../services/insights-utils.js";

// The light set of video columns used by lists and by "add video" responses (no description, raw insights or full breakdown).
export const LIST_COLS = `id, youtube_id, url, title, category, tags, summary, status, author, duration_seconds, links, chapters,
  created_at, stage, progress, stage_label, stage_detail, error, (insights_version >= ${INSIGHTS_VERSION}) AS insights_ready`;
