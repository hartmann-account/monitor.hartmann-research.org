/* DBnomics (db.nomics.world): Datensätze großer Statistikanbieter als eigener Datenbestand des Monitors.
   Umfang (PACKAGES): IWF mit allen Ausgaben des World Economic Outlook seit 2008, OECD, Eurostat, EZB, BIZ, Weltbank,
   Fed, ISM, EU-Kommission sowie Zentralbanken und Statistikämter der Schwellenländer; große Datensätze auf die Länder
   des Monitors begrenzt.
   D1 (eigene Datenbank monitor-dbnomics, Bindung DBN, getrennt vom Datenarchiv, damit der Import die Seite nicht bremst):
     Tabellen series und obs wie im Datenarchiv, Kennung dbn.<anbieter>.<datensatz>.<reihe>; datasets: Umfang und Stand
     je Datensatz.
   R2 (Bucket monitor, Bindung ARCHIVE): jede Antwort der Schnittstelle unverändert unter
     dbnomics/<anbieter>/<datensatz>/<stand>/<reihe>.json.gz, Metadaten unter dbnomics/<anbieter>/<datensatz>/datensatz.json;
     frühere Stände bleiben liegen (eigene Datenstände). Datensätze mit raw: true nur in R2 (Fed Z.1, 42.000 Reihen).
   Ablauf in Etappen, Zustand in KV: Ein Durchgang stellt die Liste der Datensätze auf, prüft je Datensatz den
   Indexierungsstand bei DBnomics und lädt nur neu indexierte Datensätze seitenweise; je Lauf höchstens einige Seiten.
   Nach einem vollständigen Durchgang beginnt der nächste nach sieben Tagen.
   Der Job dbnomics_mirror lädt mit derselben Technik weitere Anbieter nur nach R2 (Schalter DBNOMICS_MIRROR). */
import { putJson, putTextGz, getJson, updateOverview, dbnMetaKey, dbnPageKey } from "./r2.js";
import { ensureArchive, writeObs, writeSeriesMeta, isoDate } from "./archive.js";
import { makeFetcher } from "./lib/http.js";

export const API = "https://api.db.nomics.world/v22";
const REFRESH_DAYS = 7;
const PAGE_BYTES = 3e6;   // Zielgröße einer Antwort; die Zahl der Reihen je Seite richtet sich nach der vorigen Seite
const MAX_BYTES = 8e6;    // größere Antworten werden abgebrochen und mit weniger Reihen wiederholt (Worker: 128 MB Speicher)
// je Lauf höchstens so lange neue Seiten beginnen: Die Schnittstelle braucht für 1.000 Reihen 15 bis 35 Sekunden, die
// Rechenzeit bleibt gering (Cron-Läufe: 30 s CPU, 15 Minuten Laufzeit); unter dem Abstand der Cron-Läufe von 10 Minuten
const RUN_MS = 240000;
const BUDGET = 300;       // eigene Subrequests je Lauf (nicht aus dem Budget der übrigen Quellen)
const FIRST_LIMIT = 10;   // erste Seite eines Datensatzes klein (Tagesreihen können je Reihe mehrere 100 kB groß sein)
// Stand des Importzustands: Bei einer Änderung beginnt der Import von vorn (2: R2-Bucket im EU-Rechtsraum, damit dort alle
// Seiten liegen; D1 schreibt dabei nur geänderte Werte)
const STATE_V = 2;

// Länder des Monitors: ISO 3 (WEO, Weltbank) und ISO 2 (IWF, BIZ); dazu Euroraum (U2) und Welt (W00)
const C3 = ["USA", "CHN", "DEU", "JPN", "GBR", "IND", "FRA", "ITA", "ESP", "NLD", "CHE", "CAN", "AUS", "KOR", "BRA", "MEX", "ZAF",
  "IDN", "TUR", "RUS", "SAU", "ARG", "POL", "SWE", "TWN"];
