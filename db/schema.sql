-- Performance Alignment Intelligence — database schema
-- This is a reference copy of exactly what POST /api/setup creates.
-- You normally don't need to run this by hand — calling /api/setup once
-- after deploying does it for you, and it's safe to call more than once.
-- It's here so you (or anyone reviewing this) can see the schema directly,
-- or run it manually in the Neon SQL editor if you ever need to.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'executive',        -- admin | hr_manager | head_of_dept | executive
  department TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id),
  label TEXT,
  datasets JSONB NOT NULL,                         -- the 4 raw uploaded datasets
  kpi JSONB NOT NULL,                               -- cached computeExecutiveKPIs() output
  department_rollups JSONB NOT NULL DEFAULT '{}'::jsonb,
  overall_avg_score NUMERIC,                        -- denormalised for fast trend queries
  is_current BOOLEAN NOT NULL DEFAULT false         -- exactly one row is true at a time
);

CREATE TABLE IF NOT EXISTS workflow_items (
  id SERIAL PRIMARY KEY,
  item_type TEXT NOT NULL,                          -- 'goal' | 'task'
  item_key TEXT NOT NULL,                            -- the goal/task ID from the dataset
  status TEXT NOT NULL DEFAULT 'open',               -- open | in_progress | resolved
  assigned_to TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_type, item_key)
);

CREATE TABLE IF NOT EXISTS workflow_comments (
  id SERIAL PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_key TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
