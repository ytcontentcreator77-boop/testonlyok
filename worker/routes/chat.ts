import { Hono } from "hono";
import type { AppEnv } from "./app";
import { isOwner } from "../env";
import { tg } from "../telegram";
export const chat = new Hono<AppEnv>();
const now=()=>Math.floor(Date.now()/1000);
chat.post("/presence",async c=>{await c.env.DB.prepare("UPDATE users SET last_seen_at=?1 WHERE id=?2").bind(now(),c.get("user").id).run();return c.json({ok:true})});
const bad=(c:any,s:number,code:string)=>c.json({error:code,code},s);
chat.use("*",async(c,next)=>{if(!c.get("user").can_message)return bad(c,403,"BOT_START_REQUIRED");await next()});
chat.get("/users",async c=>{
 const me=c.get("user").id,q=(c.req.query("q")||"").trim().slice(0,64);
 if(q.length<2)return c.json({users:[]});
 const like="%"+q.replace(/[\\%_]/g,"\\$&")+"%";
 const r=await c.env.DB.prepare("SELECT u.id,u.first_name,u.last_name,u.username,u.photo_url,u.last_seen_at,p.display_name,p.username AS app_username FROM users u LEFT JOIN chat_profiles p ON p.user_id=u.id WHERE u.id<>?1 AND u.banned=0 AND u.can_message=1 AND (u.first_name LIKE ?2 ESCAPE '\\' OR u.last_name LIKE ?2 ESCAPE '\\' OR u.username LIKE ?2 ESCAPE '\\' OR p.username LIKE ?2 ESCAPE '\\' OR CAST(u.id AS TEXT)=?3) AND NOT EXISTS(SELECT 1 FROM chat_blocks b WHERE (b.blocker_id=u.id AND b.blocked_id=?1) OR (b.blocker_id=?1 AND b.blocked_id=u.id)) ORDER BY u.last_seen_at DESC LIMIT 30").bind(me,like,q).all();
 return c.json({users:r.results});
});
chat.get("/conversations",async c=>{
 const me=c.get("user").id;
 const r=await c.env.DB.prepare("SELECT c.id,c.updated_at,u.id AS peer_id,u.first_name,u.last_name,u.username,u.photo_url,u.last_seen_at,p.display_name,p.username AS app_username,m.body AS last_message,m.created_at AS last_message_at,m.sender_id AS last_sender,(SELECT COUNT(*) FROM chat_messages x WHERE x.conversation_id=c.id AND x.sender_id<>?1 AND x.read_at IS NULL) AS unread FROM chat_members mine JOIN chat_conversations c ON c.id=mine.conversation_id JOIN chat_members peer ON peer.conversation_id=c.id AND peer.user_id<>?1 JOIN users u ON u.id=peer.user_id LEFT JOIN chat_profiles p ON p.user_id=u.id LEFT JOIN chat_messages m ON m.id=(SELECT MAX(id) FROM chat_messages z WHERE z.conversation_id=c.id AND z.deleted_at IS NULL) WHERE mine.user_id=?1 AND mine.archived=0 ORDER BY COALESCE(m.created_at,c.updated_at) DESC LIMIT 100").bind(me).all();
 return c.json({conversations:r.results});
});
chat.post("/conversations",async c=>{
 const me=c.get("user").id,b=await c.req.json().catch(()=>({})),peer=Number(b.userId);
 if(!Number.isSafeInteger(peer)||peer<=0||peer===me)return bad(c,400,"INVALID_USER");
 const u=await c.env.DB.prepare("SELECT id FROM users WHERE id=?1 AND banned=0 AND can_message=1").bind(peer).first();
 if(!u)return bad(c,404,"USER_NOT_FOUND");
 const block=await c.env.DB.prepare("SELECT 1 FROM chat_blocks WHERE (blocker_id=?1 AND blocked_id=?2) OR (blocker_id=?2 AND blocked_id=?1)").bind(me,peer).first();
 if(block)return bad(c,403,"BLOCKED");
 const key=[me,peer].sort((a,b)=>a-b).join(":");
 await c.env.DB.prepare("INSERT OR IGNORE INTO chat_conversations(conversation_key,created_at,updated_at) VALUES(?1,?2,?2)").bind(key,now()).run();
 const conv=await c.env.DB.prepare("SELECT id FROM chat_conversations WHERE conversation_key=?1").bind(key).first<{id:number}>();
 await c.env.DB.batch([c.env.DB.prepare("INSERT OR IGNORE INTO chat_members(conversation_id,user_id) VALUES(?1,?2)").bind(conv!.id,me),c.env.DB.prepare("INSERT OR IGNORE INTO chat_members(conversation_id,user_id) VALUES(?1,?2)").bind(conv!.id,peer)]);
 return c.json({id:conv!.id});
});
chat.get("/conversations/:id/messages",async c=>{
 const me=c.get("user").id,id=Number(c.req.param("id"));
 const member=await c.env.DB.prepare("SELECT 1 FROM chat_members WHERE conversation_id=?1 AND user_id=?2").bind(id,me).first();
 if(!member)return bad(c,404,"CHAT_NOT_FOUND");
 const r=await c.env.DB.prepare("SELECT id,sender_id,body,created_at,edited_at,read_at,delivered_at FROM chat_messages WHERE conversation_id=?1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 100").bind(id).all();
 await c.env.DB.prepare("UPDATE chat_messages SET delivered_at=COALESCE(delivered_at,?1),read_at=COALESCE(read_at,?1) WHERE conversation_id=?2 AND sender_id<>?3").bind(now(),id,me).run();
 return c.json({messages:r.results.reverse()});
});
chat.post("/conversations/:id/messages",async c=>{
 const me=c.get("user").id,id=Number(c.req.param("id")),b=await c.req.json().catch(()=>({})),body=typeof b.body==="string"?b.body.trim():"";
 if(!Number.isSafeInteger(id)||!body||body.length>4000)return bad(c,400,"INVALID_MESSAGE");
 const member=await c.env.DB.prepare("SELECT 1 FROM chat_members WHERE conversation_id=?1 AND user_id=?2").bind(id,me).first();
 if(!member)return bad(c,404,"CHAT_NOT_FOUND");
 const blocked=await c.env.DB.prepare("SELECT 1 FROM chat_members p JOIN chat_blocks b ON b.blocker_id=p.user_id AND b.blocked_id=?1 WHERE p.conversation_id=?2 AND p.user_id<>?1").bind(me,id).first();
 if(blocked)return bad(c,403,"BLOCKED");
 const count=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE sender_id=?1 AND created_at>?2").bind(me,now()-10).first<{n:number}>();
 if((count?.n||0)>=8)return bad(c,429,"RATE_LIMIT");
 const ts=now(),m=await c.env.DB.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body,created_at) VALUES(?1,?2,?3,?4) RETURNING id,sender_id,body,created_at,edited_at,read_at,delivered_at").bind(id,me,body,ts).first();
 await c.env.DB.prepare("UPDATE chat_conversations SET updated_at=?1 WHERE id=?2").bind(ts,id).run();
 return c.json({message:m});
});
chat.get("/premium",async c=>{
 const me=c.get("user").id;
 const p=await c.env.DB.prepare("SELECT id,name,stars,duration_days FROM premium_plans WHERE active=1 ORDER BY duration_days").all();
 const s=await c.env.DB.prepare("SELECT expires_at,source FROM premium_subscriptions WHERE user_id=?1 AND status='active' AND (expires_at IS NULL OR expires_at>?2) ORDER BY expires_at DESC LIMIT 1").bind(me,now()).first();
 return c.json({plans:p.results,subscription:s||null,support:c.get("settings").support_username||null});
});
chat.post("/premium/invoice",async c=>{const me=c.get("user").id,b=await c.req.json().catch(()=>({})),id=Number(b.planId);const p=await c.env.DB.prepare("SELECT id,name,stars,duration_days FROM premium_plans WHERE id=?1 AND active=1").bind(id).first<any>();if(!p)return bad(c,404,"PLAN_NOT_FOUND");if(!Number.isInteger(p.stars)||p.stars<1)return bad(c,400,"PLAN_NOT_PAYABLE");const ts=now(),row=await c.env.DB.prepare("INSERT INTO premium_invoices(user_id,plan_id,stars,duration_days,created_at) VALUES(?1,?2,?3,?4,?5) RETURNING id").bind(me,p.id,p.stars,p.duration_days,ts).first<{id:number}>();const link=await tg<string>(c.env.BOT_TOKEN,"createInvoiceLink",{title:"Telegram X Hero Premium",description:String(p.name).slice(0,255),payload:"xh"+row!.id,currency:"XTR",prices:[{label:String(p.name).slice(0,32),amount:p.stars}]});return c.json({link,stars:p.stars})});
chat.post("/premium/request",async c=>{
 const me=c.get("user").id,b=await c.req.json().catch(()=>({})),id=Number(b.planId);
 const p=await c.env.DB.prepare("SELECT id FROM premium_plans WHERE id=?1 AND active=1").bind(id).first();
 if(!p)return bad(c,404,"PLAN_NOT_FOUND");
 await c.env.DB.prepare("INSERT INTO premium_requests(user_id,plan_id,created_at) VALUES(?1,?2,?3)").bind(me,id,now()).run();
 return c.json({ok:true});
});
chat.get("/admin/overview",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const [u,m,p,r]=await Promise.all([c.env.DB.prepare("SELECT COUNT(*) n FROM users").first<any>(),c.env.DB.prepare("SELECT COUNT(*) n FROM chat_messages").first<any>(),c.env.DB.prepare("SELECT COUNT(*) n FROM premium_subscriptions WHERE status='active' AND (expires_at IS NULL OR expires_at>?1)").bind(now()).first<any>(),c.env.DB.prepare("SELECT COUNT(*) n FROM premium_requests WHERE status='pending'").first<any>()]);
 return c.json({users:u?.n||0,messages:m?.n||0,premium:p?.n||0,pendingRequests:r?.n||0});
});
chat.post("/admin/premium/grant",async c=>{
 const me=c.get("user").id;if(!isOwner(c.env,c.get("settings"),me))return bad(c,403,"FORBIDDEN");
 const b=await c.req.json().catch(()=>({})),uid=Number(b.userId),days=Number(b.days);
 if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(days)||days<1||days>3650)return bad(c,400,"INVALID_GRANT");
 const u=await c.env.DB.prepare("SELECT id FROM users WHERE id=?1").bind(uid).first();if(!u)return bad(c,404,"USER_NOT_FOUND");
 const ts=now();await c.env.DB.prepare("INSERT INTO premium_subscriptions(user_id,starts_at,expires_at,source,created_by) VALUES(?1,?2,?3,'admin',?4)").bind(uid,ts,ts+days*86400,me).run();
 return c.json({ok:true});
});

