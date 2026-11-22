# Telegram X Hero — project notes

- This repository is a Telegram-authenticated messaging Mini App, not a store. Do not add storefront, wallet, payment-provider, inventory, or product-delivery features.
- User identity comes from Telegram Mini App initData. Validate its HMAC signature before trusting the user object.
- On every authenticated app launch, sync Telegram id, first_name, last_name, username, language_code, and photo_url into the existing user record. Never let clients submit another user's identity fields.
- Keep Telegram bot token and all credentials server-side. Never expose secrets in API responses or frontend bundles.
- Preserve the Worker, D1, Hono, Vite and Preact architecture.
- Do not claim a Premium feature is active unless the backend enforces it.
- Add new D1 changes as new numbered migrations; do not rewrite migrations already applied to deployed databases.
- Before release, run dependency installation, production build, tests, and migration validation. Report any checks that could not be run.
