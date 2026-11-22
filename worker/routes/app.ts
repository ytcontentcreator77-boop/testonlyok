import { Hono, type Context } from "hono";
import { type LedgerItem, type Me, pickLang, type Lang, LANGS } from "../../shared/types";
import { validateInitData, type TgUser } from "../auth";
import { getService, listCategories, listPlatforms, listServices, searchServices, servicesByIds } from "../catalog";
import { type Env, isOwner, ownerIds } from "../env";
import { MAX_STARS_PER_PAYMENT, starsToCover } from "../../shared/stars";
import { starsText } from "../botMessages";
import { botText } from "../i18n";
import { cancelOrder, getOrderRow, OrderError, orderView, refillOrder, refreshOrder, type OrderRow } from "../orders";
import { createInvoice, TooManyInvoices } from "../payments";
import { attachReferral, channelGateRequired, onHomeReached, parseRef, referralStats, RetryLater, rewardStars, verifyChannel } from "../growth";
import { brandInfo } from "../brand";
import { getSettings, type Settings } from "../settings";
import { tg } from "../telegram";
import { verifyAutoUpi } from "../upi";


export interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  photo_url: string | null;
  language_code: string | null;
  lang: string | null;
  balance: number;
  balance_inr: number;
  notify: number;
  can_message: number;
  terms_accepted_at: number | null;
  banned: number;
  channel_ok: number;
  channel_checked_at: number | null;
  home_at: number | null;
}

type Vars = { tgUser: TgUser; user: UserRow; settings: Settings; lang: Lang; startParam: string | null };
export type AppEnv = { Bindings: Env; Variables: Vars };
type C = Context<AppEnv>;

export const err = (c: C, status: number, code: string, details?: Record<string, unknown>) =>
  c.json({ error: code, code, details }, status as 400);

/** Parses a JSON request body; null unless it is a plain object (not an array, null or a primitive). */
export async function readBody<T extends object>(c: Context): Promise<T | null> {
  const b: unknown = await c.req.json().catch(() => null);
  return b !== null && typeof b === "object" && !Array.isArray(b) ? (b as T) : null;
}

/** Non-negative page number from a query value: NaN/Infinity/huge values fall back to 0 or the 0..1000 clamp. */
export function pageParam(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.trunc(n))) : 0;
}

/** Cursor query value (`before=`): a finite positive number, else "no cursor". */
const cursorParam = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2 ** 53) : 2 ** 53;
};

/**
 * Creates the user (order updates on by default) or refreshes their Telegram profile. To keep D1 writes low with many
 * users, an existing row is only rewritten when the profile changed or last_seen_at is over a day old.
 */
async function upsertUser(env: Env, u: TgUser): Promise<UserRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, username, photo_url, language_code, notify, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
     ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
       photo_url = excluded.photo_url, language_code = excluded.language_code, last_seen_at = excluded.last_seen_at
     WHERE users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name
       OR users.username IS NOT excluded.username OR users.photo_url IS NOT excluded.photo_url
       OR users.language_code IS NOT excluded.language_code OR users.last_seen_at < excluded.last_seen_at - 86400
     RETURNING *`,
  )
    .bind(u.id, u.first_name ?? "", u.last_name ?? "", u.username ?? null, u.photo_url ?? null, u.language_code ?? null, now)
    .first<UserRow>();
  return row ?? (await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(u.id).first<UserRow>())!;
}

export const app = new Hono<AppEnv>();

// Auth: every /api request carries Telegram's signed initData.
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
let warnedDevBypass = false;

app.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  let tgUser: TgUser | null = null;
  let startParam: string | null = null;
  if (auth.startsWith("tma ")) {
    const data = await validateInitData(auth.slice(4), c.env.BOT_TOKEN);
    tgUser = data?.user ?? null;
    startParam = data?.startParam ?? null;
  } else if (c.env.DEV_FAKE_USER_ID && !LOCAL_HOSTS.includes(new URL(c.req.url).hostname)) {
    // Never honour the dev bypass on a real host, even if the variable is set by mistake
    if (!warnedDevBypass) {
      warnedDevBypass = true;
      console.error("DEV_FAKE_USER_ID is set but the request host is not local; ignoring it. Remove it from this environment.");
    }
  } else if (c.env.DEV_FAKE_USER_ID) {
    const cookieUser = /(?:^|;\s*)dev_user=(\d+)/.exec(c.req.header("cookie") ?? "")?.[1];
    const devId = Number(c.req.header("x-dev-user") || cookieUser || c.env.DEV_FAKE_USER_ID);
    tgUser = { id: devId, first_name: devId === Number(c.env.DEV_FAKE_USER_ID) ? "Dev" : `Tester${devId}`, last_name: "User", username: "dev", language_code: "en" };
    startParam = c.req.header("x-dev-start") ?? null;
  }
  if (!tgUser) return err(c, 401, "UNAUTHORIZED");
  const isMe = c.req.path.endsWith("/api/me") && c.req.method === "GET";
  let user = isMe ? null : await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(tgUser.id).first<UserRow>();
  if (!user) user = await upsertUser(c.env, tgUser);
  if (user.banned) return err(c, 403, "BANNED");
  const settings = await getSettings(c.env);
  c.set("tgUser", tgUser);
  c.set("user", user);
  c.set("settings", settings);
  c.set("lang", pickLang(user.lang ?? user.language_code));
  c.set("startParam", startParam);
  await next();
});

async function meView(c: C, background?: (p: Promise<unknown>) => void): Promise<Me> {
  const u = c.get("user");
  const s = c.get("settings");
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.service_id, o.service_name, o.platform, o.link, o.quantity FROM orders o
     WHERE o.id IN (SELECT MAX(id) FROM (SELECT id, service_id, link FROM orders WHERE user_id = ?1 AND status != 'failed' ORDER BY id DESC LIMIT 30) GROUP BY service_id, link)
     ORDER BY o.id DESC LIMIT 3`,
  )
    .bind(u.id)
    .all<{ id: number; service_id: number; service_name: string; platform: string; link: string; quantity: number }>();
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    photoUrl: u.photo_url,
    lang: c.get("lang"),
    langChosen: u.lang !== null,
    balance: u.balance,
    balanceInr: Number(u.balance_inr ?? 0),
    notify: !!u.notify,
    canMessage: !!u.can_message,
    termsAccepted: !!u.terms_accepted_at,
    isAdmin: isOwner(c.env, s, u.id),
    starsPerUsd: s.stars_per_usd,
    minTopup: s.min_topup_stars,
    maxTopup: Math.min(s.max_topup_stars, MAX_STARS_PER_PAYMENT),
    supportUsername: s.support_username || null,
    channelUrl: s.channel_url || null,
    channelRequired: await channelGateRequired(c.env, s, u, { background }),
    referralEnabled: !!s.referral_enabled,
    referralReward: rewardStars(s),
    referralRewardInr: Number(s.referral_signup_bonus_inr || 0),
    botUsername: s.bot_username || null,
    brand: brandInfo(s),
    recent: results.map((r) => ({ id: r.id, serviceId: r.service_id, serviceName: r.service_name, platform: r.platform, link: r.link, quantity: r.quantity })),
  };
}