chat.get("/admin/requests",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const r=await c.env.DB.prepare("SELECT r.id,r.user_id,r.created_at,p.name,p.duration_days,p.stars,u.first_name,u.last_name,u.username FROM premium_requests r JOIN premium_plans p ON p.id=r.plan_id JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 100").all();return c.json({requests:r.results})});
chat.post("/admin/requests/:id/approve",async c=>{const me=c.get("user").id;if(!isOwner(c.env,c.get("settings"),me))return bad(c,403,"FORBIDDEN");const id=Number(c.req.param("id")),r=await c.env.DB.prepare("SELECT r.id,r.user_id,p.id AS plan_id,p.duration_days FROM premium_requests r JOIN premium_plans p ON p.id=r.plan_id WHERE r.id=?1 AND r.status='pending'").bind(id).first<any>();if(!r)return bad(c,404,"REQUEST_NOT_FOUND");const ts=now();const [mark]=await c.env.DB.batch([c.env.DB.prepare("UPDATE premium_requests SET status='approved' WHERE id=?1 AND status='pending'").bind(id),c.env.DB.prepare("INSERT INTO premium_subscriptions(user_id,plan_id,starts_at,expires_at,source,created_by) SELECT ?1,?2,?3,?4,'manual',?5 WHERE changes()=1").bind(r.user_id,r.plan_id,ts,ts+r.duration_days*86400,me)]);if(!mark.meta.changes)return bad(c,409,"ALREADY_PROCESSED");return c.json({ok:true})});
