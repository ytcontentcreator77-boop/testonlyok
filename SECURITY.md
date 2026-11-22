# Security notes — Amit Bot Key Store

- Never commit Telegram bot tokens, reseller API keys, master keys, payment credentials or database credentials.
- Configure `BOT_TOKEN`, `TG_WEBHOOK_SECRET` and `OWNER_IDS` as Worker secrets/environment values.
- Reseller API keys and master keys are stored server-side in D1. Admin API responses return only provider metadata and a configured flag, never credentials.
- Customer endpoints are authenticated using Telegram Mini App init data. A user can only list or reveal keys belonging to their own Telegram user ID.
- Admin endpoints require an owner/admin Telegram ID.
- Key inventory is reserved before wallet debit. If wallet debit fails, the reserved stock item is released. API fulfillment failures refund the wallet debit.
- Manual payment requests do not credit a wallet automatically. Only an authorized admin approval credits `balance_inr` and writes the INR ledger entry.
- Key orders are wallet-balance-only. Telegram Stars are accepted only through the wallet top-up endpoint.
- Do not send full delivered keys in broadcasts. Personalization tags such as `{key_1}` are powerful and should only be used in carefully targeted messages.
- Use HTTPS for product images, QR images and setup download links. Prefer Telegram file IDs for private setup files.
- The supplied reference code does not define the reseller API balance-check action. Verify it with the provider before relying on automated balance alerts.
