-- Chat controls: configurable pin limits and premium-plan administration.
CREATE TABLE IF NOT EXISTS chat_platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  free_pin_limit INTEGER NOT NULL DEFAULT 3,
  premium_pin_limit INTEGER NOT NULL DEFAULT 10,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO chat_platform_settings(id,free_pin_limit,premium_pin_limit) VALUES(1,3,10);
ALTER TABLE chat_messages ADD COLUMN forwarded_from_id INTEGER;
