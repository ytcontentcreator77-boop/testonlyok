import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { back } from "../router";
import { openLink, useBackButton } from "../tg";
import { LargeTitle, List, Row, Screen, Section, toast } from "../ui";

type Tutorial = { howto_title:string; howto_description:string; howto_youtube_url:string; howto_tiktok_url:string; howto_video_url:string; howto_fallback_url:string };
const empty:Tutorial={howto_title:"How to use this bot",howto_description:"Watch the tutorial to learn how to use the Mini App.",howto_youtube_url:"",howto_tiktok_url:"",howto_video_url:"",howto_fallback_url:""};
function youtubeEmbed(url:string):string|null {
  try {
    const u=new URL(url);
    let id="";
    if(u.hostname==="youtu.be") id=u.pathname.slice(1);
    else if(u.hostname.endsWith("youtube.com")) id=u.searchParams.get("v")||u.pathname.split("/").filter(Boolean).pop()||"";
    return /^[\w-]{11}$/.test(id)?`https://www.youtube-nocookie.com/embed/${id}`:null;
  } catch { return null; }
}
function Video({url,label}:{url:string;label:string}) {
  const embed=youtubeEmbed(url);
  const direct=/\.(mp4|webm|ogg)(?:$|\?)/i.test(url);
  if(embed) return <div class="card pad"><b>{label}</b><div style={{position:"relative",paddingBottom:"56.25%",height:0,overflow:"hidden",borderRadius:"12px",marginTop:"10px"}}><iframe src={embed} title={label} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen style={{position:"absolute",inset:0,width:"100%",height:"100%",border:0}} /></div></div>;
  if(direct) return <div class="card pad"><b>{label}</b><video controls playsInline preload="metadata" style={{width:"100%",marginTop:"10px",borderRadius:"12px"}} src={url}>Your browser does not support video playback.</video></div>;
  return <div class="card pad"><b>{label}</b><p class="hint">This video provider cannot be played here. Open it directly instead.</p><button class="btn primary" onClick={()=>openLink(url)}>Open video</button></div>;
}
export function HowToUse(){
 const [data,setData]=useState<Tutorial>(empty);
 useBackButton(()=>back("/profile"));
 useEffect(()=>{let live=true;api<Tutorial>("/how-to-use").then(v=>{if(live)setData({...empty,...v})}).catch(()=>{if(live)toast("Could not load tutorial settings","error")});return()=>{live=false}},[]);
 const links=[["YouTube",data.howto_youtube_url],["TikTok",data.howto_tiktok_url],["Video",data.howto_video_url]] as const;
 const videos=links.filter(x=>x[1]);
 return <Screen><LargeTitle size="large" title={data.howto_title||empty.howto_title} sub={data.howto_description||empty.howto_description}/><Section header="Video tutorials">{videos.length?videos.map(([label,url])=><Video key={label} label={label} url={url}/>):<p class="hint">No tutorial videos have been added yet.</p>}</Section>{data.howto_fallback_url?<Section header="Need more help?"><List><Row icon="chat" title="Open support / tutorial link" meta={data.howto_fallback_url} onClick={()=>openLink(data.howto_fallback_url)} external/></List></Section>:null}</Screen>;
}
