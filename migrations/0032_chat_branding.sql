-- Messaging platform branding, independent of legacy store settings.
ALTER TABLE chat_platform_settings ADD COLUMN brand_name TEXT NOT NULL DEFAULT 'Telegram X Hero';
ALTER TABLE chat_platform_settings ADD COLUMN brand_description TEXT NOT NULL DEFAULT 'Private messaging';
