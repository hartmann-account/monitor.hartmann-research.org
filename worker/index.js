/* Big-Cycle-Monitor: Worker.
   GET  /api/snapshot   alle Live-Reihen und der Abrufstatus (KV, Fallback: statischer Seed data/live.json)
   GET  /api/status     nur der Abrufstatus
   GET  /api/signals    Signalverlauf des Anlagebarometers aus D1: ?h=m1|y1|lt (Horizont), ?daily=Tage mit allen
                        Tageswerten (sonst Monatsenden), ?pillars=1 mit Säulenwerten, ?format=csv
   GET  /api/archive    Datenarchiv (D1): alle Reihen mit Zeitraum und Anzahl der Beobachtungen, dazu der DBnomics-Bestand
                        (Summen je Anbieter und Stand des Imports)
   GET  /api/series     Beobachtungen aus dem Archiv: ?id=a,b (höchstens 20), ?from=, ?to=, ?thin=w (letzter Wert je
                        Kalenderwoche), ?format=csv; Kennungen dbn.… aus der DBnomics-Datenbank
   GET  /api/dbnomics   DBnomics-Bestand: ?q= Suche in Bezeichnung und Kennung (höchstens 200 Reihen je Abfrage, ?offset=),
                        ?p= Anbieter, ?d= Datensatz; ?datasets=1 alle Datensätze mit Umfang und Stand
   GET  /api/rohdaten   Rohdatenarchiv (R2): ?prefix=dbnomics/IMF/ Ordner und Dateien einer Ebene (?cursor= für weitere),
                        ?key= eine Datei herunterladen (.json.gz unverändert); der Eingang (eingang/) ist privat, nur seine
                        Vorschauen unter eingang/_vorschau/ sind abrufbar
   GET  /api/backtest   Backtest des Anlagebarometers: ohne Parameter die Kennzahlen aller Horizonte, mit ?h=m1|y1|lt&id=
                        die Einzelwerte einer Anlage (Monatsende, Gesamtwert, Stufe, Rendite danach), ?format=csv
   GET  /api/events     archivierte Meldungen (GDACS): ?from=
   POST /api/run        Abruf sofort anstoßen (nur mit Secret ADMIN_TOKEN; ?jobs=a,b für bestimmte Jobs)
   Alles andere liefert die statische Seite aus public/. Der Cron-Trigger ruft scheduled() auf. */
import { runDueJobs, META_KEY, SNAP_KEY } from "./runner.js";
import { JOBS } from "./jobs.js";
import { readHistory, ensureSchema } from "./jobs-signals.js";
import { archiveSummary, readSeries, ensureArchive } from "./archive.js";
import { dbnomicsSummary, dbnomicsSearch, dbnomicsDatasets } from "./dbnomics.js";
import { INBOX, PREVIEW } from "./inbox.js";
import { readBacktest } from "./jobs-backtest.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}

async function snapshot(request, env, ctx) {
  const url = new URL(request.url);
  const cache = caches.default;
  const key = new Request(url.origin + "/api/snapshot");
  const hit = await cache.match(key);
  if (hit) return hit;
  let body = await env.DATA.get(SNAP_KEY);
  let origin = "kv";
  if (!body) {
    const seed = await env.ASSETS.fetch(new Request(url.origin + "/data/live.json"));
    if (!seed.ok) return json({ error: "Noch kein Datenstand vorhanden" }, 503);
    body = await seed.text();
    origin = "seed";
  }
  const res = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-snapshot-origin": origin,
      ...CORS,
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function status(env) {
  const meta = (await env.DATA.get(META_KEY, "json")) || { jobs: {} };
  const jobs = JOBS.map(j => ({ id: j.id, label: j.label, source: j.source, every: j.every, ...(meta.jobs[j.id] || {}) }));
  return json({ updatedAt: meta.updatedAt || null, jobs });
}

/* Antworten aus D1 mit Zwischenspeicher (10 Minuten); Fehler werden nicht gespeichert */
async function cached(request, ctx, make) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await make(); } catch (e) { return json({ error: "Datenbank nicht lesbar", detail: String((e && e.message) || e).slice(0, 200) }, 500); }
  if (res.status === 200 && !/no-store/.test(res.headers.get("cache-control") || "")) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
const csvCell = v => (v == null ? "" : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function csv(rows, name) {
  return new Response(rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "public, max-age=600", ...CORS },
  });
}

