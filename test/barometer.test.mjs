/* Prüft die Signalrechnung auf dem gespeicherten Startbestand (public/data/live.json). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SIG } = require("../src/signals.js");

const snapFile = new URL("../public/data/live.json", import.meta.url);
const histFile = new URL("../public/data/bigcycle.json", import.meta.url);

test("Kompaktformat: Tages- und Monatsreihen dekodieren", () => {
  const d = SIG.decodeSeries({ f: "D", s: "2026-10-01", d: [0, 1, 3], v: [1, 2, 3] });
  assert.deepEqual(d.map(p => SIG.isoOf(p.t)), ["2026-10-01", "2026-10-02", "2026-10-05"]);
  const m = SIG.decodeSeries({ f: "M", s: "2026-07", v: [1, null, 3] });
  assert.equal(m.length, 2);
  assert.equal(SIG.isoOf(m[1].e), "2026-09-30");
});

test("Kategorien decken die ganze Skala ab", () => {
  assert.equal(SIG.category(-1.5).n, -2);
  assert.equal(SIG.category(-0.5).n, -1);
  assert.equal(SIG.category(0).n, 0);
  assert.equal(SIG.category(0.5).n, 1);
  assert.equal(SIG.category(1.5).n, 2);
});

test("Toleranzband: Stufe wechselt erst deutlich jenseits der Schwelle", () => {
  const neutral = SIG.category(0), positiv = SIG.category(0.5);
  assert.equal(SIG.category(0.35, neutral).n, 0, "knapp über 0,3 bleibt neutral");
  assert.equal(SIG.category(0.45, neutral).n, 1, "deutlich über 0,3 wird positiv");
  assert.equal(SIG.category(0.25, positiv).n, 1, "knapp unter 0,3 bleibt positiv");
  assert.equal(SIG.category(0.15, positiv).n, 0, "deutlich unter 0,3 wird neutral");
  assert.equal(SIG.category(1.5, neutral).n, 2, "Sprünge über zwei Stufen bleiben möglich");
  assert.equal(SIG.category(-0.95, SIG.category(-1.5)).n, -2);
});

test("Anleiheindex steigt bei fallender Rendite", () => {
  const pts = [4, 3.9, 3.8, 3.7].map((v, i) => ({ t: 20000 + i * 30, e: 20000 + i * 30, x: 2024 + i / 12, v }));
  const idx = SIG.bondIndex(pts);
  assert.ok(idx[3].v > idx[0].v);
});

test("Barometer auf dem Startbestand", { skip: !existsSync(snapFile) }, () => {
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : null;
  const L = SIG.prepareLive(SIG.decodeSnapshot(snap), hist ? { gold_usd_m: { f: "M", s: hist.series.gold_usd_m.start, v: hist.series.gold_usd_m.values }, cape: hist.latest.cape } : {});
  const B = SIG.barometer(L);
  const ok = B.rows.filter(r => r.now);
  assert.ok(ok.length >= 25, `nur ${ok.length} Zeilen bewertet`);
  for (const r of ok) {
    assert.ok(r.now.score >= -2 && r.now.score <= 2, r.row.id);
    assert.ok(r.now.cat, r.row.id);
  }
  const lines = ok.map(r => `${r.row.group.padEnd(10)} ${r.row.label.padEnd(24)} ${r.now.cat.sym.padEnd(2)} ${r.now.score.toFixed(2).padStart(5)}  vorher ${r.prev && r.prev.cat ? r.prev.cat.sym : "?"}  ` +
    Object.entries(r.now.pillars).map(([k, p]) => `${k[0]}:${p ? p.s.toFixed(1) : "–"}`).join(" ") + `  ${SIG.isoOf(r.now.date)}`);
  console.log(lines.join("\n"));
  console.log("ohne Daten:", B.rows.filter(r => !r.now).map(r => r.row.id).join(", "));
  console.log("Risikoappetit", B.risk && B.risk.s.toFixed(2), B.risk && B.risk.parts.map(p => `${p.k}: ${p.v == null ? "" : p.v.toFixed(2)}`).join("; "));
});
