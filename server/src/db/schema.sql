CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id text UNIQUE NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'Other',
  tags text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id bigserial PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  idx int NOT NULL,
  start_seconds int NOT NULL,
  text text NOT NULL,
  embedding vector(384) NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_video_idx ON transcript_chunks(video_id, idx);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON transcript_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid REFERENCES videos(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages(chat_id, id);

ALTER TABLE videos ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS outline text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS embed_model text NOT NULL DEFAULT 'minilm-l6-v2';
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON transcript_chunks USING gin (tsv);

ALTER TABLE videos ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_seconds int NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS chapters jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS insights jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS deep_summary text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS insights_version int NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS insights_started_at timestamptz;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS insights_partial jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'done';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS progress int NOT NULL DEFAULT 100;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS stage_label text NOT NULL DEFAULT 'Ready';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS stage_detail text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS error text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS job_heartbeat timestamptz;
UPDATE videos SET stage = 'analyzing', progress = 60, stage_label = 'Waiting to analyse chapters' WHERE status = 'ready' AND insights_version < 1 AND stage = 'done'
;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'done';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS finish_reason text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE chats c SET updated_at = GREATEST(c.created_at, COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.chat_id = c.id), c.created_at))
WHERE c.updated_at > now() - interval '1 minute';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS user_description text NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS user_notes text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mode text
