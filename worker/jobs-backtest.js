/* Backtest des Anlagebarometers im Worker (Rechnung in worker/backtest.js, Modell in src/signals.js).
   Je Horizont ein Job: einmal pro Woche und nach jeder Modelländerung rechnet er mit der ganzen Historie aus dem
   Datenarchiv (D1) zu jedem Monatsende seit 1970 alle Anlagen durch und vergleicht mit der Kursentwicklung danach.
   Gespeichert werden die Einzelwerte (Tabelle bt_panel), die Kennzahlen (bt_stats) und eine Zusammenfassung im
   Snapshot für die Seite. Dazu die Echtzeit-Bilanz: die seit dem Start täglich gespeicherten Einstufungen
   (signal_hist, kind = 'live'), sobald ihr Horizont abgelaufen ist. solo: ein Lauf braucht 10–15 s Rechenzeit und
   läuft deshalb ohne andere Jobs im selben Cron-Aufruf. */
import sigmod from "../src/signals.js";
import { loadArchive, buildBacktestLive, runPanel, summarizeBacktest, categorize, accuracy, compactAccuracy, forward, FWD, ALFRED_SERIES } from "./backtest.js";

const { SIG } = sigmod;
// Stand der Auswertung; ändert er sich (oder das Modell), rechnen die Jobs sofort neu
export const BT_VERSION = "2"; // 2: WEO-Ausgaben ab 2008, Trefferquote gegen den üblichen Ertrag

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bt_panel (h TEXT NOT NULL, id TEXT NOT NULL, d TEXT NOT NULL, score REAL, cat INTEGER, vol REAL,
    r REAL, p TEXT, PRIMARY KEY (h, id, d)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS bt_stats (h TEXT NOT NULL, k TEXT NOT NULL, at TEXT, version TEXT, json TEXT, PRIMARY KEY (h, k)) WITHOUT ROWID`,
  // Echtzeit-Datenstände (ALFRED): Wert eines Datums mit seinem Gültigkeitszeitraum (veröffentlicht am rs, gültig bis re)
  `CREATE TABLE IF NOT EXISTS vint (s TEXT NOT NULL, d TEXT NOT NULL, rs TEXT NOT NULL, re TEXT NOT NULL, v REAL, PRIMARY KEY (s, d, rs)) WITHOUT ROWID`,
];
const VINT_INSERT = `INSERT INTO vint (s, d, rs, re, v)
  SELECT ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?1)`;
const INSERT = `INSERT INTO bt_panel (h, id, d, score, cat, vol, r, p)
  SELECT ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
    json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]') FROM json_each(?1)`;
const r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const RET = { m1: "r1", y1: "r12", lt: "r60" };

let ready = null;
export async function ensureBacktestSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map(q => db.prepare(q))).catch(e => { ready = null; throw e; });
  return ready;
}

/* Einzelwerte eines Horizonts ersetzen (eine Transaktion) */
async function writePanel(db, hz, entries) {
  const rk = RET[hz];
  const data = entries.map(e => [e.id, SIG.isoOf(e.t), r4(e.score), e.cat, r4(e.vol), r4(e[rk]), JSON.stringify(e.P)]);
  const ins = db.prepare(INSERT);
  const stmts = [db.prepare("DELETE FROM bt_panel WHERE h = ?").bind(hz)];
  for (let i = 0; i < data.length; i += 2000) stmts.push(ins.bind(JSON.stringify(data.slice(i, i + 2000)), hz));
  await db.batch(stmts);
}

/* Echtzeit-Bilanz: je Anlage und Monat die zuletzt angezeigte Einstufung, bewertet mit der Rendite bis zum Monatsende
   n Monate später (wie im Backtest); nur Fälle, deren Horizont schon abgelaufen ist */
async function liveTrack(db, L, hz) {
  const { results } = await db.prepare("SELECT d, id, score, cat FROM signal_hist WHERE h = ? AND kind = 'live' ORDER BY d").bind(hz).all();
  const last = new Map();
  for (const r of results) last.set(`${r.id}|${r.d.slice(0, 7)}`, r);
  const prices = new Map();
  const entries = [];
  for (const r of last.values()) {
    const row = SIG.ROWS.find(x => x.id === r.id);
    if (!row || r.score == null) continue;
    if (!prices.has(r.id)) prices.set(r.id, SIG.rowPrice(L, row, null));
    const t = SIG.dayOf(r.d), ret = forward(prices.get(r.id), t, FWD[hz]);
    entries.push({ id: r.id, kind: row.kind, t, score: r.score, cat: r.cat, vol: null, [RET[hz]]: ret });
  }
  const done = entries.filter(e => e[RET[hz]] != null);
  const first = results.length ? results[0].d : null;
  return { first, signals: entries.length, matured: done.length, stats: done.length ? compactAccuracy(accuracy(done, hz)) : null };
}

