import type { Env } from "./env";
import { getSettings } from "./settings";

export interface KeyApiResult { key: string; keys: string[]; total_price: number }
interface ApiConfig { id?:string; url:string; api_key:string; master_key?:string|null; android_required?:number|boolean; enabled?:number|boolean }
async function config(env:Env, apiId?:string):Promise<ApiConfig>{
 const s=await getSettings(env);let id=apiId||s.active_key_api_id||"";
 if(id){const row=await env.DB.prepare("SELECT id,url,api_key,master_key,android_required,enabled FROM key_apis WHERE id=?1 AND enabled=1").bind(id).first<ApiConfig>();if(row)return row;throw new Error("KEY_API_NOT_CONFIGURED");}
 if(!s.reseller_api_key)throw new Error("KEY_API_NOT_CONFIGURED");
 return {url:s.reseller_api_url||"https://bantibhaiya.to/api/reseller_v1.php",api_key:s.reseller_api_key,master_key:s.reseller_master_key,android_required:false,enabled:true};
}
async function request(env: Env, action: string, params: Record<string, string> = {}, apiId?:string): Promise<any> {
  const cfg=await config(env,apiId);if(!cfg.api_key)throw new Error("KEY_API_NOT_CONFIGURED");
  const body = new URLSearchParams({ api_key: cfg.api_key, action, ...params });
  const headers: Record<string,string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cfg.master_key) headers["x-master-key"] = cfg.master_key;
  const res = await fetch(cfg.url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`KEY_API_HTTP_${res.status}`);
  const data: any = await res.json();
  if (data?.success === false || data?.error) throw new Error(String(data.error || data.message || "KEY_API_FAILED").slice(0, 180));
  return data;
}
export async function buyKey(env: Env, pid: string, duration: string, androidId?: string, apiId?:string): Promise<KeyApiResult> {
  const cfg=await config(env,apiId);if(cfg.android_required&&!androidId)throw new Error("ANDROID_ID_REQUIRED");
  const d = await request(env, "buy", { product_id: pid, duration, ...(androidId ? { android_id: androidId } : {}) },apiId);
  if (String(d.status ?? "").toLowerCase() !== "success") throw new Error(String(d.message ?? d.error ?? "KEY_API_FAILED"));
  const keys = Array.isArray(d.keys) ? d.keys.map(String) : (d.key || d.code || d.serial ? [String(d.key ?? d.code ?? d.serial)] : []);
  if (!keys.length) throw new Error("KEY_API_EMPTY_RESPONSE");
  return { key: keys[0], keys, total_price: Number(d.total_price ?? d.price ?? 0) };
}
export async function checkBalance(env: Env,apiId?:string): Promise<{ balance: number; currency: string }> {
  const d = await request(env, "balance", {},apiId);
  return { balance: Number(d.balance ?? d.amount ?? 0), currency: String(d.currency ?? "INR") };
}
export async function listProducts(env: Env,apiId?:string): Promise<any[]> {
  const d = await request(env, "products", {},apiId);
  return Array.isArray(d.products) ? d.products : Array.isArray(d) ? d : [];
}
