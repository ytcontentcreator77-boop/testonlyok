-- Retire the former SMM/key-store commerce schema. Messaging, Telegram auth,
-- Premium subscriptions, announcements, bot broadcasts and setup rate limits remain.
DROP TABLE IF EXISTS campaign_notice_queue;
DROP TABLE IF EXISTS campaign_submissions;
DROP TABLE IF EXISTS campaign_completions;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS product_assets;
DROP TABLE IF EXISTS key_stock;
DROP TABLE IF EXISTS key_plans;
DROP TABLE IF EXISTS key_products;
DROP TABLE IF EXISTS key_categories;
DROP TABLE IF EXISTS key_platforms;
DROP TABLE IF EXISTS key_apis;
DROP TABLE IF EXISTS manual_payments;
DROP TABLE IF EXISTS coupon_uses;
DROP TABLE IF EXISTS coupons;
DROP TABLE IF EXISTS bonus_claims;
DROP TABLE IF EXISTS file_tokens;
DROP TABLE IF EXISTS inr_ledger;
DROP TABLE IF EXISTS upi_auto_transactions;
DROP TABLE IF EXISTS payment_methods;
DROP TABLE IF EXISTS currencies;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS category_icons;
DROP TABLE IF EXISTS category_summary;
DROP TABLE IF EXISTS category_rules;
DROP TABLE IF EXISTS service_names;
DROP TABLE IF EXISTS price_changes;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS ledger;

-- Remove persisted store/provider/payment/referral configuration while preserving
-- shared owner, bot, support, announcement and messaging settings.
DELETE FROM settings WHERE key IN (
  'default_markup_pct','stars_per_usd','min_topup_stars','max_topup_stars',
  'sync_enabled','sync_every_hours','auto_enable_new','only_timed','low_balance',
  'howto_title','howto_description','howto_youtube_url','howto_tiktok_url',
  'howto_video_url','howto_fallback_url','referral_enabled','referral_reward_stars',
  'referral_daily_cap','last_sync_at','last_sync_summary','sync_state','last_catalog_at',
  'catalog_version','np_webhook_id','np_webhook_secret','np_api_key','inr_symbol',
  'inr_per_usd','key_delivery_mode','low_stock_alert','key_stock_checked_at',
  'api_low_balance_inr','api_balance_checked_at','reseller_api_url','reseller_api_key',
  'reseller_master_key','active_key_api_id','payment_methods','upi_gateway_api_key',
  'upi_gateway_enabled','upi_id','upi_qr_url','bonus_enabled','bonus_mode',
  'bonus_fixed_inr','bonus_min_inr','bonus_max_inr','bonus_cooldown_hours',
  'referral_signup_bonus_inr','referral_commission_percent','apk_file_id',
  'apk_file_name','apk_updated_at'
);
