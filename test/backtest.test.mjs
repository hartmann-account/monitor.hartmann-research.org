/* Prüft die Bausteine des Backtests (worker/backtest.js) und die neuen Teile des Signalmodells an kleinen Beispielen. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { forward, logistic, categorize, accuracy, verdict, compactAccuracy, monthEnds, randomTest, buildBacktestLive, runPanel, applyVintages, applyAlfred, ALFRED_SERIES, addUsual, prepWeo, applyWeo } from "../worker/backtest.js";
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

test("Backtest-Jobs warten, bis ihre Quellen die ganze Historie archiviert haben", async () => {
  const { inputsReady, dueJobs } = await import("../worker/runner.js");
  const { JOBS } = await import("../worker/jobs.js");
  const bt = JOBS.find(j => j.id === "backtest_m1");
  const done = {};
  for (const id of bt.after) {
    const d = JOBS.find(j => j.id === id);
    done[id] = d.noArchive ? { okAt: "2026-10-19T00:00:00Z" } : { arch: { at: "2026-10-19T00:00:00Z" }, deepFrom: d.deep };
    if (d.version) done[id].version = d.version;
  }
  assert.equal(inputsReady(bt, { jobs: done }), true);
  // Kreditlücken noch mit der alten Länderliste abgerufen: Backtest wartet auf den neuen Lauf
  assert.equal(inputsReady(bt, { jobs: { ...done, bis_credit: { ...done.bis_credit, version: "US+XM" } } }), false);
  // OECD-Frühindikatoren noch mit der alten Startzeit archiviert: Backtest nicht fällig
  const pending = { ...done, oecd_cli: { arch: { at: "2026-10-19T00:00:00Z" }, deepFrom: "1990-01-01" } };
  assert.equal(inputsReady(bt, { jobs: pending }), false);
  const env = { DB: {} };
  assert.ok(!dueJobs({ jobs: pending }, Date.now(), JOBS, env).some(j => j.id === "backtest_m1"));
  assert.ok(dueJobs({ jobs: done }, Date.now(), JOBS, env).some(j => j.id === "backtest_m1"));
});

test("FRED-Sammelabruf: mehr als zwölf Reihen in Paketen", async () => {
  const { fredMulti } = await import("../worker/providers/official.js");
  const urls = [];
  const F = { request: async url => { urls.push(url); const ids = new URL(url).searchParams.get("id").split(","); const csv = `observation_date,${ids.join(",")}\n2026-01-01,${ids.map((_, i) => i + 1).join(",")}\n`; return new Response(csv); } };
  const ids = Array.from({ length: 30 }, (_, i) => `S${i}`);
  const r = await fredMulti(F, ids, "2026-01-01");
  assert.equal(urls.length, 3);
  assert.deepEqual(Object.keys(r).sort(), ids.slice().sort());
  assert.deepEqual(r.S29, [["2026-01-01", 6]]);
});

test("Schwellenländerkorb: BIP-gewichtete Renditen in US-Dollar, Zeitfenster der Länder", async () => {
  const { emBasket } = await import("../worker/jobs-em.js");
  const months = ["2000-01", "2000-02", "2000-03"];
  const pts = vals => months.map((m, i) => [m + "-01", vals[i]]);
  // Indien: +10 % in Landeswährung bei festem Kurs; Südafrika: Kurs fest, Rand wertet 50 % ab (−33 % in Dollar)
  const r = {
    SPASTT01INM661N: pts([100, 110, 121]), CCUSMA02INM618N: pts([40, 40, 40]),
    SPASTT01ZAM661N: pts([100, 100, 100]), CCUSMA02ZAM618N: pts([6, 9, 9]),
    // Israel nach dem Aufstieg zum Industrieland (Mai 2010) nicht mehr im Korb: hier noch enthalten
    SPASTT01ILM661N: pts([100, 100, 100]), CCUSMA02ILM618N: pts([4, 4, 4]),
  };
  const gdp = { IND: [[1999, 300]], ZAF: [[1999, 100]], ISR: [[1999, 100]] };
  const { index, usd } = emBasket(r, gdp);
  assert.deepEqual(index.map(p => p[0]), months);
  // Februar: (300 × 10 % + 100 × (−33,3 %) + 100 × 0 %) ÷ 500 = −0,67 %
  assert.ok(Math.abs(index[1][1] - 100 * (1 + (300 * 0.1 + 100 * (6 / 9 - 1)) / 500)) < 1e-9);
  assert.ok(Math.abs(usd.in.get("2000-02") - 110 / 40) < 1e-12);
});

test("Zufallstest: echte Prognosekraft gegenüber zeitlich verschobenen Signalen", () => {
  const cuts = monthEnds("1970-01", day("2019-12-31"));
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const mk = good => categorize(["a", "b", "c"].flatMap(id => cuts.map(t => {
    const r = rnd() * 0.1, noise = rnd();
    // gutes Modell: Gesamtwert enthält die spätere Rendite; schlechtes: nur Rauschen
    return { id, kind: "equity", t, score: good ? 20 * r + noise : noise, vol: 0.15, r1: r };
  })));
  const g = randomTest(mk(true), "m1"), z = randomTest(mk(false), "m1");
  assert.ok(g.pIc < 0.01 && g.ic > 0.3, `gutes Modell: p ${g.pIc}, IC ${g.ic}`);
  assert.ok(Math.abs(g.icRand) < 0.1, "Zufall nahe null");
  assert.ok(z.pIc > 0.05, `Rauschen: p ${z.pIc}`);
  // Urteil: Zufallstest muss bestehen; p ≥ 0,5 heißt nicht belegt
  const a = { ic: 0.2, icLo: 0.1, nEff: 50 }, sub = { ic: 0.1, nEff: 20 };
  assert.equal(verdict(a, [sub, sub, sub], { pIc: 0.01 }), "ok");
  assert.equal(verdict(a, [sub, sub, sub], { pIc: 0.2 }), "weak");
  assert.equal(verdict(a, [sub, sub, sub], { pIc: 0.6 }), "fail");
});

test("Echtzeit-Datenstände: Frühindikator zum Stichtag aus der damals jüngsten Ausgabe", () => {
  // heutige (revidierte) Reihe: konstant 100; Ausgabe Februar 2005 meldete für Dezember 2004 noch 104
  const months = []; for (let y = 1999; y <= 2006; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const raw = { cli_us: { freq: "M", points: months.map(ym => [ym + "-01", 100]) } };
  const vintages = { USA: { "200502": ["2004-05", [100, 100, 100, 100, 100, 101, 102, 104]] } };
  const L = buildBacktestLive(raw, { vintages });
  assert.ok(L.vint && L.vint.cli_us, "Ausgaben übernommen");
  // Frist der revidierten Reihe: 45 Tage nach Monatsende
  assert.equal(L.s.cli_us.lag, 45);
  const at = cut => { applyVintages(L, day(cut)); const p = SIG.asOf(L.s.cli_us, day(cut)); return p[p.length - 1]; };
  // Ende Januar 2005 (vor der Ausgabe): heutige Reihe mit 45 Tagen Frist → November 2004, Wert 100
  let p = at("2005-01-31");
  assert.equal(SIG.isoOf(p.t).slice(0, 7), "2004-11");
  assert.equal(p.v, 100);
  // Ende Februar 2005: Ausgabe vom Februar mit Dezember 2004 = 104 (später auf 100 revidiert)
  p = at("2005-02-28");
  assert.equal(SIG.isoOf(p.t).slice(0, 7), "2004-12");
  assert.equal(p.v, 104);
  // nach einem Panel steht wieder die heutige Reihe
  runPanel(L, { from: "2005-02", to: day("2005-03-31"), horizons: [] });
  assert.equal(L.s.cli_us, L.vint.cli_us.base);
});

test("ALFRED: Baugenehmigungen und Aktienanteil zum Stichtag im damals gültigen Stand", () => {
  const months = []; for (let y = 1995; y <= 2007; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, "0")}-01`);
  const quarters = []; for (let y = 1995; y <= 2007; y++) for (let q = 0; q < 4; q++) quarters.push(`${y}-${String(3 * q + 1).padStart(2, "0")}-01`);
  const raw = { permit_us: { freq: "M", points: months.map(d => [d, d === "2004-10-01" ? 2093 : 1500]) }, aiae_us: { freq: "Q", points: quarters.map(d => [d, 40]) } };
  // Baugenehmigungen Oktober 2004: zuerst 2018 gemeldet, ab 2006 auf 2093 revidiert; übrige Monate unverändert seit 2000
  const permit = months.flatMap(d => (d === "2004-10-01" ? [[d, "2004-11-17", "2005-12-31", 2018], [d, "2006-01-01", "9999-12-31", 2093]] : d < "2004-10-01" ? [[d, "2000-01-01", "9999-12-31", 1500]] : []));
  // Z.1: Aktien 60 + 40 und Schulden 5 × 20 = 100 → Anteil 50 %; ab 2006 Aktien revidiert (Anteil 60 %)
  const z = (v, v2) => quarters.filter(d => d <= "2004-10-01").flatMap(d => [[d, "2005-01-01", "2005-12-31", v], [d, "2006-01-01", "9999-12-31", v2]]);
  const alfred = { PERMIT: permit, NCBEILQ027S: z(60, 90), FBCELLQ027S: z(40, 60), CMDEBT: z(20, 20), BCNSDODNS: z(20, 20), FGSDODNS: z(20, 20), SLGSDODNS: z(20, 20), DODFFSWCMI: z(20, 20) };
  assert.deepEqual(Object.keys(alfred).sort(), ALFRED_SERIES.slice().sort());
  const L = buildBacktestLive(raw, { alfred });
  const lastAt = (id, cut) => { applyAlfred(L, day(cut)); const p = SIG.asOf(L.s[id], day(cut)); return p[p.length - 1]; };
  // vor dem ersten Datenstand (1999): heutige Reihe
  assert.equal(lastAt("permit_us", "1999-06-30").v, 1500);
  assert.equal(L.s.permit_us, L.alfred.permit_us.base);
  // Ende 2004: Oktober noch nicht veröffentlicht → September; Mitte 2005: Erstmeldung 2018; 2006: revidiert 2093
  assert.equal(SIG.isoOf(lastAt("permit_us", "2004-10-31").t).slice(0, 7), "2004-09");
  assert.equal(lastAt("permit_us", "2005-06-30").v, 2018);
  assert.equal(lastAt("permit_us", "2006-06-30").v, 2093);
  // Aktienanteil: 2005 aus den damaligen Z.1-Werten 50 %, 2006 nach der Revision 60 %
  assert.equal(lastAt("aiae_us", "2005-06-30").v, 50);
  assert.equal(lastAt("aiae_us", "2006-06-30").v, 60);
});

test("Üblicher Ertrag: nur Renditen, die zum Stichtag abgelaufen waren; Treffer gegen üblich", () => {
  // eine Anlage, 12-Monats-Renditen an 30 Monatsenden: abwechselnd 10 % und 2 % (Mittel 6 %)
  const cuts = monthEnds("2000-01", day("2002-06-30"));
  const E = cuts.map((t, i) => ({ id: "x", kind: "equity", t, score: i % 2 ? -0.5 : 0.5, vol: 0.15, r12: i % 2 ? 0.02 : 0.1 }));
  addUsual(E, "y1");
  // Ende Dezember 2001 (Index 23): abgelaufen sind die Renditen der Stichtage Januar bis Dezember 2000 (12 Stück, die
  // Mindestzahl); Ende November 2001 erst elf
  assert.equal(E[22].mu, null);
  assert.ok(Math.abs(E[23].mu - 0.06) < 1e-12);
  assert.ok(Math.abs(E[24].mu - (7 * 0.1 + 6 * 0.02) / 13) < 1e-12);
  categorize(E);
  const a = accuracy(E, "y1");
  // Stufe über üblich bei 10 %, unter üblich bei 2 %: immer auf der richtigen Seite des Mittels
  assert.equal(a.nRel, 30 - 23);
  assert.equal(a.hitRel, 1);
  // Richtung: alle Renditen positiv, die Stufen unter üblich gelten als falsch
  assert.ok(a.hit < 1);
  const c = compactAccuracy(a);
  assert.equal(c.rel, 1);
  assert.equal(c.nRel, 7);
});

test("WEO-Ausgaben: jüngste erschienene Ausgabe, Fehlendes aus der Ausgabe davor, Modell liest sie", () => {
  const W = prepWeo({
    "2019-10": { growth_usa: [2018, [2.9, 2.4, 2.1, 1.7]], debt_usa: [2018, [104, 106, 108, 110]] },
    "2020-04": { growth_usa: [2018, [2.9, 2.3, -5.9, 4.7]] },
  });
  const L = { s: { growth_usa: { pts: [2014, 2015, 2016, 2017, 2018, 2019].map((y, i) => ({ x: y, v: 2 + i / 10 })) } }, weoVint: W, pitYear: 2019 };
  applyWeo(L, day("2020-03-31"));
  assert.equal(L.weoEd, "2019-10");
  assert.equal(SIG.yv(L, "growth_usa", 2020), 2.1);
  applyWeo(L, day("2020-04-30"));
  assert.equal(L.weoEd, "2020-04");
  assert.equal(SIG.yv(L, "growth_usa", 2020), -5.9);
  // Kennzahl fehlt in der verkürzten Ausgabe: Stand der Ausgabe davor
  assert.equal(L.weoAt.debt_usa[2020], 108);
  // Jahr fehlt in allen Ausgaben: naive Fortschreibung (Mittel der letzten fünf Jahre bis 2019)
  assert.ok(Math.abs(SIG.yv(L, "growth_usa", 2022) - (2.1 + 2.2 + 2.3 + 2.4 + 2.5) / 5) < 1e-12);
  // vor der ersten Ausgabe: keine WEO-Werte
  applyWeo(L, day("2019-09-30"));
  assert.equal(L.weoAt, null);
});
