import type { Env } from "./env";
import { tg } from "./telegram";

const now=()=>Math.floor(Date.now()/1000);
type PreCheckout={id:string;from:{id:number};currency:string;total_amount:number;invoice_payload:string};
type SuccessfulPayment={invoice_payload:string;telegram_payment_charge_id:string;total_amount:number;currency:string};

/** Only Premium invoices are accepted; legacy wallet top-ups are retired. */
export async function onPreCheckout(env:Env,q:PreCheckout):Promise<void>{
 const match=/^xh(\d+)$/.exec(q.invoice_payload||"");
 if(!match){await tg(env.BOT_TOKEN,"answerPreCheckoutQuery",{pre_checkout_query_id:q.id,ok:false,error_message:"Wallet top-ups are no longer available. Choose a Premium plan in the app."});return;}
 const p=await env.DB.prepare("SELECT id,user_id,stars,status,created_at FROM premium_invoices WHERE id=?1").bind(Number(match[1])).first<any>();
 const banned=!!(await env.DB.prepare("SELECT banned FROM users WHERE id=?1").bind(q.from.id).first<{banned:number}>())?.banned;
 const valid=!!p&&p.status==="pending"&&p.user_id===q.from.id&&q.currency==="XTR"&&q.total_amount===p.stars&&now()-p.created_at<3600&&!banned;
 await tg(env.BOT_TOKEN,"answerPreCheckoutQuery",{pre_checkout_query_id:q.id,ok:valid,...(!valid?{error_message:banned?"Your account cannot make payments.":"This Premium invoice expired. Please create a new one."}:{})});
}

/** Activate Premium exactly once after Telegram confirms the Stars charge. */
export async function onSuccessfulPayment(env:Env,from:{id:number;language_code?:string},sp:SuccessfulPayment):Promise<void>{
 const match=/^xh(\d+)$/.exec(sp.invoice_payload||"");
 if(!match){console.warn("ignored retired wallet payment",sp.telegram_payment_charge_id);return;}
 const p=await env.DB.prepare("SELECT * FROM premium_invoices WHERE id=?1").bind(Number(match[1])).first<any>();
 if(!p||p.status!=="pending"||p.user_id!==from.id||sp.currency!=="XTR"||sp.total_amount!==p.stars||now()-p.created_at>=3600){console.error("invalid Premium Stars payment",sp.telegram_payment_charge_id);return;}
 const ts=now();
 const latest=await env.DB.prepare("SELECT MAX(expires_at) AS latest FROM premium_subscriptions WHERE user_id=?1 AND status='active' AND expires_at>?2").bind(p.user_id,ts).first<{latest:number|null}>();
 const startsAt=Math.max(ts,Number(latest?.latest||ts));
 const [mark]=await env.DB.batch([
  env.DB.prepare("UPDATE premium_invoices SET status='paid',charge_id=?2,paid_at=?3 WHERE id=?1 AND status='pending'").bind(p.id,sp.telegram_payment_charge_id,ts),
  env.DB.prepare("INSERT INTO premium_subscriptions(user_id,plan_id,starts_at,expires_at,source) SELECT ?1,?2,?3,?4,'telegram_stars' WHERE changes()=1").bind(p.user_id,p.plan_id,startsAt,startsAt+p.duration_days*86400)
 ]);
 if(!mark.meta.changes)return;
 await tg(env.BOT_TOKEN,"sendMessage",{chat_id:p.user_id,text:"⭐ Telegram X Hero Premium activated successfully."}).catch(e=>console.warn("Premium activation notice failed",e));
}
