import { Hono } from "hono";
import { platformName } from "../../shared/platforms";
import { MONEY_SUMS_SQL, parsePeriod, periodStart, totalsFrom, type MoneySums, type ReportPeriod } from "../../shared/profit";
import { balanceStars, MAX_STARS_PER_PAYMENT, shownStars, starsCredit } from "../../shared/stars";
import { LANGS, pickLang, type Lang } from "../../shared/types";
import { LIMITS } from "../../shared/brand";
import { checkImageUpload, deleteAssetStmts, detectImageMime, isAssetKind, putAssetStmts } from "../assets";
import { sendPreviews } from "../botMessages";
import { botText } from "../i18n";
import { BRAND_KEYS, normalizeBrandSettings } from "../brandSettings";
import { MARKUP_SQL, rebuildSummaryStmts, RULE_JOINS } from "../catalog";
import { connectAll, syncBotTexts } from "../connect";
import { addedOwners, envOwners, isOwner } from "../env";
import { orderView, type OrderRow } from "../orders";
import { refundOrderToBalance, refundPayment } from "../payments";
import { sellRate } from "../pricing";
import { bumpCatalogStmt, DEFAULTS, getSettings, setSettings, setSettingsStmts, type Settings } from "../settings";
import { isBlocked, personalize } from "../broadcastCore";
import { tg } from "../telegram";
import { brandName } from "../brand";
import { type AppEnv, err, readBody } from "./app";
import { providers } from "./providers";
import { startAnnouncementBroadcast } from "../broadcast";

export const admin = new Hono<AppEnv>();
admin.route("/", providers);

admin.use("*", async (c, next) => {
  if (!isOwner(c.env, c.get("settings"), c.get("user").id)) return err(c, 403, "FORBIDDEN");
  await next();
});

const dayStart = () => periodStart("today", Date.now());

/** Orders in a UTC-day period with sale, cost, profit and margin (see shared/profit.ts) */
function reportStmt(env: AppEnv["Bindings"], period: ReportPeriod) {
  // One range scan on orders.created_at; failed orders are fully refunded and left out
  return env.DB.prepare(`SELECT ${MONEY_SUMS_SQL} FROM orders WHERE created_at >= ?1 AND status != 'failed'`).bind(periodStart(period, Date.now()));
}

function reportJson(s: Settings, period: ReportPeriod, sums: unknown) {
  const t = totalsFrom(sums as MoneySums);
  return { period, ...t, salesStars: shownStars(t.sales, s.stars_per_usd) };
}

admin.get("/messages", (c) => {
  let messages: Record<string, string> = {};
  try { messages = JSON.parse(c.get("settings").bot_messages || "{}"); } catch { /* defaults */ }
  return c.json({ messages });
});

admin.put("/messages", async (c) => {
  const b = await readBody<{ messages?: Record<string, unknown> }>(c);
  if (!b || !b.messages || typeof b.messages !== "object" || Array.isArray(b.messages)) return err(c, 400, "INVALID_BODY");
  const allowed = new Set(["welcome","orderPlaced","orderCompleted","orderPartial","orderCancelled","orderFailed","orderRefunded","starsRefunded","topupDone","orderNotPlaced","help","paysupport","referralReward","keyDeliveredMasked","keyDeliveredRevealed","keyOutOfStock","fundAdded","bonusClaimed","bonusCooldown","bonusDisabled","couponApplied"]);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(b.messages)) {
    if (!allowed.has(key) || typeof value !== "string" || value.length > 4000) return err(c, 400, "INVALID_VALUE", { key });
    if (value.trim()) clean[key] = value;
  }
  await setSettings(c.env, { bot_messages: JSON.stringify(clean) });
  await getSettings(c.env, { fresh: true });
  return c.json({ ok: true });
});

admin.get("/icons", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id,platform,category,name,icon FROM services WHERE provider_id > 0 ORDER BY platform,category,name LIMIT 500").all();
  const categories = await c.env.DB.prepare("SELECT DISTINCT platform,category FROM services WHERE provider_id > 0 ORDER BY platform,category LIMIT 300").all();
  const categoryIcons = await c.env.DB.prepare("SELECT platform,category,icon FROM category_icons").all();
  return c.json({ items: results, categories: categories.results, categoryIcons: categoryIcons.results });
});

admin.get("/report", async (c) => {
  const period = parsePeriod(c.req.query("period"));
  const sums = await reportStmt(c.env, period).first();
  return c.json(reportJson(c.get("settings"), period, sums));
});

/** Users and joined referrals only grow; counting them reads every row, so the admin home reuses them for a minute */
let countsMemo: { at: number; users: number; joined: number } | null = null;

admin.get("/overview", async (c) => {
  const s = c.get("settings");
  const fresh = countsMemo && Date.now() - countsMemo.at < 60_000 ? countsMemo : null;
  const [today, pending, attention, users, joined] = await c.env.DB.batch([
    reportStmt(c.env, "today"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('submitting','pending','processing','in_progress')"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE present = 1 AND enabled = 1 AND fixed_rate IS NOT NULL AND fixed_rate < rate"),
    ...(fresh
      ? []
      : [c.env.DB.prepare("SELECT COUNT(*) AS n FROM users"), c.env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE status != 'pending'")]),
  ]);
  if (!fresh) countsMemo = { at: Date.now(), users: (users.results[0] as { n: number }).n, joined: (joined.results[0] as { n: number }).n };
  const t = reportJson(s, "today", today.results[0]);
  return c.json({
    providers: (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM providers WHERE enabled = 1").first<{n:number}>())?.n ?? 0,
    today: t,
    users: countsMemo!.users,
    referralsJoined: countsMemo!.joined,
    openOrders: (pending.results[0] as { n: number }).n,
    needsAttention: (attention.results[0] as { n: number }).n,
    defaultMarkup: s.default_markup_pct,
  });
});

// ---- Settings ----

const EDITABLE: (keyof Settings)[] = [
  "default_markup_pct",
  "stars_per_usd",
  "min_topup_stars",
  "max_topup_stars",
  "support_username",
  "howto_title", "howto_description", "howto_youtube_url", "howto_tiktok_url", "howto_video_url", "howto_fallback_url",
  "channel_url",
  "channel_id",
  "channel_gate",
  "referral_enabled",
  "referral_reward_stars",
  "referral_daily_cap",
  "payment_methods", "upi_id", "upi_qr_url", "inr_per_usd",
  "bonus_enabled", "bonus_mode", "bonus_fixed_inr", "bonus_min_inr", "bonus_max_inr", "bonus_cooldown_hours",
  "referral_signup_bonus_inr", "referral_commission_percent", "low_stock_alert", "api_low_balance_inr", "key_delivery_mode", "active_key_api_id",
  "terms_text",
  ...BRAND_KEYS,
];

admin.get("/settings", (c) => {
  const s = c.get("settings");
  return c.json({
    ...Object.fromEntries(EDITABLE.map((k) => [k, s[k]])),
    app_url: s.app_url,
    bot_username: s.bot_username,
    owners: { env: envOwners(c.env), added: addedOwners(s) },
  });
});

admin.put("/settings", async (c) => {
  const body = await readBody<Partial<Settings>>(c);
  if (!body) return err(c, 400, "INVALID_BODY");
  const values: Partial<Settings> = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    const v = body[k] as never;
    if (typeof DEFAULTS[k] === "number") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return err(c, 400, "INVALID_VALUE", { key: k });
      (values as Record<string, unknown>)[k] = n;
    } else (values as Record<string, unknown>)[k] = (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)).slice(0, 4000);
  }
  if (values.default_markup_pct !== undefined && values.default_markup_pct > 1000) return err(c, 400, "INVALID_VALUE", { key: "default_markup_pct" });
  const bad = (key: string) => err(c, 400, "INVALID_VALUE", { key });
  const inRange = (key: keyof Settings, lo: number, hi: number) => {
    const v = values[key] as number | undefined;
    return v === undefined || (v >= lo && v <= hi);
  };
  if (!inRange("stars_per_usd", 1, 1000)) return bad("stars_per_usd");
  if (!inRange("referral_reward_stars", 0, 100) || (values.referral_reward_stars !== undefined && !Number.isInteger(values.referral_reward_stars)))
    return bad("referral_reward_stars");
  if (!inRange("referral_daily_cap", 0, 10000)) return bad("referral_daily_cap");
  if (!inRange("inr_per_usd", 0.01, 1000)) return bad("inr_per_usd");
  if (!inRange("referral_signup_bonus_inr", 0, 10000)) return bad("referral_signup_bonus_inr");
  if (!inRange("referral_commission_percent", 0, 100)) return bad("referral_commission_percent");
  if (!inRange("low_stock_alert", 0, 10000) || (values.low_stock_alert !== undefined && !Number.isInteger(values.low_stock_alert))) return bad("low_stock_alert");
  if (!inRange("api_low_balance_inr", 0, 10000000)) return bad("api_low_balance_inr");
  if (values.key_delivery_mode !== undefined && !["auto","stock_only","api_only"].includes(values.key_delivery_mode)) return bad("key_delivery_mode");
  // Top-up limits are compared against the merged current + new values
  const cur = c.get("settings");
  const minTopup = values.min_topup_stars ?? cur.min_topup_stars;
  const maxTopup = values.max_topup_stars ?? cur.max_topup_stars;
  if (!Number.isInteger(minTopup) || minTopup < 1) return bad("min_topup_stars");
  if (!Number.isInteger(maxTopup) || maxTopup < minTopup || maxTopup > MAX_STARS_PER_PAYMENT) return bad("max_topup_stars");
  if (values.support_username) values.support_username = values.support_username.replace(/^@/, "");
  for (const key of ["howto_youtube_url","howto_tiktok_url","howto_video_url","howto_fallback_url"] as const) {
    const value = values[key];
    if (value && (!/^https?:\/\//i.test(value) || value.length > 1000)) return err(c, 400, "INVALID_VALUE", { key });
  }
  if (values.channel_url && !/^https:\/\/t\.me\//.test(values.channel_url)) return err(c, 400, "INVALID_VALUE", { key: "channel_url" });
  if (values.channel_id && !/^-100\d{5,}$/.test(values.channel_id)) return err(c, 400, "INVALID_VALUE", { key: "channel_id" });
  const badBrand = normalizeBrandSettings(values);
  if (badBrand) return bad(badBrand);
  await c.env.DB.batch([...setSettingsStmts(c.env, values), bumpCatalogStmt(c.env)]);
  const s = await getSettings(c.env);
  if (values.default_markup_pct !== undefined) await c.env.DB.batch(rebuildSummaryStmts(c.env, s));
  // The listing filter changed: re-scan the catalog now and drop services that no longer qualify
  return c.json({ ok: true });
});

/** Admins added in the app. Admins from the OWNER_IDS variable are fixed; the app always keeps at least one admin. */
admin.put("/owners", async (c) => {
  const b = await readBody<{ added?: unknown }>(c);
  if (!b || !Array.isArray(b.added) || b.added.length > 20) return err(c, 400, "INVALID_BODY");
  const ids: number[] = [];
  for (const v of b.added) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) return err(c, 400, "INVALID_VALUE", { key: "added" });
    if (!ids.includes(n)) ids.push(n);
  }
  const fixed = envOwners(c.env);
  const added = ids.filter((n) => !fixed.includes(n));
  if (!fixed.length && !added.length) return err(c, 400, "LAST_OWNER");
  await setSettings(c.env, { owner_ids: added.join(",") });
  return c.json({ ok: true, owners: { env: fixed, added } });
});

/** Logo / welcome banner: raw image body (PNG, JPEG or WebP, checked by content, not by name) */
admin.put("/assets/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isAssetKind(kind)) return err(c, 404, "NOT_FOUND");
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > LIMITS.imageBytes) return err(c, 413, "TOO_LARGE", { max: LIMITS.imageBytes });
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const bad = checkImageUpload(c.req.header("content-type"), bytes);
  if (bad) return err(c, bad === "TOO_LARGE" ? 413 : 400, bad, bad === "TOO_LARGE" ? { max: LIMITS.imageBytes } : undefined);
  const s = await getSettings(c.env, { fresh: true });
  await c.env.DB.batch(putAssetStmts(c.env, s, kind, detectImageMime(bytes)!, bytes));
  const next = await getSettings(c.env, { fresh: true });
  return c.json({ ok: true, version: kind === "logo" ? next.logo_ver : next.banner_ver });
});

