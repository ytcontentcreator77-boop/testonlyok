import type { Env } from "./env";
import { getSettings } from "./settings";

export type UpiVerifyResult =
  | { status: "paid"; amount: number; utr: string; balance: number }
  | { status: "pending" | "expired" | "cancelled" };

export async function verifyAutoUpi(env: Env, orderId: string, userId: number): Promise<UpiVerifyResult> {
  const tx = await env.DB.prepare("SELECT * FROM upi_auto_transactions WHERE order_id=?1 AND user_id=?2")
    .bind(orderId, userId).first<any>();
  if (!tx) throw new Error("PAYMENT_NOT_FOUND");
  if (tx.status === "paid") {
    const u = await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(userId).first<{balance_inr:number}>();
    return { status: "paid", amount: Number(tx.amount_inr), utr: String(tx.utr || ""), balance: Number(u?.balance_inr || 0) };
  }
  if (tx.status !== "pending") return { status: tx.status === "expired" ? "expired" : "cancelled" };

  const now = Math.floor(Date.now() / 1000);
  if (now >= Number(tx.expires_at)) {
    await env.DB.prepare("UPDATE upi_auto_transactions SET status='expired' WHERE order_id=?1 AND user_id=?2 AND status='pending'")
      .bind(orderId, userId).run();
    return { status: "expired" };
  }

  const s = await getSettings(env, { fresh: true });
  if (!s.upi_gateway_enabled || !s.upi_gateway_api_key) throw new Error("UPI_GATEWAY_NOT_CONFIGURED");

  const url = new URL("https://gateway.anujbots.in/autoverify.php");
  url.searchParams.set("api_key", s.upi_gateway_api_key);
  url.searchParams.set("order_id", String(tx.gateway_order_id));
  let result: any;
  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error("UPI_VERIFY_UNAVAILABLE");
    result = await resp.json();
  } catch (e) {
    if (e instanceof Error && e.message === "UPI_VERIFY_UNAVAILABLE") throw e;
    throw new Error("UPI_VERIFY_UNAVAILABLE");
  }

  const d = result?.data;
  if (!d || String(d.order_id || "") !== String(tx.gateway_order_id)) throw new Error("UPI_VERIFY_INVALID_RESPONSE");
  const gatewayStatus = String(d.status || "").toUpperCase();
  if (gatewayStatus === "EXPIRED") {
    await env.DB.prepare("UPDATE upi_auto_transactions SET status='expired' WHERE order_id=?1 AND user_id=?2 AND status='pending'")
      .bind(orderId, userId).run();
    return { status: "expired" };
  }
  if (gatewayStatus !== "PAID") {
    if (gatewayStatus === "PENDING") return { status: "pending" };
    if (d.code === "SUBSCRIPTION_EXPIRED") throw new Error("UPI_GATEWAY_SUBSCRIPTION_EXPIRED");
    throw new Error("UPI_VERIFY_UNAVAILABLE");
  }
  if (result.status !== true && result.status !== "success") throw new Error("UPI_VERIFY_INVALID_RESPONSE");

  const paidAmount = Number(d.amount);
  if (!Number.isFinite(paidAmount) || Math.round(paidAmount * 100) !== Math.round(Number(tx.amount_inr) * 100))
    throw new Error("UPI_AMOUNT_MISMATCH");

  const utr = String(d.utr || d.transaction_id || "").slice(0, 120);
  const verifiedAt = Math.floor(Date.now() / 1000);
  // Only the pending -> paid transition may create a ledger row and credit the wallet.
  await env.DB.batch([
    env.DB.prepare("UPDATE upi_auto_transactions SET status='paid',utr=?2,verified_at=?3 WHERE order_id=?1 AND user_id=?4 AND status='pending'")
      .bind(orderId, utr, verifiedAt, userId),
    env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT user_id,amount_inr,'topup',id,'UPI automatic top-up',?2 FROM upi_auto_transactions WHERE order_id=?1 AND user_id=?3 AND status='paid' AND verified_at=?2 AND NOT EXISTS(SELECT 1 FROM inr_ledger WHERE kind='topup' AND ref=upi_auto_transactions.id)")
      .bind(orderId, verifiedAt, userId),
    env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1")
      .bind(userId, paidAmount),
  ]);

  const fresh = await env.DB.prepare("SELECT t.status,t.amount_inr,t.utr,u.balance_inr FROM upi_auto_transactions t JOIN users u ON u.id=t.user_id WHERE t.order_id=?1 AND t.user_id=?2")
    .bind(orderId, userId).first<any>();
  if (fresh?.status !== "paid") return { status: fresh?.status === "pending" ? "pending" : fresh?.status === "expired" ? "expired" : "cancelled" };
  return { status: "paid", amount: Number(fresh.amount_inr), utr: String(fresh.utr || utr), balance: Number(fresh.balance_inr || 0) };
}
