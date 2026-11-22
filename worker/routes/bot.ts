import { Hono } from "hono";
import { LANGS, langLabel, pickLang, type Lang } from "../../shared/types";
import { timingSafeEqual, webhookSecret } from "../auth";
import { tryClaim } from "../claim";
import type { Env } from "../env";
import { isOwner, ownerIds } from "../env";
import { attachReferral, parseRef } from "../growth";
import { getSettings } from "../settings";
import { botText } from "../i18n";
import { languageKeyboard, openButton, sendHelp, sendPreviews, sendWelcome } from "../botMessages";
import { ADMIN_COMMANDS, userCommands } from "../commands";
import { sendAdminLink, sendStats } from "../stats";
import { onBroadcastCallback, onBroadcastCommand, onBroadcastMessage } from "../broadcast";
import { onPreCheckout, onSuccessfulPayment } from "../payments";
import { verifyAutoUpi } from "../upi";
import { tg } from "../telegram";

export const bot = new Hono<{ Bindings: Env }>();

interface TgFrom {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

bot.post("/", async (c) => {
  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  // An empty header never matches: the effective secret is TG_WEBHOOK_SECRET, or derived from the bot token
  if (!secret || !timingSafeEqual(secret, await webhookSecret(c.env))) return c.text("forbidden", 403);
  const update = await c.req.json<any>().catch(() => null);
  if (!update || typeof update !== "object") return c.text("ok");
  // pre_checkout must be answered within 10 s — do it inline; everything else can run after we reply.
  if (update.pre_checkout_query) {
    await onPreCheckout(c.env, update.pre_checkout_query);
    return c.text("ok");
  }
  c.executionCtx.waitUntil(handle(c.env, update).catch((e) => console.error("bot update failed", e)));
  return c.text("ok");
});

/** Language buttons → save the choice (shared with the Mini App) and show the welcome in that language. */
async function onCallback(env: Env, q: any): Promise<void> {
  if (typeof q.data === "string" && q.data.startsWith("bc:")) return onBroadcastCallback(env, q);
  const upi = /^upi:(verify|cancel):(UPI[0-9A-Z]+)$/.exec(q.data ?? "");
  if (upi) {
    const action = upi[1], orderId = upi[2], uid = Number(q.from.id);
    const tx = await env.DB.prepare("SELECT * FROM upi_auto_transactions WHERE order_id=?1 AND user_id=?2").bind(orderId,uid).first<any>();
    if (!tx) return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment request not found.",show_alert:true}));
    if (action === "cancel") {
      // Check the gateway first: never cancel a payment that has already been received.
      try {
        if (tx.status === "pending") {
          const checked = await verifyAutoUpi(env, orderId, uid);
          if (checked.status === "paid") {
            if (q.message) await tg(env.BOT_TOKEN,"deleteMessage",{chat_id:uid,message_id:q.message.message_id}).catch(()=>{});
            await tg(env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:"✅ <b>PAYMENT ALREADY RECEIVED</b>\n\n₹"+checked.amount.toFixed(2)+" has been added to your wallet.\nNew balance: ₹"+checked.balance.toFixed(2),parse_mode:"HTML"});
            return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment received and wallet credited."}));
          }
          if (checked.status === "pending") {
            await env.DB.prepare("UPDATE upi_auto_transactions SET status='failed' WHERE order_id=?1 AND user_id=?2 AND status='pending'").bind(orderId,uid).run();
          }
        }
        const latest = await env.DB.prepare("SELECT status FROM upi_auto_transactions WHERE order_id=?1 AND user_id=?2").bind(orderId,uid).first<{status:string}>();
        if (latest?.status === "paid") {
          const paid = await verifyAutoUpi(env, orderId, uid);
          if (paid.status === "paid") {
            if (q.message) await tg(env.BOT_TOKEN,"deleteMessage",{chat_id:uid,message_id:q.message.message_id}).catch(()=>{});
            await tg(env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:"✅ <b>PAYMENT ALREADY RECEIVED</b>\n\n₹"+paid.amount.toFixed(2)+" has been added to your wallet.\nNew balance: ₹"+paid.balance.toFixed(2),parse_mode:"HTML"});
            return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment received and wallet credited."}));
          }
        }
        if (latest?.status === "failed" || latest?.status === "expired" || latest?.status === "cancelled") {
          if (q.message) await tg(env.BOT_TOKEN,"deleteMessage",{chat_id:uid,message_id:q.message.message_id}).catch(()=>{});
          await tg(env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:"❌ <b>PAYMENT CANCELLED</b>\n\nThis QR payment request is no longer active. You can create a new payment whenever you need." ,parse_mode:"HTML"});
          return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment request cancelled."}));
        }
        return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment is still being checked. Please try again.",show_alert:true}));
      } catch (e) {
        console.warn("UPI cancel check failed", (e as Error).message);
        return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Could not check payment status. Please try again; your request was not cancelled.",show_alert:true}));
      }
    }
    if (tx.status === "failed" || tx.status === "expired" || tx.status === "cancelled") return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"This payment request is cancelled or expired.",show_alert:true}));
    try {
      const result=await verifyAutoUpi(env,orderId,uid);
      if(result.status!=="paid") return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:result.status==="expired"?"QR expired. Please generate a new one.":"Payment is not detected yet. Wait a minute and try again.",show_alert:true}));
      if(q.message) await tg(env.BOT_TOKEN,"deleteMessage",{chat_id:uid,message_id:q.message.message_id}).catch(()=>{});
      await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Payment verified. Balance credited."});
      await tg(env.BOT_TOKEN,"sendMessage",{chat_id:uid,text:"🎉 <b>PAYMENT SUCCESSFUL</b>\n\n💰 Added: <b>₹"+result.amount.toFixed(2)+"</b>\n💳 New balance: <b>₹"+result.balance.toFixed(2)+"</b>\n🧾 UTR: <code>"+(result.utr||"N/A")+"</code>\n\nYour wallet has been credited.",parse_mode:"HTML"});
    } catch(e) {
      const code=e instanceof Error?e.message:"VERIFY_FAILED";
      await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:code==="UPI_AMOUNT_MISMATCH"?"Paid amount does not match this order. Contact support.":"Verification service is temporarily unavailable. Try again.",show_alert:true});
    }
    return;
  }
  const pm=/^pay:(approve|reject):(\d+)$/.exec(q.data??"");
  if(pm){const s=await getSettings(env);if(!isOwner(env,s,q.from.id))return void(await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Not authorized",show_alert:true}));const id=Number(pm[2]);const p=await env.DB.prepare("SELECT mp.*,u.lang FROM manual_payments mp LEFT JOIN users u ON u.id=mp.user_id WHERE mp.id=?1 AND mp.status='pending'").bind(id).first<any>();if(!p)return void(await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Already reviewed"}));if(pm[1]==="approve")return void(await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Open Admin → Manual payments and choose the INR amount to credit.",show_alert:true}));const now=Math.floor(Date.now()/1000);if(pm[1]==="approve"){const [mark]=await env.DB.batch([env.DB.prepare("UPDATE manual_payments SET status='approved',reviewed_at=?2,reviewed_by=?3 WHERE id=?1 AND status='pending'").bind(id,now,q.from.id),env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1 AND changes()=1").bind(p.user_id,p.amount_inr),env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT ?1,?2,'topup',?3,?4,?5 WHERE changes()=1").bind(p.user_id,p.amount_inr,id,p.method_name,now)]);if(!mark.meta.changes)return void(await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Already reviewed"}));const u=await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(p.user_id).first<{balance_inr:number}>();await tg(env.BOT_TOKEN,"sendMessage",{chat_id:p.user_id,text:botText(pickLang(p.lang),"fundAdded",{amount:Number(p.amount_inr).toFixed(2),balance:Number(u?.balance_inr??0).toFixed(2)}),parse_mode:"HTML"});}else{await env.DB.prepare("UPDATE manual_payments SET status='rejected',reviewed_at=?2,reviewed_by=?3,reject_reason='Rejected by admin' WHERE id=?1").bind(id,now,q.from.id).run();await tg(env.BOT_TOKEN,"sendMessage",{chat_id:p.user_id,text:`❌ Your ₹${Number(p.amount_inr).toFixed(2)} payment was rejected. Please contact support.`});}await tg(env.BOT_TOKEN,"editMessageReplyMarkup",{chat_id:q.message.chat.id,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}}).catch(()=>{});return void(await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:pm[1]==="approve"?"Payment approved":"Payment rejected"}));}
  const km = /^key:(show|hide):(\d+)$/.exec(q.data ?? "");
  if (km && q.message) {
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?1 AND user_id=?2 AND delivered_key IS NOT NULL AND status='completed'").bind(Number(km[2]),q.from.id).first<any>();
    if (!order) return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id,text:"Key not found",show_alert:true}));
    const shown = km[1] === "show";
    const key = String(order.delivered_key);
    const masked = key.length < 8 ? "••••••" : `${key.slice(0,4)}-${"•".repeat(Math.min(12,Math.max(4,key.length-4)))}`;
    const safe=(v:string)=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const text = botText(pickLang((await env.DB.prepare("SELECT lang FROM users WHERE id=?1").bind(q.from.id).first<{lang:string|null}>())?.lang??q.from.language_code),shown?"keyDeliveredRevealed":"keyDeliveredMasked",{product:safe(order.product_name),plan:safe(order.plan_duration),id:String(order.id),masked_key:safe(masked),full_key:safe(key),amount:Number(order.price_inr).toFixed(2),balance:"—"});
    const keyboard:any[][] = [[{text:shown?"🙈 Hide Key":"👁 Show Key",callback_data:`key:${shown?"hide":"show"}:${order.id}`}],[{text:"📋 Copy Key",copy_text:{text:key}}]];
    if(order.setup_file_url) keyboard.push([{text:"📥 Download Setup",url:order.setup_file_url}]);
    const botUsername=String((await getSettings(env)).bot_username||"").replace(/^@/,"");
    if(botUsername)keyboard.push([{text:"🎬 Setup Video",url:"https://t.me/"+botUsername+"?start=video"+order.product_id}]);
    await tg(env.BOT_TOKEN,"editMessageText",{chat_id:q.message.chat.id,message_id:q.message.message_id,text,parse_mode:"HTML",reply_markup:{inline_keyboard:keyboard}});
    return void (await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:q.id}));
  }
  const m = /^lang:(\w+)$/.exec(q.data ?? "");
  if (!m || !(LANGS as readonly string[]).includes(m[1])) return void (await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id }));
  const lang = m[1] as Lang;
  await env.DB.prepare("UPDATE users SET lang = ?2 WHERE id = ?1").bind(q.from.id, lang).run();
  await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: q.id, text: langLabel(lang) });
  // Swap the language picker for the photo welcome in the chosen language
  if (q.message) await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => undefined);
  await sendWelcome(env, q.from.id, lang, q.from.first_name ?? "");
}

