CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX notes_created_at ON notes (created_at);

INSERT INTO notes (title) VALUES ('It persists.');