async function signals(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const h = ["m1", "y1", "lt"].includes(url.searchParams.get("h")) ? url.searchParams.get("h") : "m1";
  const daily = Math.min(4000, Math.max(0, +(url.searchParams.get("daily") ?? 0) || 0));
  const days = Math.min(20000, Math.max(30, +(url.searchParams.get("days") ?? 4000) || 4000));
  const pillars = url.searchParams.get("pillars") === "1";
  return cached(request, ctx, async () => {
    await ensureSchema(env.DB);
    const body = await readHistory(env.DB, { h, days, daily, pillars });
    if (url.searchParams.get("format") !== "csv") return json(body, 200, { "cache-control": "public, max-age=600" });
    const ids = Object.keys(body.rows);
    const pk = pillars ? [...new Set(ids.flatMap(id => (body.rows[id].p || []).flatMap(p => (p ? Object.keys(p) : []))))] : [];
    const out = [["horizont", "datum", "art", "anlage", "gesamtwert", "stufe", ...pk]];
    body.dates.forEach((d, i) => { for (const id of ids) { const r = body.rows[id]; if (r.c[i] == null) continue; out.push([h, d, body.kinds[i], id, r.s[i], r.c[i], ...pk.map(k => (r.p && r.p[i] ? r.p[i][k] : null))]); } });
    return csv(out, `signalverlauf_${h}.csv`);
  });
}

async function archive(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  return cached(request, ctx, async () => {
    const A = await archiveSummary(env.DB);
    // DBnomics (eigene Datenbank): Summen je Anbieter und Stand des Imports
    if (env.DBN) A.dbnomics = await dbnomicsSummary(env.DBN, await env.DATA.get("state:dbnomics", "json")).catch(e => ({ error: String((e && e.message) || e).slice(0, 200) }));
    // ein noch leeres Archiv nicht zwischenspeichern, damit die ersten Abrufe sofort sichtbar werden
    return json(A, 200, { "cache-control": A.totals && A.totals.series ? "public, max-age=600" : "no-store" });
  });
}

async function rohdaten(request, env, ctx) {
  if (!env.ARCHIVE) return json({ error: "Kein R2-Bucket gebunden" }, 404);
  const url = new URL(request.url);
  const ok = v => /^[\w.@/:-]{1,300}$/.test(v) && !v.includes("..");
  const key = url.searchParams.get("key");
  if (key) {
    if (!ok(key)) return json({ error: "ungültiger Schlüssel" }, 400);
    // hochgeladene Dateien (etwa Excel-Dateien des World Gold Council) nicht weitergeben, nur ihre Vorschau
    if (key.startsWith(INBOX) && !key.startsWith(PREVIEW)) return json({ error: "Der Eingang ist privat; die Vorschau liegt unter " + PREVIEW }, 403);
    const o = await env.ARCHIVE.get(key);
    if (!o) return json({ error: "nicht gefunden" }, 404);
    const gz = o.httpMetadata && o.httpMetadata.contentEncoding === "gzip";
    // komprimierte Dateien unverändert als .json.gz, die übrigen als JSON
    return new Response(o.body, { headers: { "content-type": gz ? "application/gzip" : "application/json; charset=utf-8",
      ...(gz ? { "content-disposition": `attachment; filename="${key.split("/").pop()}"` } : {}), "cache-control": "public, max-age=600", ...CORS } });
  }
  const prefix = url.searchParams.get("prefix") || "";
  if (prefix && !ok(prefix)) return json({ error: "ungültiges Präfix" }, 400);
  const cursor = url.searchParams.get("cursor") || undefined;
  return cached(request, ctx, async () => {
    const r = await env.ARCHIVE.list({ prefix, delimiter: "/", limit: 1000, cursor });
    return json({ prefix, folders: r.delimitedPrefixes || [], files: r.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
      cursor: r.truncated ? r.cursor : null }, 200, { "cache-control": "public, max-age=600" });
  });
}

