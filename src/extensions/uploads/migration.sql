CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Content-addressed name on disk (sha256 hex + sniffed extension); never a
  -- user-supplied filename.
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX uploads_user_id ON uploads (user_id);
CREATE INDEX uploads_stored_name ON uploads (stored_name);
