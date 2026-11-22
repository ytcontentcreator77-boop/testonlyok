import type { Env } from "./env";
import { tg } from "./telegram";

/** Send campaign notices in small batches so a large user base never blocks campaign creation. */
export async function campaignNoticeTick(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT q.id,q.user_id,q.attempts,c.id AS campaign_id,c.title,c.description,c.reward_inr FROM campaign_notice_queue q JOIN campaigns c ON c.id=q.campaign_id WHERE q.status='pending' AND c.active=1 ORDER BY q.id LIMIT 20",
  ).all<any>();
  for (const row of results) {
    try {
      await tg(env.BOT_TOKEN, "sendMessage", {
        chat_id: row.user_id,
        text: "🎯 NEW CAMPAIGN IS LIVE\n\n" + String(row.title).slice(0, 180) + "\n\n" + String(row.description).slice(0, 900) + "\n\nReward: ₹" + Number(row.reward_inr).toFixed(2) + "\n\nOpen the Mini App and tap Campaigns to participate.",
      });
      await env.DB.prepare("UPDATE campaign_notice_queue SET status='sent' WHERE id=?1 AND status='pending'").bind(row.id).run();
    } catch (e) {
      const attempts = Number(row.attempts || 0) + 1;
      await env.DB.prepare("UPDATE campaign_notice_queue SET attempts=?2,status=?3 WHERE id=?1").bind(row.id, attempts, attempts >= 3 ? "failed" : "pending").run();
    }
  }
}
