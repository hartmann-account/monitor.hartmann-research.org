/* Schwellenländer: Aktien, Währungen, Konjunktur und Geldpolitik aus amtlichen bzw. frei lizenzierten Quellen.
   - Nasdaq-Emerging-Markets-Index und Länderindizes für China, Indien, Taiwan, Korea und Brasilien in US-Dollar (täglich seit
     2001, über FRED; vor dem Start im Dezember 2012 zurückgerechnet). Korea zählt Nasdaq seit 2015 zu den Industrieländern
   - Dollar gegenüber den Währungen der Schwellenländer (Fed, täglich seit 2006; davor Monatswerte seit 1973)
   - OECD-Aktienindizes und Wechselkurse von 15 Schwellenländern seit 1957: daraus ein nach Wirtschaftsleistung gewichteter
     Korb in US-Dollar für die Zeit vor 2001 (nur Archiv, Grundlage des Backtests)
   - OECD-Frühindikatoren, BIZ-Leitzinsen und reale effektive Wechselkurse der großen Schwellenländer */
import { monthlySeries } from "./lib/series.js";
import { meta, since, start, D, M } from "./lib/jobutil.js";
import { fredMulti, oecd, worldbank } from "./providers/official.js";
import { bis } from "./providers/markets.js";

const ym = pts => pts.map(([d, v]) => [String(d).slice(0, 7), v]);
const NASDAQ = "© Nasdaq, Inc., über FRED";

/* Länder des Korbs: OECD-Kürzel auf FRED, ISO3 der Weltbank, Zeitfenster als Schwellenland (näherungsweise wie die großen
   Indexanbieter: Griechenland 2001–2013 Industrieland, Israel seit 2010 Industrieland, Russland seit März 2022 nicht mehr
   investierbar; Brasilien erst ab dem Real 1995, davor verzerrt die Hyperinflation die Umrechnung) */
export const EM_BASKET = [
  { fred: "IN", wb: "IND", id: "in", name: "Indien" }, { fred: "ZA", wb: "ZAF", id: "za", name: "Südafrika" },
  { fred: "MX", wb: "MEX", id: "mx", name: "Mexiko" }, { fred: "KR", wb: "KOR", id: "kr", name: "Korea" },
  { fred: "BR", wb: "BRA", id: "br", name: "Brasilien", from: "1995-01" }, { fred: "TR", wb: "TUR", id: "tr", name: "Türkei" },
  { fred: "CL", wb: "CHL", id: "cl", name: "Chile" }, { fred: "ID", wb: "IDN", id: "id", name: "Indonesien" },
  { fred: "CN", wb: "CHN", id: "cn", name: "China" }, { fred: "PL", wb: "POL", id: "pl", name: "Polen" },
  { fred: "HU", wb: "HUN", id: "hu", name: "Ungarn" }, { fred: "CZ", wb: "CZE", id: "cz", name: "Tschechien" },
  { fred: "GR", wb: "GRC", id: "gr", name: "Griechenland", gap: ["2001-06", "2013-10"] },
  { fred: "IL", wb: "ISR", id: "il", name: "Israel", to: "2010-05" }, { fred: "RU", wb: "RUS", id: "ru", name: "Russland", to: "2022-02" },
];
const inWindow = (c, m) => (!c.from || m >= c.from) && (!c.to || m <= c.to) && (!c.gap || m < c.gap[0] || m > c.gap[1]);
const nextMonth = m => { const y = +m.slice(0, 4), k = +m.slice(5, 7); return k === 12 ? `${y + 1}-01` : `${y}-${String(k + 1).padStart(2, "0")}`; };

/* Korb in US-Dollar: Monatsrendite = gewichtetes Mittel der Länderrenditen (Aktienindex ÷ Wechselkurs), Gewicht = BIP in
   US-Dollar des Vorjahres (Weltbank); es zählen die Länder mit Werten in beiden Monaten. Liefert die Indexreihe (Start 100)
   und je Land die Kurse in US-Dollar. */
