#!/usr/bin/env node
/* Füllt die GDELT-Tageswerte rückwirkend (Standard: 120 Tage, stündliche Stichprobe der 15-Minuten-Dateien)
   und schreibt public/data/gdelt-state.json. Der Worker übernimmt diesen Stand beim ersten Lauf,
   danach schreibt er die Werte mit jeder neuen Exportdatei selbst fort.
   Aufruf: NODE_USE_ENV_PROXY=1 node scripts/gdelt_backfill.mjs [Tage] [Dateien je Stunde] */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFetcher } from "../worker/lib/http.js";
import { fetchExport, latestStamp, stepStamp, addToState } from "../worker/providers/gdelt.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "data", "gdelt-state.json");
const days = +(process.argv[2] || 120), perHour = +(process.argv[3] || 1);
const F = makeFetcher(1e6);
const last = await latestStamp(F);
const state = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { days: {}, last: null, done: {} };
state.done = state.done || {};
const stamps = [];
const step = 4 / perHour;
for (let k = 0; k < days * 96; k += step) {
  const s = stepStamp(last, -k);
  if (!state.done[s]) stamps.push(s);
}
console.log(`${stamps.length} Dateien zu laden (bis ${last})`);
let i = 0, ok = 0, fail = 0;
async function worker() {
  while (i < stamps.length) {
    const s = stamps[i++];
    try {
      const res = await fetchExport(F, s);
      addToState(state, s, res, days + 30);
      state.done[s] = 1;
      ok++;
    } catch (e) {
      fail++;
      if (fail < 10) console.warn("Fehler", s, e.message);
    }
    if ((ok + fail) % 200 === 0) console.log(`${ok + fail}/${stamps.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
// "done" nur für die letzten 2 Tage behalten (verhindert Doppelzählung beim erneuten Aufruf)
const keep = stepStamp(last, -192);
for (const k of Object.keys(state.done)) if (k < keep) delete state.done[k];
writeFileSync(out, JSON.stringify(state));
console.log(`fertig: ${ok} geladen, ${fail} Fehler, ${Object.keys(state.days).length} Tage → ${out}`);
