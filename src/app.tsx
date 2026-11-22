import { type JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError } from "./api";
import { refreshMe } from "./me";
import { setLang, useLang } from "./i18n";
import { useRoute } from "./router";
import { meStore } from "./store";
import { inTelegram, startParam } from "./tg";
import { ErrorState, Screen, Skeleton, Toasts } from "./ui";
import { Welcome } from "./screens/Welcome";
import { LanguagePick } from "./screens/LanguagePick";
import { ChannelGate } from "./screens/ChannelGate";
import { LazyPublicPages } from "./lazy";
import { ChatApp } from "./screens/ChatApp";
export function applyStartRoute() {
 const p=startParam;
 if(p==="profile"||p==="chats")if(location.hash===""||location.hash==="#/")history.replaceState(history.state,"","#/");
}
function AppSkeleton(){return <Screen bottom="none"><Skeleton h={180} radius={24}/><Skeleton h={44}/><Skeleton h={300} radius={20}/></Screen>}
export function App(){
 useLang();const me=meStore.use(),route=useRoute();const [error,setError]=useState<unknown>(null),[outside,setOutside]=useState(false);
 const load=()=>{setError(null);refreshMe().then(m=>setLang(m.lang)).catch(e=>{if(!inTelegram&&e instanceof ApiError&&e.code==="UNAUTHORIZED")setOutside(true);else setError(e)})};
 useEffect(load,[]);
 let screen:JSX.Element;
 if(outside||(import.meta.env.DEV&&route.path==="/__public"))screen=<LazyPublicPages/>;
 else if(error)screen=<Screen bottom="none" center><ErrorState error={error} onRetry={load}/></Screen>;
 else if(!me)screen=<AppSkeleton/>;
 else if(!me.langChosen)screen=<LanguagePick/>;
 else if(!me.termsAccepted)screen=<Welcome/>;
 else if(me.channelRequired)screen=<ChannelGate/>;
 else screen=<ChatApp/>;
 return <>{screen}<Toasts/></>;
}
