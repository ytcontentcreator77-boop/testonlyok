# Key-store implementation status

## Implemented in this conversion

- Key-store schema and INR wallet ledger (`migrations/0019_key_delivery.sql`).
- Product, category, platform, plan, stock and API-provider administration endpoints.
- Product storefront, plan selection, wallet-only checkout, coupon validation and delivery UI.
- Manual stock fulfillment with duplicate prevention; reseller API fallback and provider override.
- Masked/revealed/copyable key delivery in the Mini App and Telegram chat; optional setup file delivery.
- INR manual payment requests, admin approval/rejection, UPI QR/ID settings and Telegram Stars wallet top-ups.
- Wallet coupon redemption, bonus claims, referral signup rewards and purchase commissions.
- Admin key orders/refunds, payment review, coupons, bonus settings and key-store performance summary.
- Low-stock alerts and periodic reseller balance-check hook.
- Personalized broadcast and individual-message tags for user and key context.
- Key-store branding, command descriptions, language additions and Nepali locale strings.

## Provider/API verification still required

The supplied Amit reference confirms the `buy` request and successful key response shape. It does not include the balance-check action contract. Verify the balance action with the provider before relying on API balance alerts. No API credentials are embedded in this project.

## Build/test status

A full production build and live Telegram/Cloudflare acceptance test have not been run in this environment. The package installation did not complete here, so run `npm ci`, `npm run build`, the project's test scripts and a D1 migration check in your deployment environment before going live.
