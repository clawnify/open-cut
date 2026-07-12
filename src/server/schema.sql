-- Compositions: a HyperFrames HTML composition the user (or agent) authors.
-- width/height/duration live in the HTML's data-* attributes; we only keep the
-- render-time knobs the CLI needs (fps).
CREATE TABLE IF NOT EXISTS compositions (
  -- UUIDv4. The API supplies crypto.randomUUID(); this default covers any
  -- direct insert so the primary key (and the URL it appears in) is always a UUID.
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  fps INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Media library: logos, product-demo clips, images the user uploads. Stored in
-- R2 under `key`; the composition HTML references them as `assets/<key>`.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Render jobs: one row per render. The MP4 is stored in R2 and served from
-- output_url. status: rendering | completed | failed.
CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rendering',
  output_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_composition ON render_jobs(composition_id);
