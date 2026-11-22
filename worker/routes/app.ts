import { Hono, type Context } from "hono";
import { type Me, pickLang, type Lang, LANGS } from "../../shared/types";
import { validateInitData, type TgUser } from "../auth";
import { type Env, isOwner } from "../env";
import { channelGateRequired, RetryLater, verifyChannel } from "../growth";
import { brandInfo } from "../brand";
import { getSettings, type Settings } from "../settings";


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
  created_at: number;
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
       photo_url = COALESCE(excluded.photo_url, users.photo_url), language_code = excluded.language_code, last_seen_at = excluded.last_seen_at
     WHERE users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name
       OR users.username IS NOT excluded.username OR (excluded.photo_url IS NOT NULL AND users.photo_url IS NOT excluded.photo_url)
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
  // Refresh signed Telegram identity on every authenticated request. The upsert's WHERE clause
  // avoids routine writes, while still syncing changed names, usernames, language and photo URLs.
  const user = await upsertUser(c.env, tgUser);
  if (user.banned) return err(c, 403, "BANNED");
  const settings = await getSettings(c.env);
  c.set("tgUser", tgUser);
  c.set("user", user);
  c.set("settings", settings);
  c.set("lang", pickLang(user.lang ?? user.language_code));
  c.set("startParam", startParam);
  await next();
});

// Legacy storefront APIs are retired. Keep the handlers below temporarily for migration
// compatibility, but do not expose catalog, wallet, key, order, coupon or campaign endpoints.
app.use("*", async (c, next) => {
  if (/^\/api\/(?:catalog|orders|wallet|keys|upi-auto|coupon|bonus|campaigns|referrals?)(?:\/|$)/.test(c.req.path)) {
    return err(c, 410, "STORE_FEATURES_RETIRED");
  }
  await next();
});

async function meView(c: C, background?: (p: Promise<unknown>) => void): Promise<Me> {
  const u = c.get("user");
  const s = c.get("settings");
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    photoUrl: u.photo_url,
    lang: c.get("lang"),
    langChosen: u.lang !== null,
    balance: 0,
    balanceInr: 0,
    notify: !!u.notify,
    canMessage: !!u.can_message,
    termsAccepted: !!u.terms_accepted_at,
    isAdmin: isOwner(c.env, s, u.id),
    starsPerUsd: 0,
    minTopup: 0,
    maxTopup: 0,
    supportUsername: s.support_username || null,
    channelUrl: s.channel_url || null,
    channelRequired: await channelGateRequired(c.env, s, u, { background }),
    referralEnabled: false,
    referralReward: 0,
    referralRewardInr: 0,
    botUsername: s.bot_username || null,
    brand: brandInfo(s),
    recent: [],
  };
}

app.get("/announcements/current", async (c) => {
  const u=c.get("user"),row=await c.env.DB.prepare("SELECT id,title,description,image_url,button_text,button_enabled,button_url FROM announcements WHERE active=1 ORDER BY id DESC LIMIT 1").first<any>();
  if(!row)return c.json({announcement:null});
  const s=c.get("settings");
  return c.json({announcement:row,vars:{name:[u.first_name,u.last_name].filter(Boolean).join(" ")||"there",first_name:u.first_name||"",last_name:u.last_name||"",user_id:String(u.id),id:String(u.id),username:u.username?"@"+u.username:"",joined:u.created_at?new Date(Number(u.created_at)*1000).toLocaleDateString("en-GB"):"",brand:s.brand_name,support:s.support_username?"@"+s.support_username:"Support"}});
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
  const u=c.get("user"),s=c.get("settings");
  if(u.lang===null||!u.terms_accepted_at)return c.json({ok:false});
  if(await channelGateRequired(c.env,s,u))return err(c,403,"CHANNEL_REQUIRED");
  return c.json({ok:true});
});

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
