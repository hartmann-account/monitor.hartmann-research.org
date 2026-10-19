/* Signalverlauf des Anlagebarometers und Import der Langfristreihen in D1.
   signal_history rechnet das Barometer im Worker mit demselben Modell wie die Seite (src/signals.js) für alle drei
   Horizonte (1 Monat, 12 Monate, 5–10 Jahre) und schreibt die Einstufung jedes Tages in die Tabelle signal_hist.
   Für Anlagen ohne Monatsenden werden 24 Monatsenden mit dem Datenstand rückgerechnet, der damals veröffentlicht
   gewesen wäre (kind = 'calc'); danach wächst die Reihe täglich (kind = 'live') und zeigt, was die Seite an jedem
   Tag tatsächlich angezeigt hat.
   archive_hist übernimmt die wöchentlich erzeugten Langfristreihen (data/bigcycle.json, teils seit dem 13. Jahrhundert)
   und die Teilwerte des Machtindex ins Datenarchiv. */
import sigmod from "../src/signals.js";
import { SNAP_KEY } from "./keys.js";
import { ensureArchive, writeObs } from "./archive.js";

const { SIG } = sigmod;
const HORIZONS = SIG.cfg.horizons.map(h => h.id);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS signal_hist (h TEXT NOT NULL, d TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    score REAL, cat INTEGER, p TEXT, PRIMARY KEY (h, d, id)) WITHOUT ROWID`,
];
const UPSERT = `INSERT INTO signal_hist (h, d, id, kind, score, cat, p)
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?2, json_extract(value, '$[3]'),
    json_extract(value, '$[4]'), json_extract(value, '$[5]') FROM json_each(?1) WHERE true
  ON CONFLICT (h, d, id) DO UPDATE SET kind = excluded.kind, score = excluded.score, cat = excluded.cat, p = excluded.p`;

const r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/* Tabelle anlegen; Bestand der ersten Version (Tabelle signals, nur 1 Monat) einmalig übernehmen */
let ready = null;
export async function ensureSchema(db) {
  if (!ready) ready = (async () => {
    await db.batch(SCHEMA.map(q => db.prepare(q)));
    const old = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signals'").first();
    if (old) {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO signal_hist (h, d, id, kind, score, cat, p) SELECT 'm1', d, id, kind, score, cat,
          json_object('trend', trend, 'cycle', cycle, 'value', value, 'liquidity', liquidity, 'risk', risk) FROM signals`),
        db.prepare("DROP TABLE signals"),
      ]);
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function writeRows(db, rows, kind) {
  const stmt = db.prepare(UPSERT);
  const data = rows.map(r => [r.h, r.d, r.id, r4(r.score), r.cat, JSON.stringify(Object.fromEntries(Object.entries(r.p || {}).map(([k, v]) => [k, r4(v)])))]);
  const stmts = [];
  for (let i = 0; i < data.length; i += 2000) stmts.push(stmt.bind(JSON.stringify(data.slice(i, i + 2000)), kind));
  if (stmts.length) await db.batch(stmts);
}

/* Kompakter Verlauf eines Horizonts für Seite und API: je Monat der letzte gespeicherte Tag, der jüngste Tag und alle
   Tage der letzten `daily` Tage. pillars: zusätzlich die Säulenwerte je Tag. */
export async function readHistory(db, { h = "m1", days = 800, daily = 0, pillars = false } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - daily * 864e5).toISOString().slice(0, 10);
  const { results: all } = await db.prepare(`SELECT d, id, kind, score, cat${pillars ? ", p" : ""} FROM signal_hist WHERE h = ? AND d >= ? ORDER BY d`).bind(h, since).all();
  const allDates = [...new Set(all.map(r => r.d))];
  const keep = new Set(allDates.filter((d, i) => (daily && d >= recent) || i === allDates.length - 1 || allDates[i + 1].slice(0, 7) !== d.slice(0, 7)));
  const results = all.filter(r => keep.has(r.d));
  const dates = [...new Set(results.map(r => r.d))];
  const idx = new Map(dates.map((d, i) => [d, i]));
  const kinds = dates.map(() => "calc");
  const rows = {};
  for (const r of results) {
    const i = idx.get(r.d);
    if (r.kind === "live") kinds[i] = "live";
    const e = rows[r.id] || (rows[r.id] = { s: new Array(dates.length).fill(null), c: new Array(dates.length).fill(null), ...(pillars ? { p: new Array(dates.length).fill(null) } : {}) });
    e.s[i] = r.score;
    e.c[i] = r.cat;
    if (pillars && r.p) e.p[i] = JSON.parse(r.p);
  }
  return { hz: h, dates, kinds, rows };
}

