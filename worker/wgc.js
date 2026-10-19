/* World Gold Council (Goldhub): Excel-Dateien aus dem privaten Eingang eingang/wgc/ (die Seiten des WGC verlangen eine
   Anmeldung, die Dateien werden deshalb hochgeladen). Der Job wgc liest je Art die neueste Datei und schreibt Reihen mit
   dem Präfix wgc_ ins Datenarchiv:
   - ETF-Bestände und Zuflüsse in Tonnen, monatlich seit 2003, weltweit und je Region (ETF_Flows_….xlsx)
   - Käufe und Verkäufe der Zentralbanken laut IWF-Meldungen in Tonnen je Monat seit 2002, weltweit und große Käufer
     (Changes_latest_….xlsx)
   - Angebot und Nachfrage je Quartal seit 2010 in Tonnen, mit den nicht gemeldeten Zentralbankkäufen (GDT_Tables_….xlsx)
   - Preisaufschlag am chinesischen (seit 2003) und indischen Markt (seit 2012) gegenüber London in US-$ je Unze, täglich
     (gold-premiums.xlsx)
   Quelle auf der Seite: World Gold Council (Goldhub). */
import { readXlsx, excelDate } from "./lib/xlsx.js";
import { meta } from "./lib/jobutil.js";
import { dailySeries, monthlySeries, quarterlySeries } from "./lib/series.js";
import { INBOX } from "./inbox.js";

const DIR = INBOX + "wgc/";
// Stand des Einlesens: Eine Änderung hier liest unveränderte Dateien neu ein (2: ETF-Zuflüsse als Summe der Fonds)
const PARSER_V = 2;
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);
const ym = d => d.slice(0, 7);
const findSheet = (sheets, re) => sheets.find(s => re.test(s.name));
const label = v => String(v == null ? "" : v).trim();
const sum = a => a.reduce((x, y) => x + y, 0);

/* ETF: Blätter "Holdings by month" (Bestand) und "Demand by month" (Zufluss); Kopfzeile mit "Date" in Spalte A, darüber
   die Zeile "Region" je Fonds; ab Spalte F je Fonds in Tonnen. Insgesamt = Summe der Fonds (Spalte D wiederholt in beiden
   Blättern den Bestand) */
export function parseEtf(sheets) {
  const out = {};
  const REG = { "North America": "na", Europe: "eu", Asia: "asia", Other: "other" };
  for (const [sheet, kind] of [[/^Holdings by month$/i, "t"], [/^Demand by month$/i, "flow"]]) {
    const s = findSheet(sheets, sheet);
    if (!s) continue;
    const h = s.rows.findIndex(r => label(r[0]) === "Date");
    const reg = s.rows.find(r => label(r[0]) === "Region") || [];
    if (h < 0) continue;
    const tot = [], byReg = {};
    for (const r of s.rows.slice(h + 1)) {
      if (typeof r[0] !== "number") continue;
      const d = ym(excelDate(r[0]));
      const acc = {};
      let all = null;
      for (let c = 5; c < r.length; c++) {
        const k = REG[label(reg[c])], v = num(r[c]);
        if (v == null) continue;
        all = (all || 0) + v;
        if (k) acc[k] = (acc[k] || 0) + v;
      }
      if (all != null) tot.push([d, all]);
      for (const [k, v] of Object.entries(acc)) (byReg[k] || (byReg[k] = [])).push([d, v]);
    }
    out[kind] = { total: tot, ...byReg };
  }
  return out;
}

/* Zentralbanken: Blatt "Monthly", Kopfzeile mit "Country" in Spalte B, darin ab Spalte D die Monate (Excel-Datum);
   je Land die Veränderung in Tonnen. Weltweit = Summe aller Länderzeilen (die Zeile "Turkey*" ist eine zweite Fassung
   der Türkei und zählt nicht mit) */