const C2 = ["US", "CN", "DE", "JP", "GB", "IN", "FR", "IT", "ES", "NL", "CH", "CA", "AU", "KR", "BR", "MX", "ZA", "ID", "TR", "RU",
  "SA", "AR", "PL", "SE", "TW"];

/* Pakete: d = feste Datensätze; match = Muster für Datensatzkennungen, name = Muster für Datensatznamen, all = alle Datensätze
   des Anbieters (diese drei über die Datensatzliste des Anbieters); dims = Filter je Dimension; raw = nur R2 */
export const PACKAGES = [
  // IWF: alle WEO-Ausgaben (Prognosen im damaligen Stand), Aggregate, Rohstoffpreise, Reserven, Fiscal Monitor, IFS
  { p: "IMF", match: "^WEO:\\d{4}-\\d{2}$", dims: { "weo-country": C3 } },
  { p: "IMF", match: "^WEOAGG:\\d{4}-\\d{2}$", dims: { "weo-countries-group": ["001", "110", "119", "163", "200", "505"] } },
  { p: "IMF", d: ["PCPS", "COFER", "FM", "APDREO"] },
  { p: "IMF", d: ["IFS", "FSI"], dims: { REF_AREA: [...C2, "U2", "W00"] } },
  { p: "IMF", d: ["DOT"], dims: { FREQ: ["A"], REF_AREA: [...C2, "W00"], COUNTERPART_AREA: [...C2, "W00"] } },
  // OECD: Kennzahlen, Frühindikatoren, Umfragen, Finanzmärkte, Wohnimmobilien, Quartals-BIP der G20, Economic Outlook
  { p: "OECD", d: ["DSD_KEI@DF_KEI", "DSD_STES@DF_CLI", "DSD_STES@DF_BTS", "DSD_STES@DF_CS", "DSD_STES@DF_CSBAR", "DSD_STES@DF_FINMARK",
    "DSD_RHPI_TARGET@DF_RHPI_TARGET", "DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_G20", "DSD_EO@DF_EO"] },
  // Eurostat: Euro-Indikatoren (Umfragen, Preise, Arbeitsmarkt, Handel, Zahlungsbilanz, Häuserpreise), Zinsen, Staatsschulden
  // und Echtzeit-Datenstände von BIP, Industrieproduktion und Arbeitslosigkeit
  { p: "Eurostat", d: ["ei_bssi_m_r2", "ei_bsci_m_r2", "ei_bsin_m_r2", "ei_bsse_m_r2", "ei_bsrt_m_r2", "ei_bsbu_m_r2", "ei_bsco_m",
    "ei_bsee_m_r2", "ei_cphi_m", "ei_lmhr_m", "ei_isrt_m", "ei_hppi_q", "ei_mfir_m", "ei_mfef_m", "ei_bpm6ca_q", "ei_bpm6iip_q",
    "irt_euryld_m", "irt_lt_mcby_m", "irt_st_m", "gov_10q_ggdebt", "ei_na_q_vtg", "ei_is_m_vtgfix", "ei_is_m_vtg", "ei_lm_m_vtg"] },
  // EZB: Stressindizes, €STR, Finanzmärkte, Projektionen, Echtzeit-Datenbank, Verbrauchererwartungen, Immobilien, Umfragen
  { p: "ECB", d: ["CISS", "CLIFS", "EST", "FM", "MPD", "RTD", "CES", "RESR", "RPP", "SUR", "TGB"] },
  { p: "ECB", d: ["EXR"], dims: { FREQ: ["M"] } },
  { p: "ECB", d: ["BLS", "MIR"], dims: { REF_AREA: ["U2", "DE", "FR", "IT", "ES", "NL"] } },
  { p: "ECB", d: ["SPF"], dims: { FCT_SOURCE: ["AVG"] } },
  // BIZ: Kredit, Schuldendienst, Kreditlücke, Immobilien, lange Preisreihen, Leitzinsen, Zentralbankbilanzen, Liquidität
  { p: "BIS", d: ["WS_TC", "WS_DSR", "WS_CREDIT_GAP", "WS_SPP", "WS_CPP", "WS_LONG_CPI", "WS_CBPOL", "WS_CBTA", "WS_GLI"] },
  { p: "BIS", d: ["WS_EER", "WS_XRU"], dims: { FREQ: ["M"] } },
  // Weltbank: Prognosen, Rohstoffpreise (Pink Sheet), Global Economic Monitor, Entwicklungs- und Governance-Indikatoren
  { p: "WB", d: ["GEP", "commodity_prices"] },
  { p: "WB", d: ["GEM"], dims: { country: [...C3, "WLT"] } },
  { p: "WB", d: ["WDI", "WGI"], dims: { country: [...C3, "WLD", "EMU", "HIC", "LMY"] } },
  // Fed: Zinsen, Wechselkurse, Bilanz, Banken, Geldmengen, Produktion und Auslastung, Zinskurven, Kreditausfälle; Z.1 nur R2
  { p: "FED", d: ["H15", "H10", "H41", "H8", "H3", "H6_H6_M1", "H6_H6_M2", "H6_H6_MBASE", "H6_H6_MEMO", "G17_CAPUTL", "G17_CAP",
    "G17_IP_MAJOR_INDUSTRY_GROUPS", "G17_IP_MARKET_GROUPS", "G17_IP_SPECIAL_AGGREGATES", "G17_DIFF", "PRATES_PRATES_POLICY_RATES",
    "NOMINAL_YIELD_CURVE", "TIPS", "FOR", "CHGDEL"] },
  { p: "FED", d: ["Z1"], raw: true },
  // ISM, Konjunkturumfragen der EU-Kommission, China (Statistikamt, nach Themen), Zentralbanken der Schwellenländer
  { p: "ISM", all: true },
  { p: "EC", match: "^(INDUSTRY|SERVICE|RETAIL|CONSTRUCTION|CONSUMPTION|FINANCIAL_SERVICES)$" },
  { p: "NBS", name: "PMI|Purchasing Managers|Consumer Price|Producer Price|Industrial|Retail|Fixed Asset|Money Supply|Export|Import|Real Estate|Gross Domestic" },
  ...["BCB", "TCMB", "SARB", "BI", "MOSPI", "INEGI", "SAFE"].map(p => ({ p, all: true })),
];

