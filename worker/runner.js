/* Batch-Runner: wählt die fälligen Abrufjobs aus, führt sie im Rahmen des Subrequest-Budgets aus,
   legt jedes Ergebnis unter job:<id> in KV ab und setzt daraus den Snapshot zusammen.
   Der Snapshot wird ohne erneutes Parsen als Zeichenkette zusammengefügt, damit ein Lauf auch im
   Free-Plan (10 ms CPU) bleibt. Fehlgeschlagene Jobs behalten ihren letzten guten Stand (wie bei World Monitor). */
import { JOBS } from "./jobs.js";
import { makeFetcher } from "./lib/http.js";
import { lastObs, trimFrom } from "./lib/series.js";
import { archiveOutput, isoDate } from "./archive.js";
import { putJsonGz, sourceKey } from "./r2.js";
import { META_KEY, SNAP_KEY } from "./keys.js";

export { META_KEY, SNAP_KEY };
const HOUR = 3600000;

function backoff(fails) { return [1, 2, 4, 8, 12, 24][Math.min(fails - 1, 5)] * HOUR; }

/* Noch nicht archiviert (D1 gebunden, aber keine Archivausgabe bzw. bei "deep" noch nicht die ganze Historie):
   solche Jobs laufen vorgezogen, auch wenn ihr Takt noch nicht abgelaufen ist */
export function archivePending(j, s, env) {
  return !!(env && env.DB && !j.noArchive && (!s.arch || !s.arch.at || deepPending(j, s)));
}
// volle Historie noch nicht (oder mit einem späteren Startdatum als heute vorgesehen) geladen
function deepPending(j, s) {
  return !!j.deep && s.deepFrom !== j.deep;
}
const ARCHIVE_CATCHUP_PER_RUN = 4;

/* Job mit "after": erst fällig, wenn diese Jobs ihre Daten (bei "deep" die ganze Historie) archiviert haben; Jobs, die
   selbst in D1 schreiben (noArchive, etwa archive_hist), müssen einmal erfolgreich gelaufen sein. Quellen mit "version"
   (etwa einer erweiterten Länderliste) müssen in dieser Version gelaufen sein. Quellen, denen eine Bindung oder ein Secret
   fehlt (env bekannt), zählen nicht */
export function inputsReady(j, meta, jobs = JOBS, env = null) {
  return !j.after || j.after.every(id => {
    const d = jobs.find(x => x.id === id), s = (meta.jobs && meta.jobs[id]) || {};
    if (!d || (env && !hasBindings(d, env))) return true;
    if (d.version && s.version !== d.version) return false;
    return d.noArchive ? !!s.okAt : !!(s.arch && s.arch.at && !deepPending(d, s));
  });
}

export function dueJobs(meta, now, jobs = JOBS, env = null) {
  const due = [];
  for (const j of jobs) {
    if (env && !hasBindings(j, env)) continue;
    if (!inputsReady(j, meta, jobs, env)) continue;
    const s = (meta.jobs && meta.jobs[j.id]) || {};
    if (s.retryAt && s.retryAt > now) continue;
    const last = s.okAt ? Date.parse(s.okAt) : 0;
    // 10 % Toleranz, damit ein Job nicht wegen weniger Minuten auf den nächsten Lauf rutscht; Hintergrundjobs (DBnomics)
    // laufen nach allen anderen fälligen Jobs mit dem verbleibenden Budget
    if (now - last >= j.every * HOUR * 0.9) due.push({ job: j, age: j.background ? 0.1 : last ? (now - last) / (j.every * HOUR) : 1e9 });
    // Jobs mit neuer Version (etwa ein geändertes Signalmodell: Verlauf sofort neu rechnen) vor den Archivläufen
    else if (j.version && s.version !== j.version) due.push({ job: j, age: 0.7 });
    else if (archivePending(j, s, env)) due.push({ job: j, age: 0.5, catchup: true });
  }
  // nie geladene Jobs zuerst, dann nach relativer Überfälligkeit; nachzuholende Archivläufe zuletzt und begrenzt
  due.sort((a, b) => b.age - a.age);
  let catchup = 0;
  return due.filter(d => !d.catchup || ++catchup <= ARCHIVE_CATCHUP_PER_RUN).map(d => d.job);
}

/* Nach dem ersten Archivlauf mit voller Historie: Snapshot-Ausgabe wieder auf den bisherigen Zeitraum kürzen
   (Beginn der gespeicherten Reihe, sonst das übliche Startdatum des Abrufs) */