admin.delete("/assets/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isAssetKind(kind)) return err(c, 404, "NOT_FOUND");
  await c.env.DB.batch(deleteAssetStmts(c.env, await getSettings(c.env, { fresh: true }), kind));
  return c.json({ ok: true });
});



// ---- Prices: platforms → categories → services ----

admin.get("/platforms", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.platform AS slug, COUNT(*) AS count, SUM(s.enabled) AS enabled, pr.enabled AS rule_enabled, pr.markup_pct
     FROM services s LEFT JOIN category_rules pr ON pr.platform = s.platform AND pr.category = ''
     WHERE s.present = 1 GROUP BY s.platform ORDER BY count DESC`,
  ).all<{ slug: string; count: number; enabled: number; rule_enabled: number | null; markup_pct: number | null }>();
  return c.json(
    results.map((r) => ({
      slug: r.slug,
      name: platformName(r.slug),
      count: r.count,
      enabledServices: r.enabled,
      enabled: r.rule_enabled !== 0,
      markupPct: r.markup_pct,
    })),
  );
});

admin.get("/categories", async (c) => {
  const platform = c.req.query("platform") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT s.category AS name, COUNT(*) AS count, SUM(s.enabled) AS enabled, MIN(s.sort) AS sort, cr.enabled AS rule_enabled, cr.markup_pct
     FROM services s LEFT JOIN category_rules cr ON cr.platform = s.platform AND cr.category = s.category
     WHERE s.present = 1 AND s.platform = ?1 GROUP BY s.category ORDER BY sort`,
  )
    .bind(platform)
    .all<{ name: string; count: number; enabled: number; rule_enabled: number | null; markup_pct: number | null }>();
  return c.json(
    results.map((r) => ({ name: r.name, count: r.count, enabledServices: r.enabled, enabled: r.rule_enabled !== 0, markupPct: r.markup_pct })),
  );
});

/** Platform rule when category is "" — enable/disable or set a markup for a whole platform or category */
admin.put("/rule", async (c) => {
  const b = await readBody<{ platform: string; category?: string; enabled?: boolean; markupPct?: number | null }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  if (!b.platform || typeof b.platform !== "string") return err(c, 400, "MISSING_PLATFORM");
  const markup = b.markupPct === undefined ? undefined : b.markupPct === null ? null : Number(b.markupPct);
  if (markup !== undefined && markup !== null && (!Number.isFinite(markup) || markup < 0 || markup > 1000)) return err(c, 400, "INVALID_VALUE");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO category_rules (platform, category, enabled, markup_pct) VALUES (?1, ?2, COALESCE(?3, 1), ?4)
       ON CONFLICT(platform, category) DO UPDATE SET enabled = COALESCE(?3, enabled), markup_pct = CASE WHEN ?5 THEN ?4 ELSE markup_pct END`,
    ).bind(b.platform, b.category ?? "", b.enabled === undefined ? null : b.enabled ? 1 : 0, markup ?? null, markup !== undefined ? 1 : 0),
    ...rebuildSummaryStmts(c.env, c.get("settings")),
    bumpCatalogStmt(c.env),
  ]);
  return c.json({ ok: true });
});

const PAGE = 50;
/** Escapes LIKE wildcards in user input */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, "")}%`;
/** Positive integer query param, or null */
const intParam = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
/** Trims the extra look-ahead row and builds the `{ items, next }` page */
function page<T>(rows: T[], cursor: (last: T) => string | number) {
  const more = rows.length > PAGE;
  const items = more ? rows.slice(0, PAGE) : rows;
  return { items, next: more ? cursor(items[PAGE - 1]) : null };
}

admin.get("/services", async (c) => {
  const s = c.get("settings");
  const platform = c.req.query("platform");
  const category = c.req.query("category");
  const q = (c.req.query("q") ?? "").trim();
  const attention = c.req.query("attention") === "1";
  const where = ["s.present = 1"];
  const vals: unknown[] = [s.default_markup_pct];
  if (platform) {
    vals.push(platform);
    where.push(`s.platform = ?${vals.length}`);
  }
  if (category) {
    vals.push(category);
    where.push(`s.category = ?${vals.length}`);
  }
  if (q) {
    vals.push(/^\d+$/.test(q) ? Number(q) : -1, likeOf(q));
    where.push(`(s.id = ?${vals.length - 1} OR s.name LIKE ?${vals.length} OR s.custom_name LIKE ?${vals.length})`);
  }
  if (attention) where.push("s.fixed_rate IS NOT NULL AND s.fixed_rate < s.rate");
  const offset = Math.min(intParam(c.req.query("offset")) ?? 0, 100_000);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.custom_name, s.platform, s.category, s.rate, s.min, s.max, s.enabled, s.markup_pct, s.fixed_rate,
       ${MARKUP_SQL} AS markup, (SELECT old_rate FROM price_changes p WHERE p.service_id = s.id ORDER BY p.id DESC LIMIT 1) AS prev_rate
     FROM services s ${RULE_JOINS} WHERE ${where.join(" AND ")} ORDER BY s.sort, s.id LIMIT ${PAGE + 1} OFFSET ${offset}`,
  )
    .bind(...vals)
    .all<{
      id: number;
      name: string;
      custom_name: string | null;
      platform: string;
      category: string;
      rate: number;
      min: number;
      max: number;
      enabled: number;
      markup_pct: number | null;
      fixed_rate: number | null;
      markup: number;
      prev_rate: number | null;
    }>();
  const pg = page(results, () => offset + PAGE);
  return c.json({
    next: pg.next,
    items: pg.items.map((r) => ({
      id: r.id,
      name: r.name,
      customName: r.custom_name,
      platform: r.platform,
      category: r.category,
      cost: r.rate,
      prevCost: r.prev_rate,
      sell: sellRate(r.rate, r.markup, r.fixed_rate),
      sellStars: shownStars(sellRate(r.rate, r.markup, r.fixed_rate), s.stars_per_usd),
      starsPerUsd: s.stars_per_usd,
      markup: r.markup,
      markupPct: r.markup_pct,
      fixedRate: r.fixed_rate,
      min: r.min,
      max: r.max,
      enabled: !!r.enabled,
    })),
  });
});

admin.put("/services/:id", async (c) => {
  const b = await readBody<{ enabled?: boolean; markupPct?: number | null; fixedRate?: number | null; customName?: string | null }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = ?${vals.length}`);
  };
  if (b.enabled !== undefined) set("enabled", b.enabled ? 1 : 0);
  if (b.markupPct !== undefined) {
    if (b.markupPct !== null && (!Number.isFinite(b.markupPct) || b.markupPct < 0 || b.markupPct > 1000)) return err(c, 400, "INVALID_VALUE");
    set("markup_pct", b.markupPct);
  }
  if (b.fixedRate !== undefined) {
    if (b.fixedRate !== null && (!Number.isFinite(b.fixedRate) || b.fixedRate <= 0)) return err(c, 400, "INVALID_VALUE");
    set("fixed_rate", b.fixedRate === null ? null : Math.round(b.fixedRate));
  }
  if (b.customName !== undefined) set("custom_name", b.customName?.trim() ? b.customName.trim().slice(0, 200) : null);
  if (!sets.length) return c.json({ ok: true });
  vals.push(Number(c.req.param("id")));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals),
    ...rebuildSummaryStmts(c.env, c.get("settings")),
    bumpCatalogStmt(c.env),
  ]);
  return c.json({ ok: true });
});

admin.get("/price-changes", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (before) {
    vals.push(before);
    where.push(`p.id < ?${vals.length}`);
  }
  if (q) {
    vals.push(/^\d+$/.test(q) ? Number(q) : -1, likeOf(q));
    where.push(`(p.service_id = ?${vals.length - 1} OR s.name LIKE ?${vals.length} OR s.custom_name LIKE ?${vals.length})`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.service_id, p.old_rate, p.new_rate, p.changed_at, s.name, s.platform, s.category
     FROM price_changes p LEFT JOIN services s ON s.id = p.service_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...vals)
    .all<{ id: number }>();
  return c.json(page(results, (r) => r.id));
});

// ---- Payments ----

// Lifetime paid totals scan the whole payments table, so cache them per isolate for 5 minutes.
let totalsMemo: { at: number; value: unknown } | null = null;
async function paymentTotals(env: AppEnv["Bindings"]): Promise<unknown> {
  if (totalsMemo && Date.now() - totalsMemo.at < 5 * 60_000) return totalsMemo.value;
  const value = await env.DB.prepare(
    "SELECT COALESCE(SUM(stars), 0) AS stars, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'paid'",
  ).first();
  totalsMemo = { at: Date.now(), value };
  return value;
}

const ADMIN_PAYMENTS_SQL = (where: string[], limit: number) =>
  `SELECT p.id, p.user_id, p.stars, p.amount, p.status, p.order_id, p.paid_at, p.created_at, u.first_name, u.last_name, u.username
   FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT ${limit}`;

admin.get("/payments", async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/^[@#]/, "").slice(0, 100);
  const status = c.req.query("status");
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (status === "paid" || status === "refunded") {
    vals.push(status);
    where.push(`p.status = ?${vals.length}`);
  } else where.push("p.status != 'pending'");
  const user = intParam(c.req.query("user"));
  if (user) {
    vals.push(user);
    where.push(`p.user_id = ?${vals.length}`);
  }
  if (before) {
    vals.push(before);
    where.push(`p.id < ?${vals.length}`);
  }
  if (q) {
    vals.push(q, likeOf(q));
    where.push(
      `(CAST(p.id AS TEXT) = ?${vals.length - 1} OR CAST(p.user_id AS TEXT) = ?${vals.length - 1} OR p.charge_id = ?${vals.length - 1} OR u.username LIKE ?${vals.length} OR u.first_name LIKE ?${vals.length})`,
    );
  }
  const { results } = await c.env.DB.prepare(ADMIN_PAYMENTS_SQL(where, PAGE + 1))
    .bind(...vals)
    .all<{ id: number }>();
  // stars = Stars paid; amount = micro-USD credited for them
  return c.json({ ...page(results, (r) => r.id), totals: await paymentTotals(c.env), starsPerUsd: c.get("settings").stars_per_usd });
});

admin.post("/payments/:id/refund", async (c) => {
  const b = (await readBody<{ force?: boolean }>(c)) ?? {};
  const r = await refundPayment(c.env, Number(c.req.param("id")), b.force === true);
  return r.ok ? c.json(r) : err(c, 400, r.error ?? "REFUND_FAILED", r.details);
});

/**
 * Refunds an order: "stars" sends back the Stars payment that bought it, "balance" credits the user's balance (all
 * that is still charged, or `stars` worth of it).
 */
admin.post("/orders/:id/refund", async (c) => {
  const b = (await readBody<{ to?: string; force?: boolean; stars?: number }>(c)) ?? {};
  const id = Number(c.req.param("id"));
  let r;
  if (b.to === "stars") {
    const p = await c.env.DB.prepare("SELECT id FROM payments WHERE order_id = ?1 AND status = 'paid' ORDER BY id DESC LIMIT 1").bind(id).first<{ id: number }>();
    if (!p) return err(c, 400, "NO_STARS_PAYMENT");
    r = await refundPayment(c.env, p.id, b.force === true);
  } else if (b.to === "balance") {
    let upTo: number | undefined;
    if (b.stars !== undefined) {
      const stars = Number(b.stars);
      if (!Number.isInteger(stars) || stars < 1 || stars > 1_000_000) return err(c, 400, "INVALID_AMOUNT");
      const o = await c.env.DB.prepare("SELECT charge - refund AS left FROM orders WHERE id = ?1").bind(id).first<{ left: number }>();
      const rate = c.get("settings").stars_per_usd;
      // The full amount as shown in Stars (rounded up) refunds exactly what is left, without a stray fraction
      if (o && stars < shownStars(o.left, rate)) upTo = starsCredit(stars, rate);
    }
    r = await refundOrderToBalance(c.env, id, upTo);
  } else return err(c, 400, "BAD_REQUEST");
  return r.ok ? c.json(r) : err(c, 400, r.error ?? "REFUND_FAILED", r.details);
});