const FREQ = { annual: "A", "bi-annual": "S", quarterly: "Q", "bi-monthly": "B", monthly: "M", weekly: "W", daily: "D" };
const clean = s => String(s).replace(/[^\w.:-]+/g, "_");
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
/* Kennung im Monitor: dbn.<anbieter>.<datensatz>.<reihe>; andere Zeichen als Buchstaben, Ziffern und _ . : - werden zu _,
   dann (wie bei mehr als 120 Zeichen) mit Prüfsumme, damit die Kennung eindeutig bleibt */
export function seriesId(p, d, code) {
  const c = clean(code);
  const id = `dbn.${clean(p)}.${clean(d)}.${c}`;
  return c !== String(code) || id.length > 120 ? `${id.slice(0, 110)}.${fnv(`${p}/${d}/${code}`)}` : id;
}
const enc = d => encodeURIComponent(d);
export function pageUrl(e, offset, limit) {
  const q = new URLSearchParams({ observations: "1", metadata: "false", limit: String(limit), offset: String(offset) });
  if (e.dims) q.set("dimensions", JSON.stringify(e.dims));
  return `${API}/series/${e.p}/${enc(e.d)}?${q}`;
}

/* Einheiten-Dimension eines Datensatzes (unit, UNIT_MEASURE, …) mit Bezeichnungen */
export function unitDim(ds) {
  const key = (ds.dimensions_codes_order || []).find(k => /^unit/i.test(k) || /unit_measure|_unit$/i.test(k));
  if (!key) return null;
  const lab = (ds.dimensions_values_labels || {})[key];
  return { key, labels: Array.isArray(lab) ? Object.fromEntries(lab) : lab || {} };
}