/** Telegram refunded Stars on its side (e.g. a dispute): take the credited balance back, even if that makes it negative. */
async function onRefundedPayment(env: Env, r: { currency?: string; total_amount?: number; telegram_payment_charge_id?: string }): Promise<void> {
  const charge = r.telegram_payment_charge_id;
  if (!charge) return;
  const p = await env.DB.prepare("SELECT id, stars FROM payments WHERE charge_id = ?1 AND status = 'paid'").bind(charge).first<{ id: number; stars: number }>();
  if (!p) return; // unknown, or already refunded (our own admin refund also triggers this message)
  if (r.currency !== "XTR" || r.total_amount !== p.stars) {
    console.error("telegram refund mismatch, not applied", charge, r.currency, r.total_amount);
    return;
  }
  const now = Math.floor(Date.now() / 1000);const settings=await getSettings(env);const inr=(await env.DB.prepare("SELECT amount FROM payments WHERE id=?1").bind(p.id).first<{amount:number}>())!.amount/1_000_000*settings.inr_per_usd;
  await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?1 AND status = 'paid'").bind(p.id),
    env.DB.prepare("INSERT INTO ledger (user_id, delta, kind, ref, note, created_at) SELECT user_id, -amount, 'stars_refund', id, 'telegram refund', ?2 FROM payments WHERE id = ?1 AND changes() = 1").bind(p.id, now),
    env.DB.prepare("UPDATE users SET balance = balance - (SELECT amount FROM payments WHERE id = ?1), balance_inr=MAX(0,balance_inr-?2) WHERE id = (SELECT user_id FROM payments WHERE id = ?1) AND changes() = 1").bind(p.id,inr),
    env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) SELECT user_id,-?2,'stars_refund',id,'Telegram refund',?3 FROM payments WHERE id=?1 AND status='refunded'").bind(p.id,inr,now),
  ]);
}

