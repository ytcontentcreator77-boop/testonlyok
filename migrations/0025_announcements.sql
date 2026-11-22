-- Mini App announcements and per-user dismissal tracking.
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  button_text TEXT NOT NULL DEFAULT 'Continue',
  button_enabled INTEGER NOT NULL DEFAULT 0,
  button_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS announcements_active_id ON announcements(active, id DESC);
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  user_id INTEGER NOT NULL,
  announcement_id INTEGER NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, announcement_id),
  FOREIGN KEY(announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
);
