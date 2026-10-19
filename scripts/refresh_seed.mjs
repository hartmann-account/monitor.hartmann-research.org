#!/usr/bin/env node
/* Erneuert den statischen Live-Startbestand public/data/live.json (Rückfall der Seite, solange der Worker
   keinen eigenen Datenstand hat). Bevorzugt wird der aktuelle Snapshot des Workers (LIVE_URL); ist er nicht
   erreichbar oder unvollständig, laufen die Abrufjobs lokal (ohne GDELT, dessen Zustand der Worker selbst führt).
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

if (!(await fromWorker())) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "fetch_live.mjs"), "--except", "gdelt_tension"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
