#!/usr/bin/env node
/* Prüfungen gegen Rückschaufehler für die Seite (public/data/robustness.json):
   1. Prüfzeitraum vor 1970: das unveränderte Modell auf 1955–1969 (bei der Gewichtung nicht verwendet), mit Zufallstest.
   2. Echtzeit-Frühindikatoren: Kennzahlen seit 2001 mit den heute revidierten Werten (Frist 15 Tage) gegenüber den damals
      veröffentlichten Ausgaben (OECD-Revisionsdatenbank, data/cli_vintages.json).
   3. JST-Prüfung der Langfrist-Bausteine an 18 Ländern seit 1890 (pipeline/jst_check.py → data/jst_check.json), übernommen.
   4. mit --alfred datei.json: Baugenehmigungen und Fed Z.1 (Aktienanteil am Anlegervermögen) im damals veröffentlichten
      gegenüber dem heutigen Stand, ab dem ersten Datenstand (pipeline/alfred_snapshots.py bzw. Job alfred_vintages).
   Aufruf: node scripts/robustness.mjs [--alfred datei.json]   (liest die lokale D1-Datenbank wie scripts/backtest.mjs --local) */
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { btSeriesIds, buildBacktestLive, runPanel, categorize, accuracy, compactAccuracy, randomTest, spearman, THIN_SQL, FULL_SQL } from "../worker/backtest.js";

const require = createRequire(import.meta.url);
const { SIG } = require("../src/signals.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = f => join(root, "public", "data", f);

async function loadLocal() {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const db = new DatabaseSync(join(dir, readdirSync(dir).find(f => f.endsWith(".sqlite") && f !== "metadata.sqlite")), { readOnly: true });
  const catalog = db.prepare("SELECT id, freq FROM series").all();
  const freq = Object.fromEntries(catalog.map(r => [r.id, r.freq]));
  const raw = {};
  for (const id of btSeriesIds(catalog.map(r => r.id))) raw[id] = { freq: freq[id], points: db.prepare(freq[id] === "D" ? THIN_SQL : FULL_SQL).all(id).map(r => [r.d, r.v]) };
  return raw;
}
const KINDS = ["all", "equity", "bond", "credit", "fx", "gold", "commodity", "relative"];
const RK = { m1: "r1", y1: "r12", lt: "r60" };
const pick = a => a && { n: a.n, nEff: a.nEff, hit: a.hit, lo: a.lo, hi: a.hi, base: a.base, ic: a.ic, icLo: a.icLo, icHi: a.icHi, from: a.from, to: a.to };
const stats = (E, hz) => Object.fromEntries(KINDS.map(k => [k, pick(compactAccuracy(accuracy(k === "all" ? E : E.filter(e => e.kind === k), hz)))]).filter(([, v]) => v));

const raw = await loadLocal();
const vint = JSON.parse(readFileSync(data("cli_vintages.json"), "utf8")).editions;
const out = { generated: new Date().toISOString(), version: SIG.cfg.version };

// 1. vor 1970: Gold erst ab der Freigabe des Preises (1971), Währungen erst nach Bretton Woods (ohnehin ohne Daten)
{
  const L = buildBacktestLive(raw, { vintages: vint });
  const panel = runPanel(L, { from: "1955-01", to: SIG.dayOf("1969-12-31"), horizons: ["m1", "y1", "lt"] }).filter(e => e.kind !== "gold" && e.kind !== "fx" && e.id !== "rel_gold_eq" && e.id !== "rel_gold_bd");
  out.pre1970 = {};
  for (const hz of ["m1", "y1", "lt"]) {
    const E = categorize(panel.filter(e => e.hz === hz && e.score != null).map(e => ({ ...e })));
    out.pre1970[hz] = { stats: stats(E, hz), random: randomTest(E, hz), ids: [...new Set(E.map(e => e.id))] };
    const a = out.pre1970[hz].stats.all, r = out.pre1970[hz].random;
    console.log(`vor 1970 ${hz}: Treffer ${a && a.hit} (Basis ${a && a.base}), IC ${a && a.ic}, Zufall ${r ? `${r.icRand} / p ${r.pIc}` : "–"}`);
  }
}
// 2. Echtzeit gegen revidiert, Stichtage ab 2001 (Horizonte 1 und 12 Monate; 5–10 Jahre nutzt keine Frühindikatoren)
{
  out.realtime = { from: "2001-02" };
  const from = "2001-02";
  for (const mode of ["revised", "realtime"]) {
    const L = buildBacktestLive(raw, { vintages: mode === "realtime" ? vint : null });
    if (mode === "revised") for (const id of Object.keys(L.s)) if (id.startsWith("cli_")) L.s[id].lag = undefined; // wie bisher: Frist 15 Tage
    const panel = runPanel(L, { from, horizons: ["m1", "y1"] });
    out.realtime[mode] = {};
    for (const hz of ["m1", "y1"]) {
      const E = categorize(panel.filter(e => e.hz === hz && e.score != null).map(e => ({ ...e })));
      const cyc = hz === "m1" ? "cycle" : "cycle12", g = panel.filter(e => e.hz === hz && e.P[cyc] != null && e[RK[hz]] != null);
      const icCycle = spearman(g.map(e => e.P[cyc]), g.map(e => e[RK[hz]] / Math.max(0.02, e.vol || 0.15)));
      out.realtime[mode][hz] = { all: pick(compactAccuracy(accuracy(E, hz))), cycle: icCycle == null ? null : Math.round(icCycle * 1000) / 1000 };
      console.log(`${mode} ${hz} ab ${from}: IC ${out.realtime[mode][hz].all.ic}, Konjunktursäule ${out.realtime[mode][hz].cycle}`);
    }
  }
}
// 3. JST
if (existsSync(data("jst_check.json"))) out.jst = JSON.parse(readFileSync(data("jst_check.json"), "utf8"));
// 4. ALFRED: Aktien und Gold (Bewertung über den Aktienanteil), Horizonte 12 Monate und 5–10 Jahre, ab dem ersten Z.1-Datenstand
const ai = process.argv.indexOf("--alfred");
if (ai > 0) {
  const alfred = JSON.parse(readFileSync(process.argv[ai + 1], "utf8"));
  out.alfred = {};
  let from = null;
  for (const mode of ["revised", "realtime"]) {
    const L = buildBacktestLive(raw, { vintages: vint, alfred: mode === "realtime" ? alfred : null });
    if (mode === "realtime") from = SIG.isoOf(L.alfred.aiae_us.from).slice(0, 7);
    const panel = runPanel(L, { from: from || "2013-06", horizons: ["m1", "y1", "lt"] });
    out.alfred[mode] = {};
    for (const hz of ["m1", "y1", "lt"]) {
      const E = categorize(panel.filter(e => e.hz === hz && e.score != null).map(e => ({ ...e })));
      out.alfred[mode][hz] = { all: pick(compactAccuracy(accuracy(E, hz))), equity: pick(compactAccuracy(accuracy(E.filter(e => e.kind === "equity"), hz))) };
      console.log(`ALFRED ${mode} ${hz} ab ${from || "2013-06"}: IC alle ${out.alfred[mode][hz].all && out.alfred[mode][hz].all.ic}, Aktien ${out.alfred[mode][hz].equity && out.alfred[mode][hz].equity.ic}`);
    }
  }
  out.alfred.from = from;
}
writeFileSync(data("robustness.json"), JSON.stringify(out));
console.log("geschrieben: public/data/robustness.json");