/* Gemeinsame Vorbereitung: Snapshot dekodieren und mit den Langfristreihen ergänzen */
export function liveFromSnapshot(snap, hist) {
  const L = SIG.decodeSnapshot(snap);
  const hs = hist && hist.series ? hist.series : {};
  SIG.prepareLive(L, {
    gold_usd_m: hs.gold_usd_m ? { f: "M", s: hs.gold_usd_m.start, v: hs.gold_usd_m.values } : null,
    sp500_m: hs.sp500_m ? { f: "M", s: hs.sp500_m.start, v: hs.sp500_m.values } : null,
    cape_m: hs.cape_m ? { f: "M", s: hs.cape_m.start, v: hs.cape_m.values } : null,
    gpr_m: hs.gpr_hist_m ? { f: "M", s: hs.gpr_hist_m.start, v: hs.gpr_hist_m.values } : null,
    cape: hist && hist.latest ? hist.latest.cape : null,
  });
  return L;
}

/* Verlauf ohne Datenbank (für den statischen Startbestand): Rückrechnung plus heutiger Stand */
export function historyWithoutDb(snap, hist, h = "m1") {
  const L = liveFromSnapshot(snap, hist);
  const B = SIG.barometer(L, h);
  const today = SIG.isoOf(B.tNow);
  const rows = SIG.backfill(L, 24, B.tNow, h).filter(r => r.d < today)
    .concat(B.rows.filter(r => r.now).map(r => ({ d: today, id: r.row.id, score: r.now.score, cat: r.now.cat.n })));
  const dates = [...new Set(rows.map(r => r.d))].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = { hz: h, dates, kinds: dates.map(() => "calc"), rows: {} };
  for (const r of rows) {
    const e = out.rows[r.id] || (out.rows[r.id] = { s: new Array(dates.length).fill(null), c: new Array(dates.length).fill(null) });
    e.s[idx.get(r.d)] = r4(r.score);
    e.c[idx.get(r.d)] = r.cat;
  }
  return out;
}

/* Langfristreihen des wöchentlichen Datensatzes als Archivreihen h_<id> (Jahres-, Monats- und Quartalswerte) */
function histSeries(hist) {
  const out = [];
  const pad = n => String(n).padStart(2, "0");
  for (const [id, s] of Object.entries(hist.series || {})) {
    const f = s.freq || "A", v = s.values || [];
    const pts = [];
    if (f === "A") v.forEach((x, i) => { if (x != null) pts.push([`${s.start + i}-01-01`, x]); });
    else if (f === "M") { const y0 = +String(s.start).slice(0, 4), m0 = +String(s.start).slice(5, 7) - 1; v.forEach((x, i) => { if (x != null) pts.push([`${y0 + Math.floor((m0 + i) / 12)}-${pad(((m0 + i) % 12) + 1)}-01`, x]); }); }
    else if (f === "Q") { const y0 = +String(s.start).slice(0, 4), q0 = +String(s.start).slice(-1) - 1; v.forEach((x, i) => { if (x != null) pts.push([`${y0 + Math.floor((q0 + i) / 4)}-${pad(3 * ((q0 + i) % 4) + 1)}-01`, x]); }); }
    else if (f === "D") { const t0 = Date.parse(s.start + "T00:00:00Z"); v.forEach((x, i) => { if (x != null) pts.push([new Date(t0 + i * 864e5).toISOString().slice(0, 10), x]); }); }
    if (pts.length) out.push({ id: "h_" + id, l: s.label, u: s.unit, f, src: Array.isArray(s.src) ? s.src.join(", ") : s.src || "bigcycle", note: s.note || null, pts });
  }
  // Teilwerte des Machtindex (Anteil an der Welt bzw. Punktwert je Land und Jahr)
  const P = hist.power;
  if (P && P.years && P.score) {
    for (const [m, byC] of Object.entries(P.score)) {
      for (const [c, arr] of Object.entries(byC)) {
        const pts = [];
        (arr || []).forEach((x, i) => { if (x != null) pts.push([`${P.years[i]}-01-01`, x]); });
        const ml = (P.measures || []).find(x => x.id === m);
        if (pts.length) out.push({ id: `h_power_${m}_${c.toLowerCase()}`, l: `Machtindex, ${ml ? ml.label : m}: ${c}`, u: "Punkte (0–1)", f: "A", src: "bigcycle", note: null, pts });
      }
    }
  }
  return out;
}

