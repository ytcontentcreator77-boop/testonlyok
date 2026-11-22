-- Setup tutorials belong to individual products, not platform categories.
ALTER TABLE key_products ADD COLUMN setup_video_file_id TEXT;
ALTER TABLE key_products ADD COLUMN setup_video_url TEXT;
