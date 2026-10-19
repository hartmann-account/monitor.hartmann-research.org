/* Prüft die Bausteine des Backtests (worker/backtest.js) und die neuen Teile des Signalmodells an kleinen Beispielen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { forward, logistic, categorize, accuracy, verdict, compactAccuracy, monthEnds } from "../worker/backtest.js";
const require = createRequire(import.meta.url);
const { SIG } = require("../src/signals.js");

const day = iso => SIG.dayOf(iso);
// Monatsmittel (t = Monatsanfang, e = Monatsende) und Tageswerte (t = e)
const monthPt = (ym, v) => { const t = day(ym + "-01"); const [y, m] = ym.split("-").map(Number); return { t, e: Date.UTC(y, m, 1) / 864e5 - 1, x: y + (m - 1) / 12, v }; };
const dayPt = (iso, v) => ({ t: day(iso), e: day(iso), x: SIG.yearFrac(day(iso)), v });

test("Rendite danach: verkettete Reihe aus Monatsmitteln und Tageskursen", () => {
  const p = [monthPt("2000-01", 100), monthPt("2000-02", 110), monthPt("2000-03", 121), dayPt("2000-04-03", 130), dayPt("2000-04-28", 140), dayPt("2000-05-31", 150)];
  // Stichtag Ende Januar: Monatsmittel ab dem Folgemonat (Februar 110 → März 121)
  assert.ok(Math.abs(forward(p, day("2000-01-31"), 1) - 0.1) < 1e-9);
  // Stichtag Ende April (Tageskurs 140) bis Ende Mai (150)
  assert.ok(Math.abs(forward(p, day("2000-04-30"), 1) - (150 / 140 - 1)) < 1e-9);
  // Horizont über das Ende der Reihe hinaus: keine Rendite
  assert.equal(forward(p, day("2000-05-31"), 1), null);
});

test("Verknüpfung: Monatsmittel gelten bis zum Periodenende", () => {
  const weekly = [dayPt("2001-03-02", 10), dayPt("2001-03-09", 11), dayPt("2001-03-30", 12)];
  const monthly = [monthPt("2001-03", 2)];
  const r = SIG.combine(weekly, monthly, (a, b) => a / b);
  assert.deepEqual(r.map(q => q.v), [5, 5.5, 6]);
});

test("Logistische Regression findet bekannte Koeffizienten", () => {
  // deterministische Stichprobe: P(1) = σ(0,4 + 1,2·x)
  const xs = [], ys = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 20000; i++) { const x = 4 * rnd() - 2; xs.push(x); ys.push(rnd() < 1 / (1 + Math.exp(-(0.4 + 1.2 * x))) ? 1 : 0); }
  const { a, b } = logistic(xs, ys, 0.001);
  assert.ok(Math.abs(a - 0.4) < 0.06, `a = ${a}`);
  assert.ok(Math.abs(b - 1.2) < 0.08, `b = ${b}`);
  // starke Strafe bei kleinem Fallgewicht zieht die Steigung Richtung null
  assert.ok(logistic(xs, ys, 4, 1 / 5000).b < b);
});

test("Treffsicherheit: Treffer, Mehrheitsregel und Urteil", () => {
  const cuts = monthEnds("1990-01", day("1999-12-31"));
  // Gesamtwert sagt das Vorzeichen der Rendite in 70 % der Fälle richtig voraus
  const entries = cuts.map((t, i) => { const s = i % 2 ? 1 : -1, right = i % 10 < 7; return { id: "x", kind: "equity", t, score: s, vol: 0.15, r1: (right ? s : -s) * 0.02 }; });
  const a = compactAccuracy(accuracy(categorize(entries), "m1"));
  assert.ok(Math.abs(a.hit - 0.7) < 1e-9);
  assert.ok(a.lo < 0.7 && a.hi > 0.7);
  assert.equal(a.nEff, 120);
  assert.equal(verdict(a, [a, a, a]), "ok");
  assert.equal(verdict({ ...a, ic: -0.1 }, []), "fail");
  assert.equal(verdict({ ...a, icLo: -0.01 }, [a, a]), "weak");
});

test("Aktienanteil am Anlegervermögen: Fortschreibung mit dem S&P 500 und Veröffentlichungsfrist", () => {
  const q = (y, k, v) => { const t = Date.UTC(y, 3 * (k - 1), 1) / 864e5; return { t, e: Date.UTC(y, 3 * k, 1) / 864e5 - 1, x: y + (k - 1) / 4, v }; };
  const aiae = [];
  for (let y = 1980; y < 2000; y++) for (let k = 1; k <= 4; k++) aiae.push(q(y, k, 30 + (y - 1980)));
  const eq = [dayPt("1999-09-30", 100), dayPt("1999-12-31", 110), dayPt("2000-02-29", 120)];
  const L = { s: { aiae_us: { id: "aiae_us", f: "Q", lag: 80, pts: aiae }, eq_us: { id: "eq_us", f: "D", pts: eq } }, _pm: null };
  // Ende Februar 2000 ist das 4. Quartal 1999 noch nicht veröffentlicht (Frist 80 Tage): Basis 3. Quartal 1999 = 49 %,
  // fortgeschrieben mit dem S&P 500 seit Quartalsende (+20 %): 1,2 × 0,49 ÷ (1,2 × 0,49 + 0,51)
  const a = SIG.aiaeAt(L, day("2000-02-29"));
  assert.equal(a.date, "1999-Q3");
  assert.equal(a.q, 49);
  assert.ok(Math.abs(a.v - 100 * (1.2 * 0.49) / (1.2 * 0.49 + 0.51)) < 1e-9);
  assert.ok(a.z > 1, "über dem Mittel aller Quartale");
});
