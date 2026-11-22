// Update-channel gate and referral rewards.
import { type Env, isOwner } from "./env";
import { alertAdmins } from "./alerts";
import { getSettings, type Settings } from "./settings";
import { tg } from "./telegram";

const DAY = 86400;
const MEMBER = new Set(["creator", "administrator", "member"]);

export type ChannelCheck = "member" | "not_member" | "unavailable";

/** Telegram asked us to slow down: the user should simply try again (never treated as "let in"). */
export class RetryLater extends Error {}

/** Asks Telegram whether the user is in the update channel. "unavailable" = Telegram couldn't answer (bot not admin, wrong id…). */
export async function checkChannel(env: Env, s: Settings, userId: number): Promise<ChannelCheck> {
  if (!s.channel_id) return "unavailable";
  try {
    const m = await tg<{ status: string; is_member?: boolean }>(env.BOT_TOKEN, "getChatMember", { chat_id: s.channel_id, user_id: userId });
    return MEMBER.has(m.status) || (m.status === "restricted" && m.is_member) ? "member" : "not_member";
  } catch (e) {
    const msg = (e as Error).message;
    // "user not found" / "PARTICIPANT_ID_INVALID" means the user simply isn't in the channel
    if (/user not found|participant/i.test(msg)) return "not_member";
    if (/\b429\b|too many requests/i.test(msg)) throw new RetryLater(msg);
    // Telegram down or unreachable (5xx, network error): not a setup problem, so no alert; held rewards are re-checked later
    if (!msg.startsWith("Telegram ") || /^Telegram \w+: 5\d\d\b/.test(msg)) {
      console.warn("channel check: Telegram unavailable for now", msg);
      return "unavailable";
    }
    console.error("channel check unavailable", msg);
    await alertAdmins(
      env,
      "channel",
      "The bot can't check members of your update channel, so new users can't be confirmed and <b>referral rewards are on hold</b>.\n\n" +
        "Make the bot an <b>admin of the channel</b> (and check the channel ID in Settings). Held rewards are paid automatically once it works.\n\n" +
        `<i>Telegram said: ${msg.replace(/[<>&]/g, "")}</i>`,
    );
    return "unavailable";
  }
}

/** users.channel_ok values */
const NOT_CONFIRMED = 0;
const MEMBER_OK = 1;
const PASSED_UNCONFIRMED = 2;

export interface GateUser {
  id: number;
  channel_ok: number;
  channel_checked_at: number | null;
}

/**
 * Whether the app should show the "join the update channel" step. Owners are never gated. Users who confirmed
 * membership are re-checked once a day (cheap) so leaving the channel brings the step back. If Telegram can't
 * answer, the user is let through but stays unconfirmed (no referral reward without a real confirmation).
 */
export async function channelGateRequired(
  env: Env,
  s: Settings,
  u: GateUser,
  opts: { background?: (p: Promise<unknown>) => void } = {},
): Promise<boolean> {
  if (!s.channel_gate || !s.channel_id || isOwner(env, s, u.id)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (u.channel_ok === NOT_CONFIRMED) return true;
  // Member, or let through while Telegram was unavailable: re-check once a day
  if (u.channel_checked_at && now - u.channel_checked_at < DAY) return false;
  const recheck = async () => {
    const r = await checkChannel(env, s, u.id).catch(() => "unavailable" as const);
    const next = r === "member" ? MEMBER_OK : r === "not_member" ? NOT_CONFIRMED : u.channel_ok;
    await env.DB.prepare("UPDATE users SET channel_ok = ?2, channel_checked_at = ?3 WHERE id = ?1").bind(u.id, next, now).run();
    return next;
  };
  if (opts.background) {
    // Answer from the cached state now; the result applies on the next request (leaving the channel brings the step back then)
    opts.background(recheck().catch((e) => console.warn("channel recheck failed", (e as Error).message)));
    return false;
  }
  const next = await recheck();
  u.channel_ok = next;
  u.channel_checked_at = now;
  return next === NOT_CONFIRMED;
}

/** The Verify button: confirms membership now. Returns the check result; "unavailable" lets the user through unconfirmed. */
export async function verifyChannel(env: Env, s: Settings, userId: number): Promise<ChannelCheck> {
  const now = Math.floor(Date.now() / 1000);
  const slot = await env.DB.prepare(
    "UPDATE users SET channel_checked_at = ?2 WHERE id = ?1 AND (channel_checked_at IS NULL OR channel_checked_at <= ?2 - 5)",
  )
    .bind(userId, now)
    .run();
  if (!slot.meta.changes) throw new RetryLater("too fast");
  const r = await checkChannel(env, s, userId);
  // Unavailable: let the user in as "passed, unconfirmed" (2) — never downgrade a confirmed member, never pays referrals
  const value = r === "member" ? MEMBER_OK : r === "not_member" ? NOT_CONFIRMED : PASSED_UNCONFIRMED;
  await env.DB.prepare(
    `UPDATE users SET channel_ok = CASE WHEN ?2 = ${PASSED_UNCONFIRMED} AND channel_ok = ${MEMBER_OK} THEN channel_ok ELSE ?2 END,
       channel_checked_at = ?3 WHERE id = ?1`,
  )
    .bind(userId, value, Math.floor(Date.now() / 1000))
    .run();
  return r;
}
