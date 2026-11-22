// Messages the bot sends in chat. Placeholders: {name}, {brand} (filled automatically, see setBotBrand). Missing translations fall back to English.
import type { Lang } from "../shared/types";
import bot from "./bot-strings.json";

const en = {
  welcome: "🔑 <b>Welcome, {name}!</b>\n\n<b>{brand}</b> is your instant key store. Browse game and software keys, add INR wallet balance and receive your key right after purchase.",
  open: "Open App",
  chooseLanguage: "🌐 <b>Choose your language</b>\n\nTap a language below. You can change it any time with /language.",
  viewOrder: "View order",
  orderPlaced: "🔑 <b>KEY DELIVERED</b>\n\n📦 {service}\n🧾 Order #{id}\n\nYour key is available in My Keys.",
  orderCompleted: "✅ <b>KEY DELIVERY COMPLETE</b>\n\n📦 {service}\n🧾 Order #{id}",
  orderPartial: "⚠️ <b>KEY DELIVERY UPDATE</b>\n\nPlease contact support if your key is missing.",
  orderCancelled: "💸 <b>ORDER REFUNDED</b>\n\n₹{refund} has been returned to your wallet balance.",
  orderFailed: "❌ <b>KEY COULD NOT BE DELIVERED</b>\n\n₹{refund} has been returned to your wallet balance. Please try again later.",
  orderRefunded: "💸 <b>REFUND COMPLETED</b>\n\n₹{refund} returned to your wallet balance.",
  starsRefunded: "⭐ <b>TELEGRAM PAYMENT REFUNDED</b>\n\nYour Stars payment was refunded by Telegram.",
  topupDone: "💰 <b>BALANCE ADDED</b>\n\nAdded: ₹{amount}\nWallet balance: ₹{balance}",
  orderNotPlaced: "❌ <b>KEY NOT DELIVERED</b>\n\n₹{amount} was not charged or has been refunded. Reason: {reason}",
  help:
    "ℹ️ <b>HELP</b>\n\n" +
    "  ┣ 🚀 Open the app with the button below\n" +
    "  ┣ 🌐 /language: change language\n" +
    "  ┗ 💬 Support: {support}\n\n" +
    "⭐️ <b>Payment questions?</b> Write to {support} with your payment date and amount. Telegram support can't help with purchases made in this bot.",
  paysupport:
    "⭐️ <b>PAYMENT SUPPORT</b>\n\n" +
    "  ┣ 💬 Write to: {support}\n" +
    "  ┗ 🧾 Include your payment date and amount\n\n" +
    "<i>Telegram support can't help with purchases made in this bot.</i>",
  termsButton: "Terms of service",
  referralReward:
    "🎁 <b>REFERRAL BONUS</b>\n\n" +
    "  ┣ 👤 {name} joined with your link\n" +
    "  ┣ 💰 Added: <b>{amount}</b>\n" +
    "  ┗ 👛 Balance: <b>{balance}</b>\n\n" +
    "<i>Invite more friends and earn for each one.</i>",
  inviteMore: "Invite more friends",
  cmdStart: "Open {brand}",
  cmdLanguage: "Change language",
  cmdHelp: "Help and support",
  cmdOrders: "My Keys",
  cmdWallet: "Wallet & INR top-up",
  ordersReply: "🔑 <b>YOUR PURCHASED KEYS</b>\n\nOpen My Keys in the app to view, copy and download your delivered keys.",
  walletReply: "💰 <b>WALLET BALANCE: ₹{balance}</b>\n\nAdd funds using UPI or an available manual payment method in the app.",
  invoiceTitle: "{brand} balance",
  invoiceTopup: "Add {amount} to your {brand} balance",
  invoiceOrder: "{service} · {quantity}",
  keyDeliveredMasked: "🔑 <b>KEY DELIVERED</b>\n\n📦 <b>Product:</b> {product}\n⏳ <b>Plan:</b> {plan}\n🧾 <b>Order:</b> #{id}\n\n🗝 <b>Your Key:</b>\n<code>{masked_key}</code>\n\n💰 Paid: ₹{amount}\n💵 Balance: ₹{balance}",
  keyDeliveredRevealed: "🔑 <b>KEY DELIVERED</b>\n\n📦 <b>Product:</b> {product}\n⏳ <b>Plan:</b> {plan}\n🧾 <b>Order:</b> #{id}\n\n🗝 <b>Your Key:</b>\n<code>{full_key}</code>\n\n💰 Paid: ₹{amount}\n💵 Balance: ₹{balance}",
  keyOutOfStock: "⚠️ This key is temporarily out of stock. You have not been charged. Contact support.",
  fundAdded: "💰 ₹{amount} has been added to your wallet. New balance: ₹{balance}.",
  bonusClaimed: "🎁 Bonus claimed! ₹{amount} added. New balance: ₹{balance}. Next claim in {hours}h.",
  bonusCooldown: "⏳ You already claimed your bonus. Try again in {remaining}.",
  bonusDisabled: "Bonus claims are currently disabled.",
  couponApplied: "🎟 Coupon {code} applied. You saved ₹{discount}. New total: ₹{price}.",
};

export type BotKey = keyof typeof en;
const all = bot as Partial<Record<Lang, Partial<Record<BotKey, string>>>>;

let botBrand = "Amit Bot";
let customBotMessages: Partial<Record<BotKey, string>> = {};

/** Apply owner-defined message templates. Empty values fall back to the translated defaults. */
export function hasCustomBotMessage(key: BotKey): boolean { return !!customBotMessages[key]; }

export function setBotMessages(messages: Partial<Record<BotKey, string>>) {
  customBotMessages = Object.fromEntries(Object.entries(messages).filter(([k, v]) => k in en && typeof v === "string" && v.length <= 4000 && v.trim())) as Partial<Record<BotKey, string>>;
}

/** Sets the brand name that fills {brand} in every bot text (call whenever settings load). */
export function setBotBrand(name: string) {
  if (name.trim()) botBrand = name.trim();
}

export function botText(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = customBotMessages[key] ?? all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(vars[k] ?? (k === "brand" ? botBrand : "")));
}

/** Same, without HTML escaping, for plain-text places like invoice titles */
export function botPlain(lang: Lang, key: BotKey, vars: Record<string, string> = {}): string {
  const tpl = customBotMessages[key] ?? all[lang]?.[key] ?? en[key];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? (k === "brand" ? botBrand : ""));
}

export const BOT_EN = en;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