// Reihen, die mindestens bis zum angegebenen Jahr zurückreichen müssen: fehlt die lange Historie noch (erster Archivlauf
// steht aus), scheitert der Lauf bewusst und wird später wiederholt, statt Kennzahlen auf lückenhaften Daten zu zeigen
const REQUIRED = { h_sp500_m: "1960", h_cape_m: "1960", aiae_us: "1960", eqh_de: "1965", eqh_jp: "1965", baa_m: "1960", gs10_m: "1960",
  cli_us: "1965", cpi_us: "1965", fxh_chf: "1972", h_gold_usd_m: "1965", umcsent: "1970" };

// Jobs, deren lange Historie der Backtest braucht: er wartet, bis sie archiviert ist (Runner: "after")
// (nicht alfred_vintages: ohne dessen Daten rechnet der Backtest Baugenehmigungen und Z.1 im heutigen Stand, statt zu warten)
const BT_INPUT_JOBS = ["fred_markets", "fred_rates", "fred_risk", "fred_credit", "fred_cycle", "fred_fxhist", "fred_intl", "fred_z1",
  "oecd_cli", "oecd_prices", "imf_commodities", "bis_reer", "archive_hist", "em_markets", "em_history", "oecd_cli_em", "bis_em", "bis_credit"];

/* ALFRED: alle Datenstände einer Reihe in einem Abruf (Beobachtungen nach Gültigkeitszeitraum, ab 1776-07-04 = alle) */
async function alfredAll(F, id, key) {
  const rows = [];
  for (let offset = 0; offset < 1e6; offset += 100000) {
    const u = new URL("https://api.stlouisfed.org/fred/series/observations");
    for (const [k, v] of Object.entries({ series_id: id, api_key: key, file_type: "json", realtime_start: "1776-07-04", realtime_end: "9999-12-31", limit: "100000", offset: String(offset) })) u.searchParams.set(k, v);
    const j = await F.json(u.toString());
    if (!j || !Array.isArray(j.observations)) throw new Error(`ALFRED ${id}: unerwartete Antwort${j && j.error_message ? ` (${j.error_message})` : ""}`);
    for (const o of j.observations) { const v = parseFloat(o.value); if (isFinite(v)) rows.push([o.date, o.realtime_start, o.realtime_end, v]); }
    if (j.observations.length < 100000 || offset + 100000 >= (j.count || 0)) break;
  }
  if (!rows.length) throw new Error(`ALFRED ${id}: keine Datenstände`);
  return rows;
}
async function writeVint(db, s, rows) {
  const ins = db.prepare(VINT_INSERT);
  const stmts = [db.prepare("DELETE FROM vint WHERE s = ?").bind(s)];
  for (let i = 0; i < rows.length; i += 2000) stmts.push(ins.bind(JSON.stringify(rows.slice(i, i + 2000)), s));
  await db.batch(stmts);
}
export async function loadAlfred(db) {
  await ensureBacktestSchema(db);
  const { results } = await db.prepare("SELECT s, d, rs, re, v FROM vint ORDER BY s, d, rs").all();
  if (!results.length) return null;
  const out = {};
  for (const r of results) (out[r.s] ??= []).push([r.d, r.rs, r.re, r.v]);
  return out;
}

/* Echtzeit-Datenstände der vom Modell genutzten, nachträglich revidierten US-Reihen aus ALFRED (Schlüssel als Secret
   ALFRED_API): Baugenehmigungen und die Z.1-Reihen des Aktienanteils am Anlegervermögen. Nur Archiv; der Backtest liest
   die Tabelle vint. Ohne Secret läuft der Job nicht, der Backtest rechnet diese Reihen dann im heutigen Stand. */
