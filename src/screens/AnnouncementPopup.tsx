import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { openLink } from "../tg";

type Item = { id:number; title:string; description:string; image_url:string|null; button_text:string; button_enabled:number; button_url:string|null };
type Vars = Record<string,string>;

export function AnnouncementPopup() {
  const [item,setItem]=useState<Item|null>(null);
  const [vars,setVars]=useState<Vars>({});
  const [closing,setClosing]=useState(false);
  useEffect(()=>{let live=true;api<{announcement:Item|null;vars?:Vars}>("/announcements/current").then(r=>{if(live){setItem(r.announcement);setVars(r.vars??{});}}).catch(()=>{});return()=>{live=false};},[]);
  const dismiss=()=>{if(!item||closing)return;setClosing(true);setItem(null);};
  if(!item)return null;
  const fill=(value:string)=>value.replace(/\{([a-z][a-z0-9_]*)\}/gi,(whole,key)=>vars[key.toLowerCase()]??whole);
  const title=fill(item.title),description=fill(item.description);
  const action=()=>{if(item.button_enabled&&item.button_url){openLink(item.button_url);void dismiss();}else void dismiss();};
  return <div class="announcement-backdrop" role="dialog" aria-modal="true" aria-label={title}>
    <div class="announcement-modal">
      <button type="button" class="announcement-close" aria-label="Close announcement" onClick={()=>void dismiss()}>×</button>
      {item.image_url?<img class="announcement-image" src={item.image_url} alt=""/>:null}
      <div class="announcement-content">
        <span class="announcement-eyebrow">ANNOUNCEMENT</span>
        <h2>{title}</h2>
        {description?<p>{description}</p>:null}
        <button type="button" class="announcement-action" onClick={action}>{fill(item.button_text||"Continue")}</button>
      </div>
    </div>
  </div>;
}
