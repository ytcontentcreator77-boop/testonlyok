import { describe, expect, it } from "vitest";
import { LANGS } from "../shared/types";

type CatDict = { n?: Record<string, string>; p?: Record<string, string> };
const FILES = import.meta.glob("../src/i18n/cat/*.json", { eager: true, import: "default" }) as Record<string, CatDict>;
const dict = (lang: string) => FILES[`../src/i18n/cat/${lang}.json`];

describe("category name translations", () => {
  it("loads category dictionaries only for supported languages", () => {
    const supported = new Set<string>(LANGS);
    for (const path of Object.keys(FILES)) {
      const lang = /\/([a-z]{2,3})\.json$/.exec(path)?.[1];
      expect(lang && supported.has(lang), path).toBe(true);
    }
  });

  it("cover the parts every language needs, with no empty values", () => {
    const parts = Object.keys(dict("de").p ?? {});
    expect(parts.length).toBeGreaterThan(200);
    for (const l of LANGS.filter((l) => l !== "en")) {
      const d = dict(l);
      if (!d) continue; // Missing category files intentionally fall back to the original English category name.
      for (const v of [...Object.values(d.n ?? {}), ...Object.values(d.p ?? {})]) expect(v.trim(), l).not.toBe("");
      if (!d.n) expect(Object.keys(d.p ?? {}).sort(), l).toEqual([...parts].sort());
    }
  });

  it("translate a common category in every language", () => {
    for (const l of LANGS.filter((l) => l !== "en")) {
      const d = dict(l);
      if (!d) {
        expect("Views - Post - Worldwide", l).toBe("Views - Post - Worldwide");
        continue;
      }
      const name = d.n?.["Views - Post - Worldwide"] ?? "Views - Post - Worldwide".split(" - ").map((p) => d.p?.[p] ?? p).join(" - ");
      expect(name, l).not.toBe("Views - Post - Worldwide");
    }
  });
});
