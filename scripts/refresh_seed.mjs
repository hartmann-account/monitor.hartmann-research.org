#!/usr/bin/env node
/* Erneuert den statischen Live-Startbestand public/data/live.json (Rückfall der Seite, solange der Worker
   keinen eigenen Datenstand hat). Bevorzugt wird der aktuelle Snapshot des Workers (LIVE_URL); ist er nicht
   erreichbar oder unvollständig, laufen die Abrufjobs lokal (ohne GDELT, dessen Zustand der Worker selbst führt).
   Dazu die Kennzahlen des Backtests (public/data/backtest.json) aus /api/backtest desselben Workers.
   Aufruf: LIVE_URL=https://…/api/snapshot node scripts/refresh_seed.mjs */
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "data", "live.json");
const url = process.env.LIVE_URL;

async function fromWorker() {
  if (!url) return false;
  try {
    const r = await fetch(url, { headers: { "user-agent": "BigCycleMonitor-Seed/2.0" }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (r.headers.get("x-snapshot-origin") !== "kv") throw new Error("Worker liefert noch keinen eigenen Datenstand");
    const snap = await r.json();
    const ok = Object.values(snap.status || {}).filter(s => s.ok).length;
    if (snap.schema !== 2 || !snap.data || ok < 20) throw new Error(`unvollständig (${ok} Jobs ok)`);
    snap.origin = "seed";
    writeFileSync(out, JSON.stringify(snap));
    console.log(`Startbestand aus dem Worker übernommen: ${ok} Jobs, Stand ${snap.generated}`);
    return true;
  } catch (e) {
    console.log(`Worker-Snapshot nicht verwendbar (${e.message}); Abrufjobs laufen lokal.`);
    return false;
  }
}

/* Kennzahlen des Backtests (Jobs backtest_*) als Rückfall data/backtest.json übernehmen, sofern vollständig */
async function backtestFromWorker() {
  if (!url) return;
  try {
    const r = await fetch(new URL("/api/backtest", url), { headers: { "user-agent": "BigCycleMonitor-Seed/2.0" }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bt = await r.json();
    if (!["m1", "y1", "lt"].every(h => bt[h] && bt[h].stats && bt[h].stats.all)) throw new Error("noch nicht für alle Horizonte gerechnet");
    writeFileSync(join(root, "public", "data", "backtest.json"), JSON.stringify(bt));
    console.log(`Backtest aus dem Worker übernommen (Stand ${bt.m1.at})`);
  } catch (e) {
    console.log(`Backtest des Workers nicht übernommen (${e.message}); data/backtest.json bleibt.`);
  }
}

await backtestFromWorker();
if (!(await fromWorker())) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "fetch_live.mjs"), "--except", "gdelt_tension"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
