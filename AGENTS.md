# Project agent notes — Amit Bot Key Store

- Primary customer flow is the key storefront, INR wallet, key purchase and delivery. Do not re-enable the legacy SMM `/orders` creation route.
- New key-store database changes belong in a new numbered SQL migration under `migrations/`; never edit an already deployed migration.
- All key purchases must debit `users.balance_inr`. Telegram Stars may top up the INR wallet only and must never be used for direct key checkout.
- Keep reseller API credentials server-side. Do not hardcode API keys/master keys or return them from admin GET endpoints.
- Verify all new key endpoints against Telegram user ownership and admin role checks.
- Use `inr_ledger` for all INR balance credits/debits/refunds.
- Manual payment requests remain pending until an admin explicitly approves them.
- Preserve the existing Worker, D1, Vite and Preact architecture; avoid adding paid infrastructure requirements.
- Run `npm ci`, `npm run build`, tests and D1 migration validation before production release.
