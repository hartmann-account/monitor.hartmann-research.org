/* Big-Cycle-Monitor: Worker.
   GET  /api/snapshot   alle Live-Reihen und der Abrufstatus (KV, Fallback: statischer Seed data/live.json)
   GET  /api/status     nur der Abrufstatus
   GET  /api/signals    Signalverlauf des Anlagebarometers aus D1 (?daily=Tage mit Tageswerten, Standard 120)
   POST /api/run        Abruf sofort anstoßen (nur mit Secret ADMIN_TOKEN; ?jobs=a,b für bestimmte Jobs)
   Alles andere liefert die statische Seite aus public/. Der Cron-Trigger ruft scheduled() auf. */
import { runDueJobs, META_KEY, SNAP_KEY } from "./runner.js";
import { JOBS } from "./jobs.js";
import { readHistory } from "./jobs-signals.js";

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

async function signals(request, env, ctx) {
  if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden" }, 404);
  const url = new URL(request.url);
  const cache = caches.default;
  const key = new Request(url.toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const daily = Math.min(2000, Math.max(0, +(url.searchParams.get("daily") ?? 120) || 0));
  const res = json(await readHistory(env.DB, { days: 2000, daily }), 200, { "cache-control": "public, max-age=600" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
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