export function emBasket(r, gdp) {
  const usd = {}, months = new Set();
  for (const c of EM_BASKET) {
    const sp = r[`SPASTT01${c.fred}M661N`], fx = r[`CCUSMA02${c.fred}M618N`];
    if (!sp || !fx) continue;
    const fxm = new Map(ym(fx));
    const m = new Map();
    for (const [k, v] of ym(sp)) { const f = fxm.get(k); if (v > 0 && f > 0) m.set(k, v / f); }
    usd[c.id] = m;
    for (const k of m.keys()) months.add(k);
  }
  const weight = (c, month) => {
    const y = +month.slice(0, 4) - 1;
    let best = null;
    for (const [yy, v] of gdp[c.wb] || []) if (yy <= y && v > 0 && (!best || yy > best[0])) best = [yy, v];
    return best ? best[1] : null;
  };
  const ms = [...months].sort(), out = [];
  let level = null;
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1], b = ms[i];
    if (nextMonth(a) !== b) { level = null; continue; }
    let num = 0, den = 0;
    for (const c of EM_BASKET) {
      const m = usd[c.id];
      if (!m || !inWindow(c, a) || !inWindow(c, b)) continue;
      const p0 = m.get(a), p1 = m.get(b), w = weight(c, b);
      if (p0 && p1 && w) { num += w * (p1 / p0 - 1); den += w; }
    }
    if (!den) continue;
    if (level == null) { if (out.length) break; level = 100; out.push([a, level]); }
    level *= 1 + num / den;
    out.push([b, level]);
  }
  return { index: out, usd };
}