app.get("/announcements/current", async (c) => {
  const u = c.get("user");
  const userId = u.id;
  const row = await c.env.DB.prepare("SELECT a.id,a.title,a.description,a.image_url,a.button_text,a.button_enabled,a.button_url FROM announcements a WHERE a.active=1 AND a.id=(SELECT MAX(id) FROM announcements WHERE active=1) LIMIT 1").first<any>();
  if (!row) return c.json({ announcement: null });
  const [stats, keys] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS orders,SUM(CASE WHEN delivered_key IS NOT NULL THEN 1 ELSE 0 END) AS totalkeys FROM orders WHERE user_id=?1").bind(userId).first<any>(),
    c.env.DB.prepare("SELECT delivered_key,product_name,expires_at FROM orders WHERE user_id=?1 AND delivered_key IS NOT NULL ORDER BY id DESC LIMIT 3").bind(userId).all<any>(),
  ]);
  const k = keys.results;
  const s = c.get("settings");
  return c.json({ announcement: row, vars: {
    name: [u.first_name,u.last_name].filter(Boolean).join(" ") || "there",
    first_name: u.first_name || "", last_name: u.last_name || "", user_id: String(userId), id: String(userId),
    username: u.username ? "@"+u.username : "",
    balance: "₹"+Number(u.balance_inr??0).toFixed(2),
    totalkeys: String(stats?.totalkeys ?? 0),
    key_1: k[0]?.delivered_key ?? "", key_2: k[1]?.delivered_key ?? "", key_3: k[2]?.delivered_key ?? "",
    product: k[0]?.product_name ?? "",
    expiry: k[0]?.expires_at ? new Date(Number(k[0].expires_at)*1000).toLocaleDateString("en-GB") : "",
    joined: u.created_at ? new Date(Number(u.created_at)*1000).toLocaleDateString("en-GB") : "",
    orders: String(stats?.orders ?? 0), brand: s.brand_name, support: s.support_username ? "@"+s.support_username : "Support",
  } });
});
app.post("/announcements/:id/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return err(c, 400, "INVALID_ID");
  await c.env.DB.prepare("INSERT OR IGNORE INTO announcement_dismissals(user_id,announcement_id,dismissed_at) SELECT ?1,id,?3 FROM announcements WHERE id=?2").bind(c.get("user").id,id,Math.floor(Date.now()/1000)).run();
  return c.json({ ok: true });
});

app.get("/how-to-use", (c) => {
  const s = c.get("settings");
  return c.json({
    howto_title: s.howto_title,
    howto_description: s.howto_description,
    howto_youtube_url: s.howto_youtube_url,
    howto_tiktok_url: s.howto_tiktok_url,
    howto_video_url: s.howto_video_url,
    howto_fallback_url: s.howto_fallback_url
  });
});

app.get("/developer/profile", async (c) => {
  const developerId = 7062424671;
  const developer = await c.env.DB.prepare(
    "SELECT id, first_name, last_name, username, photo_url FROM users WHERE id = ?1"
  ).bind(developerId).first<{id:number;first_name:string;last_name:string|null;username:string|null;photo_url:string|null}>();
  return c.json({
    id: developerId,
    firstName: developer?.first_name || "",
    lastName: developer?.last_name || "",
    username: developer?.username || "devheroo",
    photoUrl: developer?.photo_url || null
  });
});

app.get("/me", async (c) => {
  // Mini App opened from a referral link (t.me/<bot>/app?startapp=ref_<id>): link the new user to the referrer
  const ref = parseRef(c.get("startParam"));
  if (ref) await attachReferral(c.env, c.get("settings"), c.get("user").id, ref);
  return c.json(await meView(c, (p) => c.executionCtx.waitUntil(p)));
});

/** The Verify button on the join-channel step */
app.post("/channel/verify", async (c) => {
  let result;
  try {
    result = await verifyChannel(c.env, c.get("settings"), c.get("user").id);
  } catch (e) {
    if (e instanceof RetryLater) return err(c, 429, "TRY_AGAIN");
    throw e;
  }
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(c.get("user").id).first<UserRow>();
  c.set("user", user!);
  // "unavailable" is stored as passed-unconfirmed, so meView no longer requires the step (and no referral is paid)
  return c.json({ result, me: await meView(c) });
});

/** Called once when the home screen first shows: completes a pending referral */
app.post("/me/home", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  if (u.lang === null || !u.terms_accepted_at) return c.json({ ok: false });
  if (await channelGateRequired(c.env, s, u)) return err(c, 403, "CHANNEL_REQUIRED");
  await onHomeReached(c.env, s, (p) => c.executionCtx.waitUntil(p), u.id);
  return c.json({ ok: true });
});

app.get("/referrals", async (c) => c.json(await referralStats(c.env, c.get("settings"), c.get("user").id)));
app.get("/referral/stats", async (c) => c.json(await referralStats(c.env, c.get("settings"), c.get("user").id)));

app.get("/terms", (c) => c.json({ terms: c.get("settings").terms_text }));

app.patch("/me", async (c) => {
  const b = await readBody<{ lang?: string | null; notify?: boolean; canMessage?: boolean; acceptTerms?: boolean }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const u = c.get("user");
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.lang !== undefined) {
    if (b.lang !== null && !(LANGS as readonly string[]).includes(b.lang)) return err(c, 400, "INVALID_LANG");
    sets.push("lang = ?");
    vals.push(b.lang);
  }
  if (b.notify !== undefined) sets.push(`notify = ${b.notify ? 1 : 0}`);
  if (b.canMessage) sets.push("can_message = 1");
  if (b.acceptTerms) sets.push(`terms_accepted_at = COALESCE(terms_accepted_at, ${Math.floor(Date.now() / 1000)})`);
  if (sets.length) {
    const row = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...vals, u.id).first<UserRow>();
    c.set("user", row!);
    c.set("lang", pickLang(row!.lang ?? row!.language_code));
  }
  return c.json(await meView(c));
});

// ---- Catalog ----

const cacheable = (c: C) => c.header("cache-control", "private, max-age=60");

app.get("/catalog/platforms", async (c) => {
  cacheable(c);
  return c.json(await listPlatforms(c.env, c.get("settings")));
});

app.get("/catalog/categories", async (c) => {
  cacheable(c);
  return c.json(await listCategories(c.env, c.get("settings"), c.req.query("platform") ?? ""));
});

app.get("/catalog/services", async (c) => {
  cacheable(c);
  const page = pageParam(c.req.query("page"));
  return c.json(await listServices(c.env, c.get("settings"), c.get("lang"), c.req.query("platform") ?? "", c.req.query("category") ?? "", page));
});

app.get("/catalog/search", async (c) => {
  c.header("cache-control", "private, max-age=120");
  return c.json(await searchServices(c.env, c.get("settings"), c.get("lang"), c.req.query("q") ?? ""));
});

/** The user's favorite services (IDs from Telegram cloud storage), at most 60 */
app.get("/catalog/favorites", async (c) => {
  const ids = [...new Set((c.req.query("ids") ?? "").split(",").map(Number))].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 60);
  return c.json(await servicesByIds(c.env, c.get("settings"), c.get("lang"), ids));
});

app.get("/catalog/service/:id", async (c) => {
  const svc = await getService(c.env, c.get("settings"), c.get("lang"), Number(c.req.param("id")));
  if (!svc) return err(c, 404, "SERVICE_NOT_FOUND");
  const { cost: _cost, ...pub } = svc;
  return c.json(pub);
});