// ---- Referrals ----

interface RefTotals {
  invited: number;
  joined: number;
  rewarded: number;
  pending: number;
  capped: number;
  paid: number;
  todayInvited: number;
  todayPaid: number;
}
interface RefTop {
  id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  invited: number;
  joined: number;
  earned: number;
  last_at: number;
}
let refCache: { at: number; totals: RefTotals; top: RefTop[] } | null = null;

const REF_TOTALS_SQL = `SELECT COUNT(*) AS invited,
    COALESCE(SUM(status != 'pending'), 0) AS joined,
    COALESCE(SUM(status = 'rewarded'), 0) AS rewarded,
    COALESCE(SUM(status = 'pending'), 0) AS pending,
    COALESCE(SUM(status = 'capped'), 0) AS capped,
    COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) AS paid,
    COALESCE(SUM(created_at >= ?1), 0) AS todayInvited,
    COALESCE(SUM(CASE WHEN status = 'rewarded' AND rewarded_at >= ?1 THEN reward END), 0) AS todayPaid
  FROM referrals`;

const REF_TOP_SQL = (where: string) => `SELECT g.referrer_id AS id, u.first_name, u.last_name, u.username, g.invited, g.joined, g.earned, g.last_at
  FROM (SELECT referrer_id, COUNT(*) AS invited, SUM(status != 'pending') AS joined,
          COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) AS earned, MAX(created_at) AS last_at
        FROM referrals ${where} GROUP BY referrer_id ORDER BY joined DESC, invited DESC LIMIT 20) g
  LEFT JOIN users u ON u.id = g.referrer_id ORDER BY g.joined DESC, g.invited DESC`;

admin.get("/referrals", async (c) => {
  const s = c.get("settings");
  const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 64);
  const beforeN = Number(c.req.query("before"));
  const before = Number.isFinite(beforeN) && beforeN > 0 ? Math.floor(beforeN) : null;
  const now = Date.now();
  const cached = !q && refCache && now - refCache.at < 60_000 ? refCache : null;
  const like = `%${q.replace(/[\\%_]/g, "")}%`;
  const match = `SELECT id FROM users WHERE CAST(id AS TEXT) = ?1 OR username LIKE ?2 OR first_name LIKE ?2 OR last_name LIKE ?2 LIMIT 50`;

  const stmts: D1PreparedStatement[] = [];
  if (!cached) stmts.push(c.env.DB.prepare(REF_TOTALS_SQL).bind(dayStart()));
  if (!cached || q) {
    stmts.push(q ? c.env.DB.prepare(REF_TOP_SQL(`WHERE referrer_id IN (${match})`)).bind(q, like) : c.env.DB.prepare(REF_TOP_SQL("")));
  }
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    binds.push(q, like);
    conds.push(`(r.referrer_id IN (${match}) OR r.referred_id IN (${match}))`);
  }
  if (before) {
    binds.push(before);
    conds.push(`r.created_at < ?${binds.length}`);
  }
  stmts.push(
    c.env.DB.prepare(
      `SELECT r.referred_id, r.referrer_id, r.status, r.reward, r.created_at, r.rewarded_at,
         f.first_name AS f_first, f.last_name AS f_last, f.username AS f_user,
         u.first_name AS r_first, u.last_name AS r_last, u.username AS r_user
       FROM referrals r LEFT JOIN users f ON f.id = r.referred_id LEFT JOIN users u ON u.id = r.referrer_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT 50`,
    ).bind(...binds),
  );
  const res = await c.env.DB.batch(stmts);
  let i = 0;
  let totals: RefTotals;
  let top: RefTop[];
  if (cached) {
    totals = cached.totals;
    top = cached.top;
  } else {
    totals = res[i++].results[0] as unknown as RefTotals;
    top = res[i++].results as unknown as RefTop[];
    if (!q) refCache = { at: now, totals, top };
  }
  const recent = res[i].results as Record<string, unknown>[];
  return c.json({
    totals,
    top,
    recent,
    next: recent.length === 50 ? recent[49].created_at : null,
    settings: { enabled: !!s.referral_enabled, rewardStars: s.referral_reward_stars, dailyCap: s.referral_daily_cap, starsPerUsd: s.stars_per_usd },
  });
});

// ---- Users ----

admin.post("/users/add-by-id", async (c) => {
  const b = await readBody<{ telegram_id?: number | string }>(c);
  const id = Number(b?.telegram_id);
  if (!Number.isSafeInteger(id) || id <= 0) return err(c, 400, "INVALID_TELEGRAM_ID");
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE id=?1").bind(id).first<{id:number}>();
  if (existing) return c.json({ok:true,userId:id,alreadyRegistered:true});
  // Telegram only exposes a private chat to this bot after the person has interacted with it.
  // This prevents admins from manufacturing user records for arbitrary IDs.
  let chat:any;
  try { chat = await tg<any>(c.env.BOT_TOKEN, "getChat", {chat_id:id}); }
  catch { return err(c, 409, "USER_MUST_START_BOT", {message:"Ask this person to open the bot and press /start first, then try again."}); }
  if (!chat || chat.type !== "private" || Number(chat.id) !== id) return err(c, 409, "USER_MUST_START_BOT");
  const now = Math.floor(Date.now()/1000);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO users (id,first_name,last_name,username,language_code,notify,created_at,last_seen_at) VALUES (?1,?2,?3,?4,?5,1,?6,?6)"
  ).bind(id,String(chat.first_name||"").slice(0,160),String(chat.last_name||"").slice(0,160),chat.username||null,chat.language_code||null,now).run();
  const created = await c.env.DB.prepare("SELECT id FROM users WHERE id=?1").bind(id).first<{id:number}>();
  if (!created) return err(c, 502, "USER_REGISTRATION_FAILED");
  return c.json({ok:true,userId:id,alreadyRegistered:false},201);
});

admin.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 100);
  // Cursor "lastSeenAt_id" keeps paging stable when many users share a timestamp.
  const m = /^(\d+)_(\d+)$/.exec(c.req.query("before") ?? "");
  const where: string[] = [];
  const vals: unknown[] = [];
  if (q) {
    vals.push(q, likeOf(q));
    where.push(`(CAST(id AS TEXT) = ?1 OR username LIKE ?2 OR first_name LIKE ?2 OR last_name LIKE ?2)`);
  }
  if (m) {
    vals.push(Number(m[1]), Number(m[2]));
    where.push(`(last_seen_at < ?${vals.length - 1} OR (last_seen_at = ?${vals.length - 1} AND id < ?${vals.length}))`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
       (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS paid
     FROM (SELECT * FROM users ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_seen_at DESC, id DESC LIMIT ${PAGE + 1}) u
     ORDER BY u.last_seen_at DESC, u.id DESC`,
  )
    .bind(...vals)
    .all<{ id: number; last_seen_at: number }>();
  return c.json(page(results, (u) => `${u.last_seen_at}_${u.id}`));
});

admin.post("/users/:id/balance", async (c) => {
  const b = await readBody<{ amount: number; note?: string }>(c);
  if (!b || !Number.isFinite(Number(b.amount)) || Number(b.amount) === 0 || Math.abs(Number(b.amount)) > 10000000)
    return err(c, 400, "INVALID_AMOUNT");
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!b.note?.trim()) return err(c, 400, "REASON_REQUIRED");
  const id = intParam(c.req.param("id"));
  if (!id) return err(c, 400, "INVALID_USER");
  const now = Math.floor(Date.now() / 1000);
  const upd = await c.env.DB.prepare("UPDATE users SET balance_inr = balance_inr + ?2 WHERE id = ?1 AND balance_inr + ?2 >= 0").bind(id, amount).run();
  if (!(upd.meta.changes ?? 0)) return err(c, 400, "INSUFFICIENT_BALANCE_OR_USER");
  await c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,note,created_at) VALUES(?1,?2,'admin',?3,?4)")
    .bind(id, amount, b.note.trim().slice(0,200), now).run();
  const u = await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(id).first<{balance_inr:number}>();
  return c.json({ok:true,balance:Number(u?.balance_inr ?? 0)});
});

admin.get("/users/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return err(c, 404, "NOT_FOUND");
  const [user, stats, invitedBy, orders, payments] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, first_name, last_name, username, language_code, lang, balance, balance_inr, banned, can_message, channel_ok, created_at, last_seen_at, home_at
       FROM users WHERE id = ?1`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = ?1) AS orders,
         (SELECT COUNT(*) FROM orders WHERE user_id = ?1 AND status IN ('submitting','pending','processing','in_progress')) AS openOrders,
         (SELECT COALESCE(SUM(charge - refund), 0) FROM orders WHERE user_id = ?1 AND status != 'failed') AS spent,
         (SELECT COALESCE(SUM(refund), 0) FROM orders WHERE user_id = ?1 AND status != 'failed') AS refunded,
         (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE user_id = ?1 AND status = 'paid') AS paid,
         (SELECT COALESCE(SUM(stars), 0) FROM payments WHERE user_id = ?1 AND status = 'paid') AS paidStars,
         (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?1) AS invited,
         (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?1 AND status != 'pending') AS joined,
         (SELECT COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward END), 0) FROM referrals WHERE referrer_id = ?1) AS earned`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT r.referrer_id AS id, r.status, u.first_name, u.last_name, u.username
       FROM referrals r LEFT JOIN users u ON u.id = r.referrer_id WHERE r.referred_id = ?1`,
    ).bind(id),
    c.env.DB.prepare(ADMIN_ORDERS_SQL(["o.user_id = ?1"], 5)).bind(id),
    c.env.DB.prepare(ADMIN_PAYMENTS_SQL(["p.user_id = ?1", "p.status != 'pending'"], 5)).bind(id),
  ]);
  if (!user.results[0]) return err(c, 404, "NOT_FOUND");
  return c.json({
    user: user.results[0],
    stats: stats.results[0],
    invitedBy: invitedBy.results[0] ?? null,
    orders: (orders.results as AdminOrderRow[]).map(adminOrderItem),
    payments: payments.results,
    starsPerUsd: c.get("settings").stars_per_usd,
  });
});

