#!/usr/bin/env node
/* Backtest des Anlagebarometers auf der Historie im Datenarchiv (D1), dieselbe Rechnung wie die Worker-Jobs backtest_*.
   Aufruf: node scripts/backtest.mjs [--local] [--api https://monitor.hartmann-it.workers.dev] [--from 1970-01]
                                    [--hz m1,y1,lt] [--panel datei.json] [--out datei.json]
   --local liest die lokale D1-Datenbank von wrangler dev (.wrangler/state), sonst die öffentliche API des Workers.
   --panel speichert alle Einzelwerte (Säulen, Gesamtwert, spätere Renditen), --out die Zusammenfassungen
   (public/data/backtest.json: Rückfall der Seite, solange der Worker noch keine eigenen Ergebnisse liefert). */
import { writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { btSeriesIds, buildBacktestLive, runPanel, summarizeBacktest } from "../worker/backtest.js";
import { BT_VERSION } from "../worker/jobs-backtest.js";

const require = createRequire(import.meta.url);
const { SIG } = require("../src/signals.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);

async function loadLocal() {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find(f => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  const catalog = db.prepare("SELECT id, freq FROM series").all();
  const freq = Object.fromEntries(catalog.map(r => [r.id, r.freq]));
  const raw = {};
  // wie im Worker: Tageswerte auf den letzten Wert je Kalenderwoche verdichtet
  for (const id of btSeriesIds(catalog.map(r => r.id))) {
    const sql = freq[id] === "D"
      ? "SELECT MAX(d) AS d, v FROM obs WHERE s = ? AND v IS NOT NULL GROUP BY strftime('%Y-%W', d) ORDER BY d"
      : "SELECT d, v FROM obs WHERE s = ? AND v IS NOT NULL ORDER BY d";
    raw[id] = { freq: freq[id], points: db.prepare(sql).all(id).map(r => [r.d, r.v]) };
  }
  return raw;
}
async function loadApi(base) {
  const cat = await (await fetch(`${base}/api/archive`)).json();
  const freq = Object.fromEntries(cat.series.map(s => [s.id, s.freq]));
  const ids = btSeriesIds(cat.series.map(s => s.id));
  const raw = {};
  for (let i = 0; i < ids.length; i += 5) {
    const part = ids.slice(i, i + 5);
    const r = await fetch(`${base}/api/series?id=${part.join(",")}&thin=w`);
    if (!r.ok) throw new Error(`API ${r.status} für ${part.join(",")}`);
    const j = await r.json();
    for (const id of part) if (j[id]) raw[id] = { freq: freq[id], points: j[id].points };
  }
  return raw;
}

const t0 = Date.now();
const raw = flag("--local") ? await loadLocal() : await loadApi(arg("--api", "https://monitor.hartmann-it.workers.dev"));
console.log(`geladen: ${Object.keys(raw).length} Reihen, ${Object.values(raw).reduce((a, r) => a + r.points.length, 0)} Werte (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const L = buildBacktestLive(raw);
const hzs = arg("--hz", "m1,y1,lt").split(",");
const t1 = Date.now();
const panel = runPanel(L, { from: arg("--from", "1970-01"), horizons: hzs });
console.log(`Panel: ${panel.length} Einträge in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
if (arg("--panel")) writeFileSync(arg("--panel"), JSON.stringify(panel));

const pct = v => (v == null ? "  –  " : (100 * v).toFixed(1).padStart(5));
const num = v => (v == null ? "  –  " : (v >= 0 ? " " : "") + v.toFixed(3));
const VERDICT = { ok: "belegt", weak: "schwach", fail: "NICHT belegt" };
const out = {};
for (const hz of hzs) {
  const S = summarizeBacktest(panel, hz);
  out[hz] = { ...S, at: new Date().toISOString(), version: `${SIG.cfg.version}/${BT_VERSION}`, origin: "Datei" };
  console.log(`\n=== ${SIG.horizon(hz).title}: ${S.months} Monatsenden ${S.from} – ${S.to} ===`);
  console.log("Anlageart    Fälle   nEff  Treffer [95 %-KI]     Basis  IC     [95 %-KI]        Teilperioden IC          ohne Vorgriff IC/Treffer  Brier-Skill  Urteil");
  for (const [k, a] of Object.entries(S.stats)) {
    const o = S.oos[k], b = S.brier[k];
    console.log(`${k.padEnd(11)} ${String(a.n).padStart(6)} ${String(a.nEff).padStart(6)}  ${pct(a.hit)} [${pct(a.lo)}–${pct(a.hi)}]  ${pct(a.base)}  ${num(a.ic)} [${num(a.icLo)}–${num(a.icHi)}]  ` +
      `${a.sub.map(x => (x ? num(x.ic) : "  –   ")).join(" ")}    ${o ? `${num(o.ic)} / ${pct(o.hit)}` : "      –       "}   ${b ? num(b.skill) : "  –  "}     ${VERDICT[a.verdict]}`);
  }
  const c = S.stats.all.cats;
  console.log("Anteil steigender Kurse je Stufe (alle): " + c.map(([cat, n, up, m]) => `${cat > 0 ? "+" : ""}${cat}: ${pct(up)} % (n=${n}, Ø ${pct(m)} %)`).join("  "));
}
if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(out));
