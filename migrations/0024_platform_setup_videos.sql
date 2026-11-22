-- Per-platform setup tutorial videos and stable Telegram deep links (video<platform_id>).
ALTER TABLE key_platforms ADD COLUMN setup_video_file_id TEXT;
ALTER TABLE key_platforms ADD COLUMN setup_video_url TEXT;