/** Every balance change of one user, newest first: top-ups, orders, refunds, admin changes, referral rewards */
admin.get("/users/:id/ledger", async (c) => {
  const id = intParam(c.req.param("id"));
  const before = intParam(c.req.query("before"));
  const { results } = await c.env.DB.prepare(
    `SELECT id, delta_inr, kind, ref, note, created_at FROM inr_ledger WHERE user_id = ?1 ${before ? "AND id < ?2" : ""} ORDER BY id DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...(before ? [id, before] : [id]))
    .all<{ id: number }>();
  return c.json(page(results, (r) => r.id));
});

/** Sends the user a plain-text message from the bot (support replies) */
admin.post("/users/:id/message", async (c) => {
  const body = await readBody<{ text?: string }>(c);
  const raw = (body?.text ?? "").trim();
  if (!raw || raw.length > 4000) return err(c, 400, "INVALID_TEXT");
  const id = intParam(c.req.param("id"));
  const u = id ? await c.env.DB.prepare("SELECT id,first_name,username,balance_inr,created_at FROM users WHERE id = ?1").bind(id).first<any>() : null;
  if (!u) return err(c, 404, "NOT_FOUND");
  const [counts, latest] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS orders,COUNT(delivered_key) AS totalkeys FROM orders WHERE user_id=?1").bind(id),
    c.env.DB.prepare("SELECT delivered_key,product_name,expires_at FROM orders WHERE user_id=?1 AND delivered_key IS NOT NULL ORDER BY id DESC LIMIT 3").bind(id),
  ]);
  const keys:any[] = latest.results as any[];
  const vars = { name:u.first_name||"there", username:u.username?`@${u.username}`:(u.first_name||"there"), balance:`₹${Number(u.balance_inr||0).toFixed(2)}`, totalkeys:String((counts.results[0] as any)?.totalkeys||0), key_1:keys[0]?.delivered_key||"", key_2:keys[1]?.delivered_key||"", key_3:keys[2]?.delivered_key||"", product:keys[0]?.product_name||"", expiry:keys[0]?.expires_at?new Date(Number(keys[0].expires_at)*1000).toLocaleDateString("en-GB"):"", joined:new Date(Number(u.created_at)*1000).toLocaleDateString("en-GB"), orders:String((counts.results[0] as any)?.orders||0), brand:brandName(c.get("settings")), support:c.get("settings").support_username?`@${c.get("settings").support_username}`:"Support" };
  const text=personalize(raw,[],vars,4000).text;
  try {
    await tg(c.env.BOT_TOKEN, "sendMessage", { chat_id: id, text });
  } catch (e) {
    const m = (e as Error).message;
    if (isBlocked(m)) {
      await c.env.DB.prepare("UPDATE users SET can_message = 0 WHERE id = ?1").bind(id).run();
      return err(c, 400, "CANT_MESSAGE");
    }
    return err(c, 400, "SEND_FAILED", { message: m.replace(/^Telegram \w+: /, "").slice(0, 160) });
  }
  return c.json({ ok: true });
});

admin.post("/users/:id/ban", async (c) => {
  const b = await readBody<{ banned: boolean }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const { banned } = b;
  await c.env.DB.prepare("UPDATE users SET banned = ?2 WHERE id = ?1").bind(Number(c.req.param("id")), banned ? 1 : 0).run();
  return c.json({ ok: true });
});

// ---- Orders ----

type AdminOrderRow = OrderRow & { rate: number | null; first_name: string; username: string | null; paid_stars: number | null };

/** Orders with their user's name and the Stars of the payment that bought them (if still paid) */
const ADMIN_ORDERS_SQL = (where: string[], limit: number) =>
  `SELECT o.*, u.first_name, u.username,
     (SELECT p.stars FROM payments p WHERE p.order_id = o.id AND p.status = 'paid' ORDER BY p.id DESC LIMIT 1) AS paid_stars
   FROM orders o LEFT JOIN users u ON u.id = o.user_id
   ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.id DESC LIMIT ${limit}`;

const adminOrderItem = (o: AdminOrderRow) => ({
  ...orderView(o),
  npOrderId: o.np_order_id,
  cost: o.cost,
  rate: o.rate,
  userId: o.user_id,
  userName: o.first_name,
  username: o.username,
  error: o.error,
  errorDetail: o.error_detail,
  paidStars: o.paid_stars,
  refundable: Math.max(0, o.charge - o.refund),
});

admin.get("/orders", async (c) => {
  const status = c.req.query("status");
  const q = (c.req.query("q") ?? "").trim().replace(/^#/, "");
  const user = intParam(c.req.query("user"));
  const before = intParam(c.req.query("before"));
  const where: string[] = [];
  const vals: unknown[] = [];
  if (status === "open") where.push("o.status IN ('submitting','pending','processing','in_progress')");
  else if (status) {
    vals.push(status);
    where.push(`o.status = ?${vals.length}`);
  }
  if (user) {
    vals.push(user);
    where.push(`o.user_id = ?${vals.length}`);
  }
  if (q) {
    const name = q.replace(/^@/, "").slice(0, 100);
    vals.push(q.slice(0, 200), likeOf(q.slice(0, 200)), likeOf(name));
    const [eq, like, nameLike] = [vals.length - 2, vals.length - 1, vals.length];
    where.push(
      `(CAST(o.id AS TEXT) = ?${eq} OR CAST(o.np_order_id AS TEXT) = ?${eq} OR CAST(o.user_id AS TEXT) = ?${eq} OR o.link LIKE ?${like}
        OR o.user_id IN (SELECT id FROM users WHERE username LIKE ?${nameLike} OR first_name LIKE ?${nameLike} OR last_name LIKE ?${nameLike} LIMIT 50))`,
    );
  }
  // The totals cover the whole filter (not just this page) and are only needed with the first page
  const filterVals = [...vals];
  const filterWhere = [...where];
  if (before) {
    vals.push(before);
    where.push(`o.id < ?${vals.length}`);
  }
  const listStmt = c.env.DB.prepare(ADMIN_ORDERS_SQL(where, PAGE + 1)).bind(...vals);
  const totalsStmt = before
    ? null
    : c.env.DB.prepare(`SELECT ${MONEY_SUMS_SQL} FROM orders o WHERE ${[...filterWhere, "o.status != 'failed'"].join(" AND ")}`).bind(...filterVals);
  const [list, totals] = await c.env.DB.batch(totalsStmt ? [listStmt, totalsStmt] : [listStmt]);
  const pg = page(list.results as AdminOrderRow[], (o) => o.id);
  return c.json({
    next: pg.next,
    // Sale, cost, profit and margin of every non-failed order in this filter (shared/profit.ts); only on the first page
    totals: totals ? totalsFrom(totals.results[0] as MoneySums) : undefined,
    // charge/refund/cost are micro-USD; rate is Stars per $1 when the order was placed (null on very old rows)
    starsPerUsd: c.get("settings").stars_per_usd,
    items: pg.items.map(adminOrderItem),
  });
});

// ---- Connection: bot setup ----

/** Sends one of every bot message (sample data) to the owner's chat */
admin.post("/preview-messages", async (c) => {
  const lang = (await readBody<{ lang?: string }>(c))?.lang;
  const u = c.get("user");
  const l = (LANGS as readonly string[]).includes(lang ?? "") ? (lang as Lang) : c.get("lang");
  try {
    const sent = await sendPreviews(c.env, u.id, l, u.first_name, LANGS);
    return c.json({ ok: true, sent });
  } catch (e) {
    return err(c, 400, "SEND_FAILED", { message: (e as Error).message });
  }
});

admin.post("/connect", async (c) => {
  const url = new URL(c.req.url).origin;
  const result = await connectAll(c.env, url);
  return c.json(result);
});

admin.post("/bot-texts/:batch", async (c) => c.json({ next: await syncBotTexts(c.env, Number(c.req.param("batch")) || 0) }));

admin.get("/key-api",(c)=>({apiUrl:c.get("settings").reseller_api_url,configured:!!c.get("settings").reseller_api_key,masked:c.get("settings").reseller_api_key?"••••••••":""}));
admin.put("/key-api",async(c)=>{const b=await readBody<{apiUrl?:string;apiKey?:string;masterKey?:string}>(c);if(!b)return err(c,400,"INVALID_BODY");const v:Partial<Settings>={};if(b.apiUrl!==undefined){if(!/^https:\/\//.test(b.apiUrl))return err(c,400,"INVALID_URL");v.reseller_api_url=b.apiUrl.slice(0,300);}if(b.apiKey!==undefined)v.reseller_api_key=b.apiKey.slice(0,500);if(b.masterKey!==undefined)v.reseller_master_key=b.masterKey.slice(0,500);await setSettings(c.env,v);return c.json({ok:true,configured:!!(v.reseller_api_key??c.get("settings").reseller_api_key)});});

// ---- Key store administration ----
admin.get("/key-products", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM key_plans pl WHERE pl.product_id=p.id AND pl.enabled=1) AS plan_count,
     (SELECT COUNT(*) FROM key_stock ks WHERE ks.product_id=p.id AND ks.used=0) AS stock_count
     FROM key_products p ORDER BY p.sort, p.id DESC`,
  ).all();
  return c.json({ items: results });
});
admin.post("/key-products", async (c) => {
  const b = await readBody<any>(c);
  if (!b || typeof b.name !== "string" || !b.name.trim()) return err(c, 400, "INVALID_NAME");
  if (b.api_source === "api" && !String(b.pid ?? "").trim()) return err(c, 400, "API_PID_REQUIRED");
  const now = Math.floor(Date.now()/1000);
  const r = await c.env.DB.prepare(`INSERT INTO key_products(name,pid,category,platform,description,image_url,api_id,api_source,enabled,sort,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) RETURNING *`)
    .bind(b.name.trim().slice(0,120), b.pid ?? null, b.category ?? "other", b.platform ?? "all", b.description ?? null,
      b.image_url ?? null, b.api_id ?? null, ["stock","api","both"].includes(b.api_source) ? b.api_source : "both",
      b.enabled === false ? 0 : 1, Number(b.sort)||0, now).first();
  if (r && !(r as any).public_uid) { const uid=`P${String((r as any).id).padStart(6,"0")}`; await c.env.DB.prepare("UPDATE key_products SET public_uid=?2 WHERE id=?1").bind((r as any).id,uid).run(); (r as any).public_uid=uid; }
  return c.json({ item: r }, 201);
});
admin.put("/key-products/:id", async (c) => {
  const id = Number(c.req.param("id")); const b = await readBody<any>(c);
  if (!Number.isSafeInteger(id) || id < 1 || !b) return err(c,400,"INVALID_BODY");
  const allowed = ["name","pid","category","platform","description","image_url","api_id","api_source","enabled","sort","setup_file_id","setup_file_name","setup_file_url","setup_video_file_id","setup_video_url"];
  const fields = allowed.filter(k => b[k] !== undefined);
  if (!fields.length) return c.json({ok:true});
  const sets = fields.map((k,i)=>`${k}=?${i+2}`).join(",");
  const vals = fields.map(k => k === "enabled" ? (b[k] ? 1 : 0) : b[k]);
  await c.env.DB.prepare(`UPDATE key_products SET ${sets} WHERE id=?1`).bind(id,...vals).run();
  return c.json({ok:true});
});
admin.delete("/key-products/:id", async (c) => {
  const id=Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return err(c,400,"INVALID_ID");
  const product=await c.env.DB.prepare("SELECT id FROM key_products WHERE id=?1").bind(id).first();
  if (!product) return err(c,404,"PRODUCT_NOT_FOUND");
  // Archive only: retain every stock key and delivery/order record for audit and refunds.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE key_products SET enabled=0 WHERE id=?1").bind(id),
    c.env.DB.prepare("UPDATE key_plans SET enabled=0 WHERE product_id=?1").bind(id)
  ]);
  return c.json({ok:true,archived:true});
});
admin.get("/key-products/:id/plans", async (c) => {
  const {results}=await c.env.DB.prepare("SELECT pl.*,(SELECT COUNT(*) FROM key_stock ks WHERE ks.plan_id=pl.id AND ks.used=0) AS stock_count FROM key_plans pl WHERE pl.product_id=?1 ORDER BY pl.sort,pl.id").bind(Number(c.req.param("id"))).all();
  return c.json({items:results});
});
admin.post("/key-products/:id/plans", async (c) => {
  const b=await readBody<any>(c); const productId=Number(c.req.param("id"));
  if(!b || typeof b.duration!=="string" || !Number.isFinite(Number(b.price_inr)) || Number(b.price_inr)<0) return err(c,400,"INVALID_PLAN");
  const item=await c.env.DB.prepare(`INSERT INTO key_plans(product_id,duration,duration_days,price_inr,reseller_price_inr,api_duration,enabled,sort)
    VALUES(?1,?2,?3,?4,?5,?6,1,?7) RETURNING *`).bind(productId,b.duration, b.duration_days ?? null, Number(b.price_inr),b.reseller_price_inr ?? null,b.api_duration ?? b.duration,Number(b.sort)||0).first();
  return c.json({item},201);
});
admin.put("/key-plans/:id", async (c) => {
  const id=Number(c.req.param("id")); const b=await readBody<any>(c); if(!b) return err(c,400,"INVALID_BODY");
  const keys=["duration","duration_days","price_inr","reseller_price_inr","api_duration","enabled","sort"].filter(k=>b[k]!==undefined);
  if(keys.length) await c.env.DB.prepare(`UPDATE key_plans SET ${keys.map((k,i)=>`${k}=?${i+2}`).join(",")} WHERE id=?1`).bind(id,...keys.map(k=>k==="enabled"?(b[k]?1:0):b[k])).run();
  return c.json({ok:true});
});
admin.delete("/key-plans/:id", async (c)=>{
  const id=Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return err(c,400,"INVALID_ID");
  const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM key_stock WHERE plan_id=?1").bind(id).first<{n:number}>();
  if (Number(used?.n??0)>0) return err(c,409,"PLAN_HAS_STOCK",{message:"Remove all keys for this plan before deleting it. Used keys are retained."});
  const r=await c.env.DB.prepare("DELETE FROM key_plans WHERE id=?1").bind(id).run();
  if (!r.meta.changes) return err(c,404,"PLAN_NOT_FOUND");
  return c.json({ok:true,deleted:true});
});
admin.post("/key-products/:id/stock", async (c)=>{
  const b=await readBody<{plan_id:number;keys:string|string[];import_batch?:string}>(c); const productId=Number(c.req.param("id"));
  if(!b || !Number.isSafeInteger(Number(b.plan_id))) return err(c,400,"INVALID_BODY");
  const keys=(Array.isArray(b.keys)?b.keys.join("\n"):String(b.keys??"")).split(/\r?\n/).map(x=>x.trim()).filter(x=>x && x.length<=1000).slice(0,5000);
  if(!keys.length) return err(c,400,"NO_KEYS");
  const now=Math.floor(Date.now()/1000); let added=0;
  for(let i=0;i<keys.length;i+=50){ const batch=keys.slice(i,i+50).map(k=>c.env.DB.prepare(`INSERT OR IGNORE INTO key_stock(product_id,plan_id,key_value,import_batch,added_at,added_by) VALUES(?1,?2,?3,?4,?5,?6)`).bind(productId,b.plan_id,k,b.import_batch??`admin-${now}`,now,c.get("user").id)); const rs=await c.env.DB.batch(batch); added+=rs.reduce((n,r)=>n+(r.meta.changes??0),0); }
  return c.json({ok:true,added,duplicates:keys.length-added});
});
admin.get("/key-products/:id/stock", async (c)=>{const id=Number(c.req.param("id"));const planId=Number(c.req.query("plan_id"))||null;const {results}=await c.env.DB.prepare(`SELECT id,plan_id,key_value,used,used_by,used_at,added_at FROM key_stock WHERE product_id=?1 AND (?2 IS NULL OR plan_id=?2) ORDER BY id DESC LIMIT 200`).bind(id,planId).all();return c.json({items:results});});
admin.delete("/key-stock/:id", async (c)=>{await c.env.DB.prepare("DELETE FROM key_stock WHERE id=?1 AND used=0").bind(Number(c.req.param("id"))).run();return c.json({ok:true});});
admin.get("/stock-summary", async (c)=>{const {results}=await c.env.DB.prepare(`SELECT p.id product_id,p.name product_name,pl.id plan_id,pl.duration,COUNT(ks.id) stock FROM key_products p JOIN key_plans pl ON pl.product_id=p.id LEFT JOIN key_stock ks ON ks.product_id=p.id AND ks.plan_id=pl.id AND ks.used=0 GROUP BY p.id,pl.id ORDER BY p.sort,pl.sort`).all();return c.json({items:results});});
admin.get("/manual-payments/:id/proof",async(c)=>{
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_ID");
 const p=await c.env.DB.prepare("SELECT proof_file_id FROM manual_payments WHERE id=?1").bind(id).first<{proof_file_id:string|null}>();
 if(!p?.proof_file_id)return err(c,404,"PROOF_NOT_FOUND");
 const file=await tg<any>(c.env.BOT_TOKEN,"getFile",{file_id:p.proof_file_id});
 if(!file?.file_path)return err(c,502,"PROOF_FILE_UNAVAILABLE");
 const response=await fetch("https://api.telegram.org/file/bot"+c.env.BOT_TOKEN+"/"+file.file_path);
 if(!response.ok)return err(c,502,"PROOF_FILE_DOWNLOAD_FAILED");
 const bytes=new Uint8Array(await response.arrayBuffer());let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
 const mime=response.headers.get("content-type")||"image/jpeg";
 return c.json({dataUrl:"data:"+mime+";base64,"+btoa(binary)});
});
admin.get("/manual-payments", async (c)=>{const {results}=await c.env.DB.prepare(`SELECT mp.*,u.first_name,u.username FROM manual_payments mp LEFT JOIN users u ON u.id=mp.user_id ORDER BY CASE mp.status WHEN 'pending' THEN 0 ELSE 1 END,mp.id DESC LIMIT 300`).all();return c.json({items:results});});
admin.post("/manual-payments/:id/approve", async (c)=>{
 const id=Number(c.req.param("id")); const now=Math.floor(Date.now()/1000); const b=await readBody<{amount_inr?:number}>(c);
 const p=await c.env.DB.prepare("SELECT mp.*,u.lang FROM manual_payments mp LEFT JOIN users u ON u.id=mp.user_id WHERE mp.id=?1 AND mp.status='pending'").bind(id).first<any>(); if(!p)return err(c,404,"PAYMENT_NOT_PENDING"); if(!p.proof_file_id)return err(c,409,"PAYMENT_PROOF_REQUIRED");
 const amount=Number(b?.amount_inr); if(!Number.isFinite(amount)||amount<=0||amount>1000000||Math.round(amount*100)!==amount*100)return err(c,400,"VALID_CREDIT_AMOUNT_REQUIRED");
 const [mark]=await c.env.DB.batch([c.env.DB.prepare("UPDATE manual_payments SET amount_inr=?2,status='approved',reviewed_at=?3,reviewed_by=?4 WHERE id=?1 AND status='pending'").bind(id,amount,now,c.get("user").id),c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(p.user_id,amount),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT ?1,?2,'topup',?3,?4,?5 WHERE changes()=1").bind(p.user_id,amount,id,p.method_name,now)]);if(!mark.meta.changes)return err(c,409,"PAYMENT_ALREADY_REVIEWED");
 const u=await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(p.user_id).first<{balance_inr:number}>();await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:p.user_id,text:botText(pickLang(p.lang),"fundAdded",{amount:amount.toFixed(2),balance:Number(u?.balance_inr??0).toFixed(2)}),parse_mode:"HTML"}); return c.json({ok:true,credited:amount});
});
admin.post("/manual-payments/:id/reject", async (c)=>{const id=Number(c.req.param("id"));const b=await readBody<{reason?:string}>(c);const p=await c.env.DB.prepare("SELECT * FROM manual_payments WHERE id=?1 AND status='pending'").bind(id).first<any>();if(!p)return err(c,404,"PAYMENT_NOT_PENDING");await c.env.DB.prepare("UPDATE manual_payments SET status='rejected',reject_reason=?2,reviewed_at=?3,reviewed_by=?4 WHERE id=?1").bind(id,(b?.reason??"Payment could not be verified").slice(0,300),Math.floor(Date.now()/1000),c.get("user").id).run();await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:p.user_id,text:`❌ Your ₹${Number(p.amount_inr).toFixed(2)} payment was rejected. ${b?.reason??"Please contact support."}`});return c.json({ok:true});});
admin.get("/bonus-settings",(c)=>{const s=c.get("settings");return c.json({enabled:!!s.bonus_enabled,mode:s.bonus_mode,fixed:s.bonus_fixed_inr,min:s.bonus_min_inr,max:s.bonus_max_inr,cooldownHours:s.bonus_cooldown_hours});});
admin.put("/bonus-settings",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");if(b.bonus_mode!==undefined&&!['fixed','random'].includes(b.bonus_mode))return err(c,400,"INVALID_BONUS_MODE");for(const k of ['bonus_fixed_inr','bonus_min_inr','bonus_max_inr'])if(b[k]!==undefined&&(!Number.isFinite(Number(b[k]))||Number(b[k])<0||Number(b[k])>10000))return err(c,400,"INVALID_BONUS_AMOUNT");if(b.bonus_min_inr!==undefined&&b.bonus_max_inr!==undefined&&Number(b.bonus_min_inr)>Number(b.bonus_max_inr))return err(c,400,"INVALID_BONUS_RANGE");if(b.bonus_cooldown_hours!==undefined&&(!Number.isInteger(Number(b.bonus_cooldown_hours))||Number(b.bonus_cooldown_hours)<1||Number(b.bonus_cooldown_hours)>8760))return err(c,400,"INVALID_BONUS_COOLDOWN");const v:any={};for(const k of ["bonus_enabled","bonus_mode","bonus_fixed_inr","bonus_min_inr","bonus_max_inr","bonus_cooldown_hours"])if(b[k]!==undefined)v[k]=b[k];await setSettings(c.env,v);return c.json({ok:true});});
admin.get("/api-balance",async(c)=>{try{const {checkBalance}=await import("../bantibhaiya");return c.json(await checkBalance(c.env));}catch(e){return err(c,502,"KEY_API_ERROR",{message:String((e as Error).message).slice(0,180)});}});

admin.post("/payments/:id/approve",async(c)=>{const id=Number(c.req.param("id"));const p=await c.env.DB.prepare("SELECT id FROM manual_payments WHERE id=?1").bind(id).first();if(!p)return err(c,404,"NOT_FOUND");return c.redirect(`/api/admin/manual-payments/${id}/approve`,307);});
admin.post("/payments/:id/reject",async(c)=>{const id=Number(c.req.param("id"));const p=await c.env.DB.prepare("SELECT id FROM manual_payments WHERE id=?1").bind(id).first();if(!p)return err(c,404,"NOT_FOUND");return c.redirect(`/api/admin/manual-payments/${id}/reject`,307);});

admin.get("/coupons",async(c)=>{const {results}=await c.env.DB.prepare("SELECT * FROM coupons ORDER BY id DESC LIMIT 500").all();return c.json({items:results});});
admin.post("/coupons",async(c)=>{const b=await readBody<any>(c);if(!b||typeof b.code!=="string"||!b.code.trim()||!Number.isFinite(Number(b.value))||Number(b.value)<=0)return err(c,400,"INVALID_COUPON");const types=["wallet_inr","free_key","panel_discount","global_discount","next_x_orders"];if(!types.includes(b.type))return err(c,400,"INVALID_COUPON_TYPE");if(b.type==="free_key"&&(!b.target_product_id||!b.target_plan_id))return err(c,400,"FREE_KEY_TARGET_REQUIRED");if(b.type==="panel_discount"&&(!b.target_product_id||Number(b.panel_valid_days)<1))return err(c,400,"PANEL_DISCOUNT_SCOPE_REQUIRED");if(b.type==="next_x_orders"&&Number(b.next_orders_count)<1)return err(c,400,"NEXT_ORDERS_COUNT_REQUIRED");const r=await c.env.DB.prepare(`INSERT INTO coupons(code,type,discount_mode,value,target_product_id,target_plan_id,panel_valid_days,next_orders_count,max_uses,per_user_limit,expires_at,enabled,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12) RETURNING *`).bind(b.code.trim().toUpperCase().slice(0,40),b.type,(b.type==="wallet_inr"||b.type==="free_key"?"flat_inr":(b.discount_mode??"percent")),Number(b.value),b.target_product_id??null,b.target_plan_id??null,b.panel_valid_days??null,b.next_orders_count??null,Number(b.max_uses)||0,Math.max(1,Number(b.per_user_limit)||1),b.expires_at??null,Math.floor(Date.now()/1000)).first();return c.json({item:r},201);});
admin.put("/coupons/:id",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");const keys=["value","enabled","max_uses","per_user_limit","expires_at"].filter(k=>b[k]!==undefined);if(keys.length)await c.env.DB.prepare(`UPDATE coupons SET ${keys.map((k,i)=>`${k}=?${i+2}`).join(",")} WHERE id=?1`).bind(Number(c.req.param("id")),...keys.map(k=>k==="enabled"?(b[k]?1:0):b[k])).run();return c.json({ok:true});});
admin.delete("/coupons/:id",async(c)=>{await c.env.DB.prepare("UPDATE coupons SET enabled=0 WHERE id=?1").bind(Number(c.req.param("id"))).run();return c.json({ok:true});});

admin.post("/users/:id/notify",async(c)=>{const id=intParam(c.req.param("id"));const b=await readBody<{kind?:string;amount?:number;order_id?:number;message?:string}>(c);if(!id||!b)return err(c,400,"INVALID_BODY");const u=await c.env.DB.prepare("SELECT balance_inr,first_name FROM users WHERE id=?1").bind(id).first<any>();if(!u)return err(c,404,"NOT_FOUND");let message=b.message?.slice(0,3500);if(!message&&b.kind==="balance")message=`💰 Your current wallet balance is ₹${Number(u.balance_inr||0).toFixed(2)}.`;if(!message&&b.kind==="key"&&b.order_id){const o=await c.env.DB.prepare("SELECT product_name,plan_duration,delivered_key FROM orders WHERE id=?1 AND user_id=?2").bind(b.order_id,id).first<any>();if(!o)return err(c,404,"KEY_NOT_FOUND");message=`🔑 Key delivered: ${o.product_name} · ${o.plan_duration}\nKey: ${o.delivered_key}`;}if(!message)return err(c,400,"INVALID_NOTIFICATION");const sent=await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:id,text:message});return c.json({ok:true,message_id:sent.message_id});});