// ---- Orders ----


function orderErr(c: C, e: unknown) {
  if (e instanceof TooManyInvoices) return err(c, 429, "TOO_MANY_REQUESTS");
  if (e instanceof OrderError) return err(c, e.code === "INSUFFICIENT_FUNDS" ? 402 : 400, e.code, e.details);
  throw e;
}

app.post("/orders", async (c) => {
  return err(c, 410, "KEY_STORE_ONLY", { message: "SMM service ordering is disabled. Choose a key product from the storefront." });
});

app.get("/orders", async (c) => {
  const u = c.get("user");
  const filter = c.req.query("filter") ?? "all";
  const q = (c.req.query("q") ?? "").trim();
  const before = cursorParam(c.req.query("before"));
  const where = ["user_id = ?1", "id < ?2"];
  const vals: unknown[] = [u.id, before];
  if (filter === "active") where.push("status IN ('submitting','pending','processing','in_progress')");
  if (filter === "finished") where.push("status IN ('completed','partial','cancelled','failed')");
  if (q) {
    vals.push(`%${q.replace(/^#/, "")}%`);
    where.push(`(CAST(COALESCE(np_order_id, id) AS TEXT) LIKE ?3 OR link LIKE ?3 OR service_name LIKE ?3)`);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 30`)
    .bind(...vals)
    .all<OrderRow>();
  const starIds = await paidWithStars(c.env, results.map((o) => o.id));
  return c.json(results.map((o) => orderView(o, starIds.has(o.id))));
});

async function paidWithStars(env: Env, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { results } = await env.DB.prepare("SELECT order_id FROM payments WHERE order_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .all<{ order_id: number }>();
  return new Set(results.map((r) => r.order_id));
}

async function ownOrder(c: C): Promise<OrderRow | null> {
  const o = await getOrderRow(c.env, Number(c.req.param("id")));
  return o && o.user_id === c.get("user").id ? o : null;
}

app.get("/orders/:id", async (c) => {
  let o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  // Re-ask NotPanel at most every 90 s (20 s while the order is still being submitted); webhooks and cron cover the rest
  if (Date.now() / 1000 - o.checked_at > (o.status === "submitting" ? 20 : 90)) o = await refreshOrder(c.env, o);
  const stars = await paidWithStars(c.env, [o.id]);
  return c.json(orderView(o, stars.has(o.id)));
});

app.post("/orders/:id/cancel", async (c) => {
  const o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  try {
    return c.json(orderView(await cancelOrder(c.env, o)));
  } catch (e) {
    return orderErr(c, e);
  }
});

app.post("/orders/:id/refill", async (c) => {
  const o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  try {
    return c.json(orderView(await refillOrder(c.env, o)));
  } catch (e) {
    return orderErr(c, e);
  }
});

// ---- Wallet ----

app.get("/wallet", async (c) => {
  const u = c.get("user");
  const before = cursorParam(c.req.query("before"));
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.delta, l.kind, l.ref, l.note, l.created_at, COALESCE(o.np_order_id, o.id) AS order_number
     FROM ledger l LEFT JOIN orders o ON o.id = l.ref AND l.kind IN ('order','refund')
     WHERE l.user_id = ?1 AND l.id < ?2 ORDER BY l.id DESC LIMIT 30`,
  )
    .bind(u.id, before)
    .all<{ id: number; delta: number; kind: LedgerItem["kind"]; ref: number | null; note: string | null; created_at: number; order_number: number | null }>();
  return c.json({
    balance: u.balance,
    items: results.map((r) => ({ id: r.id, delta: r.delta, kind: r.kind, ref: r.ref, orderNumber: r.kind === "order" || r.kind === "refund" ? r.order_number ?? r.ref : null, note: r.note, createdAt: r.created_at })),
  });
});

app.post("/wallet/topup", async (c) => {
  if (await channelGateRequired(c.env, c.get("settings"), c.get("user"))) return err(c, 403, "CHANNEL_REQUIRED");
  const b = await readBody<{ stars: number }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const s = c.get("settings");
  let configuredMethods:any[]=[];try{configuredMethods=JSON.parse(s.payment_methods||"[]");}catch{}if(configuredMethods.length&&!configuredMethods.some(m=>m.id==="stars"&&m.enabled!==false))return err(c,403,"STARS_TOPUP_DISABLED");
  // Whole Stars only
  const stars = Number(b.stars);
  const max = Math.min(s.max_topup_stars, MAX_STARS_PER_PAYMENT);
  if (!Number.isInteger(stars) || stars < s.min_topup_stars || stars > max)
    return err(c, 400, "INVALID_AMOUNT", { min: starsText(s.min_topup_stars), max: starsText(max) });
  try {
    const inv = await createInvoice(c.env, c.get("user").id, c.get("lang"), stars, s.stars_per_usd, null);
    return c.json({ invoice: inv.link, stars: inv.stars, paymentId: inv.paymentId });
  } catch (e) {
    if (e instanceof TooManyInvoices) return err(c, 429, "TOO_MANY_REQUESTS");
    throw e;
  }
});

app.get("/payments/:id", async (c) => {
  const p = await c.env.DB.prepare("SELECT id, status, order_id FROM payments WHERE id = ?1 AND user_id = ?2")
    .bind(Number(c.req.param("id")), c.get("user").id)
    .first<{ id: number; status: string; order_id: number | null }>();
  if (!p) return err(c, 404, "NOT_FOUND");
  return c.json({ id: p.id, status: p.status, orderId: p.order_id, balance: c.get("user").balance });
});

