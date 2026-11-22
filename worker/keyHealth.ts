import type { Env } from "./env";
import { alertAdmins } from "./alerts";
import { getSettings, setSettings } from "./settings";
import { checkBalance } from "./bantibhaiya";

/** Low inventory alert, grouped by product and plan. */
export async function stockCheckTick(env: Env): Promise<void> {
  const s=await getSettings(env,{fresh:true});const now=Math.floor(Date.now()/1000);if(s.key_stock_checked_at&&now-s.key_stock_checked_at<300)return;await setSettings(env,{key_stock_checked_at:now});const limit=Math.max(0,Number(s.low_stock_alert)||0);if(!limit)return;
  const {results}=await env.DB.prepare(`SELECT p.name,pl.duration,COUNT(ks.id) AS available FROM key_products p JOIN key_plans pl ON pl.product_id=p.id AND pl.enabled=1 LEFT JOIN key_stock ks ON ks.product_id=p.id AND ks.plan_id=pl.id AND ks.used=0 WHERE p.enabled=1 GROUP BY p.id,pl.id HAVING COUNT(ks.id)<?1 ORDER BY available,p.name LIMIT 30`).bind(limit).all<{name:string;duration:string;available:number}>();
  if(results.length)await alertAdmins(env,"key_stock",`Key stock is below ${limit}:\n${results.map(r=>`• ${r.name} — ${r.duration}: ${r.available} available`).join("\n")}`);
}

/** Reseller balance is checked at most every six hours to stay within free-plan subrequest limits. */
export async function apiBalanceTick(env: Env): Promise<void> {
  const s=await getSettings(env,{fresh:true});if(!s.reseller_api_key&&!s.active_key_api_id)return;const now=Math.floor(Date.now()/1000);if(s.api_balance_checked_at&&now-s.api_balance_checked_at<21600)return;
  await setSettings(env,{api_balance_checked_at:now});
  try{const r=await checkBalance(env);if(r.balance<Number(s.api_low_balance_inr||100))await alertAdmins(env,"key_api_balance",`Reseller API balance is low: ${r.balance} ${r.currency}. Please top up the API account.`);}catch(e){console.warn("key API balance check failed",(e as Error).message);}
}