export function trimOutput(out, ctx) {
  const firsts = ctx.firsts || [];
  if (!firsts.length || !out || !out.series) return out;
  const iso = f => (/^\d{6}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-01` : isoDate(f));
  const fallback = firsts.map(iso).sort()[0];
  const series = {};
  for (const [k, s] of Object.entries(out.series)) {
    // full: Reihe, die der Job immer vollständig liefert (etwa der US-Verbraucherpreisindex seit 1947)
    if (s && s.full) { series[k] = s; continue; }
    const p = ctx.prev && ctx.prev.series && ctx.prev.series[k];
    const from = p && p.s != null ? isoDate(p.s) : fallback;
    series[k] = trimFrom(s, from);
  }
  return { ...out, series };
}

/* Ausgabe für den Snapshot: Reihen, die nur ins Archiv gehören (Job archiveOnly oder Reihe mit ao), fallen heraus;
   ohne Datenbank bleibt alles stehen */
export function kvOutput(job, out, archived) {
  if (!archived || !out || !out.series) return out;
  if (job.archiveOnly) return { series: {}, items: [{ archived: Object.keys(out.series).length, latest: summarize(out).latest }] };
  if (!Object.values(out.series).some(s => s && s.ao)) return out;
  const series = {};
  for (const [k, s] of Object.entries(out.series)) if (!s.ao) series[k] = s;
  return { ...out, series };
}

/* Jobs mit Bindings (etwa D1) laufen nur, wenn diese vorhanden sind */
export function hasBindings(job, env) { return !job.requires || job.requires.every(b => env && env[b]); }

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
  const queue = only ? JOBS.filter(j => only.has(j.id) && hasBindings(j, env)) : dueJobs(meta, now, JOBS, env);
  const fetcher = makeFetcher(budget);
  const ran = [];
  let dirty = false;
  for (const job of queue) {
    if (ran.length >= maxJobs) break;
    // rechenintensive Jobs (Backtests) laufen allein: nur als erster Job eines Aufrufs, danach keiner mehr
    if (job.solo && ran.length) continue;
    if (fetcher.used + job.cost > budget) continue;
    // Quellen mit enger Drosselung (OECD) nur einmal je Lauf
    if (job.onePerRun && ran.some(id => { const j = JOBS.find(x => x.id === id); return j.onePerRun && j.source === job.source; })) continue;
    const s = meta.jobs[job.id] || {};
    if (job.solo) {
      // Schutz vor Abbrüchen: Bricht die Plattform einen Lauf ab (Rechenzeit, Speicher), bleibt nur der vermerkte Start.
      // Er zählt beim nächsten Mal als Fehler mit Wartezeit, statt jeden Cron-Lauf erneut zu belegen.
      if (s.startedAt && !(s.endedAt >= s.startedAt)) {
        Object.assign(s, { ok: false, fails: (s.fails || 0) + 1, error: "Lauf abgebrochen (Rechenzeit oder Speicher überschritten)", failAt: s.startedAt, endedAt: new Date(now).toISOString() });
        s.retryAt = now + backoff(s.fails);
        meta.jobs[job.id] = s;
        dirty = true;
        continue;
      }
      s.startedAt = new Date(now).toISOString();
      meta.jobs[job.id] = s;
      await env.DATA.put(META_KEY, JSON.stringify(meta));
    }
    const t0 = Date.now();
    // Datenarchiv (D1): jede Ausgabe wird archiviert, häufige Jobs (GDELT) höchstens alle drei Stunden; beim ersten
    // Archivlauf eines Jobs mit "deep" wird die ganze Historie der Quelle geladen
    const archive = !!env.DB && !job.noArchive && (!job.frequent || !s.arch || !s.arch.at || now - Date.parse(s.arch.at) > 3 * HOUR);
    const deep = archive && deepPending(job, s);
    try {
      const prev = job.keep ? await env.DATA.get("job:" + job.id, "json") : null;
      const ctx = workerCtx(env, now, prev, opts.base || "https://assets.invalid");
      if (archive) ctx.raw = {};
      if (deep) ctx.full = job.deep;
      let out = await runJob(job, fetcher, ctx);
      if (archive) {
        try {
          const a = await archiveOutput(env.DB, job, out, ctx, new Date(now).toISOString());
          s.arch = { at: new Date(now).toISOString(), ...a, err: null };
          if (deep) { s.deepAt = new Date(now).toISOString(); s.deepFrom = job.deep; s.deepFails = 0; }
        } catch (e) {
          s.arch = { ...(s.arch || {}), err: String((e && e.message) || e).slice(0, 300), errAt: new Date(now).toISOString() };
        }
      }
      // Rohdatenarchiv (R2): ungekürzte Ausgabe des Laufs, je Job und Tag der letzte Stand (noRaw: Ausgabe ist nur ein Status)
      if (env.ARCHIVE && !job.noRaw && out && (Object.keys(out.series || {}).length || (out.items || []).length)) {
        await putJsonGz(env.ARCHIVE, sourceKey(job, new Date(now).toISOString()), out, { job: job.id, at: new Date(now).toISOString() });
      }
      if (deep) out = trimOutput(out, ctx);
      const sum = summarize(out);
      out = kvOutput(job, out, !!env.DB);
      const body = JSON.stringify(out);
      await env.DATA.put("job:" + job.id, body);
      Object.assign(s, sum, { ok: true, okAt: new Date(now).toISOString(), error: null, fails: 0, retryAt: null, bytes: body.length, ms: Date.now() - t0 });
      if (job.version) s.version = job.version;
    } catch (e) {
      // scheitert der Abruf der ganzen Historie zweimal, läuft der Job danach mit dem üblichen Zeitraum weiter
      if (deep) { s.deepFails = (s.deepFails || 0) + 1; if (s.deepFails >= 2) { s.deepAt = "übersprungen"; s.deepFrom = job.deep; } }
      s.ok = false;
      s.fails = (s.fails || 0) + 1;
      s.error = String((e && e.message) || e).slice(0, 300);
      s.failAt = new Date(now).toISOString();
      s.retryAt = now + backoff(s.fails);
    }
    if (job.solo) s.endedAt = new Date(now).toISOString();
    meta.jobs[job.id] = s;
    ran.push(job.id);
    if (job.solo) break;
  }
  if (!ran.length) {
    if (dirty) await env.DATA.put(META_KEY, JSON.stringify(meta));
    return { ran, used: fetcher.used };
  }
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
    status[j.id] = { label: j.label, source: j.source, every: j.every, ok: s.ok ?? null, okAt: s.okAt || null, failAt: s.failAt || null, error: s.error || null, latest: s.latest || null, n: s.n || 0,
      arch: s.arch ? { at: s.arch.at || null, points: s.arch.points ?? null, err: s.arch.err || null } : null, deep: j.deep ? s.deepAt || null : undefined };
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
