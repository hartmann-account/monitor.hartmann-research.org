/* Prüft die Signalrechnung auf dem gespeicherten Startbestand (public/data/live.json) und die Hilfen des Datenarchivs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SIG } = require("../src/signals.js");

const snapFile = new URL("../public/data/live.json", import.meta.url);
const histFile = new URL("../public/data/bigcycle.json", import.meta.url);
const load = async () => {
  const { liveFromSnapshot } = await import("../worker/jobs-signals.js");
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : null;
  return { snap, hist, L: liveFromSnapshot(snap, hist) };
};

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

test("Horizonte: Gewichte je Anlageart summieren sich zu 1, Säulen sind definiert", () => {
  for (const H of SIG.cfg.horizons) {
    assert.equal(H.pillars.length, 5, H.id);
    for (const pid of H.pillars) assert.ok(SIG.pillarDef(pid), `${H.id}: Säule ${pid}`);
    for (const [kind, w] of Object.entries(H.weights)) {
      const sum = H.pillars.reduce((a, p) => a + (w[p] || 0), 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${H.id}/${kind}: Summe ${sum}`);
      for (const k of Object.keys(w)) assert.ok(H.pillars.includes(k), `${H.id}/${kind}: unbekannte Säule ${k}`);
    }
  }
});

test("Barometer auf dem Startbestand, alle Horizonte", { skip: !existsSync(snapFile) }, async () => {
  const { L } = await load();
  for (const H of SIG.cfg.horizons) {
    const B = SIG.barometer(L, H.id);
    assert.equal(B.hz, H.id);
    const ok = B.rows.filter(r => r.now);
    assert.ok(ok.length >= 30, `${H.id}: nur ${ok.length} Zeilen bewertet`);
    for (const r of ok) {
      assert.ok(r.now.score >= -2 && r.now.score <= 2, `${H.id} ${r.row.id}`);
      assert.ok(r.now.cat, r.row.id);
      for (const k of Object.keys(r.now.pillars)) assert.ok(H.pillars.includes(k), `${H.id} ${r.row.id}: Säule ${k}`);
    }
    // Gold-Monatsübersicht: Gold in Dollar, Franken und Euro sind in jedem Horizont eingestuft
    for (const id of ["gold_usd", "gold_chf", "gold_eur"]) assert.ok(B.rows.find(r => r.row.id === id && r.now), `${H.id}: ${id} ohne Einstufung`);
    console.log(`${H.id}: ${ok.length} Zeilen; ohne Daten: ${B.rows.filter(r => !r.now).map(r => r.row.id).join(", ") || "–"}`);
  }
  const lt = SIG.barometer(L, "lt");
  assert.equal(lt.rows.find(r => r.row.id === "btc").now, null, "Bitcoin ohne langfristige Einstufung");
  const g = lt.rows.find(r => r.row.id === "gold_usd").now;
  assert.ok(g.pillars.valueLT && g.pillars.trendLT, "Gold langfristig mit Bewertung und Langfristtrend");
  assert.ok(!g.pillars.debt && !g.pillars.power, "Schulden und Machtposition ohne Gewicht bei Gold (im Backtest ohne Prognosekraft)");
  // Aktien langfristig nur nach Bewertung (Prüfung an 18 Ländern seit 1890)
  const us = lt.rows.find(r => r.row.id === "eq_us").now;
  assert.ok(us.pillars.valueLT && !us.pillars.trendLT && !us.pillars.growth, "US-Aktien langfristig nur nach Bewertung");
});

test("Signalverlauf: Rückrechnung zu Monatsenden, alle Horizonte", { skip: !existsSync(snapFile) }, async () => {
  const { historyWithoutDb } = await import("../worker/jobs-signals.js");
  const { snap, hist } = await load();
  for (const hz of ["m1", "y1", "lt"]) {
    const h = historyWithoutDb(snap, hist, hz);
    assert.equal(h.hz, hz);
    assert.ok(h.dates.length >= 20, `${hz}: nur ${h.dates.length} Stichtage`);
    assert.deepEqual(h.dates, h.dates.slice().sort());
    assert.ok(Object.keys(h.rows).length >= 25);
    for (const r of Object.values(h.rows)) {
      assert.equal(r.c.length, h.dates.length);
      for (const c of r.c) assert.ok(c == null || (c >= -2 && c <= 2));
    }
  }
});

test("Shiller-KGV zum Stichtag aus der Monatsreihe", { skip: !existsSync(histFile) }, async () => {
  const { L } = await load();
  if (!L.capeM) return;
  const now = SIG.capeAt(L, null), past = SIG.capeAt(L, SIG.dayOf("2009-03-31"));
  assert.ok(now && past);
  assert.ok(past.value < now.value, "KGV im März 2009 niedriger als heute");
  assert.ok(past.date <= "2009-03-01");
});

test("Archiv: Periodenangaben werden zu ISO-Daten, Prognosemärkte zu Reihen", async () => {
  const { isoDate, polymarketSeries } = await import("../worker/archive.js");
  assert.equal(isoDate("2026-Q2", "Q"), "2026-04-01");
  assert.equal(isoDate(2026, "A"), "2026-01-01");
  assert.equal(isoDate("2026-09", "M"), "2026-09-01");
  assert.equal(isoDate("2026-09-30", "D"), "2026-09-30");
  const pm = polymarketSeries([{ q: "Fed Decision in December: 25 bps decrease", p: 0.62, url: "https://polymarket.com/event/fed-decision-in-december" }, { q: "Will China invade Taiwan by end of 2026?", p: 0.031 }], "2026-10-19");
  assert.deepEqual(Object.keys(pm), ["pm_fed_decision_in_december_25_bps_decrease", "pm_will_china_invade_taiwan_by_end_of_2026"]);
  assert.deepEqual(pm.pm_fed_decision_in_december_25_bps_decrease.pts, [["2026-10-19", 62]]);
});

test("Erster Archivlauf: ganze Historie laden, Snapshot wieder kürzen", async () => {
  const { since, start } = await import("../worker/lib/jobutil.js");
  const { dailySeries, monthlySeries } = await import("../worker/lib/series.js");
  const { trimOutput } = await import("../worker/runner.js");
  const ctx = { full: "1950-01-01" };
  assert.equal(since(ctx, "y10_us", "2014-01-01"), "1950-01-01");
  assert.equal(start(ctx, "2005-01"), "1950-01");
  assert.equal(start(ctx, "2010-Q1"), "1950-Q1");
  assert.equal(start({}, "2005-01"), "2005-01", "ohne Archivlauf unverändert");
  const out = { series: {
    a: dailySeries([["1962-01-02", 4], ["2014-01-02", 3], ["2026-10-15", 4.1]]),
    b: monthlySeries([["1990-01", 1], ["2013-12", 2], ["2014-01", 3]]),
  } };
  // Startdaten dieses Abrufs: 2014 (Tageswerte); a hatte bisher Werte ab 2014, b wird auf das Startdatum gekürzt
  const t = trimOutput(out, { full: "1950-01-01", firsts: ["2014-01-01"], prev: { series: { a: dailySeries([["2014-01-02", 3]]) } } });
  assert.equal(t.series.a.s, "2014-01-02");
  assert.equal(t.series.b.s, "2014-01");
});