export const EM_JOBS = [
  {
    // Tageswerte für Seite und Modell, mit ganzer Historie im Snapshot (20-Jahres-Trends live wie im Backtest)
    id: "em_markets", label: "Schwellenländer: Aktien in US-Dollar (Nasdaq Emerging Markets; China, Indien, Taiwan, Korea, Brasilien), Dollar gegenüber ihren Währungen", source: "fred", every: 6, cost: 1, keep: true, deep: "2001-01-01",
    async run(F, ctx) {
      const r = await fredMulti(F, ["NASDAQNQEM", "NASDAQNQCN", "NASDAQNQIN", "NASDAQNQTW", "NASDAQNQKR", "NASDAQNQBR", "DTWEXEMEGS"], since(ctx, "eq_em", "2001-01-01"));
      const s = {};
      const put = (sid, fid, l, u, note) => { if (r[fid]) s[sid] = D(ctx, sid, r[fid], meta(l, u, "fred", { fred: fid, note })); };
      put("eq_em", "NASDAQNQEM", "Aktien Schwellenländer (Nasdaq Emerging Markets Index, in US-Dollar)", "Punkte", NASDAQ);
      put("eq_cn_usd", "NASDAQNQCN", "Aktien China (Nasdaq China Index, in US-Dollar)", "Punkte", NASDAQ);
      put("eq_in_usd", "NASDAQNQIN", "Aktien Indien (Nasdaq India Index, in US-Dollar)", "Punkte", NASDAQ);
      put("eq_tw_usd", "NASDAQNQTW", "Aktien Taiwan (Nasdaq Taiwan Index, in US-Dollar)", "Punkte", NASDAQ);
      put("eq_kr_usd", "NASDAQNQKR", "Aktien Korea (Nasdaq Korea Index, in US-Dollar)", "Punkte", NASDAQ);
      put("eq_br_usd", "NASDAQNQBR", "Aktien Brasilien (Nasdaq Brazil Index, in US-Dollar)", "Punkte", NASDAQ);
      put("usd_em", "DTWEXEMEGS", "US-Dollar gegenüber den Währungen der Schwellenländer (Fed, handelsgewichtet)", "Index Jan. 2006 = 100");
      if (!s.eq_em) throw new Error("FRED: Nasdaq Emerging Markets Index fehlt");
      return { series: s };
    },
  },
  {
    // Langreihen für den Backtest: der Korb vor 2001, Länderkurse in US-Dollar, Dollarindex 1973–2019 (nur Archiv)
    id: "em_history", label: "Schwellenländer: Aktienkorb in US-Dollar seit 1960 (OECD-Indizes, Weltbank-BIP), Dollarindex seit 1973 (nur Archiv)", source: "fred", every: 24 * 7, cost: 5, archiveOnly: true, requires: ["DB"],
    async run(F, ctx) {
      const ids = EM_BASKET.flatMap(c => [`SPASTT01${c.fred}M661N`, `CCUSMA02${c.fred}M618N`]);
      const [r, old, gdp] = await Promise.all([
        fredMulti(F, ids, "1957-01-01"),
        fredMulti(F, ["TWEXOMTH"], "1973-01-01"),
        worldbank(F, EM_BASKET.map(c => c.wb), "NY.GDP.MKTP.CD", { date: "1960:2030" }),
      ]);
      const { index, usd } = emBasket(r, gdp);
      if (index.length < 300) throw new Error(`Schwellenländerkorb: nur ${index.length} Monate`);
      const s = {
        eqh_em: monthlySeries(index, meta(`Aktien Schwellenländer: Korb aus ${EM_BASKET.length} OECD-Länderindizes in US-Dollar, nach BIP gewichtet`, "Index", "fred")),
      };
      for (const c of EM_BASKET) {
        const m = usd[c.id];
        if (m && m.size) s[`eqh_${c.id}_usd`] = monthlySeries([...m.entries()], meta(`Aktien ${c.name} in US-Dollar (OECD-Index ÷ Wechselkurs)`, "Index", "fred"));
      }
      if (old.TWEXOMTH) s.usd_em_old = monthlySeries(ym(old.TWEXOMTH), meta("US-Dollar gegenüber wichtigen Handelspartnern außerhalb der Industrieländer (Fed, 1973–2019)", "Index", "fred", { fred: "TWEXOMTH" }));
      // jeder Lauf rechnet die ganze Historie neu (BIP-Revisionen ändern die Gewichte): vollständig ins Archiv schreiben
      if (ctx && ctx.raw) {
        ctx.raw.eqh_em = index;
        for (const c of EM_BASKET) if (usd[c.id] && usd[c.id].size) ctx.raw[`eqh_${c.id}_usd`] = [...usd[c.id].entries()];
      }
      return { series: s };
    },
  },
  {
    id: "oecd_cli_em", label: "OECD-Frühindikatoren der Schwellenländer (Brasilien, Mexiko, Korea, Südafrika, Indonesien, Türkei)", source: "oecd", every: 24, cost: 1, onePerRun: true, deep: "1955-01-01",
    async run(F, ctx) {
      const names = { BRA: ["br", "Brasilien"], MEX: ["mx", "Mexiko"], KOR: ["kr", "Korea"], ZAF: ["za", "Südafrika"], IDN: ["id", "Indonesien"], TUR: ["tr", "Türkei"] };
      const r = await oecd(F, "OECD.SDD.STES,DSD_STES@DF_CLI,4.1", `${Object.keys(names).join("+")}.M.LI.IX._Z.AA.IX._Z.H`, { start: start(ctx, "2010-01") });
      const s = {};
      for (const [c, [iso, name]] of Object.entries(names)) {
        const pts = (r[c] || []).filter(p => p[1] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        if (pts.length) s["cli_" + iso] = M(ctx, "cli_" + iso, pts, meta(`Frühindikator ${name} (OECD, amplitudenbereinigt)`, "Index, Mittel = 100", "oecd"));
      }
      if (!Object.keys(s).length) throw new Error("OECD: keine Frühindikatoren der Schwellenländer");
      return { series: s };
    },
  },
  {
    id: "bis_em", label: "Schwellenländer: Leitzinsen und reale effektive Wechselkurse (BIZ)", source: "bis", every: 12, cost: 2, keep: true, deep: "1980-01-01",
    async run(F, ctx) {
      const names = { BR: "Brasilien", MX: "Mexiko", KR: "Korea", ZA: "Südafrika", ID: "Indonesien", TR: "Türkei", TW: "Taiwan" };
      const pol = Object.keys(names).filter(c => c !== "TW").join("+");
      const [p, e] = await Promise.all([
        bis(F, "WS_CBPOL", `D.${pol}`, since(ctx, "pr_br", "2014-01-01", 120)),
        bis(F, "WS_EER", `M.R.B.${Object.keys(names).join("+")}`, start(ctx, "2000-01")),
      ]);
      const s = {};
      for (const [c, name] of Object.entries(names)) {
        const iso = c.toLowerCase();
        if (p["D." + c] && p["D." + c].length) s["pr_" + iso] = D(ctx, "pr_" + iso, p["D." + c], meta(`Leitzins ${name}`, "%", "bis"));
        if (e["M.R.B." + c] && e["M.R.B." + c].length) s["reer_" + iso] = monthlySeries(e["M.R.B." + c], meta(`Realer effektiver Wechselkurs ${name}`, "Index 2020 = 100", "bis"));
      }
      if (!Object.keys(s).length) throw new Error("BIZ: keine Daten der Schwellenländer");
      return { series: s };
    },
  },
];
