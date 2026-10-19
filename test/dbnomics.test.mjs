/* DBnomics-Import: Kennungen, Seitenverarbeitung und ein ganzer Durchgang gegen eine nachgebildete Schnittstelle
   (D1 über node:sqlite, R2 und KV im Speicher) */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seriesId, pageRows, unitDim, dbnomicsRun, dbnomicsSummary, dbnomicsSearch, API } from "../worker/dbnomics.js";
import { makeFetcher } from "../worker/lib/http.js";
import { getJson } from "../worker/r2.js";

/* ------------------------------------------------------------------ Nachbildungen */
function fakeD1() {
  const sql = new DatabaseSync(":memory:");
  const exec = (q, args) => {
    const p = sql.prepare(q);
    return /^\s*(SELECT|WITH)/i.test(q) ? { results: p.all(...args) } : (p.run(...args), { results: [] });
  };
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    run: async () => exec(q, args),
    all: async () => exec(q, args),
    first: async () => exec(q, args).results[0] ?? null,
    exec: () => exec(q, args),
  });
  return { sql, prepare: q => stmt(q), batch: async list => list.map(s => s.exec()) };
}
function fakeBucket() {
  const m = new Map();
  return {
    m,
    async put(key, body, opts = {}) { m.set(key, { body: typeof body === "string" ? body : new Uint8Array(body), opts }); },
    async get(key) { const o = m.get(key); return o ? { body: new Response(o.body).body, httpMetadata: o.opts.httpMetadata || {} } : null; },
  };
}
const fakeState = () => {
  const store = {};
  return { store, get: async k => (k in store ? structuredClone(store[k]) : null), put: async (k, v) => { store[k] = structuredClone(v); } };
};

/* Anbieter XP mit zwei Datensätzen: A1 (40 Monatsreihen in zwei Ländern, Einheiten-Dimension, einzelne NA) und B2 (drei
   Tagesreihen mit je 2000 Werten) */
function fakeApi() {
  const ds = {
    A1: { code: "A1", name: "Monatsdaten", indexed_at: "2026-10-01T05:00:00.000Z", dimensions_codes_order: ["FREQ", "REF_AREA", "UNIT_MEASURE"],
      dimensions_values_labels: { UNIT_MEASURE: { PC: "Prozent", IX: "Index" } } },
    B2: { code: "B2", name: "Tagesdaten", indexed_at: "2026-10-02T05:00:00.000Z", dimensions_codes_order: ["FREQ"], dimensions_values_labels: {} },
  };
  const series = {
    A1: Array.from({ length: 40 }, (_, i) => ({
      series_code: `M.${i % 2 ? "DE" : "US"}.X${String(i).padStart(2, "0")}`, series_name: `Reihe ${i}`, "@frequency": "monthly",
      dimensions: { FREQ: "M", REF_AREA: i % 2 ? "DE" : "US", UNIT_MEASURE: i % 3 ? "PC" : "IX" },
      period: Array.from({ length: 12 }, (_, k) => `2025-${String(k + 1).padStart(2, "0")}`),
      period_start_day: Array.from({ length: 12 }, (_, k) => `2025-${String(k + 1).padStart(2, "0")}-01`),
      value: Array.from({ length: 12 }, (_, k) => (k === 5 && i === 0 ? "NA" : i + k / 10)),
    })),
    B2: Array.from({ length: 3 }, (_, i) => ({
      series_code: `D.S${i}`, series_name: `Tagesreihe ${i}`, "@frequency": "daily", dimensions: { FREQ: "D" },
      period: Array.from({ length: 2000 }, (_, k) => new Date(Date.UTC(2015, 0, 1 + k)).toISOString().slice(0, 10)),
      period_start_day: Array.from({ length: 2000 }, (_, k) => new Date(Date.UTC(2015, 0, 1 + k)).toISOString().slice(0, 10)),
      value: Array.from({ length: 2000 }, (_, k) => 100 + i + k / 1000),
    })),
  };
  const calls = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    calls.push(u.pathname);
    const path = decodeURIComponent(u.pathname.replace(/^\/v22/, ""));
    const send = o => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    let m;
    if (path === "/datasets/XP") return send({ datasets: { docs: Object.values(ds).map(d => ({ ...d, nb_series: series[d.code].length })), num_found: 2, offset: 0, limit: 500 } });
    if ((m = /^\/datasets\/XP\/(\w+)$/.exec(path))) return ds[m[1]] ? send({ datasets: { docs: [{ ...ds[m[1]], nb_series: series[m[1]].length }] } }) : new Response("nicht gefunden", { status: 404 });
    if (path === "/providers/XP") return send({ category_tree: [{ code: "A1", name: "a" }, { name: "Gruppe", children: [{ code: "B2", name: "b" }] }] });
    if ((m = /^\/series\/XP\/(\w+)$/.exec(path))) {
      const dims = u.searchParams.get("dimensions") ? JSON.parse(u.searchParams.get("dimensions")) : null;
      const all = series[m[1]].filter(x => !dims || Object.entries(dims).every(([k, v]) => v.includes(x.dimensions[k])));
      const off = +u.searchParams.get("offset"), lim = +u.searchParams.get("limit");
      return send({ series: { docs: all.slice(off, off + lim), num_found: all.length, offset: off, limit: lim } });
    }
    return new Response("unbekannt", { status: 404 });
  };
  return { ds, series, calls, fetchImpl };
}
const PK = [{ p: "XP", all: true, dims: null }];