// ---- Key delivery storefront (INR wallet; legacy SMM routes remain isolated for historical data) ----
const DEFAULT_KEY_METHODS = [
  {id:"stars",name:"Telegram Stars (wallet top-up only)",icon:"⭐",details:"Pay with Telegram Stars to add INR wallet balance",enabled:true,type:"stars"},
  {id:"upi",name:"UPI QR / UPI ID",icon:"📱"},{id:"upi_auto",name:"UPI Automatic Payment",icon:"📱",details:"Generate QR and verify payment",enabled:false},
  {id:"phonepe",name:"PhonePe",icon:"💜"},{id:"gpay",name:"Google Pay",icon:"🟢"},{id:"bhim",name:"BHIM UPI",icon:"🇮🇳"},
  {id:"bank",name:"Bank Transfer (IMPS / NEFT)",icon:"🏦"},{id:"binance",name:"Binance Pay",icon:"🟡"},
  {id:"usdt_trc20",name:"USDT TRC20",icon:"₮"},{id:"usdt_bep20",name:"USDT BEP20",icon:"₮"},
  {id:"paypal",name:"PayPal",icon:"🌐"},{id:"skrill",name:"Skrill",icon:"💠"},{id:"redotpay",name:"RedotPay",icon:"💳"},
];
app.post("/wallet/topup-stars",async(c)=>{const b=await readBody<{amount_inr:number}>(c);const s=c.get("settings");let methods:any[]=[];try{methods=JSON.parse(s.payment_methods||"[]");}catch{}if(methods.length&& !methods.some(m=>m.id==="stars"&&m.enabled!==false))return err(c,403,"STARS_TOPUP_DISABLED");if(!b||!Number.isFinite(b.amount_inr)||b.amount_inr<10||b.amount_inr>100000)return err(c,400,"INVALID_AMOUNT");const targetMicro=Math.round((b.amount_inr/Number(s.inr_per_usd))*1_000_000);const stars=starsToCover(targetMicro,s.stars_per_usd);const max=Math.min(s.max_topup_stars,MAX_STARS_PER_PAYMENT);if(stars<s.min_topup_stars||stars>max)return err(c,400,"INVALID_AMOUNT",{min:s.min_topup_stars,max});try{const inv=await createInvoice(c.env,c.get("user").id,c.get("lang"),stars,s.stars_per_usd,null);return c.json({invoice:inv.link,stars,credited_inr:(stars/s.stars_per_usd)*s.inr_per_usd});}catch(e){if(e instanceof TooManyInvoices)return err(c,429,"TOO_MANY_REQUESTS");throw e;}});
app.get("/catalog/products", async (c)=>{const {results}=await c.env.DB.prepare(`SELECT p.*,kp.logo_url AS platform_logo,kc.image_url AS category_image,kc.icon AS category_icon,ka.android_required AS api_android_required,(SELECT COUNT(*) FROM key_stock s WHERE s.product_id=p.id AND s.used=0) AS stock_count FROM key_products p LEFT JOIN key_platforms kp ON kp.slug=p.platform LEFT JOIN key_categories kc ON kc.slug=p.category LEFT JOIN key_apis ka ON ka.id=COALESCE(p.api_id,?1) AND ka.enabled=1 WHERE p.enabled=1 ORDER BY p.sort,p.id DESC`).bind(c.get("settings").active_key_api_id||"").all();return c.json({items:results});});
app.get("/catalog/plans/:productId",async(c)=>{const id=Number(c.req.param("productId"));const {results}=await c.env.DB.prepare(`SELECT pl.*,(SELECT COUNT(*) FROM key_stock s WHERE s.plan_id=pl.id AND s.used=0) AS stock_count FROM key_plans pl JOIN key_products p ON p.id=pl.product_id WHERE pl.product_id=?1 AND pl.enabled=1 AND p.enabled=1 ORDER BY pl.sort,pl.id`).bind(id).all();return c.json({items:results});});
app.get("/wallet/inr",async(c)=>{const uid=c.get("user").id;const [u,ledger,pending]=await c.env.DB.batch([c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(uid),c.env.DB.prepare("SELECT id,delta_inr,kind,ref,note,created_at FROM inr_ledger WHERE user_id=?1 ORDER BY id DESC LIMIT 50").bind(uid),c.env.DB.prepare("SELECT id,method_name,amount_inr,status,created_at FROM manual_payments WHERE user_id=?1 AND status='pending' ORDER BY id DESC LIMIT 10").bind(uid)]);return c.json({balance:Number((u.results[0] as any)?.balance_inr??0),currency:"INR",history:ledger.results,pending:pending.results});});
app.post("/upi-auto/create",async(c)=>{
  const b=await readBody<{amount:number}>(c);const amount=Number(b?.amount);
  if(!Number.isFinite(amount)||amount<10||amount>100000||Math.round(amount*100)!==amount*100)return err(c,400,"INVALID_TOPUP");
  const s=c.get("settings");let methods:any[]=[];try{methods=JSON.parse(s.payment_methods||"[]")}catch{}
  if(!s.upi_gateway_enabled||!s.upi_gateway_api_key)return err(c,503,"UPI_GATEWAY_NOT_CONFIGURED");
  if(methods.length&&!methods.some(m=>m.id==="upi_auto"&&m.enabled!==false))return err(c,403,"PAYMENT_METHOD_DISABLED");
  const uid=c.get("user").id;const now=Math.floor(Date.now()/1000);
  const orderId="UPI"+uid+Date.now().toString(36).toUpperCase();
  const response=await fetch("https://gateway.anujbots.in/autoqr.php?api_key="+encodeURIComponent(s.upi_gateway_api_key)+"&amount="+encodeURIComponent(amount.toFixed(2)));
  if(!response.ok)return err(c,502,"UPI_GATEWAY_UNAVAILABLE");
  const data:any=await response.json();
  if(data?.status!=="success"||!data?.data?.order_id||!data?.data?.qr_url)return err(c,502,"UPI_QR_CREATE_FAILED");
  const gwOrder=String(data.data.order_id);const actual=Number(data.data.amount??amount);
  if(Math.abs(actual-amount)>0.009)return err(c,502,"UPI_AMOUNT_MISMATCH");
  const expiresAt=now+300;
  await c.env.DB.prepare("INSERT INTO upi_auto_transactions(order_id,gateway_order_id,user_id,amount_inr,status,created_at,expires_at) VALUES(?1,?2,?3,?4,'pending',?5,?6)")
    .bind(orderId,gwOrder,uid,amount,now,expiresAt).run();
  const caption="<b>💸 UPI PAYMENT</b>\n\n"+
    "Scan &amp; pay exactly <b>₹"+actual.toFixed(2)+"</b> via any UPI app.\n\n"+
    "🧾 <b>Order ID:</b> <code>"+gwOrder+"</code>\n"+
    "⏳ <b>Valid for:</b> 5 minutes\n\n"+
    "✅ After payment, tap <b>VERIFY PAYMENT</b>. Your wallet balance will be credited automatically after gateway confirmation.\n\n"+
    "⚠️ Payment detection may take up to 1 minute. Please wait and verify again.";
  const sent=await tg(c.env.BOT_TOKEN,"sendPhoto",{chat_id:uid,photo:data.data.qr_url,caption,parse_mode:"HTML",
    reply_markup:{inline_keyboard:[
      [{text:"✅ VERIFY PAYMENT",callback_data:"upi:verify:"+orderId}],
      [{text:"➡️ Cancel Payment",callback_data:"upi:cancel:"+orderId}]
    ]}});
  return c.json({orderId,gatewayOrderId:gwOrder,amount:actual,expiresAt,messageId:sent.message_id},201);
});
app.post("/upi-auto/verify",async(c)=>{
  const b=await readBody<{orderId:string}>(c);if(!b?.orderId)return err(c,400,"INVALID_ORDER");
  try{const result=await verifyAutoUpi(c.env,b.orderId,c.get("user").id);
    if(result.status==="expired")return err(c,410,"PAYMENT_EXPIRED");
    return c.json({ok:true,credited:result.status==="paid",paid:result.status==="paid",amount:result.status==="paid"?result.amount:0,balance:result.status==="paid"?result.balance:undefined,status:result.status});
  }catch(e){const code=e instanceof Error?e.message:"UPI_VERIFY_FAILED";return err(c,code==="PAYMENT_NOT_FOUND"?404:code==="UPI_AMOUNT_MISMATCH"?409:502,code);}
});
app.get("/wallet/payment-methods",async(c)=>{let methods:any[]=[];try{methods=JSON.parse(c.get("settings").payment_methods||"[]");}catch{}if(!Array.isArray(methods)||!methods.length)methods=DEFAULT_KEY_METHODS;methods=methods.filter(m=>m.id!=="paytm_auto");if(!methods.some(m=>m.id==="upi_auto"))methods=[...methods,{id:"upi_auto",name:"UPI Automatic Payment",icon:"📱",details:"Generate QR and verify payment",enabled:false}];const s=c.get("settings");return c.json({items:methods.filter(m=>m&&m.enabled!==false&&(m.id!=="upi_auto"||(s.upi_gateway_enabled&&!!s.upi_gateway_api_key))).map(m=>({...m,details:m.details??"",qrUrl:m.qrUrl??(m.id==="upi"?s.upi_qr_url:""),upiId:m.id==="upi"?s.upi_id:""}))});});
app.post("/wallet/topup-manual",async(c)=>{
 const b=await readBody<{method_id:string;amount_inr:number;utr_ref?:string;proof_image?:string}>(c);
 if(!b||typeof b.method_id!=="string"||!Number.isFinite(b.amount_inr)||b.amount_inr<10||b.amount_inr>100000)return err(c,400,"INVALID_TOPUP");
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.proof_image||""));
 if(!match||match[2].length>7_000_000)return err(c,400,"PAYMENT_SCREENSHOT_REQUIRED");
 const admins=ownerIds(c.env,c.get("settings"));if(!admins.length)return err(c,409,"NO_ADMIN_CHAT_CONFIGURED");
 let methods:any[]=[];try{methods=JSON.parse(c.get("settings").payment_methods||"[]");}catch{}
 if(!Array.isArray(methods)||!methods.length)methods=DEFAULT_KEY_METHODS;
 const method=methods.find(m=>m.id===b.method_id&&m.enabled!==false);
 if(!method)return err(c,400,"PAYMENT_METHOD_DISABLED");
 if(method.id==="stars")return err(c,400,"USE_STARS_TOPUP");
 const now=Math.floor(Date.now()/1000);
 const r=await c.env.DB.prepare("INSERT INTO manual_payments(user_id,method_id,method_name,amount_inr,utr_ref,status,created_at) VALUES(?1,?2,?3,?4,?5,'pending',?6) RETURNING id").bind(c.get("user").id,b.method_id,method.name,b.amount_inr,b.utr_ref?.slice(0,120)??null,now).first<{id:number}>();
 if(!r?.id)return err(c,500,"PAYMENT_CREATE_FAILED");
 const bytes=Uint8Array.from(atob(match[2]),ch=>ch.charCodeAt(0));
 const mime="image/"+(match[1]==="jpeg"?"jpeg":match[1]);
 const file=new Blob([bytes],{type:mime});
 let proofId="";
 const caption="💳 NEW MANUAL PAYMENT #"+r.id+"\nUser: "+c.get("user").id+"\nMethod: "+method.name+"\nAmount: ₹"+b.amount_inr.toFixed(2)+"\nUTR: "+(b.utr_ref||"Not supplied")+"\nScreenshot attached";
 for(const adminId of admins){
   const form=new FormData();form.set("chat_id",String(adminId));form.set("caption",caption);
   if(proofId)form.set("photo",proofId);else form.set("photo",file,"payment-proof."+match[1]);
   form.set("reply_markup",JSON.stringify({inline_keyboard:[[{text:"✅ Approve",callback_data:"pay:approve:"+r.id},{text:"❌ Reject",callback_data:"pay:reject:"+r.id}]]}));
   const response=await fetch("https://api.telegram.org/bot"+c.env.BOT_TOKEN+"/sendPhoto",{method:"POST",body:form});
   const result=await response.json() as any;
   if(!result?.ok){await c.env.DB.prepare("DELETE FROM manual_payments WHERE id=?1 AND status='pending'").bind(r.id).run();return err(c,502,"PAYMENT_PROOF_DELIVERY_FAILED");}
   const photos=result.result?.photo??[];proofId=photos[photos.length-1]?.file_id||proofId;
 }
 if(!proofId){await c.env.DB.prepare("DELETE FROM manual_payments WHERE id=?1 AND status='pending'").bind(r.id).run();return err(c,502,"PAYMENT_PROOF_DELIVERY_FAILED");}
 await c.env.DB.prepare("UPDATE manual_payments SET proof_file_id=?2 WHERE id=?1").bind(r.id,proofId).run();
 return c.json({ok:true,paymentId:r.id,status:"pending"},201);
});
app.get("/keys",async(c)=>{const {results}=await c.env.DB.prepare(`SELECT id,product_id,plan_id,product_name,plan_duration,delivered_key,key_source,price_inr,discount_inr,coupon_code,setup_file_url,expires_at,status,created_at FROM orders WHERE user_id=?1 AND delivered_key IS NOT NULL AND status='completed' ORDER BY id DESC LIMIT 100`).bind(c.get("user").id).all();return c.json({items:results});});
app.get("/keys/:id",async(c)=>{const r=await c.env.DB.prepare("SELECT o.id,o.product_id,o.plan_id,o.product_name,o.plan_duration,o.delivered_key,o.key_source,o.price_inr,o.discount_inr,o.coupon_code,o.setup_file_id,o.setup_file_url,o.expires_at,o.status,o.created_at,p.setup_video_file_id,p.setup_video_url FROM orders o LEFT JOIN key_products p ON p.id=o.product_id WHERE o.id=?1 AND o.user_id=?2 AND o.delivered_key IS NOT NULL AND o.status='completed'").bind(Number(c.req.param("id")),c.get("user").id).first();return r?c.json({...r,bot_username:c.get("settings").bot_username}):err(c,404,"NOT_FOUND");});
app.post("/keys/validate-coupon",async(c)=>{const b=await readBody<{code:string;product_id:number;plan_id:number}>(c);if(!b||!b.code)return err(c,400,"INVALID_BODY");const now=Math.floor(Date.now()/1000),uid=c.get("user").id;const coupon=await c.env.DB.prepare("SELECT * FROM coupons WHERE code=?1 COLLATE NOCASE AND enabled=1 AND (expires_at IS NULL OR expires_at>?2) AND (max_uses=0 OR used_count<max_uses)").bind(b.code.trim(),now).first<any>();if(!coupon)return err(c,404,"COUPON_INVALID");if(coupon.type==="wallet_inr")return err(c,400,"USE_WALLET_REDEEM");const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM coupon_uses WHERE coupon_id=?1 AND user_id=?2").bind(coupon.id,uid).first<{n:number}>();if(Number(used?.n??0)>=Number(coupon.per_user_limit))return err(c,409,"COUPON_LIMIT");const plan=await c.env.DB.prepare("SELECT price_inr FROM key_plans WHERE id=?1 AND product_id=?2 AND enabled=1").bind(b.plan_id,b.product_id).first<{price_inr:number}>();if(!plan)return err(c,404,"PLAN_NOT_FOUND");if(coupon.target_product_id&&Number(coupon.target_product_id)!==b.product_id)return err(c,400,"COUPON_NOT_FOR_PRODUCT");if(coupon.target_plan_id&&Number(coupon.target_plan_id)!==b.plan_id)return err(c,400,"COUPON_NOT_FOR_PLAN");let discount=0;if(coupon.type==="free_key")discount=Number(plan.price_inr);else if(["global_discount","panel_discount","next_x_orders"].includes(coupon.type))discount=coupon.discount_mode==="flat_inr"?Number(coupon.value):Number(plan.price_inr)*Math.min(100,Number(coupon.value))/100;return c.json({ok:true,code:coupon.code,type:coupon.type,discount:Math.min(Number(plan.price_inr),discount),price:Math.max(0,Number(plan.price_inr)-discount)});});
app.post("/keys/buy",async(c)=>{
 const b=await readBody<{product_id:number;plan_id:number;android_id?:string;coupon_code?:string}>(c);if(!b)return err(c,400,"INVALID_BODY");
 const product=await c.env.DB.prepare("SELECT * FROM key_products WHERE id=?1 AND enabled=1").bind(b.product_id).first<any>();
 const plan=await c.env.DB.prepare("SELECT * FROM key_plans WHERE id=?1 AND product_id=?2 AND enabled=1").bind(b.plan_id,b.product_id).first<any>();
 if(!product||!plan)return err(c,404,"PRODUCT_OR_PLAN_NOT_FOUND");
 const basePrice=Number(plan.price_inr);const uid=c.get("user").id;const now=Math.floor(Date.now()/1000);let price=basePrice,discount=0,coupon:any=null,couponUseId:number|null=null,couponCode:string|null=null;
 if(b.coupon_code){coupon=await c.env.DB.prepare("SELECT * FROM coupons WHERE code=?1 COLLATE NOCASE AND enabled=1 AND (expires_at IS NULL OR expires_at>?2) AND (max_uses=0 OR used_count<max_uses)").bind(b.coupon_code.trim(),now).first<any>();if(!coupon)return err(c,400,"COUPON_INVALID");if(coupon.type==="wallet_inr")return err(c,400,"USE_WALLET_REDEEM");const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM coupon_uses WHERE coupon_id=?1 AND user_id=?2").bind(coupon.id,uid).first<{n:number}>();if(Number(used?.n??0)>=Number(coupon.per_user_limit))return err(c,409,"COUPON_LIMIT");if(coupon.target_product_id&&Number(coupon.target_product_id)!==product.id)return err(c,400,"COUPON_NOT_FOR_PRODUCT");if(coupon.target_plan_id&&Number(coupon.target_plan_id)!==plan.id)return err(c,400,"COUPON_NOT_FOR_PLAN");if(coupon.type==="free_key")discount=basePrice;else if(["global_discount","panel_discount","next_x_orders"].includes(coupon.type))discount=coupon.discount_mode==="flat_inr"?Number(coupon.value):basePrice*Math.min(100,Number(coupon.value))/100;price=Math.max(0,basePrice-discount);couponCode=coupon.code;}
 else {const active=await c.env.DB.prepare(`SELECT cu.id AS use_id,cu.remaining_orders,c.* FROM coupon_uses cu JOIN coupons c ON c.id=cu.coupon_id WHERE cu.user_id=?1 AND cu.remaining_orders>0 AND c.enabled=1 AND (cu.valid_until IS NULL OR cu.valid_until>?2) AND (c.type='next_x_orders' OR (c.type='panel_discount' AND c.target_product_id=?3)) ORDER BY cu.used_at DESC LIMIT 1`).bind(uid,now,product.id).first<any>();if(active){coupon=active;couponUseId=Number(active.use_id);couponCode=active.code;discount=active.discount_mode==='flat_inr'?Number(active.value):basePrice*Math.min(100,Number(active.value))/100;price=Math.max(0,basePrice-discount);}}
 const mode=String(c.get("settings").key_delivery_mode||"auto");
 const stock=mode==="api_only"||product.api_source==="api"?null:await c.env.DB.prepare(`UPDATE key_stock SET used=1,used_by=?3,used_at=?4 WHERE id=(SELECT id FROM key_stock WHERE product_id=?1 AND plan_id=?2 AND used=0 ORDER BY id LIMIT 1) AND used=0 RETURNING id,key_value`).bind(product.id,plan.id,uid,now).first<{id:number;key_value:string}>();
 const apiEligible=(mode==="api_only"||(mode!=="stock_only"&&product.api_source!=="stock"))&&!!product.pid;
 if(!stock&&!apiEligible){await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:botText(c.get("lang"),"keyOutOfStock"),parse_mode:"HTML"}).catch(()=>{});return err(c,409,"OUT_OF_STOCK");}
 const deducted=await c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr-?2 WHERE id=?1 AND balance_inr>=?2 RETURNING balance_inr").bind(uid,price).first<{balance_inr:number}>();
 if(!deducted){if(stock)await c.env.DB.prepare("UPDATE key_stock SET used=0,used_by=NULL,used_at=NULL WHERE id=?1 AND order_id IS NULL").bind(stock.id).run();return err(c,402,"INSUFFICIENT_FUNDS",{required:price});}
 let deliveredKey=stock?.key_value??"",keySource=stock?"stock":"api",apiCost=0,apiKeys:string[]=[];
 if(!stock){try{const {buyKey}=await import("../bantibhaiya");const r=await buyKey(c.env,String(product.pid),String(plan.api_duration??plan.duration),b.android_id,product.api_id??undefined);deliveredKey=r.key;apiKeys=r.keys;apiCost=r.total_price;}catch(e){await c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1").bind(uid,price).run();await c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,note,created_at) VALUES(?1,?2,'refund','Key API failure',?3)").bind(uid,price,now).run();return err(c,502,"KEY_API_FAILED",{message:String((e as Error).message).slice(0,160)});}}
 let createdOrderId:number|null=null;
 try{
   const ins=await c.env.DB.prepare(`INSERT INTO orders(user_id,service_id,service_name,platform,category,link,quantity,charge,status,created_at,updated_at,checked_at,product_id,plan_id,product_name,plan_duration,delivered_key,key_source,price_inr,discount_inr,coupon_code,api_cost_inr,setup_file_id,setup_file_url,expires_at)
   VALUES(?1,0,?2,?3,?4,'',1,0,'completed',?5,?5,?5,?6,?7,?2,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) RETURNING id`).bind(uid,product.name,product.platform,product.category,now,product.id,plan.id,plan.duration,deliveredKey,keySource,price,discount,couponCode,apiCost,product.setup_file_id,product.setup_file_url,plan.duration_days?now+Math.round(Number(plan.duration_days)*86400):null).first<{id:number}>();
   if(!ins)throw new Error("ORDER_SAVE_FAILED");createdOrderId=ins.id;
   if(apiKeys.length>1){for(const extra of apiKeys.slice(1,100)){await c.env.DB.prepare("INSERT OR IGNORE INTO key_stock(product_id,plan_id,key_value,import_batch,added_at,added_by) VALUES(?1,?2,?3,?4,?5,?6)").bind(product.id,plan.id,extra,`api:${product.api_id??c.get("settings").active_key_api_id}`,now,uid).run();}}
   const referral=await c.env.DB.prepare("SELECT referred_by FROM users WHERE id=?1").bind(uid).first<{referred_by:number|null}>();const commission=referral?.referred_by?Number((price*Number(c.get("settings").referral_commission_percent||0)/100).toFixed(2)):0;
   await c.env.DB.batch([...(stock?[c.env.DB.prepare("UPDATE key_stock SET order_id=?2 WHERE id=?1").bind(stock.id,ins.id)]:[]),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) VALUES(?1,?2,'key_purchase',?3,?4,?5)").bind(uid,-price,ins.id,product.name,now),...(coupon?(couponUseId?[c.env.DB.prepare("UPDATE coupon_uses SET remaining_orders=remaining_orders-1,order_id=?2,discount_applied_inr=?3 WHERE id=?1 AND remaining_orders>0").bind(couponUseId,ins.id,discount)]:[c.env.DB.prepare("INSERT INTO coupon_uses(coupon_id,user_id,remaining_orders,order_id,discount_applied_inr,used_at,valid_until) VALUES(?1,?2,?3,?4,?5,?6,?7)").bind(coupon.id,uid,coupon.type==="next_x_orders"?Math.max(0,Number(coupon.next_orders_count||1)-1):coupon.type==="panel_discount"?999999:0,ins.id,discount,now,coupon.type==="panel_discount"&&coupon.panel_valid_days?now+Number(coupon.panel_valid_days)*86400:null)]).concat([c.env.DB.prepare("UPDATE coupons SET used_count=used_count+1 WHERE id=?1").bind(coupon.id)]):[]),...(commission>0&&referral?.referred_by?[c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2,referral_earnings_inr=referral_earnings_inr+?2 WHERE id=?1").bind(referral.referred_by,commission),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) VALUES(?1,?2,'referral_commission',?3,?4,?5)").bind(referral.referred_by,commission,ins.id,`Commission from user ${uid}`,now)]:[])]);
   const fullKey=String(deliveredKey);const masked=fullKey.length<8?"••••••":`${fullKey.slice(0,4)}-${"•".repeat(Math.min(12,Math.max(4,fullKey.length-4)))}`;
   const safe=(v:string)=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
   const keyboard:any[][]=[[{text:"👁 Show Key",callback_data:`key:show:${ins.id}`}],[{text:"📋 Copy Key",copy_text:{text:fullKey}}]];
   if(product.setup_file_url)keyboard.push([{text:"📥 Download Setup",url:product.setup_file_url}]);
   const botUsername=String(c.get("settings").bot_username||"").replace(/^@/,"");
   if(botUsername)keyboard.push([{text:"🎬 Setup Video",url:"https://t.me/"+botUsername+"?start=video"+product.id}]);
   const deliveryText=botText(c.get("lang"),"keyDeliveredMasked",{product:safe(product.name),plan:safe(plan.duration),id:String(ins.id),masked_key:safe(masked),amount:price.toFixed(2),balance:Number(deducted.balance_inr).toFixed(2)});
   await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:deliveryText,parse_mode:"HTML",reply_markup:{inline_keyboard:keyboard}}).catch(e=>console.warn("key delivery chat message failed",(e as Error).message));
   if(product.setup_file_id) await tg(c.env.BOT_TOKEN,"sendDocument",{chat_id:uid,document:product.setup_file_id,caption:`📥 Setup file for ${product.name}`}).catch(e=>console.warn("setup file delivery failed",(e as Error).message));
   const {results:assets}=await c.env.DB.prepare("SELECT asset_type,file_id,file_name,text_content,caption FROM product_assets WHERE product_id=?1 ORDER BY sort,id").bind(product.id).all<any>();
   for(const a of assets){try{if(a.asset_type==="text"){if(a.text_content)await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:String(a.text_content).slice(0,4000)});}else if(a.file_id){const method:any={photo:"sendPhoto",video:"sendVideo",animation:"sendAnimation",audio:"sendAudio",voice:"sendVoice",video_note:"sendVideoNote",sticker:"sendSticker",document:"sendDocument"}[a.asset_type]??"sendDocument";const field:any={photo:"photo",video:"video",animation:"animation",audio:"audio",voice:"voice",video_note:"video_note",sticker:"sticker",document:"document"}[a.asset_type]??"document";await tg(c.env.BOT_TOKEN,method,{chat_id:uid,[field]:a.file_id,...(a.caption?{caption:String(a.caption).slice(0,900)}:{})});}}catch(e){console.warn("product asset delivery failed",a.asset_type,(e as Error).message);}}

   return c.json({ok:true,orderId:ins.id,product:product.name,plan:plan.duration,key:deliveredKey,price,discount,balance:deducted.balance_inr,setupFileUrl:product.setup_file_url??null,setupFileName:product.setup_file_name??null});
 }catch(e){if(createdOrderId)await c.env.DB.prepare("UPDATE orders SET status='failed',delivered_key=NULL,updated_at=?2 WHERE id=?1").bind(createdOrderId,now).run();if(stock)await c.env.DB.prepare("UPDATE key_stock SET used=0,used_by=NULL,used_at=NULL,order_id=NULL WHERE id=?1").bind(stock.id).run();else if(deliveredKey)await c.env.DB.prepare("INSERT OR IGNORE INTO key_stock(product_id,plan_id,key_value,import_batch,added_at,added_by) VALUES(?1,?2,?3,'recovered-api-key',?4,?5)").bind(product.id,plan.id,deliveredKey,now,uid).run();await c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1").bind(uid,price).run();await c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) VALUES(?1,?2,'refund',?3,'Key order processing failed',?4)").bind(uid,price,createdOrderId,now).run();throw e;}
});
app.post("/coupon/redeem",async(c)=>{const b=await readBody<{code:string}>(c);if(!b?.code)return err(c,400,"INVALID_BODY");const uid=c.get("user").id,now=Math.floor(Date.now()/1000);const coupon=await c.env.DB.prepare("SELECT * FROM coupons WHERE code=?1 COLLATE NOCASE AND enabled=1 AND type='wallet_inr' AND (expires_at IS NULL OR expires_at>?2) AND (max_uses=0 OR used_count<max_uses)").bind(b.code.trim(),now).first<any>();if(!coupon)return err(c,404,"COUPON_INVALID");const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM coupon_uses WHERE coupon_id=?1 AND user_id=?2").bind(coupon.id,uid).first<{n:number}>();if(Number(used?.n??0)>=Number(coupon.per_user_limit))return err(c,409,"COUPON_LIMIT");const amount=Number(coupon.value);await c.env.DB.batch([c.env.DB.prepare("INSERT INTO coupon_uses(coupon_id,user_id,used_at,discount_applied_inr) VALUES(?1,?2,?3,?4)").bind(coupon.id,uid,now,amount),c.env.DB.prepare("UPDATE coupons SET used_count=used_count+1 WHERE id=?1").bind(coupon.id),c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1").bind(uid,amount),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) VALUES(?1,?2,'coupon',?3,?4,?5)").bind(uid,amount,coupon.id,coupon.code,now)]);const u=await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(uid).first<{balance_inr:number}>();return c.json({ok:true,amount,balance:u?.balance_inr??0});});
app.get("/bonus/status", async (c) => {
  const s = c.get("settings"), uid = c.get("user").id;
  const u = await c.env.DB.prepare("SELECT last_bonus_at FROM users WHERE id=?1").bind(uid).first<{last_bonus_at:number|null}>();
  const cooldown = Math.max(1, Number(s.bonus_cooldown_hours || 24)) * 3600;
  const remainingSeconds = Math.max(0, cooldown - (Math.floor(Date.now()/1000) - Number(u?.last_bonus_at || 0)));
  return c.json({enabled:!!s.bonus_enabled, canClaim:!!s.bonus_enabled && remainingSeconds===0, remainingSeconds, cooldownHours:Number(s.bonus_cooldown_hours||24)});
});
app.post("/bonus/claim",async(c)=>{const s=c.get("settings"),uid=c.get("user").id;if(!s.bonus_enabled)return err(c,403,"BONUS_DISABLED");const u=await c.env.DB.prepare("SELECT last_bonus_at FROM users WHERE id=?1").bind(uid).first<{last_bonus_at:number}>();const now=Math.floor(Date.now()/1000);const wait=Math.max(0,Number(s.bonus_cooldown_hours)*3600-(now-(u?.last_bonus_at??0)));if(wait>0)return err(c,429,"BONUS_COOLDOWN",{remainingSeconds:wait});const amount=s.bonus_mode==="fixed"?Number(s.bonus_fixed_inr):Number((Number(s.bonus_min_inr)+Math.random()*(Number(s.bonus_max_inr)-Number(s.bonus_min_inr))).toFixed(2));const [claim]=await c.env.DB.batch([c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2,last_bonus_at=?3 WHERE id=?1 AND COALESCE(last_bonus_at,0)=?4").bind(uid,amount,now,u?.last_bonus_at??0),c.env.DB.prepare("INSERT INTO bonus_claims(user_id,amount_inr,claimed_at) SELECT ?1,?2,?3 WHERE changes()=1").bind(uid,amount,now),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,note,created_at) SELECT ?1,?2,'bonus','Claim bonus',?3 WHERE changes()=1").bind(uid,amount,now)]);if(!claim.meta.changes)return err(c,409,"BONUS_ALREADY_CLAIMED");const bal=await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(uid).first<{balance_inr:number}>();return c.json({ok:true,amount,balance:bal?.balance_inr??0});});
app.get("/catalog/categories",async(c)=>{const {results}=await c.env.DB.prepare("SELECT slug,name,icon,image_url FROM key_categories WHERE enabled=1 ORDER BY sort,id").all();return c.json({items:results});});
app.get("/catalog/platforms",async(c)=>{const {results}=await c.env.DB.prepare("SELECT slug,name,logo_url FROM key_platforms WHERE enabled=1 ORDER BY sort,id").all();return c.json({items:results});});


