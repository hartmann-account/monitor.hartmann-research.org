#!/usr/bin/env node
/* Führt alle Abrufjobs des Workers lokal in Node aus und schreibt den Snapshot nach public/data/live.json.
   Die Datei dient als Startbestand und als Rückfall, solange der Worker noch keinen eigenen Datenstand hat.
   Aufruf: node scripts/fetch_live.mjs [job-id ...]        nur diese Jobs
           node scripts/fetch_live.mjs --except a,b        alle außer diesen
   Hinter einem Proxy: NODE_USE_ENV_PROXY=1. Optional: FRED_API_KEY in der Umgebung. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOBS } from "../worker/jobs.js";
import { makeFetcher, sleep } from "../worker/lib/http.js";
import { runJob, summarize, statusOf, hasBindings } from "../worker/runner.js";
import { historyWithoutDb } from "../worker/jobs-signals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "data", "live.json");
const args = process.argv.slice(2);
const exIdx = args.indexOf("--except");
const except = exIdx >= 0 ? (args.splice(exIdx, 2)[1] || "").split(",") : [];
const only = args;
const prevSnap = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { data: {}, status: {} };
const stateFile = join(root, "public", "data", "gdelt-state.json");
const env = { ...process.env };
const meta = { jobs: {} };
const data = { ...prevSnap.data };
const now = Date.now();
let failed = 0;
for (const job of JOBS) {
  if ((only.length && !only.includes(job.id)) || except.includes(job.id) || !hasBindings(job, env)) {
    if (prevSnap.status && prevSnap.status[job.id]) meta.jobs[job.id] = { ...prevSnap.status[job.id] };
    continue;
  }
  const F = makeFetcher(200);
  const ctx = {
    now, env, prev: job.keep ? data[job.id] || null : null,
    state: {
      get: async k => (k === "gdelt" && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null),
      put: async (k, v) => { if (k === "gdelt") writeFileSync(stateFile, JSON.stringify(v)); },
    },
    seed: async p => { const f = join(root, "public", p); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; },
  };
  const t0 = Date.now(), c0 = process.cpuUsage();
  try {
    const res = await runJob(job, F, ctx);
    const cpu = process.cpuUsage(c0);
    data[job.id] = res;
    meta.jobs[job.id] = { ...summarize(res), ok: true, okAt: new Date().toISOString(), error: null };
    console.log(`ok    ${job.id.padEnd(18)} ${String(meta.jobs[job.id].n).padStart(3)} Reihen  bis ${meta.jobs[job.id].latest || "–"}  (${F.used} Abrufe, ${Date.now() - t0} ms, CPU ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms)`);
  } catch (e) {
    failed++;
    const prevSt = (prevSnap.status || {})[job.id] || {};
    meta.jobs[job.id] = { ...prevSt, ok: false, failAt: new Date().toISOString(), error: String(e.message || e).slice(0, 300) };
    console.log(`FEHLER ${job.id.padEnd(17)} ${e.message}`);
  }
  if (job.source === "gdelt") await sleep(1500);
  if (job.source === "oecd") await sleep(8000);
}
meta.updatedAt = new Date().toISOString();
// Signalverlauf ohne D1: Rückrechnung aus dem Startbestand, damit die Verlaufsansicht von Anfang an etwas zeigt
try {
  const histFile = join(root, "public", "data", "bigcycle.json");
  const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : null;
  const h = historyWithoutDb({ schema: 2, data, status: {} }, hist);
  data.signal_history = { series: {}, items: [h] };
  meta.jobs.signal_history = { n: 1, latest: h.dates[h.dates.length - 1], ok: true, okAt: meta.updatedAt, error: null };
  console.log(`ok    signal_history     ${h.dates.length} Stichtage (rückgerechnet, ohne D1)`);
} catch (e) { console.log("FEHLER signal_history", e.message); }
const snap = { schema: 2, generated: meta.updatedAt, origin: "seed", status: statusOf(meta), data };
writeFileSync(out, JSON.stringify(snap));
console.log(`\ngeschrieben: public/data/live.json (${(JSON.stringify(snap).length / 1024).toFixed(0)} KB), ${failed} Fehler`);
