import { Hono } from "hono";
import { pickLang } from "../../shared/types";
import { timingSafeEqual, webhookSecret } from "../auth";
import type { Env } from "../env";
import { sendWelcome } from "../botMessages";
import { onPreCheckout, onSuccessfulPayment } from "../payments";
import { tg } from "../telegram";

export const bot = new Hono<{ Bindings: Env }>();

bot.post("/", async (c) => {
  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !timingSafeEqual(secret, await webhookSecret(c.env))) return c.text("forbidden", 403);
  const update = await c.req.json<any>().catch(() => null);
  if (!update || typeof update !== "object") return c.text("ok");
  if (update.pre_checkout_query) {
    await onPreCheckout(c.env, update.pre_checkout_query);
    return c.text("ok");
  }
  c.executionCtx.waitUntil(handle(c.env, update).catch((e) => console.error("bot update failed", e)));
  return c.text("ok");
});

async function handle(env: Env, update: any): Promise<void> {
  const message = update.message;
  if (message?.successful_payment && message.from?.id) {
    await onSuccessfulPayment(env, message.from, message.successful_payment);
    return;
  }
  if (update.callback_query?.id) {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: update.callback_query.id });
    return;
  }
  const from = message?.from;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!from?.id || !/^\/start(?:@\w+)?(?:\s+\S+)?$/i.test(text)) return;
  await sendWelcome(env, from.id, pickLang(from.language_code), from.first_name || "there");
}