/* Campaigns: active tasks, membership verification and screenshot submissions. */
app.get("/campaigns", async (c) => {
  const uid=c.get("user").id;
  const {results}=await c.env.DB.prepare(
    "SELECT c.id,c.title,c.description,c.type,c.reward_inr,c.channels_json,cc.completed_at,cs.status AS submission_status FROM campaigns c LEFT JOIN campaign_completions cc ON cc.campaign_id=c.id AND cc.user_id=?1 LEFT JOIN campaign_submissions cs ON cs.campaign_id=c.id AND cs.user_id=?1 WHERE c.active=1 ORDER BY c.id DESC"
  ).bind(uid).all<any>();
  return c.json({items:results.map((x:any)=>({...x,channels:JSON.parse(x.channels_json||"[]"),channels_json:undefined,completed:!!x.completed_at}))});
});
app.post("/campaigns/:id/verify", async (c) => {
  const uid=c.get("user").id,id=Number(c.req.param("id"));
  if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_CAMPAIGN");
  const campaign=await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?1 AND active=1 AND type='channel'").bind(id).first<any>();
  if(!campaign)return err(c,404,"CAMPAIGN_NOT_FOUND");
  const prior=await c.env.DB.prepare("SELECT id FROM campaign_completions WHERE campaign_id=?1 AND user_id=?2").bind(id,uid).first();
  if(prior)return c.json({ok:true,alreadyCompleted:true});
  const channels=JSON.parse(campaign.channels_json||"[]") as {chat_id:string;url:string;title:string}[];
  if(!channels.length)return err(c,400,"CAMPAIGN_CHANNELS_MISSING");
  const me=await tg<any>(c.env.BOT_TOKEN,"getMe",{});
  for(const ch of channels){
    try{
      const botMember=await tg<any>(c.env.BOT_TOKEN,"getChatMember",{chat_id:ch.chat_id,user_id:me.id});
      if(!["administrator","creator"].includes(botMember.status))return err(c,409,"BOT_NOT_ADMIN",{channel:ch.title||ch.chat_id});
      const member=await tg<any>(c.env.BOT_TOKEN,"getChatMember",{chat_id:ch.chat_id,user_id:uid});
      const joined=member.status==="creator"||member.status==="administrator"||member.status==="member"||(member.status==="restricted"&&member.is_member===true);
      if(!joined)return err(c,403,"CHANNEL_NOT_JOINED",{channel:ch.title||ch.chat_id,url:ch.url});
    }catch(e){
      const msg=(e as Error).message||"";
      if(msg.includes("BOT_NOT_ADMIN"))throw e;
      return err(c,502,"CHANNEL_VERIFY_FAILED",{channel:ch.title||ch.chat_id,reason:msg.slice(0,180)});
    }
  }
  const now=Math.floor(Date.now()/1000),reward=Math.max(0,Number(campaign.reward_inr)||0);
  const [insert]=await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO campaign_completions(campaign_id,user_id,completed_at) VALUES(?1,?2,?3)").bind(id,uid,now),
    c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(uid,reward),
    c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT ?1,?2,'campaign',?3,?4,?5 WHERE changes()=1").bind(uid,reward,id,"Campaign reward: "+campaign.title,now)
  ]);
  if(!insert.meta.changes)return c.json({ok:true,alreadyCompleted:true});
  const bal=await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(uid).first<any>();
  await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:"🎉 Thank you! Your campaign task is verified.\n\nAdded to your wallet: ₹"+reward.toFixed(2)+"\nNew balance: ₹"+Number(bal?.balance_inr||0).toFixed(2)}).catch(()=>{});
  return c.json({ok:true,reward,balance:bal?.balance_inr??0});
});
app.post("/campaigns/:id/submit", async (c) => {
  const uid=c.get("user").id,id=Number(c.req.param("id")),b=await readBody<{screenshot:string}>(c);
  if(!Number.isSafeInteger(id)||id<1||!b?.screenshot||typeof b.screenshot!=="string")return err(c,400,"INVALID_SUBMISSION");
  const campaign=await c.env.DB.prepare("SELECT id FROM campaigns WHERE id=?1 AND active=1 AND type='manual'").bind(id).first();
  if(!campaign)return err(c,404,"CAMPAIGN_NOT_FOUND");
  const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.screenshot);
  if(!m||m[2].length>1_400_000)return err(c,400,"INVALID_SCREENSHOT");
  const prior=await c.env.DB.prepare("SELECT status FROM campaign_submissions WHERE campaign_id=?1 AND user_id=?2").bind(id,uid).first<any>();
  if(prior?.status==="approved")return err(c,409,"ALREADY_APPROVED");
  const now=Math.floor(Date.now()/1000);
  try{await c.env.DB.prepare("INSERT INTO campaign_submissions(campaign_id,user_id,screenshot_data,screenshot_mime,status,created_at) VALUES(?1,?2,?3,?4,'pending',?5) ON CONFLICT(campaign_id,user_id) DO UPDATE SET screenshot_data=excluded.screenshot_data,screenshot_mime=excluded.screenshot_mime,status='pending',created_at=excluded.created_at,reviewed_at=NULL,reviewed_by=NULL WHERE campaign_submissions.status!='approved'").bind(id,uid,m[2],m[1],now).run();}
  catch{return err(c,409,"SUBMISSION_EXISTS");}
  return c.json({ok:true,status:"pending"});
});
