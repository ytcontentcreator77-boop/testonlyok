# Telegram X Hero

Repurposing of this repository into an independent, text-first messaging Mini App.

The initial chat module uses Telegram Mini App signed initData authentication, requires users to register through the bot, supports private one-to-one text conversations, message history, delivery/read timestamps, polling refresh, rate limiting and block checks. It does not expose photo, video, document or arbitrary file uploads. Voice notes are omitted until media storage and playback are implemented. Premium plan catalog and manual activation requests are included; Telegram Stars checkout is not marked active until an invoice and successful-payment confirmation path is connected.

Deployment stays on Cloudflare Workers + D1. worker/migrate.ts automatically applies the new migration on the next request. The first cut uses HTTP polling rather than WebSockets and is not end-to-end encrypted.