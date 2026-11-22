-- Unique public product IDs and multiple reusable delivery assets per product.
ALTER TABLE key_products ADD COLUMN public_uid TEXT;
UPDATE key_products SET public_uid='P' || printf('%06d',id) WHERE public_uid IS NULL OR public_uid='';
CREATE UNIQUE INDEX key_products_public_uid ON key_products(public_uid);
CREATE TABLE product_assets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, asset_type TEXT NOT NULL,
 file_id TEXT, file_name TEXT, text_content TEXT, caption TEXT, sort INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, added_by INTEGER, FOREIGN KEY(product_id) REFERENCES key_products(id)
);
CREATE INDEX product_assets_product ON product_assets(product_id,sort,id);