/* Beobachtungen und Reihen-Metadaten einer Seite: [kennung, datum, wert]; fehlende Werte ("NA") entfallen */
export function pageRows(docs, e, units) {
  const rows = [], metas = [];
  for (const x of docs) {
    const id = seriesId(e.p, e.d, x.series_code);
    const P = x.period_start_day || [], Q = x.period || [], V = x.value || [];
    for (let i = 0; i < V.length; i++) {
      const v = V[i];
      if (typeof v === "number" && Number.isFinite(v)) rows.push([id, P[i] || isoDate(Q[i]), v]);
    }
    const u = units && x.dimensions ? x.dimensions[units.key] : null;
    metas.push({ id, l: String(x.series_name || x.series_code).slice(0, 300), u: u == null ? null : String(units.labels[u] || u).slice(0, 80),
      f: FREQ[x["@frequency"]] || "X", src: "dbnomics", note: `${e.p}/${e.d}` });
  }
  return { rows, metas };
}

/* Antwort lesen, aber höchstens maxBytes (sonst null: die Seite wird mit weniger Reihen wiederholt) */
async function boundedText(F, url, maxBytes) {
  const r = await F.request(url, { timeout: 90000 });
  if (+(r.headers.get("content-length") || 0) > maxBytes) { await r.body.cancel().catch(() => {}); return null; }
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new TextDecoder().decode(buf);
}

/* ------------------------------------------------------------------ D1 (Datenbank monitor-dbnomics) */
const EXTRA = [
  `CREATE TABLE IF NOT EXISTS datasets (p TEXT NOT NULL, d TEXT NOT NULL, name TEXT, indexed_at TEXT, nb_series INTEGER,
    series INTEGER, obs INTEGER, filter TEXT, stand TEXT, pages INTEGER, raw INTEGER, imported_at TEXT, PRIMARY KEY (p, d))`,
  "CREATE INDEX IF NOT EXISTS series_note ON series (note)",
];
const ready = new WeakMap();
export async function ensureDbn(db) {
  await ensureArchive(db);
  if (!ready.has(db)) ready.set(db, db.batch(EXTRA.map(q => db.prepare(q))).catch(e => { ready.delete(db); throw e; }));
  return ready.get(db);
}
const UPSERT_DATASET = `INSERT INTO datasets (p, d, name, indexed_at, nb_series, series, obs, filter, stand, pages, raw, imported_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT (p, d) DO UPDATE SET name = excluded.name,
  indexed_at = excluded.indexed_at, nb_series = excluded.nb_series, series = excluded.series, obs = excluded.obs,
  filter = excluded.filter, stand = excluded.stand, pages = excluded.pages, raw = excluded.raw, imported_at = excluded.imported_at`;

/* ------------------------------------------------------------------ Durchgang */
const keyOf = e => `${e.p}/${e.d}`;
const roundDue = (st, now) => !st || (!!st.doneAt && now - Date.parse(st.doneAt) >= REFRESH_DAYS * 864e5);
const entry = (P, d, x = null) => ({ p: P.p, d, dims: P.dims || null, raw: !!P.raw, ia: x ? x.indexed_at || null : null });
const newRound = (prev, nowIso) => ({ v: STATE_V, round: ((prev && prev.round) || 0) + 1, startedAt: nowIso, doneAt: null, plan: { k: 0, offset: 0 },
  queue: [], i: 0, cur: null, seen: (prev && prev.seen) || {}, fails: {}, changed: 0, skipped: 0, failed: [] });