const KEY_PAYMENT_DEFAULTS = [
 {id:"stars",name:"Telegram Stars (wallet top-up only)",icon:"⭐",details:"Pay with Telegram Stars to add INR wallet balance",enabled:true,type:"stars"},
 {id:"upi_auto",name:"UPI Automatic Payment",icon:"📱",details:"Generate QR and verify payment automatically",enabled:false},{id:"upi",name:"UPI QR / UPI ID",icon:"📱",details:"",enabled:true},
 {id:"phonepe",name:"PhonePe",icon:"💜",details:"",enabled:true},{id:"gpay",name:"Google Pay (GPay)",icon:"🟢",details:"",enabled:true},
 {id:"bhim",name:"BHIM UPI",icon:"🇮🇳",details:"",enabled:true},{id:"bank",name:"Bank Transfer (IMPS / NEFT)",icon:"🏦",details:"",enabled:true},
 {id:"binance",name:"Binance Pay",icon:"🟡",details:"",enabled:true},{id:"usdt_trc20",name:"USDT TRC20",icon:"₮",details:"",enabled:true},
 {id:"usdt_bep20",name:"USDT BEP20",icon:"₮",details:"",enabled:true},{id:"paypal",name:"PayPal",icon:"🌐",details:"",enabled:true},
 {id:"skrill",name:"Skrill",icon:"💠",details:"",enabled:true},{id:"redotpay",name:"RedotPay",icon:"💳",details:"",enabled:true},
];
admin.get("/upi-gateway-settings",(c)=>{const s=c.get("settings");return c.json({configured:!!s.upi_gateway_api_key,enabled:!!s.upi_gateway_enabled,upi_id:s.upi_id||""});});
admin.put("/upi-gateway-settings",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");const current=c.get("settings");const nextKey=b.apiKey!==undefined?String(b.apiKey).trim():current.upi_gateway_api_key;if(b.apiKey!==undefined&&nextKey.length>300)return err(c,400,"INVALID_API_KEY");if(b.upiId!==undefined&&String(b.upiId).length>150)return err(c,400,"INVALID_UPI_ID");if(b.enabled===true&&!nextKey)return err(c,400,"UPI_GATEWAY_KEY_REQUIRED");await setSettings(c.env,{...(b.apiKey!==undefined&&nextKey?{upi_gateway_api_key:nextKey}:{}),...(b.enabled!==undefined?{upi_gateway_enabled:b.enabled?1:0}:{}),...(b.upiId!==undefined?{upi_id:String(b.upiId).trim()}:{})});return c.json({ok:true,configured:!!nextKey,enabled:b.enabled===undefined?!!current.upi_gateway_enabled:!!b.enabled});});
admin.get("/key-payment-methods",(c)=>{let items:any[]=[];try{items=JSON.parse(c.get("settings").payment_methods||"[]");}catch{}if(!items.length)items=KEY_PAYMENT_DEFAULTS; items=items.filter((m:any)=>m.id!=="paytm_auto");if(!items.some((m:any)=>m.id==="upi_auto"))items.unshift({id:"upi_auto",name:"UPI Automatic Payment",icon:"📱",details:"Generate QR and verify payment",enabled:false});return c.json({items,upi_id:c.get("settings").upi_id,upi_qr_url:c.get("settings").upi_qr_url});});
admin.put("/key-payment-methods",async(c)=>{const b=await readBody<{items:any[];upi_id?:string;upi_qr_url?:string}>(c);if(!b||!Array.isArray(b.items)||b.items.length>30)return err(c,400,"INVALID_BODY");const clean=b.items.map(x=>({id:String(x.id).slice(0,40),name:String(x.name).slice(0,100),icon:String(x.icon??"💳").slice(0,12),details:String(x.details??"").slice(0,1000),enabled:!!x.enabled,qrUrl:String(x.qrUrl??"").slice(0,500)}));await setSettings(c.env,{payment_methods:JSON.stringify(clean),...(b.upi_id!==undefined?{upi_id:b.upi_id.slice(0,150)}:{}),...(b.upi_qr_url!==undefined?{upi_qr_url:b.upi_qr_url.slice(0,500)}:{})});return c.json({ok:true});});

admin.post("/upload-file",async(c)=>{const b=await readBody<{product_id:number;file_id:string;file_name?:string;file_url?:string}>(c);if(!b||!Number.isSafeInteger(b.product_id)||!b.file_id)return err(c,400,"INVALID_FILE");await c.env.DB.prepare("UPDATE key_products SET setup_file_id=?2,setup_file_name=?3,setup_file_url=?4 WHERE id=?1").bind(b.product_id,b.file_id,b.file_name??"Setup file",b.file_url??null).run();return c.json({ok:true});});
admin.get("/key-categories",async(c)=>{const {results}=await c.env.DB.prepare("SELECT * FROM key_categories ORDER BY sort,id").all();return c.json({items:results});});
admin.post("/key-categories",async(c)=>{const b=await readBody<any>(c);if(!b?.name||!b?.slug)return err(c,400,"INVALID_CATEGORY");const r=await c.env.DB.prepare("INSERT INTO key_categories(slug,name,icon,image_url,enabled,sort,created_at) VALUES(?1,?2,?3,?4,1,?5,?6) RETURNING *").bind(String(b.slug).toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,50),String(b.name).slice(0,100),String(b.icon??"🔑").slice(0,12),b.image_url??null,Number(b.sort)||0,Math.floor(Date.now()/1000)).first();return c.json({item:r},201);});
admin.put("/key-categories/:id",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");const keys=["name","icon","image_url","enabled","sort"].filter(k=>b[k]!==undefined);if(keys.length)await c.env.DB.prepare(`UPDATE key_categories SET ${keys.map((k,i)=>`${k}=?${i+2}`).join(",")} WHERE id=?1`).bind(Number(c.req.param("id")),...keys.map(k=>k==="enabled"?(b[k]?1:0):b[k])).run();return c.json({ok:true});});
admin.delete("/key-categories/:id",async(c)=>{
 const id=Number(c.req.param("id")); if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_ID");
 const item=await c.env.DB.prepare("SELECT slug FROM key_categories WHERE id=?1").bind(id).first<{slug:string}>();
 if(!item)return err(c,404,"CATEGORY_NOT_FOUND");
 const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM key_products WHERE category=?1").bind(item.slug).first<{n:number}>();
 if(Number(used?.n??0)>0)return err(c,409,"CATEGORY_IN_USE",{message:"Move or delete its products before deleting this category."});
 await c.env.DB.prepare("DELETE FROM key_categories WHERE id=?1").bind(id).run();return c.json({ok:true,deleted:true});
});
admin.get("/key-platforms",async(c)=>{const {results}=await c.env.DB.prepare("SELECT id,slug,name,logo_url,enabled,sort,setup_video_url,CASE WHEN (setup_video_file_id IS NOT NULL AND setup_video_file_id!='') OR (setup_video_url IS NOT NULL AND setup_video_url!='') THEN 1 ELSE 0 END AS has_setup_video FROM key_platforms ORDER BY sort,id").all<any>();const username=String(c.get("settings").bot_username||"").replace(/^@/,"");return c.json({items:results.map((p:any)=>({...p,video_code:"video"+p.id,video_link:username?"https://t.me/"+username+"?start=video"+p.id:""}))});});
admin.post("/key-platforms",async(c)=>{const b=await readBody<any>(c);if(!b?.name||!b?.slug)return err(c,400,"INVALID_PLATFORM");const slug=String(b.slug).toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,50);if(!slug)return err(c,400,"INVALID_PLATFORM");const video=String(b.setup_video_url??"").trim();if(video&&!/^https?:\/\//i.test(video))return err(c,400,"INVALID_VIDEO_URL");const r=await c.env.DB.prepare("INSERT INTO key_platforms(slug,name,logo_url,setup_video_url,enabled,sort,created_at) VALUES(?1,?2,?3,?4,1,?5,?6) RETURNING *").bind(slug,String(b.name).slice(0,100),b.logo_url??null,video||null,Number(b.sort)||0,Math.floor(Date.now()/1000)).first();return c.json({item:r},201);});
admin.put("/key-platforms/:id",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");if(b.setup_video_url!==undefined&&String(b.setup_video_url).trim()&&!/^https?:\/\//i.test(String(b.setup_video_url).trim()))return err(c,400,"INVALID_VIDEO_URL");const keys=["name","logo_url","enabled","sort","setup_video_url"].filter(k=>b[k]!==undefined);if(keys.length)await c.env.DB.prepare(`UPDATE key_platforms SET ${keys.map((k,i)=>`${k}=?${i+2}`).join(",")} WHERE id=?1`).bind(Number(c.req.param("id")),...keys.map(k=>k==="enabled"?(b[k]?1:0):k==="setup_video_url"?(String(b[k]??"").trim()||null):b[k])).run();return c.json({ok:true});});
admin.delete("/key-platforms/:id",async(c)=>{
 const id=Number(c.req.param("id")); if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_ID");
 const item=await c.env.DB.prepare("SELECT slug FROM key_platforms WHERE id=?1").bind(id).first<{slug:string}>();
 if(!item)return err(c,404,"PLATFORM_NOT_FOUND");
 const used=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM key_products WHERE platform=?1").bind(item.slug).first<{n:number}>();
 if(Number(used?.n??0)>0)return err(c,409,"PLATFORM_IN_USE",{message:"Move or delete its products before deleting this platform."});
 await c.env.DB.prepare("DELETE FROM key_platforms WHERE id=?1").bind(id).run();return c.json({ok:true,deleted:true});
});

admin.get("/key-apis",async(c)=>{const {results}=await c.env.DB.prepare("SELECT id,name,url,mode,android_required,enabled,updated_at,CASE WHEN api_key!='' THEN 1 ELSE 0 END AS configured FROM key_apis ORDER BY created_at DESC").all();return c.json({items:results,active:c.get("settings").active_key_api_id});});
admin.post("/key-apis",async(c)=>{const b=await readBody<any>(c);if(!b?.id||!b?.name||!b?.url||!b?.api_key||!/^https:\/\//.test(b.url))return err(c,400,"INVALID_API");const now=Math.floor(Date.now()/1000);await c.env.DB.prepare("INSERT INTO key_apis(id,name,url,api_key,master_key,mode,android_required,enabled,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?8)").bind(String(b.id).slice(0,60),String(b.name).slice(0,100),String(b.url).slice(0,300),String(b.api_key).slice(0,500),b.master_key??null,b.mode??"reseller_v1",b.android_required?1:0,now).run();if(!c.get("settings").active_key_api_id)await setSettings(c.env,{active_key_api_id:String(b.id)});return c.json({ok:true});});
admin.put("/key-apis/:id",async(c)=>{const b=await readBody<any>(c);if(!b)return err(c,400,"INVALID_BODY");if(b.url!==undefined&&!/^https:\/\//.test(b.url))return err(c,400,"INVALID_URL");const keys=["name","url","api_key","master_key","mode","android_required","enabled"].filter(k=>b[k]!==undefined);if(keys.length)await c.env.DB.prepare(`UPDATE key_apis SET ${keys.map((k,i)=>`${k}=?${i+2}`).join(",")},updated_at=?${keys.length+2} WHERE id=?1`).bind(c.req.param("id"),...keys.map(k=>k==="enabled"||k==="android_required"?(b[k]?1:0):b[k]),Math.floor(Date.now()/1000)).run();if(b.enabled===false&&c.get("settings").active_key_api_id===c.req.param("id"))await setSettings(c.env,{active_key_api_id:""});return c.json({ok:true});});
admin.post("/key-apis/:id/activate",async(c)=>{const id=c.req.param("id");const api=await c.env.DB.prepare("SELECT id FROM key_apis WHERE id=?1 AND enabled=1").bind(id).first();if(!api)return err(c,404,"API_NOT_FOUND");await setSettings(c.env,{active_key_api_id:id});return c.json({ok:true,active:id});});
admin.delete("/key-apis/:id",async(c)=>{const id=c.req.param("id");await c.env.DB.prepare("UPDATE key_products SET api_id=NULL WHERE api_id=?1").bind(id).run();await c.env.DB.prepare("DELETE FROM key_apis WHERE id=?1").bind(id).run();if(c.get("settings").active_key_api_id===id)await setSettings(c.env,{active_key_api_id:""});return c.json({ok:true});});

admin.get("/key-orders",async(c)=>{const {results}=await c.env.DB.prepare(`SELECT o.id,o.user_id,o.product_name,o.plan_duration,o.price_inr,o.discount_inr,o.coupon_code,o.key_source,o.status,o.created_at,o.expires_at,u.first_name,u.username FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.delivered_key IS NOT NULL ORDER BY o.id DESC LIMIT 300`).all();return c.json({items:results});});
admin.post("/key-orders/:id/refund",async(c)=>{const id=Number(c.req.param("id"));const o=await c.env.DB.prepare("SELECT id,user_id,product_name,price_inr,status FROM orders WHERE id=?1 AND delivered_key IS NOT NULL").bind(id).first<any>();if(!o)return err(c,404,"KEY_ORDER_NOT_FOUND");if(o.status==="refunded")return err(c,409,"ALREADY_REFUNDED");if(o.status!=="completed")return err(c,409,"ORDER_NOT_REFUNDABLE");const now=Math.floor(Date.now()/1000);const [mark]=await c.env.DB.batch([c.env.DB.prepare("UPDATE orders SET status='refunded',updated_at=?2 WHERE id=?1 AND status='completed'").bind(id,now),c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(o.user_id,o.price_inr),c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT ?1,?2,'refund',?3,?4,?5 WHERE changes()=1").bind(o.user_id,o.price_inr,id,o.product_name,now)]);if(!mark.meta.changes)return err(c,409,"TRY_AGAIN");await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:o.user_id,text:`💸 Your key order #${id} was refunded. ₹${Number(o.price_inr).toFixed(2)} was returned to your wallet.`});return c.json({ok:true,refunded:o.price_inr});});
admin.get("/key-apis/:id/balance",async(c)=>{try{const {checkBalance}=await import("../bantibhaiya");return c.json(await checkBalance(c.env,c.req.param("id")));}catch(e){return err(c,502,"KEY_API_ERROR",{message:String((e as Error).message).slice(0,180)});}});

admin.get("/key-overview",async(c)=>{const now=Math.floor(Date.now()/1000);const day=now-(now%86400);const week=day-6*86400;const [today,weekStats,stock,payments,wallet]=await c.env.DB.batch([
 c.env.DB.prepare(`SELECT COUNT(*) AS orders,COALESCE(SUM(price_inr),0) AS revenue,COALESCE(SUM(api_cost_inr),0) AS api_cost,COALESCE(SUM(discount_inr),0) AS discounts FROM orders WHERE delivered_key IS NOT NULL AND status='completed' AND created_at>=?1`).bind(day),
 c.env.DB.prepare(`SELECT COUNT(*) AS orders,COALESCE(SUM(price_inr),0) AS revenue,COALESCE(SUM(api_cost_inr),0) AS api_cost FROM orders WHERE delivered_key IS NOT NULL AND status='completed' AND created_at>=?1`).bind(week),
 c.env.DB.prepare("SELECT COUNT(*) AS available FROM key_stock WHERE used=0"),
 c.env.DB.prepare("SELECT COUNT(*) AS pending,COALESCE(SUM(amount_inr),0) AS amount FROM manual_payments WHERE status='pending'"),
 c.env.DB.prepare("SELECT COALESCE(SUM(balance_inr),0) AS liability FROM users"),
]);const t:any=today.results[0]||{},w:any=weekStats.results[0]||{};return c.json({today:{orders:Number(t.orders||0),revenue:Number(t.revenue||0),apiCost:Number(t.api_cost||0),profit:Number(t.revenue||0)-Number(t.api_cost||0),discounts:Number(t.discounts||0)},week:{orders:Number(w.orders||0),revenue:Number(w.revenue||0),apiCost:Number(w.api_cost||0),profit:Number(w.revenue||0)-Number(w.api_cost||0)},availableKeys:Number((stock.results[0] as any)?.available||0),pendingPayments:Number((payments.results[0] as any)?.pending||0),pendingPaymentAmount:Number((payments.results[0] as any)?.amount||0),walletLiability:Number((wallet.results[0] as any)?.liability||0)});});


// ---- Announcements ----
admin.get("/announcements", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM announcements ORDER BY id DESC LIMIT 50").all();
  return c.json({ items: results });
});
admin.post("/announcements", async (c) => {
  const b = await readBody<any>(c);
  if (!b || !String(b.title ?? "").trim()) return err(c, 400, "TITLE_REQUIRED");
  const title = String(b.title).trim().slice(0, 160);
  const description = String(b.description ?? "").trim().slice(0, 3000);
  const imageUrl = String(b.image_url ?? "").trim();
  const buttonText = String(b.button_text ?? "Continue").trim().slice(0, 64) || "Continue";
  const buttonEnabled = !!b.button_enabled;
  const buttonUrl = String(b.button_url ?? "").trim();
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return err(c, 400, "INVALID_IMAGE_URL");
  if (buttonEnabled && (!buttonUrl || !/^https?:\/\//i.test(buttonUrl))) return err(c, 400, "BUTTON_LINK_REQUIRED");
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare("INSERT INTO announcements(title,description,image_url,button_text,button_enabled,button_url,active,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) RETURNING *")
    .bind(title, description, imageUrl || null, buttonText, buttonEnabled ? 1 : 0, buttonEnabled ? buttonUrl : null, b.active === false ? 0 : 1, now).first<any>();
  let broadcast: { total: number } | null = null;
  if (b.broadcast) {
    try { broadcast = await startAnnouncementBroadcast(c.env, c.get("user").id, { title, description, imageUrl: imageUrl || null, buttonText, buttonEnabled, buttonUrl: buttonEnabled ? buttonUrl : null }); }
    catch (e) { if ((e as Error).message === "BROADCAST_RUNNING") return err(c, 409, "BROADCAST_RUNNING", { announcementId: row.id }); if ((e as Error).message === "NO_AUDIENCE") return err(c, 409, "NO_AUDIENCE", { announcementId: row.id }); throw e; }
  }
  return c.json({ item: row, broadcast }, 201);
});
admin.put("/announcements/:id", async (c) => {
  const b = await readBody<any>(c);
  if (!b || !String(b.title ?? "").trim()) return err(c, 400, "TITLE_REQUIRED");
  const imageUrl = String(b.image_url ?? "").trim();
  const buttonEnabled = !!b.button_enabled;
  const buttonUrl = String(b.button_url ?? "").trim();
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return err(c, 400, "INVALID_IMAGE_URL");
  if (buttonEnabled && (!buttonUrl || !/^https?:\/\//i.test(buttonUrl))) return err(c, 400, "BUTTON_LINK_REQUIRED");
  const result = await c.env.DB.prepare("UPDATE announcements SET title=?2,description=?3,image_url=?4,button_text=?5,button_enabled=?6,button_url=?7,active=?8,updated_at=?9 WHERE id=?1")
    .bind(Number(c.req.param("id")), String(b.title).trim().slice(0,160), String(b.description??"").trim().slice(0,3000), imageUrl || null, String(b.button_text??"Continue").trim().slice(0,64)||"Continue", buttonEnabled?1:0, buttonEnabled?buttonUrl:null, b.active===false?0:1, Math.floor(Date.now()/1000)).run();
  if (!result.meta.changes) return err(c, 404, "ANNOUNCEMENT_NOT_FOUND");
  return c.json({ ok: true });
});
admin.delete("/announcements/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM announcements WHERE id=?1").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
admin.post("/announcements/:id/broadcast", async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM announcements WHERE id=?1").bind(Number(c.req.param("id"))).first<any>();
  if (!a) return err(c, 404, "ANNOUNCEMENT_NOT_FOUND");
  try {
    const result = await startAnnouncementBroadcast(c.env, c.get("user").id, { title:a.title, description:a.description, imageUrl:a.image_url, buttonText:a.button_text, buttonEnabled:!!a.button_enabled, buttonUrl:a.button_url });
    return c.json({ ok:true, ...result });
  } catch (e) {
    if ((e as Error).message === "BROADCAST_RUNNING") return err(c,409,"BROADCAST_RUNNING");
    if ((e as Error).message === "NO_AUDIENCE") return err(c,409,"NO_AUDIENCE");
    throw e;
  }
});


// ---- Database backup & restore ----
// Full exports include private settings and provider/payment API credentials. Keep backup files private.
type BackupScope = "full" | "key-catalog" | "users";
const BACKUP_FORMAT = "hero-bot-backup";
async function backupTables(db: AppEnv["Bindings"]["DB"]): Promise<string[]> {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='d1_migrations' ORDER BY name").all<{name:string}>();
  return r.results.map(x => x.name);
}
function quoteTable(name: string): string { return '"' + name.replace(/"/g, '""') + '"'; }
async function backupOrder(db: AppEnv["Bindings"]["DB"], names: string[]): Promise<string[]> {
  const allowed = new Set(names);
  const parents = new Map<string, Set<string>>();
  for (const name of names) {
    const r = await db.prepare("PRAGMA foreign_key_list(" + quoteTable(name) + ")").all<{table:string}>();
    parents.set(name, new Set(r.results.map(x => x.table).filter(x => allowed.has(x))));
  }
  const ordered: string[] = [];
  const remaining = new Set(names);
  while (remaining.size) {
    const ready = [...remaining].filter(n => [...(parents.get(n) ?? [])].every(p => !remaining.has(p)));
    if (!ready.length) { ordered.push(...remaining); break; }
    for (const n of ready) { ordered.push(n); remaining.delete(n); }
  }
  return ordered;
}
async function buildBackup(db: AppEnv["Bindings"]["DB"], scope: BackupScope) {
  const all = await backupTables(db);
  const names = scope === "users" ? ["users"] : scope === "key-catalog" ? ["key_categories","key_platforms"] : all;
  for (const name of names) if (!all.includes(name)) throw new Error("BACKUP_TABLE_MISSING:" + name);
  const tables: Record<string, unknown[]> = {};
  for (const name of names) {
    const r = await db.prepare("SELECT * FROM " + quoteTable(name)).all();
    tables[name] = r.results as unknown[];
  }
  return { format:BACKUP_FORMAT, version:1, scope, exportedAt:new Date().toISOString(), tables };
}
admin.get("/backup/export", async (c) => {
  const scope = (c.req.query("scope") || "full") as BackupScope;
  if (!["full","key-catalog","users"].includes(scope)) return err(c,400,"INVALID_BACKUP_SCOPE");
  try { return c.json(await buildBackup(c.env.DB,scope)); }
  catch(e) { return err(c,500,"BACKUP_EXPORT_FAILED",{message:String((e as Error).message).slice(0,180)}); }
});
admin.post("/backup/send", async (c) => {
  const b=await readBody<{scope?:BackupScope}>(c);
  const scope=(b?.scope||"full") as BackupScope;
  if (!["full","key-catalog","users"].includes(scope)) return err(c,400,"INVALID_BACKUP_SCOPE");
  const data=await buildBackup(c.env.DB,scope);
  const json=JSON.stringify(data,null,2);
  const filename="hero-bot-"+scope+"-backup-"+new Date().toISOString().slice(0,10)+".json";
  const admins=ownerIds(c.env,c.get("settings"));
  if(!admins.length) return err(c,409,"NO_ADMIN_CHAT_CONFIGURED");
  let sent=0;
  for(const adminId of admins){
    const form=new FormData();
    form.set("chat_id",String(adminId));
    form.set("caption", "🔐 "+scope.toUpperCase()+" DATABASE BACKUP\\nTables: "+Object.keys(data.tables).length+"\\nRecords: "+Object.values(data.tables).reduce((n,v)=>n+v.length,0)+"\\nCreated: "+data.exportedAt+"\\nPrivate admin backup — do not share.");
    form.set("document",new Blob([json],{type:"application/json"}),filename);
    const response=await fetch("https://api.telegram.org/bot"+c.env.BOT_TOKEN+"/sendDocument",{method:"POST",body:form});
    const result=await response.json() as any;
    if(result?.ok) sent++;
    else console.error("admin backup delivery failed",adminId,result?.description||response.status);
  }
  if(!sent) return err(c,502,"BACKUP_DELIVERY_FAILED");
  return c.json({ok:true,sent,admins:admins.length,scope,filename,tables:Object.keys(data.tables).length,records:Object.values(data.tables).reduce((n,v)=>n+v.length,0)});
});
admin.post("/backup/import", async (c) => {
  const b = await readBody<any>(c);
  if (!b || b.format !== BACKUP_FORMAT || b.version !== 1 || !["full","key-catalog","users"].includes(b.scope) || !b.tables || typeof b.tables !== "object" || Array.isArray(b.tables)) return err(c,400,"INVALID_BACKUP_FILE");
  const scope = b.scope as BackupScope;
  const all = await backupTables(c.env.DB);
  const allowedNames = scope === "users" ? ["users"] : scope === "key-catalog" ? ["key_categories","key_platforms"] : all;
  const inputNames = Object.keys(b.tables);
  if (inputNames.some(n => !allowedNames.includes(n)) || (scope !== "full" && allowedNames.some(n => !inputNames.includes(n)))) return err(c,400,"BACKUP_SCOPE_MISMATCH");
  // Never let an empty or incomplete "full" file erase a live database.
  if (scope === "full" && (inputNames.length !== all.length || all.some(n => !inputNames.includes(n)))) return err(c,400,"FULL_BACKUP_INCOMPLETE");
  const totalRows = inputNames.reduce((n,k)=>n+b.tables[k].length,0);
  const columns = new Map<string,string[]>();
  for (const name of inputNames) {
    if (!all.includes(name)) return err(c,400,"UNKNOWN_BACKUP_TABLE",{table:name});
    if (!Array.isArray(b.tables[name])) return err(c,400,"INVALID_BACKUP_TABLE",{table:name});
    const info = await c.env.DB.prepare("PRAGMA table_info(" + quoteTable(name) + ")").all<{name:string}>();
    columns.set(name,info.results.map(x=>x.name));
    for (const row of b.tables[name]) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(k=>!columns.get(name)!.includes(k)) || columns.get(name)!.some(k=>!Object.prototype.hasOwnProperty.call(row,k))) return err(c,400,"INVALID_BACKUP_ROW",{table:name});
    }
  }
  const replaceNames = scope === "full" ? all : scope === "key-catalog" ? ["key_categories","key_platforms"] : [];
  if (scope === "users" && inputNames[0] !== "users") return err(c,400,"INVALID_BACKUP_SCOPE");
  if (replaceNames.length) {
    const ordered = await backupOrder(c.env.DB,replaceNames);
    for (const name of [...ordered].reverse()) await c.env.DB.prepare("DELETE FROM " + quoteTable(name)).run();
    // Insert parent rows before dependent rows; preserve explicit IDs and all imported values.
    const statements: D1PreparedStatement[] = [];
    for (const name of ordered) {
      for (const row of b.tables[name] ?? []) {
        const keys = Object.keys(row);
        if (!keys.length) continue;
        const sql = "INSERT INTO " + quoteTable(name) + " (" + keys.map(quoteTable).join(",") + ") VALUES (" + keys.map((_,i)=>"?" + (i+1)).join(",") + ")";
        statements.push(c.env.DB.prepare(sql).bind(...keys.map(k=>row[k])));
      }
    }
    for (let i=0;i<statements.length;i+=100) await c.env.DB.batch(statements.slice(i,i+100));
  } else {
    // User-only imports merge by Telegram ID and do not delete accounts absent from the file.
    const name = "users";
    for (const row of b.tables.users as Record<string,unknown>[]) {
      if (!Number.isSafeInteger(Number(row.id))) return err(c,400,"INVALID_USER_ROW");
      const keys = Object.keys(row);
      if (!keys.includes("id")) return err(c,400,"INVALID_USER_ROW");
      const updates = keys.filter(k=>k!=="id");
      const sql = "INSERT INTO users ("+keys.map(quoteTable).join(",")+") VALUES ("+keys.map((_,i)=>"?"+(i+1)).join(",")+") ON CONFLICT(id) DO UPDATE SET "+(updates.length?updates.map(k=>quoteTable(k)+"=excluded."+quoteTable(k)).join(","):"id=excluded.id");
      await c.env.DB.prepare(sql).bind(...keys.map(k=>row[k])).run();
    }
  }
  return c.json({ok:true,scope,importedTables:inputNames.length,importedRows:totalRows});
});


/* Campaign administration. Campaign rewards are credited to the INR wallet only after verified completion. */
admin.get("/campaigns",async(c)=>{
 const {results}=await c.env.DB.prepare("SELECT * FROM campaigns ORDER BY id DESC LIMIT 100").all<any>();
 const submissions=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM campaign_submissions WHERE status='pending'").first<any>();
 return c.json({items:results.map((x:any)=>({...x,channels:JSON.parse(x.channels_json||"[]")})),pending:Number(submissions?.n||0)});
});
admin.post("/campaigns",async(c)=>{
 const b=await readBody<{title:string;description?:string;type:string;reward_inr:number;channels?:any[]}>(c);
 if(!b||!b.title?.trim()||!["channel","manual"].includes(b.type)||!Number.isFinite(Number(b.reward_inr))||Number(b.reward_inr)<0||Number(b.reward_inr)>100000)return err(c,400,"INVALID_CAMPAIGN");
 const channels=b.type==="channel"?(Array.isArray(b.channels)?b.channels:[]):[];
 if(b.type==="channel"&&(!channels.length||channels.length>20||channels.some(x=>!x?.chat_id||!/^https?:\/\//i.test(String(x.url)))))return err(c,400,"INVALID_CHANNELS");
 if(b.type==="channel"){
  try{const me=await tg<any>(c.env.BOT_TOKEN,"getMe",{});for(const ch of channels){const member=await tg<any>(c.env.BOT_TOKEN,"getChatMember",{chat_id:ch.chat_id,user_id:me.id});if(!["administrator","creator"].includes(member.status))return err(c,409,"BOT_NOT_ADMIN",{channel:ch.title||ch.chat_id});}}
  catch(e){return err(c,400,"CHANNEL_ACCESS_CHECK_FAILED",{reason:(e as Error).message.slice(0,180)});}
 }
 const now=Math.floor(Date.now()/1000);
 const ins=await c.env.DB.prepare("INSERT INTO campaigns(title,description,type,reward_inr,channels_json,active,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?6) RETURNING id").bind(b.title.trim().slice(0,160),String(b.description||"").slice(0,2000),b.type,Number(b.reward_inr),JSON.stringify(channels),now).first<any>();
 if(!ins)return err(c,500,"CAMPAIGN_CREATE_FAILED");
 await c.env.DB.prepare("INSERT OR IGNORE INTO campaign_notice_queue(campaign_id,user_id) SELECT ?1,id FROM users WHERE can_message=1 AND banned=0").bind(ins.id).run();
 return c.json({ok:true,id:ins.id});
});
admin.put("/campaigns/:id",async(c)=>{
 const id=Number(c.req.param("id")),b=await readBody<any>(c);
 if(!Number.isSafeInteger(id)||id<1||!b)return err(c,400,"INVALID_CAMPAIGN");
 const old=await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?1").bind(id).first<any>();
 if(!old)return err(c,404,"CAMPAIGN_NOT_FOUND");
 const title=String(b.title??old.title).trim(),description=String(b.description??old.description),type=b.type??old.type,reward=Number(b.reward_inr??old.reward_inr),channels=b.channels??JSON.parse(old.channels_json||"[]"),active=b.active===undefined?old.active:(b.active?1:0);
 if(!title||!["channel","manual"].includes(type)||!Number.isFinite(reward)||reward<0||reward>100000||!Array.isArray(channels)||channels.length>20)return err(c,400,"INVALID_CAMPAIGN");
 if(type==="channel"){
  if(!channels.length||channels.some((x:any)=>!x?.chat_id||!(String(x.url).startsWith("https://")||String(x.url).startsWith("http://"))))return err(c,400,"INVALID_CHANNELS");
  try{const me=await tg<any>(c.env.BOT_TOKEN,"getMe",{});for(const ch of channels){const member=await tg<any>(c.env.BOT_TOKEN,"getChatMember",{chat_id:ch.chat_id,user_id:me.id});if(!["administrator","creator"].includes(member.status))return err(c,409,"BOT_NOT_ADMIN",{channel:ch.title||ch.chat_id});}}
  catch(e){return err(c,400,"CHANNEL_ACCESS_CHECK_FAILED",{reason:(e as Error).message.slice(0,180)});}
 }
 await c.env.DB.prepare("UPDATE campaigns SET title=?2,description=?3,type=?4,reward_inr=?5,channels_json=?6,active=?7,updated_at=?8 WHERE id=?1").bind(id,title.slice(0,160),description.slice(0,2000),type,reward,JSON.stringify(channels),active,Math.floor(Date.now()/1000)).run();
 if(active&&!old.active)await c.env.DB.prepare("INSERT INTO campaign_notice_queue(campaign_id,user_id) SELECT ?1,id FROM users WHERE can_message=1 AND banned=0 ON CONFLICT(campaign_id,user_id) DO UPDATE SET status='pending',attempts=0").bind(id).run();
 return c.json({ok:true});
});
admin.delete("/campaigns/:id",async(c)=>{
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_CAMPAIGN");
 await c.env.DB.prepare("DELETE FROM campaigns WHERE id=?1").bind(id).run();return c.json({ok:true});
});
admin.get("/campaigns/:id/submissions",async(c)=>{
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1)return err(c,400,"INVALID_CAMPAIGN");
 const {results}=await c.env.DB.prepare("SELECT s.id,s.user_id,s.screenshot_data,s.screenshot_mime,s.status,s.created_at,u.first_name,u.username FROM campaign_submissions s LEFT JOIN users u ON u.id=s.user_id WHERE s.campaign_id=?1 ORDER BY s.id DESC LIMIT 10").bind(id).all<any>();
 return c.json({items:results.map((x:any)=>({...x,screenshot:"data:"+x.screenshot_mime+";base64,"+x.screenshot_data,screenshot_data:undefined}))});
});
admin.post("/campaign-submissions/:id/review",async(c)=>{
 const id=Number(c.req.param("id")),b=await readBody<{action:string}>(c);
 if(!Number.isSafeInteger(id)||id<1||!b||!["approve","reject"].includes(b.action))return err(c,400,"INVALID_REVIEW");
 const s=await c.env.DB.prepare("SELECT s.*,c.title,c.reward_inr,u.balance_inr,u.lang FROM campaign_submissions s JOIN campaigns c ON c.id=s.campaign_id JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.status='pending'").bind(id).first<any>();
 if(!s)return err(c,404,"SUBMISSION_NOT_PENDING");
 const now=Math.floor(Date.now()/1000),status=b.action==="approve"?"approved":"rejected";
 const [changed]=await c.env.DB.batch([
  c.env.DB.prepare("UPDATE campaign_submissions SET status=?2,reviewed_at=?3,reviewed_by=?4 WHERE id=?1 AND status='pending'").bind(id,status,now,c.get("user").id),
  ...(b.action==="approve"?[
   c.env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(s.user_id,s.reward_inr),
   c.env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT ?1,?2,'campaign',?3,?4,?5 WHERE changes()=1").bind(s.user_id,s.reward_inr,s.campaign_id,"Approved campaign: "+s.title,now),
   c.env.DB.prepare("INSERT OR IGNORE INTO campaign_completions(campaign_id,user_id,completed_at) SELECT campaign_id,user_id,?2 FROM campaign_submissions WHERE id=?1 AND status='approved'").bind(id,now)
  ]:[])
 ]);
 if(!changed.meta.changes)return err(c,409,"ALREADY_REVIEWED");
 const bal=await c.env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(s.user_id).first<any>();
 await tg(c.env.BOT_TOKEN,"sendMessage",{chat_id:s.user_id,text:b.action==="approve"?"🎉 Your campaign screenshot was approved!\n\nReward added: ₹"+Number(s.reward_inr).toFixed(2)+"\nNew wallet balance: ₹"+Number(bal?.balance_inr||0).toFixed(2):"Your campaign screenshot was not approved. Please review the task instructions and contact support if needed."}).catch(()=>{});
 return c.json({ok:true,status,balance:bal?.balance_inr??0});
});
