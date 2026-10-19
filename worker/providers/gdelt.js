/* GDELT 2.0 Event-Exporte (alle 15 Minuten eine ZIP-Datei mit rund 1.000 Ereignissen).
   Die DOC-API sperrt geteilte Cloud-Adressen häufig (HTTP 429); die statischen Exportdateien sind dagegen
   dauerhaft abrufbar. Je Länderpaar wird wie bei World Monitor die Konfliktintensität
     Σ NumMentions × max(0, −GoldsteinScale)  über Ereignisse der QuadClass 3 und 4
   gebildet, dazu die Kooperation (QuadClass 1 und 2) und die Zahl der Ereignisse. Tageswerte werden
   inkrementell fortgeschrieben; normiert wird mit allen Erwähnungen des Tages. */

import { unzip } from "../lib/zip.js";

export const GDELT_BASE = "https://data.gdeltproject.org/gdeltv2/";

// Länderpaare (CAMEO-Ländercodes). Eine Seite darf mehrere Codes enthalten (Europa).
export const PAIRS = [
  { id: "us_cn", label: "USA – China", a: ["USA"], b: ["CHN"] },
  { id: "cn_tw", label: "China – Taiwan", a: ["CHN"], b: ["TWN"] },
  { id: "ru_ua", label: "Russland – Ukraine", a: ["RUS"], b: ["UKR"] },
  { id: "ru_eu", label: "Russland – Europa", a: ["RUS"], b: ["DEU", "FRA", "GBR", "POL", "EUR", "ITA", "FIN", "EST", "LVA", "LTU"] },
  { id: "us_ru", label: "USA – Russland", a: ["USA"], b: ["RUS"] },
  { id: "il_ir", label: "Israel – Iran", a: ["ISR"], b: ["IRN"] },
  { id: "us_ir", label: "USA – Iran", a: ["USA"], b: ["IRN"] },
  { id: "cn_jp", label: "China – Japan", a: ["CHN"], b: ["JPN"] },
  { id: "in_pk", label: "Indien – Pakistan", a: ["IND"], b: ["PAK"] },
  { id: "in_cn", label: "Indien – China", a: ["IND"], b: ["CHN"] },
  { id: "kp", label: "Nordkorea – USA, Südkorea, Japan", a: ["PRK"], b: ["USA", "KOR", "JPN"] },
  { id: "us_eu", label: "USA – Europa", a: ["USA"], b: ["DEU", "FRA", "EUR", "ITA", "ESP", "NLD", "BEL"] },
  { id: "us_ch", label: "USA – Schweiz", a: ["USA"], b: ["CHE"] },
];

const LOOKUP = (() => {
  const m = new Map();
  for (const p of PAIRS) for (const a of p.a) for (const b of p.b) { m.set(a + "|" + b, p.id); m.set(b + "|" + a, p.id); }
  return m;
})();

export async function unzipFirst(u8) {
  const files = await unzip(u8);
  const names = Object.keys(files);
  if (!names.length) throw new Error("GDELT: leeres ZIP-Archiv");
  return files[names[0]];
}

/* Wertet eine Exportdatei aus: { total: Erwähnungen aller Ereignisse, n: Ereignisse, pairs: { id: [konflikt, kooperation, ereignisse] } } */
export function parseExport(txt) {
  const out = { total: 0, n: 0, pairs: {} };
  let pos = 0;
  const L = txt.length;
  while (pos < L) {
    let end = txt.indexOf("\n", pos);
    if (end < 0) end = L;
    const line = txt.slice(pos, end);
    pos = end + 1;
    if (line.length < 50) continue;
    const f = line.split("\t");
    const nm = +f[31] || 0;
    out.total += nm;
    out.n++;
    const a = f[7], b = f[17];
    if (!a || !b || a === b) continue;
    const id = LOOKUP.get(a + "|" + b);
    if (!id) continue;
    const qc = +f[29], gs = +f[30];
    const e = out.pairs[id] || (out.pairs[id] = [0, 0, 0]);
    if (qc >= 3) e[0] += nm * Math.max(0, -gs); else e[1] += nm * Math.max(0, gs);
    e[2]++;
  }
  return out;
}

export async function fetchExport(F, stamp) {
  const r = await F.request(`${GDELT_BASE}${stamp}.export.CSV.zip`, { timeout: 30000 });
  const u8 = new Uint8Array(await r.arrayBuffer());
  return parseExport(await unzipFirst(u8));
}

export async function latestStamp(F) {
  const txt = await F.text(`${GDELT_BASE}lastupdate.txt`, { timeout: 15000 });
  const m = txt.match(/(\d{14})\.export\.CSV\.zip/);
  if (!m) throw new Error("GDELT: lastupdate.txt ohne Exportdatei");
  return m[1];
}

/* Zeitstempel der Datei vor/nach "stamp" (15-Minuten-Raster, UTC) */
export function stepStamp(stamp, k) {
  const t = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12)) + k * 900000;
  const d = new Date(t);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

/* Zustand: { days: { "YYYY-MM-DD": { files, total, n, pairs: { id: [c, k, n] } } }, last: stamp } */
export function addToState(state, stamp, res, keepDays = 150) {
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const d = state.days[day] || (state.days[day] = { files: 0, total: 0, n: 0, pairs: {} });
  d.files++;
  d.total += res.total;
  d.n += res.n;
  for (const [id, v] of Object.entries(res.pairs)) {
    const e = d.pairs[id] || (d.pairs[id] = [0, 0, 0]);
    e[0] += v[0]; e[1] += v[1]; e[2] += v[2];
  }
  if (!state.last || stamp > state.last) state.last = stamp;
  const keys = Object.keys(state.days).sort();
  while (keys.length > keepDays) delete state.days[keys.shift()];
  return state;
}

/* Tagesreihen je Paar: Konfliktintensität je 10.000 Erwähnungen; Tage mit zu wenig Dateien entfallen */
export function stateToSeries(state, minFiles = 8) {
  const days = Object.keys(state.days).sort();
  const out = {};
  for (const p of PAIRS) {
    const pts = [], coop = [], ev = [];
    for (const day of days) {
      const d = state.days[day];
      if (d.files < minFiles || !d.total) continue;
      const v = d.pairs[p.id] || [0, 0, 0];
      pts.push([day, 1e4 * v[0] / d.total]);
      coop.push([day, 1e4 * v[1] / d.total]);
      ev.push([day, v[2]]);
    }
    out[p.id] = { conflict: pts, coop, events: ev };
  }
  return out;
}
