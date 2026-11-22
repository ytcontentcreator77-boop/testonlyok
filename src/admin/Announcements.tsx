import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { BackNav, Screen, LargeTitle, Section, toast, errText } from "../ui";

type Announcement = { id:number; title:string; description:string; image_url:string|null; button_text:string; button_enabled:number; button_url:string|null; active:number; created_at:number };
const blank = () => ({ title:"", description:"", image_url:"", button_text:"Continue", button_enabled:false, button_url:"", active:true });

export function AdminAnnouncements() {
  const [items,setItems]=useState<Announcement[]>([]);
  const [form,setForm]=useState(blank());
  const [editing,setEditing]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const load=()=>{setLoading(true);api<{items:Announcement[]}>("/admin/announcements").then(r=>setItems(r.items??[])).catch(e=>toast(errText(e),"error")).finally(()=>setLoading(false));};
  useEffect(load,[]);
  const set=(k:keyof ReturnType<typeof blank>,v:any)=>setForm(x=>({...x,[k]:v}));
  const edit=(x:Announcement)=>{setEditing(x.id);setForm({title:x.title,description:x.description,image_url:x.image_url??"",button_text:x.button_text,button_enabled:!!x.button_enabled,button_url:x.button_url??"",active:!!x.active});};
  const reset=()=>{setEditing(null);setForm(blank());};
  const save=async()=>{if(!form.title.trim()){toast("Enter an announcement title","error");return;}if(form.image_url.trim()&&!/^https?:\/\//i.test(form.image_url.trim())){toast("Image URL must start with https://","error");return;}if(form.button_enabled&&!/^https?:\/\//i.test(form.button_url.trim())){toast("Add a valid button link or disable link mode","error");return;}setBusy(true);try{if(editing)await api("/admin/announcements/"+editing,{method:"PUT",body:{...form,image_url:form.image_url||null}});else await api("/admin/announcements",{method:"POST",body:{...form,image_url:form.image_url||null}});toast("Announcement saved","ok");reset();load();}catch(e){toast(errText(e),"error");}setBusy(false);};
  const broadcast=async(id:number)=>{if(!confirm("Send this announcement to all users who can receive bot messages?"))return;setBusy(true);try{const r=await api<{total:number}>("/admin/announcements/"+id+"/broadcast",{method:"POST",body:{}});toast("Broadcast queued for "+r.total+" users","ok");}catch(e){toast(errText(e),"error");}setBusy(false);};
  const remove=async(id:number)=>{if(!confirm("Delete this announcement?"))return;try{await api("/admin/announcements/"+id,{method:"DELETE"});load();toast("Announcement deleted","ok");}catch(e){toast(errText(e),"error");}};
  const toggle=async(x:Announcement)=>{try{await api("/admin/announcements/"+x.id,{method:"PUT",body:{title:x.title,description:x.description,image_url:x.image_url,button_text:x.button_text,button_enabled:!!x.button_enabled,button_url:x.button_url,active:!x.active}});load();}catch(e){toast(errText(e),"error");}};
  const inputStyle={width:"100%",boxSizing:"border-box" as const,padding:"12px",borderRadius:"12px",border:"1px solid var(--line)",background:"var(--bg)",color:"var(--fg)",caretColor:"var(--accent)",font:"inherit",marginTop:"6px"};
  return <><BackNav to="/admin"/><Screen bottom="native"><LargeTitle size="title" title="Announcements" sub="Create floating Mini App announcements and broadcast them to Telegram users."/>
    <div class="card pad announcement-editor" style={{display:"grid",gap:"13px"}}>
      <b>{editing?"Edit announcement":"Create announcement"}</b>
      <label>Title<input style={inputStyle} maxLength={160} value={form.title} onInput={e=>set("title",(e.currentTarget as HTMLInputElement).value)} placeholder="Announcement title"/></label>
      <label>Description<textarea style={{...inputStyle,minHeight:"110px",resize:"vertical"}} maxLength={3000} value={form.description} onInput={e=>set("description",(e.currentTarget as HTMLTextAreaElement).value)} placeholder="Write announcement details. Variables: {name}, {first_name}, {last_name}, {username}, {user_id}, {balance}, {brand}, {support}"/></label>
      <label>Image URL (optional)<input style={inputStyle} value={form.image_url} onInput={e=>set("image_url",(e.currentTarget as HTMLInputElement).value)} placeholder="https://example.com/image.jpg"/></label>
      <label style={{display:"flex",alignItems:"center",gap:"10px"}}><input type="checkbox" checked={form.button_enabled} onChange={e=>set("button_enabled",(e.currentTarget as HTMLInputElement).checked)}/> Enable button link</label>
      <label>Button text<input style={inputStyle} maxLength={64} value={form.button_text} onInput={e=>set("button_text",(e.currentTarget as HTMLInputElement).value)} placeholder="Join now / Confirm / Continue"/></label>
      {form.button_enabled?<label>Button link (required)<input style={inputStyle} value={form.button_url} onInput={e=>set("button_url",(e.currentTarget as HTMLInputElement).value)} placeholder="https://t.me/yourchannel"/></label>:<small style={{color:"var(--muted)"}}>Link mode is off: the button will simply close the popup.</small>}
      <label style={{display:"flex",alignItems:"center",gap:"10px"}}><input type="checkbox" checked={form.active} onChange={e=>set("active",(e.currentTarget as HTMLInputElement).checked)}/> Show in Mini App</label>
      <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}><button class="btn primary" disabled={busy} onClick={save}>{busy?"Saving…":editing?"Save changes":"Create announcement"}</button>{editing?<button class="btn soft" onClick={reset}>Cancel edit</button>:null}</div>
    </div>
    <Section header="Saved announcements">{loading?<div class="card pad">Loading…</div>:items.length?items.map(x=><div class="card pad" style={{display:"grid",gap:"8px",marginBottom:"10px"}} key={x.id}>{x.image_url?<img src={x.image_url} alt="" style={{width:"100%",maxHeight:"150px",objectFit:"cover",borderRadius:"12px"}}/>:null}<b>{x.title}</b><small style={{color:"var(--muted)"}}>{x.active?"Active in Mini App":"Hidden"} · {x.button_enabled?"Link button":"Close button"}</small><div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}><button class="btn soft" onClick={()=>edit(x)}>Edit</button><button class="btn soft" disabled={busy} onClick={()=>void broadcast(x.id)}>Broadcast to all</button><button class="btn soft" onClick={()=>void toggle(x)}>{x.active?"Disable":"Enable"}</button><button class="btn danger" onClick={()=>void remove(x.id)}>Delete</button></div></div>):<div class="card pad">No announcements created yet.</div>}</Section>
    <Section header="Personalization variables"><div class="card pad"><code>{"{name}"}</code> full name · <code>{"{first_name}"}</code> first name · <code>{"{last_name}"}</code> last name · <code>{"{username}"}</code> Telegram username · <code>{"{user_id}"}</code> Telegram ID · <code>{"{balance}"}</code> wallet balance · <code>{"{brand}"}</code> app brand · <code>{"{support}"}</code> support contact. Telegram broadcast also supports <code>{"{totalkeys}"}</code>, <code>{"{key_1}"}</code>, <code>{"{key_2}"}</code>, <code>{"{key_3}"}</code>, <code>{"{product}"}</code>, <code>{"{expiry}"}</code>, <code>{"{joined}"}</code>, and <code>{"{orders}"}</code>.</div></Section>
  </Screen></>;
}
