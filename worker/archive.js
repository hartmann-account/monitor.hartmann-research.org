/* Datenarchiv in D1: Jede Beobachtung, die ein Abrufjob lädt, wird in der Tabelle obs gespeichert (Reihe, Datum,
   Wert) und bei späteren Abrufen nur ergänzt oder bei Revisionen aktualisiert. Die Tabelle series hält Bezeichnung,
   Einheit, Quelle und Umfang jeder Reihe, events die Meldungen von GDACS. Damit gehört die Historie dem Monitor,
   auch wenn eine Quelle ältere Werte nicht mehr anbietet (etwa die ICE-BofA-Reihen auf FRED nach drei Jahren).
   Datum: Periodenbeginn als ISO-Datum (Monat 2026-09 → 2026-09-01, Quartal 2026-Q2 → 2026-04-01, Jahr → 2026-01-01). */
import { toPoints } from "./lib/series.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS series (id TEXT PRIMARY KEY, label TEXT, unit TEXT, freq TEXT, src TEXT, job TEXT, note TEXT,
    first TEXT, last TEXT, n INTEGER, updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS obs (s TEXT NOT NULL, d TEXT NOT NULL, v REAL, PRIMARY KEY (s, d)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS events (src TEXT NOT NULL, id TEXT NOT NULL, d TEXT, kind TEXT, name TEXT, level TEXT,
    country TEXT, url TEXT, first_seen TEXT, last_seen TEXT, PRIMARY KEY (src, id))`,
];
const INSERT_OBS = `INSERT INTO obs (s, d, v) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
  FROM json_each(?1) WHERE true ON CONFLICT (s, d) DO UPDATE SET v = excluded.v WHERE obs.v IS NOT excluded.v`;
const UPSERT_SERIES = `INSERT INTO series (id, label, unit, freq, src, job, note, updated)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.l'), json_extract(value, '$.u'), json_extract(value, '$.f'),
    json_extract(value, '$.src'), json_extract(value, '$.job'), json_extract(value, '$.note'), ?2 FROM json_each(?1) WHERE true
  ON CONFLICT (id) DO UPDATE SET label = excluded.label, unit = excluded.unit, freq = excluded.freq, src = excluded.src,
    job = excluded.job, note = excluded.note, updated = excluded.updated`;
const STATS = `UPDATE series SET first = (SELECT MIN(d) FROM obs WHERE s = series.id), last = (SELECT MAX(d) FROM obs WHERE s = series.id),
  n = (SELECT COUNT(*) FROM obs WHERE s = series.id) WHERE id IN (SELECT value FROM json_each(?1))`;
const UPSERT_EVENT = `INSERT INTO events (src, id, d, kind, name, level, country, url, first_seen, last_seen)
  SELECT json_extract(value, '$.src'), json_extract(value, '$.id'), json_extract(value, '$.d'), json_extract(value, '$.kind'),
    json_extract(value, '$.name'), json_extract(value, '$.level'), json_extract(value, '$.country'), json_extract(value, '$.url'), ?2, ?2
  FROM json_each(?1) WHERE true ON CONFLICT (src, id) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen`;
// Größe eines Schreibvorgangs: D1 erlaubt höchstens 2 MB je gebundenem Wert; die JSON-Liste bleibt unter 0,9 MB
const CHUNK_BYTES = 900000;

let ready = null;
export async function ensureArchive(db) {
  if (!ready) ready = db.batch(SCHEMA.map(q => db.prepare(q))).catch(e => { ready = null; throw e; });
  return ready;
}

const pad = n => String(n).padStart(2, "0");
/* Periodenangabe → ISO-Datum des Periodenbeginns */
export function isoDate(d, f) {
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(s)) return s + "-01";
  const q = /^(\d{4})-Q([1-4])$/.exec(s);
  if (q) return `${q[1]}-${pad(3 * q[2] - 2)}-01`;
  if (/^\d{4}$/.test(s)) return s + "-01-01";
  return f === "A" ? `${s}-01-01` : s;
}
// Schreibfenster bei bereits archivierten Reihen: Tageswerte 60 Tage, Monatswerte zwei Jahre vor dem letzten Archivdatum,
// Quartals- und Jahreswerte vollständig (Revisionen und Projektionen ändern ältere Jahre)
function windowFrom(last, f) {
  if (!last) return null;
  const t = Date.parse(last + "T00:00:00Z");
  if (f === "D" || f === "W") return new Date(t - 60 * 864e5).toISOString().slice(0, 10);
  if (f === "M") { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() - 24); return d.toISOString().slice(0, 10); }
  return null;
}
const slug = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);

/* Prognosemärkte als eigene Reihen: Wahrscheinlichkeit in % je Tag, Kennung aus der Frage des Markts
   (bei Zinsentscheiden mit dem Ausgang, etwa "Fed Decision in December: 25 bps decrease") */
export function polymarketSeries(items, day) {
  const out = {};
  for (const it of items || []) {
    if (it.p == null || !it.q) continue;
    const id = ("pm_" + slug(it.q)).slice(0, 90);
    out[id] = { meta: { l: `Prognosemarkt: ${it.q}`, u: "% Wahrscheinlichkeit", f: "D", src: "polymarket", note: it.url || null }, pts: [[day, Math.round(1e4 * it.p) / 100]] };
  }
  return out;
}

/* Beobachtungen [reihe, datum, wert] schreiben: in Blöcken unter CHUNK_BYTES, nacheinander (große Erstimporte
   bleiben so unter den Grenzen je Anfrage); bekannte Tage werden nur bei geändertem Wert überschrieben */
export async function writeObs(db, rows) {
  const ins = db.prepare(INSERT_OBS);
  let chunk = [], size = 2;
  const flush = async () => { if (chunk.length) await ins.bind(JSON.stringify(chunk)).run(); chunk = []; size = 2; };
  for (const r of rows) {
    const n = r[0].length + 30;
    if (size + n > CHUNK_BYTES) await flush();
    chunk.push(r);
    size += n;
  }
  await flush();
}

/* Ausgabe eines Jobs archivieren. ctx.raw: ungekürzte neue Punkte je Reihe (aus den Hilfen D und M), sonst die
   Reihen der Ausgabe; ctx.full: erster Archivlauf mit der ganzen Historie der Quelle. */
export async function archiveOutput(db, job, out, ctx, nowIso) {
  await ensureArchive(db);
  const day = nowIso.slice(0, 10);
  const all = {};
  for (const [sid, s] of Object.entries((out && out.series) || {})) {
    if (!s || s.s == null) continue;
    all[sid] = { meta: { l: s.l, u: s.u, f: s.f, src: s.src, note: s.note || null }, out: s, raw: (ctx.raw && ctx.raw[sid]) || null };
  }
  if (job.id === "polymarket") for (const [id, e] of Object.entries(polymarketSeries(out.items, day))) all[id] = { meta: e.meta, out: null, raw: e.pts };
  const ids = Object.keys(all);
  const stmts = [];
  let n = 0;
  if (ids.length) {
    const known = new Map();
    const { results } = await db.prepare("SELECT id, last FROM series WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all();
    for (const r of results) known.set(r.id, r.last);
    const rows = [];
    for (const [sid, e] of Object.entries(all)) {
      // neue Reihe: alles, was vorliegt (gespeicherte Historie des Snapshots und neu geladene Punkte);
      // danach die neu geladenen Punkte bzw. das Schreibfenster der Ausgabe
      const pts = new Map();
      const add = (list, from) => { for (const [d, v] of list) { if (v == null || !Number.isFinite(v)) continue; const iso = isoDate(d, e.meta.f); if (!from || iso >= from) pts.set(iso, v); } };
      const last = known.get(sid);
      if (!last || ctx.full) { if (e.out) add(toPoints(e.out)); if (e.raw) add(e.raw); }
      else if (e.raw) add(e.raw);
      else if (e.out) add(toPoints(e.out), windowFrom(last, e.meta.f));
      for (const [d, v] of pts) rows.push([sid, d, v]);
    }
    n = rows.length;
    await writeObs(db, rows);
    stmts.push(db.prepare(UPSERT_SERIES).bind(JSON.stringify(ids.map(id => ({ id, ...all[id].meta, job: job.id }))), nowIso));
    stmts.push(db.prepare(STATS).bind(JSON.stringify(ids)));
  }
  if (job.id === "gdacs" && out.items && out.items.length) {
    const ev = out.items.map(e => ({ src: "gdacs", id: `${e.date}_${slug(e.type)}_${slug(e.name)}`.slice(0, 120), d: e.date, kind: e.type, name: e.name, level: e.level, country: e.country || null, url: e.url || null }));
    stmts.push(db.prepare(UPSERT_EVENT).bind(JSON.stringify(ev), nowIso));
  }
  if (stmts.length) await db.batch(stmts);
  return { series: ids.length, points: n };
}

/* Übersicht für Seite und API */
export async function archiveSummary(db) {
  await ensureArchive(db);
  const [ser, tot, ev] = await db.batch([
    db.prepare("SELECT id, label, unit, freq, src, job, first, last, n, updated FROM series ORDER BY job, id"),
    db.prepare("SELECT COUNT(*) AS series, COALESCE(SUM(n), 0) AS obs, MIN(first) AS first, MAX(updated) AS updated FROM series"),
    db.prepare("SELECT src, COUNT(*) AS n, MIN(d) AS first, MAX(d) AS last FROM events GROUP BY src"),
  ]);
  return { totals: tot.results[0], series: ser.results, events: ev.results };
}

/* Beobachtungen einer oder mehrerer Reihen */
// weekly: je Reihe nur der letzte Wert jeder Kalenderwoche und jedes Monats (wie im Backtest)
export async function readSeries(db, ids, { from = null, to = null, limit = 200000, weekly = false } = {}) {
  await ensureArchive(db);
  const q = db.prepare(weekly
    ? `SELECT s, d, v FROM obs WHERE s IN (SELECT value FROM json_each(?1)) AND d >= ?2 AND d <= ?3 AND v IS NOT NULL AND (s, d) IN (
         SELECT s, MAX(d) FROM obs WHERE s IN (SELECT value FROM json_each(?1)) AND v IS NOT NULL GROUP BY s, strftime('%Y-%W', d)
         UNION SELECT s, MAX(d) FROM obs WHERE s IN (SELECT value FROM json_each(?1)) AND v IS NOT NULL GROUP BY s, strftime('%Y-%m', d))
       ORDER BY s, d LIMIT ?4`
    : `SELECT s, d, v FROM obs WHERE s IN (SELECT value FROM json_each(?1)) AND d >= ?2 AND d <= ?3 ORDER BY s, d LIMIT ?4`)
    .bind(JSON.stringify(ids), from || "0000", to || "9999", limit);
  const meta = db.prepare("SELECT id, label, unit, freq, src, job, first, last, n, updated FROM series WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids));
  const [obs, m] = await db.batch([q, meta]);
  const out = {};
  for (const r of m.results) out[r.id] = { ...r, points: [] };
  for (const r of obs.results) (out[r.s] || (out[r.s] = { id: r.s, points: [] })).points.push([r.d, r.v]);
  return out;
}