export const SIGNAL_JOBS = [
  {
    id: "signal_history", label: "Signalverlauf des Anlagebarometers, drei Horizonte (D1)", source: "d1", every: 6, cost: 0, requires: ["DB"], noArchive: true, version: SIG.cfg.version,
    async run(F, ctx) {
      const db = ctx.env.DB;
      const txt = await ctx.env.DATA.get(SNAP_KEY);
      if (!txt) throw new Error("Noch kein Snapshot im KV");
      const L = liveFromSnapshot(JSON.parse(txt), await ctx.seed("data/bigcycle.json"));
      await ensureSchema(db);
      // neues Modell: Rückrechnung (kind = 'calc') neu erstellen, gespeicherte Tageswerte bleiben unverändert
      const model = await ctx.state.get("signal_model");
      const rebuild = !model || model.version !== SIG.cfg.version;
      const items = [], info = {};
      for (const h of HORIZONS) {
        const B = SIG.barometer(L, h);
        if (B.tNow == null) throw new Error("Barometer ohne Stichtag");
        const today = SIG.isoOf(B.tNow);
        const live = B.rows.filter(r => r.now).map(r => ({ h, d: today, id: r.row.id, score: r.now.score, cat: r.now.cat.n, p: Object.fromEntries(Object.entries(r.now.pillars).map(([k, v]) => [k, v ? v.s : null])) }));
        await writeRows(db, live, "live");
        // Rückrechnung für Anlagen, die in diesem Horizont noch keine Monatsenden haben (beim ersten Lauf alle,
        // später etwa neue Anlagen oder Quellen, die erst nach dem Start geladen wurden); gespeicherte Tage bleiben
        if (rebuild) await db.prepare("DELETE FROM signal_hist WHERE h = ? AND kind = 'calc'").bind(h).run();
        const { results: done } = await db.prepare("SELECT DISTINCT id FROM signal_hist WHERE h = ? AND kind = 'calc'").bind(h).all();
        const have = new Set(done.map(r => r.id));
        if (live.some(r => !have.has(r.id))) {
          const first = await db.prepare("SELECT MIN(d) AS first FROM signal_hist WHERE h = ? AND kind = 'live'").bind(h).first();
          const cut = (first && first.first) || today;
          await writeRows(db, SIG.backfill(L, 24, B.tNow, h).filter(r => !have.has(r.id) && r.d < cut), "calc");
        }
        const hist = await readHistory(db, { h });
        items.push(hist);
        info[h] = { today, rows: live.length, dates: hist.dates.length };
      }
      if (rebuild) await ctx.state.put("signal_model", { version: SIG.cfg.version, at: new Date(ctx.now).toISOString() });
      return { series: {}, items, info: { ...info, model: SIG.cfg.version, rebuilt: rebuild } };
    },
  },
  {
    id: "archive_hist", label: "Langfristreihen des wöchentlichen Datensatzes ins Archiv (D1)", source: "d1", every: 24 * 7, cost: 0, requires: ["DB"], noArchive: true,
    async run(F, ctx) {
      const db = ctx.env.DB;
      const hist = await ctx.seed("data/bigcycle.json");
      if (!hist || !hist.series) throw new Error("data/bigcycle.json nicht lesbar");
      await ensureArchive(db);
      const list = histSeries(hist);
      const now = new Date(ctx.now).toISOString();
      const rows = list.flatMap(s => s.pts.map(([d, v]) => [s.id, d, v]));
      await writeObs(db, rows);
      const stmts = [];
      const metas = list.map(s => ({ id: s.id, l: s.l, u: s.u, f: s.f, src: s.src, note: s.note, job: "archive_hist" }));
      stmts.push(db.prepare(`INSERT INTO series (id, label, unit, freq, src, job, note, updated)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.l'), json_extract(value, '$.u'), json_extract(value, '$.f'),
          json_extract(value, '$.src'), json_extract(value, '$.job'), json_extract(value, '$.note'), ?2 FROM json_each(?1) WHERE true
        ON CONFLICT (id) DO UPDATE SET label = excluded.label, unit = excluded.unit, freq = excluded.freq, src = excluded.src,
          job = excluded.job, note = excluded.note, updated = excluded.updated`).bind(JSON.stringify(metas), now));
      stmts.push(db.prepare(`UPDATE series SET first = (SELECT MIN(d) FROM obs WHERE s = series.id), last = (SELECT MAX(d) FROM obs WHERE s = series.id),
        n = (SELECT COUNT(*) FROM obs WHERE s = series.id) WHERE job = 'archive_hist'`));
      await db.batch(stmts);
      return { series: {}, items: [{ series: list.length, points: rows.length, generated: hist.meta && hist.meta.generated }] };
    },
  },
];