export const ALFRED_JOBS = [{
  id: "alfred_vintages", label: "Echtzeit-Datenstände: Baugenehmigungen und Fed Z.1 (ALFRED, für den Backtest)", source: "fred", every: 24 * 7,
  cost: ALFRED_SERIES.length, requires: ["DB", "ALFRED_API"], noArchive: true,
  async run(F, ctx) {
    const db = ctx.env.DB;
    await ensureBacktestSchema(db);
    const items = [];
    for (const s of ALFRED_SERIES) {
      const rows = await alfredAll(F, s, ctx.env.ALFRED_API);
      await writeVint(db, s, rows);
      items.push({ s, rows: rows.length, from: rows.reduce((a, r) => (r[1] < a ? r[1] : a), "9999") });
    }
    return { series: {}, items };
  },
}];

export async function runBacktest(db, hz, nowIso, vintages = null, weo = null) {
  await ensureBacktestSchema(db);
  let raw = await loadArchive(db);
  const missing = Object.entries(REQUIRED).filter(([id, y]) => !raw[id] || !raw[id].points.length || raw[id].points[0][0] > y).map(([id]) => id);
  if (missing.length) throw new Error(`Archiv noch ohne lange Historie für ${missing.join(", ")}; der Backtest folgt nach den Archivläufen`);
  // Frühindikatoren ab 2001 im damals veröffentlichten Stand (OECD-Revisionsdatenbank), nicht in der heute revidierten Fassung
  if (!vintages) throw new Error("data/cli_vintages.json fehlt: ohne Echtzeit-Datenstände der Frühindikatoren kein Backtest");
  // Baugenehmigungen und Fed Z.1 im damaligen Stand (ALFRED), sofern der Job alfred_vintages gelaufen ist
  const alfred = await loadAlfred(db).catch(() => null);
  // IWF-Zahlen ab April 2008 im Stand der damaligen WEO-Ausgaben (data/weo_vintages.json); ohne Datei naiv fortgeschrieben
  const L = buildBacktestLive(raw, { vintages, alfred, weo });
  raw = null; // Rohdaten freigeben (Speichergrenze des Workers: 128 MB)
  const panel = runPanel(L, { from: "1970-01", horizons: [hz] });
  if (panel.length < 1000) throw new Error(`Backtest ${hz}: nur ${panel.length} Einträge – Archiv unvollständig?`);
  const summary = summarizeBacktest(panel, hz);
  await writePanel(db, hz, categorize(panel.filter(e => e.score != null)));
  summary.realtime = { cli: Object.keys(L.vint || {}).length, from: "2001-01", alfred: Object.fromEntries(Object.entries(L.alfred || {}).map(([id, A]) => [id, SIG.isoOf(A.from)])),
    weo: weo ? { editions: Object.keys(weo).length, series: Object.keys(L.weoVint || {}).length, from: Object.keys(weo).sort()[0] } : null };
  summary.live = await liveTrack(db, L, hz);
  summary.at = nowIso;
  summary.version = `${SIG.cfg.version}/${BT_VERSION}`;
  await db.prepare("INSERT OR REPLACE INTO bt_stats (h, k, at, version, json) VALUES (?, 'summary', ?, ?, ?)")
    .bind(hz, nowIso, summary.version, JSON.stringify(summary)).run();
  return summary;
}

export const BACKTEST_JOBS = SIG.cfg.horizons.map(H => ({
  id: "backtest_" + H.id, label: `Backtest des Anlagebarometers seit 1970: ${H.title} (D1)`, source: "d1", every: 24 * 7, cost: 0,
  requires: ["DB"], noArchive: true, solo: true, version: `${SIG.cfg.version}/${BT_VERSION}`, after: BT_INPUT_JOBS,
  async run(F, ctx) {
    const vint = await ctx.seed("data/cli_vintages.json"), weo = await ctx.seed("data/weo_vintages.json");
    const s = await runBacktest(ctx.env.DB, H.id, new Date(ctx.now).toISOString(), vint && vint.editions, weo && weo.editions);
    return { series: {}, items: [s] };
  },
}));

/* Einzelwerte für die Seite und die API: Gesamtwert, Stufe und spätere Rendite je Monatsende */
export async function readBacktest(db, { h = "y1", id = null } = {}) {
  await ensureBacktestSchema(db);
  if (!id) {
    const { results } = await db.prepare("SELECT h, at, version, json FROM bt_stats WHERE k = 'summary'").all();
    return Object.fromEntries(results.map(r => [r.h, JSON.parse(r.json)]));
  }
  const { results } = await db.prepare("SELECT d, score, cat, r FROM bt_panel WHERE h = ? AND id = ? ORDER BY d").bind(h, id).all();
  return { h, id, points: results.map(r => [r.d, r.score, r.cat, r.r]) };
}
