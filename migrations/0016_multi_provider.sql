CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  usd_rate REAL NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  balance TEXT,
  created_at INTEGER NOT NULL
);
ALTER TABLE services ADD COLUMN provider_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN remote_id TEXT;
ALTER TABLE services ADD COLUMN icon TEXT;
CREATE TABLE category_icons (
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  icon TEXT NOT NULL,
  PRIMARY KEY (platform, category)
) WITHOUT ROWID;
CREATE TABLE currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  per_usd REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
INSERT INTO currencies (code, name, symbol, per_usd) VALUES
('USD','US Dollar','$',1),('EUR','Euro','€',0.92),('GBP','British Pound','£',0.79),('INR','Indian Rupee','₹',83.5),
('NPR','Nepalese Rupee','रु',133.5),('BDT','Bangladeshi Taka','৳',110),('PKR','Pakistani Rupee','₨',278),('LKR','Sri Lankan Rupee','Rs',300),
('AED','UAE Dirham','د.إ',3.67),('SAR','Saudi Riyal','﷼',3.75),('TRY','Turkish Lira','₺',32),('RUB','Russian Ruble','₽',92),
('IDR','Indonesian Rupiah','Rp',15700),('MYR','Malaysian Ringgit','RM',4.7),('PHP','Philippine Peso','₱',57),('VND','Vietnamese Dong','₫',25000),
('THB','Thai Baht','฿',36),('BRL','Brazilian Real','R$',5),('NGN','Nigerian Naira','₦',1500),('EGP','Egyptian Pound','E£',48),
('CAD','Canadian Dollar','C$',1.36),('AUD','Australian Dollar','A$',1.52),('JPY','Japanese Yen','¥',150),('KRW','South Korean Won','₩',1350);
CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  currency TEXT NOT NULL DEFAULT 'USD',
  details TEXT NOT NULL DEFAULT '',
  api_url TEXT,
  api_key TEXT,
  min_amount REAL NOT NULL DEFAULT 1,
  fee_pct REAL NOT NULL DEFAULT 0,
  icon TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
INSERT INTO payment_methods (id, name, kind, currency, enabled, sort) VALUES
('stars','Telegram Stars','stars','USD',1,0),('upi','UPI','manual','INR',0,1),
('bank','Bank Transfer','manual','USD',0,3),('manual','Manual Payment','manual','USD',0,4),('esewa','eSewa','manual','NPR',0,5),
('khalti','Khalti','manual','NPR',0,6),('bkash','bKash','manual','BDT',0,7),('binance','Binance Pay','api','USD',0,8),
('crypto','Crypto','api','USD',0,9);