async function handle(env: Env, u: any): Promise<void> {
  if (u.callback_query) return onCallback(env, u.callback_query);
  if (u.my_chat_member && u.my_chat_member.chat?.type === "private") {
    const status = u.my_chat_member.new_chat_member?.status;
    await env.DB.prepare("UPDATE users SET can_message = ?2 WHERE id = ?1")
      .bind(u.my_chat_member.from.id, status === "kicked" ? 0 : 1)
      .run();
    return;
  }
  const m = u.message;
  if (!m || m.chat?.type !== "private") return;
  const from = m.from as TgFrom;
  const now = Math.floor(Date.now() / 1000);
  // Messaging the bot means it may message back
  const user = await env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, username, language_code, can_message, notify, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET can_message = 1, first_name = excluded.first_name, last_name = excluded.last_name,
       username = excluded.username, language_code = excluded.language_code
     WHERE users.can_message = 0 OR users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name
       OR users.username IS NOT excluded.username OR users.language_code IS NOT excluded.language_code
     RETURNING lang, language_code`,
  )
    .bind(from.id, from.first_name ?? "", from.last_name ?? "", from.username ?? null, from.language_code ?? null, now)
    .first<{ lang: string | null; language_code: string | null }>()
    .then((r) => r ?? env.DB.prepare("SELECT lang, language_code FROM users WHERE id = ?1").bind(from.id).first<{ lang: string | null; language_code: string | null }>());
  const lang = pickLang(user?.lang ?? user?.language_code);

  if (m.successful_payment) {
    await onSuccessfulPayment(env, from, m.successful_payment);
    return;
  }
  if (m.refunded_payment) {
    await onRefundedPayment(env, m.refunded_payment);
    return;
  }
  const proofCaption=String(m.caption??"");const proofMatch=/^\/proof\s+(\d+)/i.exec(proofCaption);if(proofMatch&&(m.photo?.length||m.document?.file_id)){const fileId=m.photo?.[m.photo.length-1]?.file_id??m.document?.file_id;const id=Number(proofMatch[1]);const r=await env.DB.prepare("UPDATE manual_payments SET proof_file_id=?3 WHERE id=?1 AND user_id=?2 AND status='pending'").bind(id,from.id,fileId).run();await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:r.meta.changes?"✅ Payment proof attached. Your payment is waiting for admin review.":"Pending payment not found. Please check the payment ID."});if(r.meta.changes){const p=await env.DB.prepare("SELECT amount_inr,method_name,utr_ref FROM manual_payments WHERE id=?1").bind(id).first<any>();for(const adminId of ownerIds(env,await getSettings(env))){await tg(env.BOT_TOKEN,"sendMessage",{chat_id:adminId,text:`📎 <b>PAYMENT PROOF RECEIVED</b>\nPayment #${id} · User ${from.id}\n${p?.method_name} · ₹${Number(p?.amount_inr??0).toFixed(2)}\nUTR: ${p?.utr_ref??"—"}`,parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"✅ Approve",callback_data:`pay:approve:${id}`},{text:"❌ Reject",callback_data:`pay:reject:${id}`}]]}});if(m.photo?.length)await tg(env.BOT_TOKEN,"sendPhoto",{chat_id:adminId,photo:fileId,caption:`Payment proof #${id}`});else if(m.document?.file_id)await tg(env.BOT_TOKEN,"sendDocument",{chat_id:adminId,document:fileId,caption:`Payment proof #${id}`});}}return;}
  // Product-specific setup videos: send/reply to a video with "/addv PRODUCT_ID".
  if (isOwner(env, await getSettings(env), from.id)) {
    const setupCaption=String(m.caption??m.text??"").trim();
    const addVideo=/^\/addv\s+(\d+)$/i.exec(setupCaption);
    const setupVideo=m.video??m.reply_to_message?.video;
    if(addVideo&&setupVideo){
      const productId=Number(addVideo[1]);
      const product=await env.DB.prepare("SELECT id,name FROM key_products WHERE id=?1").bind(productId).first<any>();
      if(!product){await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"Product not found. Use the product ID shown in Admin → Key products & stock."});return;}
      await env.DB.prepare("UPDATE key_products SET setup_video_file_id=?2,setup_video_url=NULL WHERE id=?1").bind(productId,setupVideo.file_id).run();
      const username=String((await getSettings(env)).bot_username||"").replace(/^@/,"");
      await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"✅ Setup video saved for "+product.name+"."+(username?"\nLink: https://t.me/"+username+"?start=video"+productId:"\nSet the bot username to generate its deep link.")});
      return;
    }
    const bodyText=String(m.text??m.caption??"").trim();
    const uploadMatch=/^\/upload\s+(P[0-9A-Z_-]+)(?:\s+([\s\S]*))?$/i.exec(bodyText);
    const hasMedia=!!(m.document||m.photo?.length||m.video||m.animation||m.audio||m.voice||m.video_note||m.sticker);
    if(uploadMatch&&(hasMedia||!!uploadMatch[2])){
      const product=await env.DB.prepare("SELECT id,name,public_uid FROM key_products WHERE public_uid=?1 COLLATE NOCASE").bind(uploadMatch[1]).first<any>();
      if(!product){await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:`Product UID ${uploadMatch[1]} was not found. Copy the UID from the admin Products page.`});return;}
      const now=Math.floor(Date.now()/1000); let assetType="text",fileId:string|null=null,fileName:string|null=null,textContent:string|null=null;
      if(m.photo?.length){assetType="photo";fileId=m.photo[m.photo.length-1].file_id;}
      else if(m.video){assetType="video";fileId=m.video.file_id;fileName=m.video.file_name??null;}
      else if(m.animation){assetType="animation";fileId=m.animation.file_id;fileName=m.animation.file_name??null;}
      else if(m.audio){assetType="audio";fileId=m.audio.file_id;fileName=m.audio.file_name??null;}
      else if(m.voice){assetType="voice";fileId=m.voice.file_id;}
      else if(m.video_note){assetType="video_note";fileId=m.video_note.file_id;}
      else if(m.sticker){assetType="sticker";fileId=m.sticker.file_id;}
      else if(m.document){assetType="document";fileId=m.document.file_id;fileName=m.document.file_name??"File";}
      else textContent=uploadMatch[2]??"";
      await env.DB.prepare("INSERT INTO product_assets(product_id,asset_type,file_id,file_name,text_content,caption,created_at,added_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)").bind(product.id,assetType,fileId,fileName,textContent,assetType==="text"?null:(uploadMatch[2]??null),now,from.id).run();
      await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:`✅ Added ${assetType} delivery asset to ${product.name} (${product.public_uid}). It will be sent automatically after each successful purchase.`});return;
    }
  }

  if (m.document && isOwner(env, await getSettings(env), from.id)) {
    const cap=String(m.caption??"");const upload=/^\/upload\s+(\d+)/i.exec(cap);const add=/^\/addkey\s+(\d+)\s*[| ]\s*(\d+)/i.exec(cap);
    if(upload){const productId=Number(upload[1]);const product=await env.DB.prepare("SELECT id,name FROM key_products WHERE id=?1").bind(productId).first<any>();if(!product){await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"Product not found. Use /upload PRODUCT_ID as the document caption."});return;}await env.DB.prepare("UPDATE key_products SET setup_file_id=?2,setup_file_name=?3 WHERE id=?1").bind(productId,m.document.file_id,m.document.file_name??"Setup file").run();await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:`✅ Attached ${m.document.file_name??"file"} to ${product.name}. It will be delivered after a successful purchase.`});return;}
    if(add){try{const f=await tg<any>(env.BOT_TOKEN,"getFile",{file_id:m.document.file_id});if(!f.file_path)throw new Error("FILE_PATH_MISSING");const res=await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.file_path}`);if(!res.ok)throw new Error("FILE_DOWNLOAD_FAILED");const content=await res.text();const keys=content.split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean).slice(0,5000);let added=0;for(const key of keys){const r=await env.DB.prepare("INSERT OR IGNORE INTO key_stock(product_id,plan_id,key_value,added_at,added_by) VALUES(?1,?2,?3,?4,?5)").bind(Number(add[1]),Number(add[2]),key,now,from.id).run();added+=r.meta.changes??0;}await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:`✅ Imported ${added} keys from ${m.document.file_name??"file"}. Duplicates skipped: ${keys.length-added}.`});}catch(e){await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:`Could not import key file: ${(e as Error).message}`});}return;}
    await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"Attach a setup file with caption /upload PRODUCT_ID, or a key.txt file with caption /addkey PRODUCT_ID | PLAN_ID."});return;
  }
  const text: string = (m.text ?? "").trim();
  const cmd = /^\/(\w+)/.exec(text)?.[1]?.toLowerCase() ?? "";
  const send = (t: string, markup?: unknown) =>
    tg(env.BOT_TOKEN, "sendMessage", { chat_id: from.id, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup });
  const pickLanguage = () => send(botText(lang, "chooseLanguage"), languageKeyboard(LANGS));

  // First-admin claim: "/start claim_<code>" (the setup link) or "/claim <code>". Wrong codes look like any other message.
  const arg = text.split(/\s+/)[1] ?? "";
  if(cmd==="addv"&&isOwner(env,await getSettings(env),from.id)){
    const parts=text.split(/\s+/);const productId=Number(parts[1]);const videoUrl=parts.slice(2).join(" ").trim();
    if(!Number.isSafeInteger(productId)||productId<1)return void(await send("Use <code>/addv PRODUCT_ID https://video-link</code>, or send/reply to a video with caption <code>/addv PRODUCT_ID</code>."));
    const product=await env.DB.prepare("SELECT id,name FROM key_products WHERE id=?1").bind(productId).first<any>();
    if(!product)return void(await send("Product not found. Use the product ID shown in Admin → Key products & stock."));
    if(!videoUrl)return void(await send("Send a video with caption <code>/addv "+productId+"</code>, or reply to a video with that command."));
    if(!/^https?:\/\//i.test(videoUrl))return void(await send("Video URL must start with https:// or http://"));
    await env.DB.prepare("UPDATE key_products SET setup_video_url=?2,setup_video_file_id=NULL WHERE id=?1").bind(productId,videoUrl.slice(0,1000)).run();
    const username=String((await getSettings(env)).bot_username||"").replace(/^@/,"");
    return void(await send("✅ Setup video link saved for <b>"+product.name+"</b>."+(username?"\nhttps://t.me/"+username+"?start=video"+productId:"\nSet the bot username in setup to generate its deep link.")));
  }
  if (cmd === "claim" || (cmd === "start" && arg.startsWith("claim_"))) {
    const code = cmd === "claim" ? arg : arg.slice("claim_".length);
    if (code && (await tryClaim(env, from.id, code))) {
      await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: from.id, message_id: m.message_id }).catch(() => undefined);
      return void (await send("You are now the admin of this bot. Open the app and tap <b>Admin</b> in your profile to finish setting up."));
    }
  }
  // /paysupport stays answered (Telegram requires it for Stars) but isn't in the command menu.
  if (cmd === "paysupport" || cmd === "support") return void (await sendHelp(env, from.id, lang, "paysupport"));
  if (cmd === "language") return void (await pickLanguage());
  if(cmd==="start"&&/^video\d+$/.test(arg)){
    const productId=Number(arg.slice(5));
    const product=await env.DB.prepare("SELECT name,setup_video_file_id,setup_video_url FROM key_products WHERE id=?1 AND enabled=1").bind(productId).first<any>();
    if(!product||(!product.setup_video_file_id&&!product.setup_video_url)){
      await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"🎬 Setup video not configured yet for this product. Please contact support if you need help."});
      return;
    }
    if(product.setup_video_file_id)await tg(env.BOT_TOKEN,"sendVideo",{chat_id:from.id,video:product.setup_video_file_id,caption:"🎬 "+product.name+" setup tutorial"});
    else await tg(env.BOT_TOKEN,"sendMessage",{chat_id:from.id,text:"🎬 "+product.name+" setup tutorial",reply_markup:{inline_keyboard:[[{text:"▶️ Watch setup video",url:product.setup_video_url}]]}});
    return;
  }
  if (cmd === "start") {
    const ref = parseRef(text.split(/\s+/)[1]);
    if (ref) await attachReferral(env, await getSettings(env), from.id, ref);
  }
  if (cmd === "start") {
    // An admin's own menu (with /admin and /stats) can only be set once they have a chat with the bot
    const s = await getSettings(env);
    if (isOwner(env, s, from.id))
      await tg(env.BOT_TOKEN, "setMyCommands", { scope: { type: "chat", chat_id: from.id }, commands: [...userCommands(lang), ...ADMIN_COMMANDS] }).catch(() => undefined);
    return void (await (user?.lang ? sendWelcome(env, from.id, lang, from.first_name) : pickLanguage()));
  }
  if (cmd === "orders" || cmd === "keys") {
    const {results}=await env.DB.prepare("SELECT id,product_id,product_name,plan_duration,delivered_key,price_inr,setup_file_url FROM orders WHERE user_id=?1 AND delivered_key IS NOT NULL ORDER BY id DESC LIMIT 10").bind(from.id).all<any>();
    if(!results.length)return void(await send("🔑 You have no purchased keys yet. Open the store to browse products."));
    const botUsername=String((await getSettings(env)).bot_username||"").replace(/^@/,"");
    for(const o of results){const key=String(o.delivered_key);const masked=key.length<8?"••••••":`${key.slice(0,4)}-${"•".repeat(Math.min(12,Math.max(4,key.length-4)))}`;const buttons:any[][]=[[{text:"👁 Show Key",callback_data:`key:show:${o.id}`}],[{text:"📋 Copy Key",copy_text:{text:key}}]];if(o.setup_file_url)buttons.push([{text:"📥 Download Setup",url:o.setup_file_url}]);if(botUsername)buttons.push([{text:"🎬 Setup Video",url:"https://t.me/"+botUsername+"?start=video"+o.product_id}]);await send(`🔑 <b>${o.product_name}</b>\n📅 ${o.plan_duration} · #${o.id}\n🗝 <code>${masked}</code>\n💰 ₹${Number(o.price_inr).toFixed(2)}`,{inline_keyboard:buttons});}
    return;
  }
  if (cmd === "wallet" || cmd === "balance") {
    const s=await getSettings(env);const bal=await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(from.id).first<{balance_inr:number}>();
    const open=openButton(lang,s,"/#/key-wallet");return void(await send(botText(lang,"walletReply",{balance:Number(bal?.balance_inr??0).toFixed(2)}),open?{inline_keyboard:[[open]]}:undefined));
  }
  if(cmd==="coupon"){
    const code=text.split(/\s+/).slice(1).join(" ").trim().toUpperCase();if(!code)return void(await send("Use <code>/coupon CODE</code> to redeem a wallet-credit coupon."));const now=Math.floor(Date.now()/1000);const cp=await env.DB.prepare("SELECT * FROM coupons WHERE code=?1 COLLATE NOCASE AND type='wallet_inr' AND enabled=1 AND (expires_at IS NULL OR expires_at>?2) AND (max_uses=0 OR used_count<max_uses)").bind(code,now).first<any>();if(!cp)return void(await send("❌ Coupon is invalid or expired."));const used=await env.DB.prepare("SELECT COUNT(*) AS n FROM coupon_uses WHERE coupon_id=?1 AND user_id=?2").bind(cp.id,from.id).first<{n:number}>();if(Number(used?.n??0)>=Number(cp.per_user_limit))return void(await send("You have already used this coupon."));const amount=Number(cp.value);await env.DB.batch([env.DB.prepare("INSERT INTO coupon_uses(coupon_id,user_id,used_at,discount_applied_inr) VALUES(?1,?2,?3,?4)").bind(cp.id,from.id,now,amount),env.DB.prepare("UPDATE coupons SET used_count=used_count+1 WHERE id=?1").bind(cp.id),env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2 WHERE id=?1").bind(from.id,amount),env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,ref,note,created_at) VALUES(?1,?2,'coupon',?3,?4,?5)").bind(from.id,amount,cp.id,cp.code,now)]);const bal=await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(from.id).first<{balance_inr:number}>();return void(await send(botText(lang,"fundAdded",{amount:amount.toFixed(2),balance:Number(bal?.balance_inr??0).toFixed(2)})));
  }
  if(cmd==="bonus"){
    const s=await getSettings(env);if(!s.bonus_enabled)return void(await send(botText(lang,"bonusDisabled")));const u=await env.DB.prepare("SELECT last_bonus_at FROM users WHERE id=?1").bind(from.id).first<{last_bonus_at:number}>();const now=Math.floor(Date.now()/1000);const wait=Math.max(0,Number(s.bonus_cooldown_hours)*3600-(now-(u?.last_bonus_at??0)));if(wait>0)return void(await send(botText(lang,"bonusCooldown",{remaining:`${Math.ceil(wait/3600)} hour(s)`})));const amount=s.bonus_mode==="fixed"?Number(s.bonus_fixed_inr):Number((Number(s.bonus_min_inr)+Math.random()*(Number(s.bonus_max_inr)-Number(s.bonus_min_inr))).toFixed(2));const [claim]=await env.DB.batch([env.DB.prepare("UPDATE users SET balance_inr=balance_inr+?2,last_bonus_at=?3 WHERE id=?1 AND COALESCE(last_bonus_at,0)=?4").bind(from.id,amount,now,u?.last_bonus_at??0),env.DB.prepare("INSERT INTO bonus_claims(user_id,amount_inr,claimed_at) SELECT ?1,?2,?3 WHERE changes()=1").bind(from.id,amount,now),env.DB.prepare("INSERT INTO inr_ledger(user_id,delta_inr,kind,note,created_at) SELECT ?1,?2,'bonus','Claim bonus',?3 WHERE changes()=1").bind(from.id,amount,now)]);if(!claim.meta.changes)return void(await send("You already claimed this bonus. Try again later."));const bal=await env.DB.prepare("SELECT balance_inr FROM users WHERE id=?1").bind(from.id).first<{balance_inr:number}>();return void(await send(botText(lang,"bonusClaimed",{amount:amount.toFixed(2),balance:Number(bal?.balance_inr??0).toFixed(2),hours:String(s.bonus_cooldown_hours)})));
  }
  if(cmd==="upload"&&isOwner(env,await getSettings(env),from.id))return void(await send("Attach a photo, video, APK/document, audio or send text using <code>/upload PRODUCT_UID</code>. Example: <code>/upload P000123</code>. The product UID is shown in Admin → Products."));
  if(cmd==="bonus_settings"&&isOwner(env,await getSettings(env),from.id)){const s=await getSettings(env);return void(await send(`🎁 <b>Bonus settings</b>\nEnabled: ${s.bonus_enabled?"Yes":"No"}\nMode: ${s.bonus_mode}\nFixed: ₹${s.bonus_fixed_inr}\nRange: ₹${s.bonus_min_inr}–₹${s.bonus_max_inr}\nCooldown: ${s.bonus_cooldown_hours}h`));}
  if ((cmd === "stock" || cmd === "addkey" || cmd === "apicheck") && isOwner(env, await getSettings(env), from.id)) {
    if(cmd==="stock"){const {results}=await env.DB.prepare(`SELECT p.name,pl.duration,COUNT(s.id) AS stock FROM key_products p JOIN key_plans pl ON pl.product_id=p.id LEFT JOIN key_stock s ON s.product_id=p.id AND s.plan_id=pl.id AND s.used=0 GROUP BY p.id,pl.id ORDER BY p.name`).all<any>();return void(await send(results.length?"📦 <b>KEY STOCK</b>\n\n"+results.map(r=>`${r.name} · ${r.duration}: <b>${r.stock}</b>`).join("\n"):"No key products/plans configured yet."));}
    if(cmd==="apicheck"){try{const {checkBalance}=await import("../bantibhaiya");const r=await checkBalance(env);return void(await send(`🔌 API balance: ${r.balance} ${r.currency}`));}catch(e){return void(await send(`API check failed: ${(e as Error).message}`));}}
    const raw=text.slice(text.indexOf(" ")+1);const first=raw.split("\n")[0].split("|");if(first.length<2)return void(await send("Format: <code>/addkey PRODUCT_ID | PLAN_ID | KEY1\nKEY2\nKEY3</code>"));const productId=Number(first[0].trim()),planId=Number(first[1].trim());const keys=[first.slice(2).join("|").trim(),...raw.split("\n").slice(1)].filter(x=>x.trim());if(!Number.isInteger(productId)||!Number.isInteger(planId)||!keys.length)return void(await send("Invalid product, plan or key list."));let added=0;for(const key of keys){const r=await env.DB.prepare("INSERT OR IGNORE INTO key_stock(product_id,plan_id,key_value,added_at,added_by) VALUES(?1,?2,?3,?4,?5)").bind(productId,planId,key.trim(),now,from.id).run();added+=r.meta.changes??0;}return void(await send(`✅ Added ${added} key(s) to stock. Duplicate keys were skipped.`));
  }
  // Admin only (English, like the admin panel)
  if (cmd === "broadcast" && isOwner(env, await getSettings(env), from.id)) {
    return void (await onBroadcastCommand(env, from.id, (text.split(/\s+/)[1] ?? "").toLowerCase(), m.reply_to_message));
  }
  if ((cmd === "admin" || cmd === "stats") && isOwner(env, await getSettings(env), from.id)) {
    return void (await (cmd === "admin" ? sendAdminLink(env, from.id) : sendStats(env, from.id)));
  }
  // Owner only: one of every message, e.g. "/preview" or "/preview ru"
  if (cmd === "preview" && isOwner(env, await getSettings(env), from.id)) {
    const arg = text.split(/\s+/)[1] as Lang | undefined;
    const l = arg && (LANGS as readonly string[]).includes(arg) ? arg : lang;
    await sendPreviews(env, from.id, l, from.first_name, LANGS);
    return;
  }
  // An admin's message that isn't a command is never answered with help: the broadcast menu may be waiting for it
  if (!cmd && isOwner(env, await getSettings(env), from.id)) return void (await onBroadcastMessage(env, from.id, m));
  await sendHelp(env, from.id, lang);
}
