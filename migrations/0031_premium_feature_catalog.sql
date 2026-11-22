-- Premium feature catalog and editable plan entitlements.
ALTER TABLE premium_plans ADD COLUMN features TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS premium_feature_catalog (
  feature_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO premium_feature_catalog(feature_key,title,description) VALUES
('pin10','Pin up to 10 chats','Expanded pinned chat limit'),
('unlimited_pins','Unlimited pinned chats','Remove the pinned chat cap'),
('chat_folders','Chat folders','Organize conversations into folders'),
('advanced_search','Advanced search','Search message history with filters'),
('saved_messages','Saved messages','Keep a private saved-message space'),
('scheduled_messages','Scheduled messages','Schedule messages for later'),
('silent_messages','Silent messages','Send without notification sounds where supported'),
('auto_delete','Auto-delete timer','Set an automatic message expiry timer'),
('edit_history','Edit history','View previous versions of edited messages'),
('custom_themes','Custom themes','Choose premium chat appearance'),
('accent_colors','Accent colors','Personalize chat colors'),
('profile_badge','Premium profile badge','Display a premium badge'),
('profile_emoji','Profile emoji','Choose a profile status emoji'),
('long_bio','Extended bio','Use a longer profile description'),
('username_style','Username styling','Enhanced username presentation'),
('last_seen_controls','Granular last-seen controls','Choose who can see activity'),
('read_receipt_controls','Read receipt controls','Control read receipt visibility'),
('message_translation','Message translation','Translate message text'),
('chat_export','Chat export','Export your own conversation history'),
('larger_drafts','Longer messages','Higher message length allowance'),
('priority_support','Priority support','Priority admin support'),
('extra_reactions','Extra reactions','Additional reaction choices'),
('chat_backup','Chat backup','Create downloadable chat backups'),
('multiple_profiles','Profile themes','Save multiple profile looks'),
('premium_analytics','Usage insights','View personal chat activity insights');