async function dbnomics(request, env, ctx) {
  if (!env.DBN) return json({ error: "Keine DBnomics-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const code = k => (/^[\w.:@-]{1,100}$/.test(url.searchParams.get(k) || "") ? url.searchParams.get(k) : null);
  return cached(request, ctx, async () => {
    if (url.searchParams.get("datasets") === "1") return json({ datasets: await dbnomicsDatasets(env.DBN) }, 200, { "cache-control": "public, max-age=600" });
    const q = (url.searchParams.get("q") || "").slice(0, 80);
    const offset = Math.max(0, Math.min(1e6, +(url.searchParams.get("offset") || 0) || 0));
    return json(await dbnomicsSearch(env.DBN, { q, p: code("p"), d: code("d"), offset }), 200, { "cache-control": "public, max-age=600" });
  });
}

async function series(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const ids = (url.searchParams.get("id") || "").split(",").map(x => x.trim()).filter(x => /^[\w.:-]{1,120}$/.test(x)).slice(0, 20);
  if (!ids.length) return json({ error: "Parameter id fehlt (Kennungen der Reihen, durch Komma getrennt; Liste unter /api/archive)" }, 400);
  const from = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : null;
  const to = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") + "~" : null;
  const weekly = url.searchParams.get("thin") === "w";
  return cached(request, ctx, async () => {
    // Kennungen dbn.… liegen in der DBnomics-Datenbank
    const own = ids.filter(id => !id.startsWith("dbn.")), dbn = env.DBN ? ids.filter(id => id.startsWith("dbn.")) : [];
    const data = {
      ...(own.length ? await readSeries(env.DB, own, { from, to, weekly }) : {}),
      ...(dbn.length ? await readSeries(env.DBN, dbn, { from, to, weekly }) : {}),
    };
    if (url.searchParams.get("format") !== "csv") return json(data, 200, { "cache-control": "public, max-age=600" });
    const out = [["reihe", "datum", "wert", "einheit", "bezeichnung"]];
    for (const [id, s] of Object.entries(data)) for (const [d, v] of s.points) out.push([id, d, v, s.unit, s.label]);
    return csv(out, ids.length === 1 ? `${ids[0]}.csv` : "reihen.csv");
  });
}

async function backtest(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const h = ["m1", "y1", "lt"].includes(url.searchParams.get("h")) ? url.searchParams.get("h") : "y1";
  const id = /^[\w-]{1,40}$/.test(url.searchParams.get("id") || "") ? url.searchParams.get("id") : null;
  return cached(request, ctx, async () => {
    const data = await readBacktest(env.DB, { h, id });
    // noch ohne Ergebnis (erster Lauf steht aus): nicht zwischenspeichern
    const empty = id ? !data.points.length : !Object.keys(data).length;
    if (!id || url.searchParams.get("format") !== "csv") return json(data, 200, empty ? {} : { "cache-control": "public, max-age=3600" });
    return csv([["monatsende", "gesamtwert", "stufe", "rendite_danach"], ...data.points], `backtest_${h}_${id}.csv`);
  });
}

async function events(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : "0000";
  return cached(request, ctx, async () => {
    await ensureArchive(env.DB);
    const { results } = await env.DB.prepare("SELECT src, id, d, kind, name, level, country, url, first_seen, last_seen FROM events WHERE d >= ? ORDER BY d DESC LIMIT 2000").bind(from).all();
    return json({ events: results }, 200, { "cache-control": "public, max-age=600" });
  });
}

async function manualRun(request, env, ctx) {
  const auth = request.headers.get("authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "nicht berechtigt" }, 401);
  const url = new URL(request.url);
  const only = url.searchParams.get("jobs");
  const result = await runDueJobs(env, { only: only ? only.split(",") : null, maxJobs: only ? 50 : undefined });
  await caches.default.delete(new Request(url.origin + "/api/snapshot"));
  return json(result);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/api/snapshot" && request.method === "GET") return snapshot(request, env, ctx);
    if (url.pathname === "/api/status" && request.method === "GET") return status(env);
    if (url.pathname === "/api/signals" && request.method === "GET") return signals(request, env, ctx);
    if (url.pathname === "/api/archive" && request.method === "GET") return archive(request, env, ctx);
    if (url.pathname === "/api/series" && request.method === "GET") return series(request, env, ctx);
    if (url.pathname === "/api/dbnomics" && request.method === "GET") return dbnomics(request, env, ctx);
    if (url.pathname === "/api/rohdaten" && request.method === "GET") return rohdaten(request, env, ctx);
    if (url.pathname === "/api/events" && request.method === "GET") return events(request, env, ctx);
    if (url.pathname === "/api/backtest" && request.method === "GET") return backtest(request, env, ctx);
    if (url.pathname === "/api/run" && request.method === "POST") return manualRun(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return json({ error: "unbekannter Endpunkt" }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDueJobs(env, { now: controller.scheduledTime }).then(r => {
      if (r.ran.length) console.log(JSON.stringify({ msg: "cron", ...r }));
    }));
  },
};