/* Liste der Datensätze aufstellen; Anbieterlisten seitenweise (je 500 Datensätze), mirror: Kennungen aus dem Katalogbaum */
async function plan(F, st, packages, left) {
  while (st.plan.k < packages.length) {
    const P = packages[st.plan.k];
    if (P.d) {
      for (const d of P.d) st.queue.push(entry(P, d));
    } else if (P.tree) {
      if (!left()) return false;
      const t = await F.json(`${API}/providers/${P.p}`, { timeout: 90000 });
      const codes = new Set();
      const walk = c => { for (const x of c || []) if (x.children) walk(x.children); else if (x.code) codes.add(x.code); };
      walk(t.category_tree);
      for (const d of codes) if (!P.skip || !P.skip.has(`${P.p}/${d}`)) st.queue.push(entry(P, d));
    } else {
      if (!left()) return false;
      const j = await F.json(`${API}/datasets/${P.p}?limit=500&offset=${st.plan.offset}`, { timeout: 90000 });
      const docs = (j.datasets && j.datasets.docs) || [];
      const re = P.match ? new RegExp(P.match) : null, nre = P.name ? new RegExp(P.name, "i") : null;
      for (const x of docs) if ((!re || re.test(x.code)) && (!nre || nre.test(x.name || ""))) st.queue.push(entry(P, x.code, x));
      st.plan.offset += docs.length;
      if (docs.length && st.plan.offset < ((j.datasets && j.datasets.num_found) || 0)) continue;
    }
    st.plan.k++;
    st.plan.offset = 0;
  }
  return true;
}

/* Datensatz beginnen: Metadaten laden; unverändert seit dem letzten Import → überspringen (false) */
async function beginDataset(F, st, e, bucket, nowIso) {
  if (e.ia && st.seen[keyOf(e)] === e.ia) return false;
  const j = await F.json(`${API}/datasets/${e.p}/${enc(e.d)}`, { timeout: 60000 });
  const ds = j.datasets && j.datasets.docs && j.datasets.docs[0];
  if (!ds) throw new Error(`DBnomics: keine Metadaten für ${keyOf(e)}`);
  if (st.seen[keyOf(e)] && st.seen[keyOf(e)] === ds.indexed_at) return false;
  const stand = (ds.indexed_at || nowIso).slice(0, 10);
  st.cur = { offset: 0, limit: FIRST_LIMIT, ia: ds.indexed_at || null, stand, name: ds.name || e.d, nb: ds.nb_series ?? null,
    units: unitDim(ds), found: null, n: 0, obs: 0, pages: 0, big: 0, since: nowIso };
  if (bucket) {
    const prev = (await getJson(bucket, dbnMetaKey(e.p, e.d)).catch(() => null)) || {};
    await putJson(bucket, dbnMetaKey(e.p, e.d), { ...prev, anbieter: e.p, datensatz: e.d, name: ds.name || e.d, quelle: `https://db.nomics.world/${e.p}/${e.d}`,
      filter: e.dims, nur_r2: e.raw, metadaten: ds, laufender_import: { stand, seit: nowIso } });
  }
  return true;
}

async function finishDataset(db, bucket, st, e, nowIso) {
  const c = st.cur;
  if (bucket) {
    const prev = (await getJson(bucket, dbnMetaKey(e.p, e.d)).catch(() => null)) || {};
    const staende = [...new Set([...(prev.staende || []), c.stand])].sort();
    const { laufender_import, ...rest } = prev;
    await putJson(bucket, dbnMetaKey(e.p, e.d), { ...rest, anbieter: e.p, datensatz: e.d, name: c.name, filter: e.dims, nur_r2: e.raw,
      stand: c.stand, indexed_at: c.ia, reihen_gesamt: c.nb, reihen: c.n, beobachtungen: c.obs, seiten: c.pages,
      zu_gross_uebersprungen: c.big, importiert: nowIso, staende });
  }
  if (db) await db.prepare(UPSERT_DATASET).bind(e.p, e.d, c.name, c.ia, c.nb, c.n, c.obs, e.dims ? JSON.stringify(e.dims) : null,
    c.stand, c.pages, e.raw ? 1 : 0, nowIso).run();
  st.seen[keyOf(e)] = c.ia;
  st.cur = null;
  st.i++;
  st.changed++;
}