/* ------------------------------------------------------------------ Bausteine */
test("Kennungen: lesbar, eindeutig, höchstens 120 Zeichen", () => {
  assert.equal(seriesId("IMF", "WEO:2025-04", "USA.NGDP_RPCH.pcent_change"), "dbn.IMF.WEO:2025-04.USA.NGDP_RPCH.pcent_change");
  assert.equal(seriesId("OECD", "DSD_KEI@DF_KEI", "AUS.M.LI"), "dbn.OECD.DSD_KEI_DF_KEI.AUS.M.LI");
  // ersetzte Zeichen: Prüfsumme, damit a/b und a_b verschieden bleiben
  assert.notEqual(seriesId("X", "Y", "a/b"), seriesId("X", "Y", "a_b"));
  assert.match(seriesId("X", "Y", "a/b"), /^dbn\.X\.Y\.a_b\.[0-9a-f]{8}$/);
  const long = seriesId("Eurostat", "namq_10_gdp", "Q." + "X".repeat(200));
  assert.ok(long.length <= 120);
  assert.match(long, /^[\w.:-]+$/);
});

test("Seite: Werte ohne NA, Datum Periodenbeginn, Einheit mit Bezeichnung, Frequenz", () => {
  const units = unitDim({ dimensions_codes_order: ["FREQ", "UNIT_MEASURE"], dimensions_values_labels: { UNIT_MEASURE: { PC: "Prozent" } } });
  assert.deepEqual(units, { key: "UNIT_MEASURE", labels: { PC: "Prozent" } });
  assert.equal(unitDim({ dimensions_codes_order: ["weo-country", "weo-subject", "unit"], dimensions_values_labels: { unit: [["pcent", "Percent"]] } }).labels.pcent, "Percent");
  assert.equal(unitDim({ dimensions_codes_order: ["FREQ", "REF_AREA"] }), null);
  const docs = [{ series_code: "A.US.X", series_name: "Test", "@frequency": "annual", dimensions: { UNIT_MEASURE: "PC" }, period: ["2024", "2025", "2026"], value: [1.5, "NA", 2] }];
  const { rows, metas } = pageRows(docs, { p: "IMF", d: "IFS" }, units);
  assert.deepEqual(rows, [["dbn.IMF.IFS.A.US.X", "2024-01-01", 1.5], ["dbn.IMF.IFS.A.US.X", "2026-01-01", 2]]);
  assert.deepEqual(metas[0], { id: "dbn.IMF.IFS.A.US.X", l: "Test", u: "Prozent", f: "A", src: "dbnomics", note: "IMF/IFS" });
});

