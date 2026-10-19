/* Batch-Runner: wählt die fälligen Abrufjobs aus, führt sie im Rahmen des Subrequest-Budgets aus,
   legt jedes Ergebnis unter job:<id> in KV ab und setzt daraus den Snapshot zusammen.
   Der Snapshot wird ohne erneutes Parsen als Zeichenkette zusammengefügt, damit ein Lauf auch im
   Free-Plan (10 ms CPU) bleibt. Fehlgeschlagene Jobs behalten ihren letzten guten Stand (wie bei World Monitor). */
import { JOBS } from "./jobs.js";
import { makeFetcher } from "./lib/http.js";
import { lastObs } from "./lib/series.js";

export const META_KEY = "meta:v2";
export const SNAP_KEY = "snapshot:v2";
const HOUR = 3600000;

function backoff(fails) { return [1, 2, 4, 8, 12, 24][Math.min(fails - 1, 5)] * HOUR; }

export function dueJobs(meta, now, jobs = JOBS) {
  const due = [];
  for (const j of jobs) {
    const s = (meta.jobs && meta.jobs[j.id]) || {};
    if (s.retryAt && s.retryAt > now) continue;
    const last = s.okAt ? Date.parse(s.okAt) : 0;
    // 10 % Toleranz, damit ein Job nicht wegen weniger Minuten auf den nächsten Lauf rutscht
    if (now - last >= j.every * HOUR * 0.9) due.push({ job: j, age: last ? (now - last) / (j.every * HOUR) : 1e9 });
  }
  // nie geladene Jobs zuerst, dann nach relativer Überfälligkeit
  due.sort((a, b) => b.age - a.age);
  return due.map(d => d.job);
}

/* Kennzahlen einer Jobausgabe für den Datenstatus */
export function summarize(out) {
  const ser = out && out.series ? Object.values(out.series) : [];
  const dates = ser.map(lastObs).filter(Boolean).sort();
  return { n: ser.length + (out && out.items ? out.items.length : 0), latest: dates.length ? dates[dates.length - 1] : null };
}

export async function runJob(job, fetcher, ctx) {
  const out = await job.run(fetcher, ctx);
  const nSeries = out && out.series ? Object.keys(out.series).length : 0;
  if (!out || (!nSeries && !(out.items && out.items.length))) throw new Error("Leeres Ergebnis");
  return out;
}

/* Kontext eines Jobs im Worker: Umgebung, letzter Stand, kleiner Zustandsspeicher, statische Startdaten */
function workerCtx(env, now, prev, base) {
  return {
    now, env, prev,
    state: {
      get: k => env.DATA.get("state:" + k, "json"),
      put: (k, v) => env.DATA.put("state:" + k, JSON.stringify(v)),
    },
    async seed(path) {
      if (!env.ASSETS) return null;
      const r = await env.ASSETS.fetch(new Request(`${base}/${path}`));
      return r.ok ? r.json() : null;
    },
  };
}

export async function runDueJobs(env, opts = {}) {
  const now = opts.now ?? Date.now();
  const meta = (await env.DATA.get(META_KEY, "json")) || { jobs: {} };
  const maxJobs = Math.max(1, +(opts.maxJobs ?? env.MAX_JOBS_PER_RUN ?? 5));
  const budget = Math.max(1, +(env.SUBREQUEST_BUDGET ?? 40));
  const only = opts.only ? new Set(opts.only) : null;
  const queue = only ? JOBS.filter(j => only.has(j.id)) : dueJobs(meta, now);
  const fetcher = makeFetcher(budget);
  const ran = [];
  for (const job of queue) {
    if (ran.length >= maxJobs) break;
    if (fetcher.used + job.cost > budget) continue;
    // Quellen mit enger Drosselung (OECD) nur einmal je Lauf
    if (job.onePerRun && ran.some(id => { const j = JOBS.find(x => x.id === id); return j.onePerRun && j.source === job.source; })) continue;
    const s = meta.jobs[job.id] || {};
    const t0 = Date.now();
    try {
      const prev = job.keep ? await env.DATA.get("job:" + job.id, "json") : null;
      const out = await runJob(job, fetcher, workerCtx(env, now, prev, opts.base || "https://assets.invalid"));
      const body = JSON.stringify(out);
      await env.DATA.put("job:" + job.id, body);
      Object.assign(s, summarize(out), { ok: true, okAt: new Date(now).toISOString(), error: null, fails: 0, retryAt: null, bytes: body.length, ms: Date.now() - t0 });
    } catch (e) {
      s.ok = false;
      s.fails = (s.fails || 0) + 1;
      s.error = String((e && e.message) || e).slice(0, 300);
      s.failAt = new Date(now).toISOString();
      s.retryAt = now + backoff(s.fails);
    }
    meta.jobs[job.id] = s;
    ran.push(job.id);
  }
  if (!ran.length) return { ran, used: fetcher.used };
  meta.updatedAt = new Date(now).toISOString();
  // Häufige Jobs (GDELT) bauen den Snapshot höchstens alle 30 Minuten neu; andere Jobs sofort
  const onlyFrequent = ran.every(id => (JOBS.find(j => j.id === id) || {}).frequent);
  const stale = !meta.snapAt || now - Date.parse(meta.snapAt) > 30 * 60000;
  if (!onlyFrequent || stale || opts.forceSnapshot) {
    meta.snapAt = meta.updatedAt;
    await env.DATA.put(META_KEY, JSON.stringify(meta));
    await assembleSnapshot(env, meta);
  } else {
    await env.DATA.put(META_KEY, JSON.stringify(meta));
  }
  return { ran, used: fetcher.used, errors: ran.filter(id => !meta.jobs[id].ok).map(id => [id, meta.jobs[id].error]) };
}

export function statusOf(meta) {
  const status = {};
  for (const j of JOBS) {
    const s = meta.jobs[j.id] || {};
    status[j.id] = { label: j.label, source: j.source, every: j.every, ok: s.ok ?? null, okAt: s.okAt || null, failAt: s.failAt || null, error: s.error || null, latest: s.latest || null, n: s.n || 0 };
  }
  return status;
}

/* Snapshot = Status aller Jobs plus deren zuletzt erfolgreich geladene Ausgaben */
export async function assembleSnapshot(env, meta) {
  const parts = await Promise.all(JOBS.map(async j => [j.id, await env.DATA.get("job:" + j.id)]));
  const data = parts.filter(p => p[1]).map(([id, txt]) => JSON.stringify(id) + ":" + txt).join(",");
  const snap = `{"schema":2,"generated":${JSON.stringify(meta.updatedAt)},"origin":"worker","status":${JSON.stringify(statusOf(meta))},"data":{${data}}}`;
  await env.DATA.put(SNAP_KEY, snap);
  return snap.length;
}
