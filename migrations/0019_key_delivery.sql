-- Key delivery commerce schema. Legacy SMM tables remain for historical order compatibility;
-- new storefront and checkout use only these key-specific tables.
ALTER TABLE users ADD COLUMN balance_inr REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN referred_by INTEGER;
ALTER TABLE users ADD COLUMN referral_earnings_inr REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_bonus_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN product_id INTEGER;
ALTER TABLE orders ADD COLUMN plan_id INTEGER;
ALTER TABLE orders ADD COLUMN product_name TEXT;
ALTER TABLE orders ADD COLUMN plan_duration TEXT;
ALTER TABLE orders ADD COLUMN delivered_key TEXT;
ALTER TABLE orders ADD COLUMN key_source TEXT;
ALTER TABLE orders ADD COLUMN price_inr REAL;
ALTER TABLE orders ADD COLUMN discount_inr REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE orders ADD COLUMN api_cost_inr REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN setup_file_id TEXT;
ALTER TABLE orders ADD COLUMN setup_file_url TEXT;
ALTER TABLE orders ADD COLUMN expires_at INTEGER;

CREATE TABLE key_products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pid TEXT,
 category TEXT NOT NULL DEFAULT 'other', platform TEXT NOT NULL DEFAULT 'all',
 description TEXT, image_url TEXT, api_id TEXT, api_source TEXT NOT NULL DEFAULT 'both',
 setup_file_id TEXT, setup_file_name TEXT, setup_file_url TEXT,
 enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX key_products_enabled ON key_products(enabled, category, sort);
CREATE TABLE key_plans (
 id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, duration TEXT NOT NULL,
 duration_days REAL, price_inr REAL NOT NULL, reseller_price_inr REAL, api_duration TEXT,
 enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(product_id) REFERENCES key_products(id)
);
CREATE INDEX key_plans_product ON key_plans(product_id, enabled, sort);
CREATE TABLE key_stock (
 id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, plan_id INTEGER NOT NULL,
 key_value TEXT NOT NULL, import_batch TEXT, used INTEGER NOT NULL DEFAULT 0,
 used_by INTEGER, used_at INTEGER, order_id INTEGER, added_at INTEGER NOT NULL, added_by INTEGER
);
CREATE INDEX key_stock_avail ON key_stock(product_id, plan_id, used);
CREATE UNIQUE INDEX key_stock_unique_value ON key_stock(product_id, plan_id, key_value);
CREATE TABLE manual_payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, method_id TEXT NOT NULL,
 method_name TEXT NOT NULL, amount_inr REAL NOT NULL, utr_ref TEXT, proof_file_id TEXT,
 status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, created_at INTEGER NOT NULL,
 reviewed_at INTEGER, reviewed_by INTEGER
);
CREATE INDEX manual_payments_status ON manual_payments(status, id DESC);
CREATE TABLE coupons (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
 discount_mode TEXT NOT NULL DEFAULT 'percent', value REAL NOT NULL, target_product_id INTEGER,
 target_plan_id INTEGER, panel_valid_days INTEGER, next_orders_count INTEGER,
 max_uses INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0,
 per_user_limit INTEGER NOT NULL DEFAULT 1, expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE TABLE coupon_uses (
 id INTEGER PRIMARY KEY AUTOINCREMENT, coupon_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 remaining_orders INTEGER NOT NULL DEFAULT 0, order_id INTEGER, discount_applied_inr REAL NOT NULL DEFAULT 0,
 used_at INTEGER NOT NULL
);
CREATE INDEX coupon_uses_user ON coupon_uses(coupon_id, user_id);
CREATE TABLE bonus_claims (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount_inr REAL NOT NULL, claimed_at INTEGER NOT NULL
);
CREATE INDEX bonus_claims_user ON bonus_claims(user_id, claimed_at DESC);
CREATE TABLE file_tokens (
 token TEXT PRIMARY KEY, file_id TEXT NOT NULL, file_name TEXT, created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE inr_ledger (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, delta_inr REAL NOT NULL,
 kind TEXT NOT NULL, ref INTEGER, note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX inr_ledger_user ON inr_ledger(user_id, id DESC);
ALTER TABLE referrals ADD COLUMN reward_inr REAL NOT NULL DEFAULT 0;
ALTER TABLE coupon_uses ADD COLUMN valid_until INTEGER;
CREATE TABLE key_categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT '🔑', image_url TEXT, enabled INTEGER NOT NULL DEFAULT 1,
 sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE key_platforms (
 id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 logo_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE TABLE key_apis (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, api_key TEXT NOT NULL,
 master_key TEXT, mode TEXT NOT NULL DEFAULT 'reseller_v1', android_required INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) WITHOUT ROWID;