/* Ein Lauf: Liste aufstellen bzw. fortsetzen, dann Seiten laden, bis Subrequests (cost) oder Zeit (RUN_MS) aufgebraucht sind.
   o: { key (Zustand in KV), packages, db (D1 oder null für nur R2), bucket (R2), cost, rawOnly; für Tests maxBytes, pageBytes, runMs } */
export async function dbnomicsRun(F, ctx, o) {
  const { key, packages, db = null, bucket = null, cost, rawOnly = false, maxBytes = MAX_BYTES, pageBytes = PAGE_BYTES, runMs = RUN_MS } = o;
  const t0 = Date.now(), now = ctx.now, nowIso = new Date(now).toISOString();
  const cap = Math.min(F.budget, F.used + cost);
  const left = () => F.used < cap && Date.now() - t0 < runMs;
  let st = await ctx.state.get(key);
  if (st && st.v !== STATE_V) st = null;
  if (roundDue(st, now)) st = newRound(st, nowIso);
  // Durchgang abgeschlossen, der nächste noch nicht fällig: nichts zu tun
  if (st.doneAt) return progress(st);
  // ein anderer Lauf arbeitet noch (Sperre bis Ende seiner Laufzeit): nicht doppelt laden
  if (st.lease && st.lease > Date.now()) return progress(st);
  st.lease = Date.now() + runMs + 120000;
  await ctx.state.put(key, st);
  const leaseAt = Date.now();
  const run = { pages: 0, series: 0, obs: 0, datasets: 0, error: null };
  if (db) await ensureDbn(db);
  try {
    if (st.planned || (st.planned = await plan(F, st, packages, left))) {
      while (st.i < st.queue.length && left()) {
        const e = st.queue[st.i], k = keyOf(e);
        try {
          if (!st.cur) {
            const raw = e.raw || rawOnly;
            if ((raw && !bucket) || !(await beginDataset(F, st, e, bucket, nowIso))) { st.i++; st.skipped++; continue; }
          }
          const c = st.cur;
          while (left()) {
            const lim = c.limit;
            const txt = await boundedText(F, pageUrl(e, c.offset, lim), maxBytes);
            if (txt == null) {
              // Seite zu groß: weniger Reihen; eine einzelne zu große Reihe wird übersprungen (zählt in big)
              if (c.limit > 1) c.limit = Math.max(1, Math.floor(c.limit / 8));
              else { c.offset++; c.big++; }
              continue;
            }
            const J = JSON.parse(txt);
            // Antwort ohne Reihenliste (Fehlermeldung der Schnittstelle): im nächsten Lauf erneut versuchen
            if (!J.series) throw new Error(`DBnomics: ${String(J.message || "Antwort ohne Reihen").slice(0, 160)}`);
            const S = J.series;
            const docs = S.docs || [];
            if (S.num_found != null) c.found = S.num_found;
            if (bucket) await putTextGz(bucket, dbnPageKey(e.p, e.d, c.stand, c.offset), txt, { anbieter: e.p, datensatz: e.d, stand: c.stand });
            if (db && !e.raw && !rawOnly) {
              const { rows, metas } = pageRows(docs, e, c.units);
              await writeObs(db, rows);
              await writeSeriesMeta(db, metas, "dbnomics", nowIso);
              c.obs += rows.length;
              run.obs += rows.length;
            } else {
              c.obs += docs.reduce((a, x) => a + (x.value || []).length, 0);
            }
            c.n += docs.length;
            c.offset += docs.length;
            c.pages++;
            run.pages++;
            run.series += docs.length;
            // nächste Seite: Zahl der Reihen aus der Größe dieser Seite, höchstens zehnmal so viele wie bisher, höchstens 1000
            const per = txt.length / Math.max(1, docs.length);
            c.limit = Math.max(1, Math.min(1000, c.limit * 10, Math.floor(pageBytes / per)));
            if (!docs.length || (c.found != null ? c.offset >= c.found : docs.length < lim)) {
              await finishDataset(db, bucket, st, e, nowIso);
              run.datasets++;
              break;
            }
          }
          delete st.fails[k];
        } catch (err) {
          // Fehler eines Datensatzes: im nächsten Lauf erneut, nach dem dritten Fehlschlag überspringen
          const msg = String((err && err.message) || err).slice(0, 300);
          st.fails[k] = (st.fails[k] || 0) + 1;
          run.error = `${k}: ${msg}`;
          if (st.fails[k] >= 3 || (err && err.status === 404)) {
            st.failed = [...(st.failed || []).filter(x => x.k !== k), { k, error: msg, at: nowIso }].slice(-50);
            delete st.fails[k];
            st.cur = null;
            st.i++;
            continue;
          }
          break;
        }
      }
      if (st.planned && st.i >= st.queue.length) st.doneAt = nowIso;
    }
  } finally {
    st.lease = null;
    // KV nimmt je Schlüssel höchstens einen Schreibvorgang pro Sekunde an
    const wait = 1100 - (Date.now() - leaseAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    await ctx.state.put(key, st);
  }
  if (run.datasets && bucket) await updateOverview(bucket, { [key]: await overviewPart(db, st) }, nowIso).catch(() => {});
  // keine Seite geladen und Fehler: als Fehler melden (Wartezeit des Runners), sonst Stand des Durchgangs
  if (run.error && !run.pages && !st.doneAt) throw new Error(run.error);
  return progress(st, run);
}

export function progress(st, run = null) {
  const c = st.cur;
  return { round: st.round, startedAt: st.startedAt, doneAt: st.doneAt, planned: !!st.planned, datasets: st.queue.length, at: st.i,
    changed: st.changed, skipped: st.skipped, failed: (st.failed || []).length,
    failedList: (st.failed || []).slice(-10).map(x => ({ ds: x.k, error: String(x.error || "").slice(0, 160), at: x.at })),
    current: c ? { ds: keyOf(st.queue[st.i]), offset: c.offset, found: c.found, stand: c.stand } : null,
    nextRound: st.doneAt ? new Date(Date.parse(st.doneAt) + REFRESH_DAYS * 864e5).toISOString() : null, run };
}

async function overviewPart(db, st) {
  const out = { durchgang: st.round, begonnen: st.startedAt, abgeschlossen: st.doneAt, datensaetze_geplant: st.queue.length, bearbeitet: st.i };
  if (db) out.anbieter = (await providerTotals(db)).map(r => ({ anbieter: r.p, datensaetze: r.datasets, reihen: r.series, beobachtungen: r.obs, zuletzt: r.updated }));
  return out;
}

/* ------------------------------------------------------------------ Abfragen für Seite und API */
async function providerTotals(db) {
  const { results } = await db.prepare(`SELECT p, COUNT(*) AS datasets, SUM(raw) AS raw, COALESCE(SUM(series), 0) AS series,
    COALESCE(SUM(CASE WHEN raw = 1 THEN 0 ELSE obs END), 0) AS obs, MAX(imported_at) AS updated FROM datasets GROUP BY p ORDER BY series DESC`).all();
  return results;
}
export async function dbnomicsSummary(db, st) {
  await ensureDbn(db);
  const providers = await providerTotals(db);
  const tot = providers.reduce((a, r) => ({ datasets: a.datasets + r.datasets, series: a.series + (r.series || 0), obs: a.obs + (r.obs || 0) }), { datasets: 0, series: 0, obs: 0 });
  return { totals: tot, providers, progress: st ? progress(st) : null };
}
/* Datensätze (Liste) und Reihensuche: q in Bezeichnung oder Kennung, p/d grenzen auf Anbieter bzw. Datensatz ein */
export async function dbnomicsDatasets(db) {
  await ensureDbn(db);
  const { results } = await db.prepare("SELECT p, d, name, indexed_at, nb_series, series, obs, filter, stand, pages, raw, imported_at FROM datasets ORDER BY p, d").all();
  return results;
}
export async function dbnomicsSearch(db, { q = "", p = null, d = null, offset = 0 } = {}) {
  await ensureDbn(db);
  const like = `%${String(q).replace(/[%_]/g, "")}%`;
  const note = p && d ? `${p}/${d}` : null, pre = p && !d ? `${p}/%` : null;
  const { results } = await db.prepare(`SELECT id, label, unit, freq, note, first, last, n FROM series
    WHERE (?1 = '%%' OR label LIKE ?1 OR id LIKE ?1) AND (?2 IS NULL OR note = ?2) AND (?3 IS NULL OR note LIKE ?3)
    ORDER BY id LIMIT 200 OFFSET ?4`).bind(like, note, pre, offset).all();
  return { q, p, d, offset, series: results };
}

/* ------------------------------------------------------------------ Jobs */
// Weitere Anbieter nur nach R2: DBNOMICS_MIRROR = Anbieterkennungen mit Komma (etwa "Eurostat,OECD") oder "*" für alle
export async function mirrorPackages(F, env, ctx) {
  const want = String(env.DBNOMICS_MIRROR || "").split(",").map(s => s.trim()).filter(Boolean);
  let providers = want;
  if (want.includes("*")) {
    const j = await F.json(`${API}/providers`, { timeout: 60000 });
    providers = ((j.providers && j.providers.docs) || []).map(x => x.code);
  }
  // Datensätze, die der Job dbnomics schon lädt, nicht doppelt
  const main = await ctx.state.get("dbnomics");
  const skip = new Set(main ? main.queue.map(keyOf) : []);
  return providers.map(p => ({ p, tree: true, raw: true, skip }));
}

/* Beide Jobs laufen nach allen anderen fälligen Jobs (background), mit eigenem Subrequest-Budget (cost 0 im Budget der
   übrigen Quellen), ihre Ausgabe ist nur der Stand des Imports (noRaw: nicht unter quellen/ in R2) */
export const DBNOMICS_JOBS = [
  {
    id: "dbnomics", label: "DBnomics: IWF (alle WEO-Ausgaben), OECD, Eurostat, EZB, BIZ, Weltbank, Fed und Schwellenländer (eigene D1-Datenbank und R2)",
    source: "dbnomics", every: 1 / 6, cost: 0, requires: ["DBN"], noArchive: true, noRaw: true, frequent: true, background: true,
    async run(F, ctx) {
      const G = makeFetcher(BUDGET);
      const p = await dbnomicsRun(G, ctx, { key: "dbnomics", packages: PACKAGES, db: ctx.env.DBN, bucket: ctx.env.ARCHIVE || null, cost: BUDGET });
      return { series: {}, items: [p] };
    },
  },
  {
    id: "dbnomics_mirror", label: "DBnomics: weitere Anbieter als Rohdaten nach R2 (eingeschaltet über DBNOMICS_MIRROR)",
    source: "dbnomics", every: 1 / 6, cost: 0, requires: ["ARCHIVE", "DBNOMICS_MIRROR"], noArchive: true, noRaw: true, frequent: true, background: true,
    async run(F, ctx) {
      const G = makeFetcher(BUDGET);
      // Anbieterliste nur, solange die Liste der Datensätze aufgestellt wird
      const st = await ctx.state.get("dbnomics_mirror");
      const packages = !st || st.v !== STATE_V || roundDue(st, ctx.now) || !st.planned ? await mirrorPackages(G, ctx.env, ctx) : [];
      const p = await dbnomicsRun(G, ctx, { key: "dbnomics_mirror", packages, bucket: ctx.env.ARCHIVE, cost: BUDGET, rawOnly: true });
      return { series: {}, items: [p] };
    },
  },
];
