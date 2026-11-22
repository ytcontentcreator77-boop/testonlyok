CREATE TABLE IF NOT EXISTS campaigns (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL CHECK(type IN ('channel','manual')),
 reward_inr REAL NOT NULL DEFAULT 0,
 channels_json TEXT NOT NULL DEFAULT '[]',
 active INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS campaigns_active ON campaigns(active,id DESC);
CREATE TABLE IF NOT EXISTS campaign_completions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 campaign_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 completed_at INTEGER NOT NULL,
 UNIQUE(campaign_id,user_id),
 FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS campaign_submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 campaign_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 screenshot_data TEXT NOT NULL,
 screenshot_mime TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at INTEGER NOT NULL,
 reviewed_at INTEGER,
 reviewed_by INTEGER,
 UNIQUE(campaign_id,user_id),
 FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS campaign_notice_queue (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 campaign_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(campaign_id,user_id),
 FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS campaign_notice_pending ON campaign_notice_queue(status,id);
