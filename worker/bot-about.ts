// Bot profile name and descriptions for the Amit Bot key store.
import { type Lang, LANGS } from "../shared/types";
import extra from "./bot-about-extra.json";

export type BotAbout = { name: string; short: string; description: string };

const LIMIT = { name: 64, short: 120, description: 512 };

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // would cut between a surrogate pair
  return s.slice(0, end);
}

/** Builds a text around the brand, shortening only the brand if the result would be too long. */
function fit(max: number, make: (b: string) => string, brand: string): string {
  const full = make(brand);
  if (full.length <= max) return full;
  const b = clip(brand, Math.max(1, brand.length - (full.length - max))).trimEnd();
  return clip(make(b), max);
}

/** Bot profile texts per language with the deployer's brand name inserted, within Telegram's limits. */
export function botAboutFor(brand: string): Record<Lang, BotAbout> {
  const out = {} as Record<Lang, BotAbout>;
  for (const l of LANGS) {
    out[l] = {
      name: fit(LIMIT.name, (b) => `${b} - Key Store 🔑`, brand),
      short: "Instant game and software keys. Add wallet balance in INR, choose a plan and receive your key instantly.",
      description: fit(LIMIT.description, (b) => `🔑 ${b} Key Store\n\n🎮 Game keys and software access\n📱 Android, iOS and PC products\n⚡ Instant key delivery from available stock\n💰 Add funds in INR (₹) using UPI and manual payment methods\n👛 Orders are paid securely from your wallet balance\n\n👇 Tap Start to browse products`, brand),
    };
  }
  return out;
}

type ExtraAbout = { term: string; short: string; description: string };
const EXTRA = extra as Record<string, ExtraAbout>;

/** Languages the bot profile is translated into: the 20 app languages first, then profile-only languages */
export const ABOUT_LANGS: string[] = [...LANGS, ...Object.keys(EXTRA).filter((l) => !(LANGS as readonly string[]).includes(l))];

/** Profile texts for every profile language (app languages + profile-only ones), brand inserted, within limits */
export function botAboutAll(brand: string): Record<string, BotAbout> {
  const out: Record<string, BotAbout> = { ...botAboutFor(brand) };
  for (const l of Object.keys(EXTRA)) {
    if (out[l]) continue;
    out[l] = {
      name: fit(LIMIT.name, (b) => `${b} - Key Store 🔑`, brand),
      short: "Instant game and software keys with INR wallet payments and fast delivery.",
      description: fit(LIMIT.description, (b) => `🔑 ${b} Key Store\n\n🎮 Game and software keys\n⚡ Instant delivery\n💰 INR wallet top-ups with UPI and manual methods\n👇 Tap Start to browse products`, brand),
    };
  }
  return out;
}

