/* Signalverlauf des Anlagebarometers in D1.
   Der Job rechnet das Barometer im Worker mit demselben Modell wie die Seite (src/signals.js) und schreibt die
   Einstufung jedes Tages in die Tabelle signals. Beim ersten Lauf werden zusätzlich 24 Monatsenden mit dem
   Datenstand rückgerechnet, der damals veröffentlicht gewesen wäre (kind = 'calc'); danach wächst die Reihe täglich
   (kind = 'live') und zeigt, was die Seite an jedem Tag tatsächlich angezeigt hat. */
import sigmod from "../src/signals.js";
import { SNAP_KEY } from "./keys.js";

const { SIG } = sigmod;
const PILLARS = ["trend", "cycle", "value", "liquidity", "risk"];

const SCHEMA = `CREATE TABLE IF NOT EXISTS signals (
  d TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, score REAL, cat INTEGER,
  trend REAL, cycle REAL, value REAL, liquidity REAL, risk REAL, PRIMARY KEY (d, id))`;

const UPSERT = `INSERT INTO signals (d, id, kind, score, cat, trend, cycle, value, liquidity, risk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (d, id) DO UPDATE SET kind = excluded.kind, score = excluded.score, cat = excluded.cat, trend = excluded.trend,
  cycle = excluded.cycle, value = excluded.value, liquidity = excluded.liquidity, risk = excluded.risk`;

const r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

export async function ensureSchema(db) { await db.prepare(SCHEMA).run(); }

async function writeRows(db, rows, kind) {
  const stmt = db.prepare(UPSERT);
  for (let i = 0; i < rows.length; i += 100) {
    await db.batch(rows.slice(i, i + 100).map(r => stmt.bind(r.d, r.id, kind, r4(r.score), r.cat, ...PILLARS.map(k => r4(r.p[k])))));
  }
}

/* Kompakter Verlauf für Seite und API: je Monat der letzte gespeicherte Tag, dazu alle Tage der letzten
   `daily` Tage (mit großem daily der vollständige Tagesverlauf) */
export async function readHistory(db, { days = 800, daily = 120 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - daily * 864e5).toISOString().slice(0, 10);
  const { results: all } = await db.prepare("SELECT d, id, kind, score, cat FROM signals WHERE d >= ? ORDER BY d").bind(since).all();
  const allDates = [...new Set(all.map(r => r.d))];
  const keep = new Set(allDates.filter((d, i) => d >= recent || i === allDates.length - 1 || allDates[i + 1].slice(0, 7) !== d.slice(0, 7)));
  const results = all.filter(r => keep.has(r.d));
  const dates = [...new Set(results.map(r => r.d))];
  const idx = new Map(dates.map((d, i) => [d, i]));
  const kinds = dates.map(() => "calc");
  const rows = {};
  for (const r of results) {
    const i = idx.get(r.d);
    if (r.kind === "live") kinds[i] = "live";
    const e = rows[r.id] || (rows[r.id] = { s: new Array(dates.length).fill(null), c: new Array(dates.length).fill(null) });
    e.s[i] = r.score;
    e.c[i] = r.cat;
  }
  return { dates, kinds, rows };
}

/* Verlauf ohne Datenbank (für den statischen Startbestand): Rückrechnung plus heutiger Stand */
export function historyWithoutDb(snap, hist) {
  const L = SIG.decodeSnapshot(snap);
  SIG.prepareLive(L, hist ? { gold_usd_m: { f: "M", s: hist.series.gold_usd_m.start, v: hist.series.gold_usd_m.values }, cape: hist.latest.cape } : {});
  const B = SIG.barometer(L);
  const today = SIG.isoOf(B.tNow);
  const rows = SIG.backfill(L, 24, B.tNow).filter(r => r.d < today)
    .concat(B.rows.filter(r => r.now).map(r => ({ d: today, id: r.row.id, score: r.now.score, cat: r.now.cat.n })));
  const dates = [...new Set(rows.map(r => r.d))].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = { dates, kinds: dates.map(() => "calc"), rows: {} };
  for (const r of rows) {
    const e = out.rows[r.id] || (out.rows[r.id] = { s: new Array(dates.length).fill(null), c: new Array(dates.length).fill(null) });
    e.s[idx.get(r.d)] = r4(r.score);
    e.c[idx.get(r.d)] = r.cat;
  }
  return out;
}

export const SIGNAL_JOBS = [
  {
    id: "signal_history", label: "Signalverlauf des Anlagebarometers (D1)", source: "d1", every: 6, cost: 0, requires: ["DB"],
    async run(F, ctx) {
      const db = ctx.env.DB;
      const txt = await ctx.env.DATA.get(SNAP_KEY);
      if (!txt) throw new Error("Noch kein Snapshot im KV");
      const hist = await ctx.seed("data/bigcycle.json");
      const L = SIG.decodeSnapshot(JSON.parse(txt));
      SIG.prepareLive(L, hist ? { gold_usd_m: { f: "M", s: hist.series.gold_usd_m.start, v: hist.series.gold_usd_m.values }, cape: hist.latest.cape } : {});
      const B = SIG.barometer(L);
      if (B.tNow == null) throw new Error("Barometer ohne Stichtag");
      await ensureSchema(db);
      const today = SIG.isoOf(B.tNow);
      const live = B.rows.filter(r => r.now).map(r => ({ d: today, id: r.row.id, score: r.now.score, cat: r.now.cat.n, p: Object.fromEntries(PILLARS.map(k => [k, r.now.pillars[k] ? r.now.pillars[k].s : null])) }));
      await writeRows(db, live, "live");
      // einmalige Rückrechnung, solange noch keine Monatsenden gespeichert sind
      const { n } = await db.prepare("SELECT COUNT(DISTINCT d) AS n FROM signals WHERE kind = 'calc'").first();
      if (!n) await writeRows(db, SIG.backfill(L, 24, B.tNow).filter(r => r.d < today), "calc");
      const h = await readHistory(db);
      return { series: {}, items: [h], info: { today, rows: live.length, dates: h.dates.length } };
    },
  },
];