export function parseCentralBanks(sheets) {
  const s = findSheet(sheets, /^Monthly$/i);
  if (!s) return null;
  const h = s.rows.findIndex(r => label(r[1]) === "Country");
  if (h < 0) return null;
  const dates = s.rows[h].map(v => (typeof v === "number" ? ym(excelDate(v)) : null));
  const world = new Map(), countries = {};
  const pick = { "China, P.R.: Mainland": "cn", "Russian Federation": "ru", India: "in", Turkey: "tr", "Poland, Rep. of": "pl" };
  for (const r of s.rows.slice(h + 1)) {
    const name = label(r[1]);
    if (!name || name.endsWith("*")) continue;
    for (let c = 3; c < r.length; c++) {
      const v = num(r[c]), d = dates[c];
      if (v == null || !d) continue;
      world.set(d, (world.get(d) || 0) + v);
      if (pick[name]) (countries[pick[name]] || (countries[pick[name]] = [])).push([d, v]);
    }
  }
  return { world: [...world.entries()].sort(), ...countries };
}

/* Gold Demand Trends: Blatt "Gold Balance", Kopfzeile mit Quartalen "Q1'10" …; Zeilen nach Bezeichnung */
export const GDT_ROWS = {
  "Total Supply": ["supply", "Goldangebot insgesamt"],
  "Mine Production": ["mine", "Minenproduktion"],
  "Recycled Gold": ["recycling", "Recycling"],
  "Jewellery Consumption": ["jewellery", "Schmucknachfrage"],
  Technology: ["technology", "Nachfrage der Technik"],
  Investment: ["investment", "Investmentnachfrage"],
  "Total Bar and Coin": ["barcoin", "Barren und Münzen"],
  "ETFs and Similar Products": ["etf_q", "ETFs und ähnliche Produkte"],
  "Central Bank and Other Institutions": ["cb", "Zentralbanken und andere Institutionen"],
  "Gold Demand": ["demand", "Goldnachfrage"],
  "OTC and other": ["otc", "Außerbörslich und Sonstiges"],
};
export function parseGdt(sheets) {
  const s = findSheet(sheets, /^Gold Balance$/i);
  if (!s) return null;
  const hr = s.rows.find(r => r.some(v => /^Q[1-4]'\d\d$/.test(label(v))));
  if (!hr) return null;
  const cols = [];
  hr.forEach((v, c) => { const m = /^Q([1-4])'(\d\d)$/.exec(label(v)); if (m) cols.push([c, `20${m[2]}-Q${m[1]}`]); });
  const out = {};
  for (const r of s.rows) {
    // die Bezeichnung steht vor den Quartalsspalten erneut (rechter Tabellenteil); maßgeblich ist die letzte vor der ersten Quartalsspalte
    const before = r.slice(0, cols[0][0]).map(label).filter(Boolean);
    const def = GDT_ROWS[before[before.length - 1]];
    if (!def || out[def[0]]) continue;
    out[def[0]] = cols.map(([c, q]) => [q, num(r[c])]).filter(p => p[1] != null);
  }
  return out;
}

/* Preisaufschläge: Blätter "Chinese premiums-discounts" und "Indian premiums-discounts", Datum (Text oder Excel-Zahl) und Wert */
export function parsePremiums(sheets) {
  const out = {};
  for (const [re, k] of [[/^Chinese prem/i, "cn"], [/^Indian prem/i, "in"]]) {
    const s = findSheet(sheets, re);
    if (!s) continue;
    const pts = [];
    for (const r of s.rows) {
      const d = typeof r[0] === "number" ? excelDate(r[0]) : /^\d{4}-\d{2}-\d{2}$/.test(label(r[0])) ? label(r[0]) : null;
      const v = num(r[1]);
      if (d && v != null) pts.push([d, v]);
    }
    out[k] = pts;
  }
  return out;
}

/* Alle Reihen aus den eingelesenen Arbeitsmappen (books: { etf, cb, gdt, prem } → Blätter) */
export function wgcSeries(books) {
  const s = {}, m = (l, u, extra) => meta(l, u, "wgc", extra);
  const REGL = { na: "Nordamerika", eu: "Europa", asia: "Asien", other: "übrige Welt" };
  if (books.etf) {
    const e = parseEtf(books.etf);
    if (e.t) {
      s.wgc_etf_t = monthlySeries(e.t.total, m("Goldbestand der Gold-ETFs weltweit", "Tonnen"));
      for (const k of Object.keys(REGL)) if (e.t[k]) s[`wgc_etf_t_${k}`] = monthlySeries(e.t[k], m(`Goldbestand der Gold-ETFs: ${REGL[k]}`, "Tonnen"));
    }
    if (e.flow) {
      s.wgc_etf_flow = monthlySeries(e.flow.total, m("Zuflüsse der Gold-ETFs weltweit", "Tonnen je Monat"));
      for (const k of Object.keys(REGL)) if (e.flow[k]) s[`wgc_etf_flow_${k}`] = monthlySeries(e.flow[k], m(`Zuflüsse der Gold-ETFs: ${REGL[k]}`, "Tonnen je Monat"));
    }
  }
  if (books.cb) {
    const c = parseCentralBanks(books.cb);
    const CL = { cn: "China", ru: "Russland", in: "Indien", tr: "Türkei", pl: "Polen" };
    if (c) {
      s.wgc_cb_world = monthlySeries(c.world, m("Goldkäufe der Zentralbanken (IWF-Meldungen, netto)", "Tonnen je Monat"));
      for (const [k, l] of Object.entries(CL)) if (c[k]) s[`wgc_cb_${k}`] = monthlySeries(c[k], m(`Goldkäufe der Zentralbank: ${l} (IWF-Meldungen)`, "Tonnen je Monat"));
    }
  }
  if (books.gdt) {
    const g = parseGdt(books.gdt);
    if (g) for (const [, [k, l]] of Object.entries(GDT_ROWS)) if (g[k] && g[k].length) s[`wgc_q_${k}`] = quarterlySeries(g[k], m(`${l} (Gold Demand Trends)`, "Tonnen je Quartal"));
  }
  if (books.prem) {
    const p = parsePremiums(books.prem);
    if (p.cn) s.wgc_prem_cn = dailySeries(p.cn, m("Preisaufschlag am chinesischen Goldmarkt gegenüber London", "US-$ je Unze"));
    if (p.in) s.wgc_prem_in = dailySeries(p.in, m("Preisaufschlag am indischen Goldmarkt gegenüber London", "US-$ je Unze"));
  }
  return s;
}

/* neueste Datei je Art im Eingang */
const KINDS = { etf: /^ETF_Flows.*\.xlsx$/i, cb: /^Changes_latest.*\.xlsx$/i, gdt: /^GDT_Tables.*\.xlsx$/i, prem: /premium.*\.xlsx$/i };
export function pickFiles(objects) {
  const out = {};
  for (const o of objects) {
    const name = o.key.slice(DIR.length);
    for (const [k, re] of Object.entries(KINDS)) if (re.test(name) && (!out[k] || o.uploaded > out[k].uploaded)) out[k] = o;
  }
  return out;
}

export const WGC_JOBS = [{
  id: "wgc", label: "World Gold Council: ETF-Bestände, Zentralbankkäufe, Angebot und Nachfrage, Preisaufschläge (Eingang eingang/wgc/)",
  source: "wgc", every: 24, cost: 0, requires: ["ARCHIVE"], keep: true,
  async run(F, ctx) {
    const b = ctx.env.ARCHIVE;
    const r = await b.list({ prefix: DIR, limit: 1000 });
    const files = pickFiles(r.objects);
    const stamp = `v${PARSER_V}|` + Object.values(files).map(o => o.key + "@" + o.etag).sort().join("|");
    // unverändert: letzten Stand behalten (der Runner verlangt eine Ausgabe)
    if (ctx.prev && ctx.prev.items && ctx.prev.items[0] && ctx.prev.items[0].stamp === stamp && Object.keys(ctx.prev.series || {}).length) return ctx.prev;
    const books = {};
    for (const [k, o] of Object.entries(files)) {
      const obj = await b.get(o.key);
      if (obj) books[k] = await readXlsx(new Uint8Array(await obj.arrayBuffer()));
    }
    const series = wgcSeries(books);
    if (!Object.keys(series).length) throw new Error("Keine WGC-Dateien im Eingang eingang/wgc/ erkannt");
    return { series, items: [{ stamp, files: Object.fromEntries(Object.entries(files).map(([k, o]) => [k, o.key])) }] };
  },
}];