/* ------------------------------------------------------------------ Durchgang */
test("Durchgang: Liste, seitenweiser Import in D1 und R2, Abschluss, Wiederholung nur bei neuem Stand", async () => {
  const api = fakeApi(), db = fakeD1(), bucket = fakeBucket(), state = fakeState();
  const t0 = Date.parse("2026-10-19T12:00:00Z");
  const run = async (now, o = {}) => dbnomicsRun(makeFetcher(80, api.fetchImpl), { now, state, env: {} },
    { key: "dbnomics", packages: [{ p: "XP", all: true, dims: null, ...o.pk }], db, bucket, cost: 6, maxBytes: 120000, pageBytes: 60000 });
  let p, n = 0;
  do { p = await run(t0 + n * 6e5); n++; } while (!p.doneAt && n < 30);
  assert.ok(p.doneAt, "Durchgang abgeschlossen");
  assert.ok(n > 1, "in mehreren Läufen (je Lauf höchstens cost Subrequests)");
  assert.equal(p.changed, 2);
  // D1: alle Reihen, alle Werte außer dem einen NA, Zeitraum und Anzahl je Reihe
  const cnt = db.sql.prepare("SELECT COUNT(*) AS n FROM obs").get().n;
  assert.equal(cnt, 40 * 12 - 1 + 3 * 2000);
  const s0 = db.sql.prepare("SELECT * FROM series WHERE id = 'dbn.XP.A1.M.US.X00'").get();
  assert.equal(s0.n, 11);
  assert.equal(s0.first, "2025-01-01");
  assert.equal(s0.unit, "Index");
  assert.equal(s0.freq, "M");
  assert.equal(s0.note, "XP/A1");
  const sum = await dbnomicsSummary(db, state.store.dbnomics);
  assert.deepEqual(sum.totals, { datasets: 2, series: 43, obs: 40 * 12 - 1 + 6000 });
  assert.equal(sum.progress.doneAt, p.doneAt);
  const hits = await dbnomicsSearch(db, { q: "Tagesreihe" });
  assert.equal(hits.series.length, 3);
  assert.equal((await dbnomicsSearch(db, { p: "XP", d: "A1" })).series.length, 40);
  // R2: Metadaten und Seiten je Stand; Tagesreihen einzeln (Seite sonst über maxBytes)
  const meta = await getJson(bucket, "dbnomics/XP/A1/datensatz.json");
  assert.equal(meta.reihen, 40);
  assert.equal(meta.beobachtungen, 479);
  assert.deepEqual(meta.staende, ["2026-10-01"]);
  assert.equal(meta.laufender_import, undefined);
  assert.ok(bucket.m.has("dbnomics/XP/A1/2026-10-01/0000000.json.gz"));
  const b2 = [...bucket.m.keys()].filter(k => k.startsWith("dbnomics/XP/B2/2026-10-02/"));
  assert.equal(b2.length, 3);
  const page = await getJson(bucket, "dbnomics/XP/A1/2026-10-01/0000000.json.gz");
  assert.equal(page.series.docs.length, 10);
  assert.ok((await getJson(bucket, "uebersicht.json")).dbnomics.anbieter.length === 1);

  // vor Ablauf von sieben Tagen: nichts zu tun, kein Abruf
  api.calls.length = 0;
  p = await run(t0 + 864e5);
  assert.equal(api.calls.length, 0);
  // nach sieben Tagen: neuer Durchgang, unverändert indexiert → keine Reihen geladen
  p = await run(t0 + 8 * 864e5);
  assert.equal(p.round, 2);
  assert.ok(p.doneAt);
  assert.equal(p.changed, 0);
  assert.equal(p.skipped, 2);
  assert.ok(!api.calls.some(c => c.includes("/series/")));
  // A1 neu indexiert: nur A1 neu, in einen neuen Stand; der alte bleibt liegen
  api.ds.A1.indexed_at = "2026-11-05T05:00:00.000Z";
  api.series.A1[1].value[0] = 99;
  n = 0;
  do { p = await run(t0 + 16 * 864e5 + n * 6e5); n++; } while (!p.doneAt && n < 30);
  assert.equal(p.round, 3);
  assert.equal(p.changed, 1);
  assert.equal(db.sql.prepare("SELECT v FROM obs WHERE s = 'dbn.XP.A1.M.DE.X01' AND d = '2025-01-01'").get().v, 99);
  assert.deepEqual((await getJson(bucket, "dbnomics/XP/A1/datensatz.json")).staende, ["2026-10-01", "2026-11-05"]);
  assert.ok(bucket.m.has("dbnomics/XP/A1/2026-10-01/0000000.json.gz") && bucket.m.has("dbnomics/XP/A1/2026-11-05/0000000.json.gz"));
});

