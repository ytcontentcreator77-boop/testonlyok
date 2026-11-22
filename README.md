# Amit Bot — Key Delivery Store

A Telegram bot + Telegram Mini App for selling game, software and platform access keys. The original Workpanel/Cloudflare architecture is retained, while the customer storefront and new order flow use the INR key-store database and wallet.

## What is included

- Product catalogue with configurable categories, platform logos and product images.
- Validity plans priced in INR.
- Manual stock import from the admin app or Telegram (`/addkey PRODUCT_ID | PLAN_ID` with newline-separated keys; or attach a `.txt` file with that caption).
- Multi-provider reseller API registry. Each product can use the active API or a provider override.
- Automatic delivery: manual stock first, then API when the product and delivery mode permit it.
- Masked key display, reveal/copy controls, My Keys history and optional APK/setup-file delivery.
- INR wallet, UPI QR/UPI ID and 10+ manual payment options, proof submission and admin approval.
- Telegram Stars are an optional wallet top-up method only. Key orders are charged from wallet balance; there is no direct Stars checkout for a key.
- Coupons (wallet credit, free key, global/product discount and next-X-order discounts), bonus claims and INR referral rewards/commissions.
- Personalized broadcasts and one-to-one messages with `{name}`, `{username}`, `{balance}`, `{totalkeys}`, `{key_1}`, `{key_2}`, `{key_3}`, `{product}`, `{expiry}`, `{joined}`, `{orders}`, `{brand}` and `{support}`.
- Nepali language onboarding plus the existing language picker and locale fallback system.
- Admin pages for products, plans, stock, API providers, payment methods, payment approvals, coupons, bonuses, key orders/refunds and key-store analytics.

## Runtime requirements

Use Node.js 24 or newer (as required by the project toolchain).

## Local development

```bash
npm ci
npm run dev
```

The app uses the existing Vite + Preact frontend and Cloudflare Worker backend. See `wrangler.jsonc` for bindings and deployment configuration.

## Cloudflare deployment

1. Create a Cloudflare D1 database and configure the `DB` binding in `wrangler.jsonc`.
2. Configure the static assets binding (`ASSETS`) and Worker name/domain.
3. Set Worker secrets: `BOT_TOKEN`, and optionally `TG_WEBHOOK_SECRET` and `OWNER_IDS` (comma-separated Telegram user IDs).
4. Apply migrations in order. The runtime migration bootstrap also applies pending SQL migrations when the Worker starts.
5. Build and deploy:

```bash
npm ci
npm run build
npx wrangler deploy
```

6. Open the setup route configured by the project, complete bot setup and set the bot webhook. Add admin Telegram IDs in `OWNER_IDS` or from the admin controls.
7. In the Admin panel, create products and plans, import key stock, configure payment instructions/UPI QR, and connect reseller API providers.

## Reseller API setup

Add provider credentials from **Admin → Reseller API providers**. Credentials are stored server-side in D1 and are not returned to the Mini App. Do not paste API keys into frontend source, commit them, or share them in screenshots.

The Amit reference code confirms the reseller purchase request shape: `action=buy`, `api_key`, `product_id`, `duration`, optional `android_id`, and an `x-master-key` header; a successful response contains `status: "success"` and a key. The provider's balance-check action is not defined by the supplied reference source, so the balance-check button/low-balance alert must be verified against the live provider's current API documentation before relying on it.

## Wallet and payment behavior

- The customer selects a product and plan, applies any coupon, and checks out from `balance_inr`.
- UPI/manual submissions create a pending payment. Wallet funds are credited only after an admin approves it.
- Customers can attach a screenshot to the bot with caption `/proof PAYMENT_ID`.
- Telegram Stars create a wallet top-up invoice and are converted to INR using the configured `inr_per_usd` rate. They cannot directly buy a key.
- Set `inr_per_usd` to the rate you intend to use before enabling Stars top-ups.

## Important notes

- The legacy SMM tables and historical records are retained for compatibility, but the legacy `/orders` creation route is disabled and the old SMM cron sync/order polling is no longer scheduled.
- `key_delivery_mode` supports `auto`, `stock_only`, and `api_only`.
- Use HTTPS image/setup URLs. Telegram file IDs can be attached by sending a document to the bot with caption `/upload PRODUCT_ID`.
- Always test a provider with a low-value product and a non-production key before opening the store to customers.
