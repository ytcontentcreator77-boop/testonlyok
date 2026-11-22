import { Hono } from "hono";
import type { AppEnv } from "./app";
import { isOwner } from "../env";
import { tg } from "../telegram";
export const chat = new Hono<AppEnv>();
const now=()=>Math.floor(Date.now()/1000);
chat.post("/presence",async c=>{if(!c.get("user").can_message)return bad(c,403,"BOT_START_REQUIRED");await c.env.DB.prepare("UPDATE users SET last_seen_at=?1 WHERE id=?2").bind(now(),c.get("user").id).run();return c.json({ok:true})});
const bad=(c:any,s:number,code:string)=>c.json({error:code,code},s);
chat.use("*",async(c,next)=>{if(!c.get("user").can_message)return bad(c,403,"BOT_START_REQUIRED");await next()});
chat.get("/users",async c=>{
 const me=c.get("user").id,q=(c.req.query("q")||"").trim().slice(0,64);
 if(q.length<2)return c.json({users:[]});
 const term=q.replace(/^@/,"").trim();
 const like="%"+term.replace(/[\\%_]/g,"\\$&")+"%";
 const r=await c.env.DB.prepare("SELECT u.id,u.first_name,u.last_name,u.username,u.photo_url,u.last_seen_at,p.display_name,p.username AS app_username FROM users u LEFT JOIN chat_profiles p ON p.user_id=u.id WHERE u.id<>?1 AND u.banned=0 AND u.can_message=1 AND (u.first_name LIKE ?2 ESCAPE '\\' OR u.last_name LIKE ?2 ESCAPE '\\' OR (u.first_name||' '||COALESCE(u.last_name,'')) LIKE ?2 ESCAPE '\\' OR u.username LIKE ?2 ESCAPE '\\' OR p.username LIKE ?2 ESCAPE '\\' OR CAST(u.id AS TEXT)=?3) AND NOT EXISTS(SELECT 1 FROM chat_blocks b WHERE (b.blocker_id=u.id AND b.blocked_id=?1) OR (b.blocker_id=?1 AND b.blocked_id=u.id)) ORDER BY u.last_seen_at DESC LIMIT 30").bind(me,like,term).all();
 return c.json({users:r.results});
});
chat.get("/conversations",async c=>{
 const me=c.get("user").id;
 const r=await c.env.DB.prepare("SELECT c.id,c.updated_at,u.id AS peer_id,u.first_name,u.last_name,u.username,u.photo_url,u.last_seen_at,p.display_name,p.username AS app_username,m.body AS last_message,m.created_at AS last_message_at,m.sender_id AS last_sender,(SELECT COUNT(*) FROM chat_messages x WHERE x.conversation_id=c.id AND x.sender_id<>?1 AND x.read_at IS NULL) AS unread FROM chat_members mine JOIN chat_conversations c ON c.id=mine.conversation_id JOIN chat_members peer ON peer.conversation_id=c.id AND peer.user_id<>?1 JOIN users u ON u.id=peer.user_id LEFT JOIN chat_profiles p ON p.user_id=u.id LEFT JOIN chat_messages m ON m.id=(SELECT MAX(id) FROM chat_messages z WHERE z.conversation_id=c.id AND z.deleted_at IS NULL) WHERE mine.user_id=?1 AND mine.archived=?2 ORDER BY mine.pinned DESC,COALESCE(m.created_at,c.updated_at) DESC LIMIT 100").bind(me,c.req.query("archived")==="1"?1:0).all();
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
 const r=await c.env.DB.prepare("SELECT id,sender_id,body,created_at,edited_at,read_at,delivered_at FROM chat_messages WHERE conversation_id=?1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM chat_message_hidden h WHERE h.message_id=chat_messages.id AND h.user_id=?2) ORDER BY id DESC LIMIT 100").bind(id,me).all();
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
chat.get("/admin/users",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const q=(c.req.query("q")||"").trim().replace(/^@/,"").slice(0,64);
 if(q.length<2)return c.json({users:[]});
 const like="%"+q.replace(/[\\%_]/g,"\\$&")+"%";
 const r=await c.env.DB.prepare("SELECT id,first_name,last_name,username,photo_url,banned,created_at FROM users WHERE CAST(id AS TEXT)=?1 OR first_name LIKE ?2 ESCAPE '\\' OR last_name LIKE ?2 ESCAPE '\\' OR (first_name||' '||COALESCE(last_name,'')) LIKE ?2 ESCAPE '\\' OR username LIKE ?2 ESCAPE '\\' ORDER BY created_at DESC LIMIT 30").bind(q,like).all();
 return c.json({users:r.results});
});
chat.post("/admin/users/:id/ban",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1||id===c.get("user").id)return bad(c,400,"INVALID_USER");
 const r=await c.env.DB.prepare("UPDATE users SET banned=1 WHERE id=?1").bind(id).run();
 return r.meta.changes?c.json({ok:true}):bad(c,404,"USER_NOT_FOUND");
});
chat.post("/admin/users/:id/unban",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1)return bad(c,400,"INVALID_USER");
 const r=await c.env.DB.prepare("UPDATE users SET banned=0 WHERE id=?1").bind(id).run();
 return r.meta.changes?c.json({ok:true}):bad(c,404,"USER_NOT_FOUND");
});
chat.get("/admin/branding",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const r=await c.env.DB.prepare("SELECT brand_name,brand_description FROM chat_platform_settings WHERE id=1").first<any>();
 return c.json({brandName:r?.brand_name||"Telegram X Hero",brandDescription:r?.brand_description||"Private messaging"});
});
chat.put("/admin/branding",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const b=await c.req.json().catch(()=>({})),name=String(b.brandName||"").trim().slice(0,48),description=String(b.brandDescription||"").trim().slice(0,120);
 if(!name)return bad(c,400,"INVALID_BRAND_NAME");
 await c.env.DB.prepare("UPDATE chat_platform_settings SET brand_name=?1,brand_description=?2,updated_at=?3 WHERE id=1").bind(name,description,now()).run();
 return c.json({ok:true,brandName:name,brandDescription:description});
});
chat.get("/admin/overview",async c=>{")+"%";
 const r=await c.env.DB.prepare("SELECT id,first_name,last_name,username,photo_url,banned,created_at FROM users WHERE CAST(id AS TEXT)=?1 OR first_name LIKE ?2 ESCAPE '\\' OR last_name LIKE ?2 ESCAPE '\\' OR (first_name||' '||COALESCE(last_name,'')) LIKE ?2 ESCAPE '\\' OR username LIKE ?2 ESCAPE '\\' ORDER BY created_at DESC LIMIT 30").bind(q,like).all();
 return c.json({users:r.results});
});
chat.post("/admin/users/:id/ban",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1||id===c.get("user").id)return bad(c,400,"INVALID_USER");
 const r=await c.env.DB.prepare("UPDATE users SET banned=1 WHERE id=?1").bind(id).run();
 return r.meta.changes?c.json({ok:true}):bad(c,404,"USER_NOT_FOUND");
});
chat.post("/admin/users/:id/unban",async c=>{
 if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");
 const id=Number(c.req.param("id"));if(!Number.isSafeInteger(id)||id<1)return bad(c,400,"INVALID_USER");
 const r=await c.env.DB.prepare("UPDATE users SET banned=0 WHERE id=?1").bind(id).run();
 return r.meta.changes?c.json({ok:true}):bad(c,404,"USER_NOT_FOUND");
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

const chatMember=async(db:D1Database,conversationId:number,userId:number)=>!!(await db.prepare("SELECT 1 FROM chat_members WHERE conversation_id=?1 AND user_id=?2").bind(conversationId,userId).first());
chat.post("/conversations/:id/archive",async c=>{const me=c.get("user").id,id=Number(c.req.param("id"));const r=await c.env.DB.prepare("UPDATE chat_members SET archived=1 WHERE conversation_id=?1 AND user_id=?2").bind(id,me).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"CHAT_NOT_FOUND")});
chat.post("/conversations/:id/unarchive",async c=>{const me=c.get("user").id,id=Number(c.req.param("id"));const r=await c.env.DB.prepare("UPDATE chat_members SET archived=0 WHERE conversation_id=?1 AND user_id=?2").bind(id,me).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"CHAT_NOT_FOUND")});
chat.post("/conversations/:id/mute",async c=>{const me=c.get("user").id,id=Number(c.req.param("id")),b=await c.req.json().catch(()=>({}));const r=await c.env.DB.prepare("UPDATE chat_members SET muted=?3 WHERE conversation_id=?1 AND user_id=?2").bind(id,me,b.muted?1:0).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"CHAT_NOT_FOUND")});
chat.post("/conversations/:id/pin",async c=>{const me=c.get("user").id,id=Number(c.req.param("id"));const row=await c.env.DB.prepare("SELECT pinned FROM chat_members WHERE conversation_id=?1 AND user_id=?2").bind(id,me).first<any>();if(!row)return bad(c,404,"CHAT_NOT_FOUND");if(!row.pinned){const n=await c.env.DB.prepare("SELECT COUNT(*) n FROM chat_members WHERE user_id=?1 AND pinned=1").bind(me).first<any>();const limit=await pinLimit(c.env.DB,me);if(Number(n?.n||0)>=limit)return c.json({error:"PIN_LIMIT_REACHED",code:"PIN_LIMIT_REACHED",limit},409)}await c.env.DB.prepare("UPDATE chat_members SET pinned=?3 WHERE conversation_id=?1 AND user_id=?2").bind(id,me,row.pinned?0:1).run();return c.json({ok:true,pinned:!row.pinned})});
chat.post("/conversations/:id/messages/:messageId/edit",async c=>{const me=c.get("user").id,conv=Number(c.req.param("id")),mid=Number(c.req.param("messageId")),b=await c.req.json().catch(()=>({})),body=typeof b.body==="string"?b.body.trim():"";if(!body||body.length>4000)return bad(c,400,"INVALID_MESSAGE");if(!await chatMember(c.env.DB,conv,me))return bad(c,404,"CHAT_NOT_FOUND");const r=await c.env.DB.prepare("UPDATE chat_messages SET body=?4,edited_at=?5 WHERE id=?1 AND conversation_id=?2 AND sender_id=?3 AND deleted_at IS NULL").bind(mid,conv,me,body,now()).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"MESSAGE_NOT_FOUND")});
chat.post("/conversations/:id/messages/:messageId/delete",async c=>{const me=c.get("user").id,conv=Number(c.req.param("id")),mid=Number(c.req.param("messageId")),b=await c.req.json().catch(()=>({}));if(!await chatMember(c.env.DB,conv,me))return bad(c,404,"CHAT_NOT_FOUND");const scope=b.forEveryone? "all":"self";if(scope==="all"){const r=await c.env.DB.prepare("UPDATE chat_messages SET deleted_at=?4,body='Message deleted' WHERE id=?1 AND conversation_id=?2 AND sender_id=?3 AND deleted_at IS NULL").bind(mid,conv,me,now()).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"MESSAGE_NOT_FOUND")}const r=await c.env.DB.prepare("INSERT OR IGNORE INTO chat_message_hidden(message_id,user_id) VALUES(?1,?2)").bind(mid,me).run();return c.json({ok:true})});
chat.post("/conversations/:id/messages/:messageId/forward",async c=>{const me=c.get("user").id,conv=Number(c.req.param("id")),mid=Number(c.req.param("messageId")),b=await c.req.json().catch(()=>({})),to=Number(b.toConversationId);if(!await chatMember(c.env.DB,conv,me)||!await chatMember(c.env.DB,to,me))return bad(c,404,"CHAT_NOT_FOUND");const original=await c.env.DB.prepare("SELECT body FROM chat_messages WHERE id=?1 AND conversation_id=?2 AND deleted_at IS NULL").bind(mid,conv).first<any>();if(!original)return bad(c,404,"MESSAGE_NOT_FOUND");const ts=now(),m=await c.env.DB.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body,created_at,forwarded_from_id) VALUES(?1,?2,?3,?4,?5) RETURNING id,sender_id,body,created_at,edited_at,read_at,delivered_at").bind(to,me,original.body,ts,mid).first();await c.env.DB.prepare("UPDATE chat_conversations SET updated_at=?1 WHERE id=?2").bind(ts,to).run();return c.json({message:m})});
chat.post("/users/:id/block",async c=>{const me=c.get("user").id,other=Number(c.req.param("id"));if(other===me||!Number.isSafeInteger(other))return bad(c,400,"INVALID_USER");await c.env.DB.prepare("INSERT OR IGNORE INTO chat_blocks(blocker_id,blocked_id,created_at) VALUES(?1,?2,?3)").bind(me,other,now()).run();return c.json({ok:true})});
chat.post("/users/:id/unblock",async c=>{const me=c.get("user").id,other=Number(c.req.param("id"));await c.env.DB.prepare("DELETE FROM chat_blocks WHERE blocker_id=?1 AND blocked_id=?2").bind(me,other).run();return c.json({ok:true})});
chat.post("/reports",async c=>{const me=c.get("user").id,b=await c.req.json().catch(()=>({})),target=Number(b.userId),messageId=b.messageId?Number(b.messageId):null,reason=String(b.reason||"").trim().slice(0,500);if(!Number.isSafeInteger(target)||target<1||!reason)return bad(c,400,"INVALID_REPORT");await c.env.DB.prepare("INSERT INTO chat_reports(reporter_id,reported_user_id,message_id,reason,created_at) VALUES(?1,?2,?3,?4,?5)").bind(me,target,messageId,reason,now()).run();return c.json({ok:true})});
chat.get("/features",async c=>{const me=c.get("user").id,sub=await c.env.DB.prepare("SELECT p.features FROM premium_subscriptions s LEFT JOIN premium_plans p ON p.id=s.plan_id WHERE s.user_id=?1 AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>?2) ORDER BY s.expires_at DESC LIMIT 1").bind(me,now()).first<any>();const rows=await c.env.DB.prepare("SELECT feature_key,title,description FROM premium_feature_catalog WHERE enabled=1 ORDER BY title").all();let selected:string[]=[];try{selected=JSON.parse(sub?.features||"[]")}catch{};return c.json({premium:!!sub,features:rows.results.map((x:any)=>({...x,included:!!sub&&(selected.length===0||selected.includes(x.feature_key))}))})});
chat.get("/admin/plans",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const [plans,features]=await Promise.all([c.env.DB.prepare("SELECT id,name,stars,duration_days,active,features FROM premium_plans ORDER BY duration_days").all(),c.env.DB.prepare("SELECT feature_key,title,description,enabled FROM premium_feature_catalog ORDER BY title").all()]);return c.json({plans:plans.results,features:features.results})});
chat.post("/admin/plans",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const b=await c.req.json().catch(()=>({})),name=String(b.name||"").trim().slice(0,80),stars=Number(b.stars),days=Number(b.durationDays),features=Array.isArray(b.features)?b.features:[];if(!name||!Number.isInteger(stars)||stars<0||stars>1000000||!Number.isInteger(days)||days<1||days>3650)return bad(c,400,"INVALID_PLAN");const valid=await c.env.DB.prepare("SELECT feature_key FROM premium_feature_catalog WHERE enabled=1").all<any>();const allowed=new Set(valid.results.map(x=>x.feature_key));if(features.some((x:string)=>!allowed.has(x)))return bad(c,400,"INVALID_FEATURE");const r=await c.env.DB.prepare("INSERT INTO premium_plans(name,stars,duration_days,active,created_at,features) VALUES(?1,?2,?3,?4,?5,?6) RETURNING id").bind(name,stars,days,b.active===false?0:1,now(),JSON.stringify(features)).first<any>();return c.json({ok:true,id:r.id})});
chat.patch("/admin/plans/:id",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const id=Number(c.req.param("id")),b=await c.req.json().catch(()=>({})),old=await c.env.DB.prepare("SELECT * FROM premium_plans WHERE id=?1").bind(id).first<any>();if(!old)return bad(c,404,"PLAN_NOT_FOUND");const name=b.name===undefined?old.name:String(b.name).trim().slice(0,80),stars=b.stars===undefined?old.stars:Number(b.stars),days=b.durationDays===undefined?old.duration_days:Number(b.durationDays),active=b.active===undefined?old.active:(b.active?1:0),features=b.features===undefined?JSON.parse(old.features||"[]"):b.features;if(!name||!Number.isInteger(stars)||stars<0||!Number.isInteger(days)||days<1||days>3650||!Array.isArray(features))return bad(c,400,"INVALID_PLAN");const valid=await c.env.DB.prepare("SELECT feature_key FROM premium_feature_catalog WHERE enabled=1").all<any>();const allowed=new Set(valid.results.map(x=>x.feature_key));if(features.some((x:string)=>!allowed.has(x)))return bad(c,400,"INVALID_FEATURE");await c.env.DB.prepare("UPDATE premium_plans SET name=?2,stars=?3,duration_days=?4,active=?5,features=?6 WHERE id=?1").bind(id,name,stars,days,active,JSON.stringify(features)).run();return c.json({ok:true})});
chat.delete("/admin/plans/:id",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const id=Number(c.req.param("id"));const r=await c.env.DB.prepare("UPDATE premium_plans SET active=0 WHERE id=?1").bind(id).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"PLAN_NOT_FOUND")});
chat.put("/admin/pin-limits",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const b=await c.req.json().catch(()=>({})),free=Number(b.freePinLimit),premium=Number(b.premiumPinLimit);if(!Number.isInteger(free)||free<0||free>100||!Number.isInteger(premium)||premium<free||premium>500)return bad(c,400,"INVALID_LIMIT");await c.env.DB.prepare("UPDATE chat_platform_settings SET free_pin_limit=?1,premium_pin_limit=?2,updated_at=?3 WHERE id=1").bind(free,premium,now()).run();return c.json({ok:true})});

chat.get("/admin/reports",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const r=await c.env.DB.prepare("SELECT r.id,r.reporter_id,r.reported_user_id,r.message_id,r.reason,r.status,r.created_at,u.first_name,u.username FROM chat_reports r LEFT JOIN users u ON u.id=r.reported_user_id WHERE r.status='open' ORDER BY r.created_at LIMIT 100").all();return c.json({reports:r.results})});
chat.patch("/admin/reports/:id",async c=>{if(!isOwner(c.env,c.get("settings"),c.get("user").id))return bad(c,403,"FORBIDDEN");const id=Number(c.req.param("id")),b=await c.req.json().catch(()=>({})),status=b.status==="resolved"?"resolved":"dismissed";const r=await c.env.DB.prepare("UPDATE chat_reports SET status=?2 WHERE id=?1 AND status='open'").bind(id,status).run();return r.meta.changes?c.json({ok:true}):bad(c,404,"REPORT_NOT_FOUND")});