test("Filter je Dimension, zu große Einzelreihe, nur R2 und Katalogbaum (Spiegel)", async () => {
  const api = fakeApi(), bucket = fakeBucket(), state = fakeState(), db = fakeD1();
  const now = Date.parse("2026-10-19T12:00:00Z");
  // Filter: nur Deutschland (20 der 40 Reihen); B2 mit maxBytes unter einer Tagesreihe → alle drei übersprungen
  let p, n = 0;
  do {
    p = await dbnomicsRun(makeFetcher(80, api.fetchImpl), { now: now + n * 6e5, state, env: {} },
      { key: "dbnomics", packages: [{ p: "XP", d: ["A1"], dims: { REF_AREA: ["DE"] } }, { p: "XP", d: ["B2"] }], db, bucket, cost: 10, maxBytes: 20000, pageBytes: 10000 });
    n++;
  } while (!p.doneAt && n < 40);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM series WHERE note = 'XP/A1'").get().n, 20);
  const m = await getJson(bucket, "dbnomics/XP/B2/datensatz.json");
  assert.equal(m.zu_gross_uebersprungen, 3);
  assert.equal(m.reihen, 0);
  assert.deepEqual(m.filter, null);
  assert.deepEqual((await getJson(bucket, "dbnomics/XP/A1/datensatz.json")).filter, { REF_AREA: ["DE"] });

  // Spiegel: Kennungen aus dem Katalogbaum, schon importierte (A1) übersprungen, nur R2, keine D1-Zeilen
  const b2 = fakeBucket(), st2 = fakeState();
  n = 0;
  do {
    p = await dbnomicsRun(makeFetcher(80, api.fetchImpl), { now: now + n * 6e5, state: st2, env: {} },
      { key: "dbnomics_mirror", packages: [{ p: "XP", tree: true, raw: true, skip: new Set(["XP/A1"]) }], bucket: b2, cost: 10, rawOnly: true });
    n++;
  } while (!p.doneAt && n < 40);
  assert.equal(p.datasets, 1);
  assert.ok([...b2.m.keys()].some(k => k.startsWith("dbnomics/XP/B2/2026-10-02/")));
  assert.ok(![...b2.m.keys()].some(k => k.startsWith("dbnomics/XP/A1/")));
  assert.equal((await getJson(b2, "dbnomics/XP/B2/datensatz.json")).nur_r2, true);
});

test("Fehler: Datensatz nach drei Fehlschlägen übersprungen, ohne geladene Seite als Fehler gemeldet", async () => {
  const api = fakeApi(), state = fakeState(), bucket = fakeBucket();
  const now = Date.parse("2026-10-19T12:00:00Z");
  const run = k => dbnomicsRun(makeFetcher(80, api.fetchImpl), { now: now + k * 6e5, state, env: {} },
    { key: "dbnomics", packages: [{ p: "XP", d: ["ZZ", "A1"] }], bucket, cost: 10 });
  // ZZ gibt es nicht (404): sofort übersprungen, danach A1 im selben Lauf
  const p = await run(0);
  assert.equal(state.store.dbnomics.failed[0].k, "XP/ZZ");
  assert.ok(p.run.pages > 0);
  assert.equal(API, "https://api.db.nomics.world/v22");
});
