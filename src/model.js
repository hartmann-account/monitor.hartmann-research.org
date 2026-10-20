"use strict";
/* Rechenkern: Machtindex, Phasenschätzung, Analogien, Schuldensimulation.
   Reine Funktionen auf dem Datenobjekt D; im Browser und in Node lauffähig. */

const MODEL = {
  // Archetyp nach Dalios Grafik der typischen Abfolge (Principles for Dealing with the Changing World Order,
  // Chart-PDF S. 5): Bildung erreicht ihren Höhepunkt rund 60 Jahre vor dem Zenit, Innovation und
  // Wettbewerbsfähigkeit 20 bis 25 Jahre davor, Handel, Wirtschaftsleistung, Militär und Finanzzentrum um den
  // Zenit, die Reservewährung 60 bis 70 Jahre danach. Die Zahlen sind aus der Grafik abgelesen, nicht publiziert.
  arch: {
    offsets: { education: -60, innovation: -25, competitiveness: -20, output: 0, trade: 0, military: 0, finance: 5, reserve: 65 },
    sigma: 45,
    lag: 15,
  },
};

function compositeSeries(D, c, weights, minN) {
  const M = D.power.measures;
  return D.power.years.map((y, i) => {
    let num = 0, den = 0, n = 0;
    for (const m of M) {
      const w = weights[m.id] ?? 1;
      const v = D.power.score[m.id][c][i];
      if (v != null && w > 0) { num += w * v; den += w; n++; }
    }
    return { y, v: n >= minN && den > 0 ? 100 * num / den : null, n };
  });
}

function archLevel(k, phi, a) { const z = (phi - a.offsets[k]) / a.sigma; return Math.exp(-0.5 * z * z); }
function archCurve(phi, a, keys) {
  keys = keys || Object.keys(a.offsets);
  let s = 0; for (const k of keys) s += archLevel(k, phi, a); return s / keys.length;
}
function archPredict(k, phi, a) {
  const mu = a.offsets[k];
  const peakSoFar = phi >= mu ? 1 : archLevel(k, phi, a);
  const L = archLevel(k, phi, a) / peakSoFar;
  const S = (archLevel(k, phi, a) - archLevel(k, phi - a.lag, a)) / peakSoFar;
  return [L, S];
}
function observedPattern(D, c, k, yi, lag) {
  const arr = D.power.score[k][c];
  let mx = 0;
  for (let i = 0; i <= yi; i++) { const v = arr[i]; if (v != null && v > mx) mx = v; }
  const v = arr[yi], v0 = arr[yi - lag];
  if (v == null || v0 == null || mx < 0.05) return null;
  return [v / mx, (v - v0) / mx];
}
function fitPhase(D, c, year, a) {
  a = a || MODEL.arch;
  const yi = D.power.years.indexOf(year);
  if (yi < 0) return null;
  const obs = {};
  for (const k of Object.keys(a.offsets)) { const o = observedPattern(D, c, k, yi, a.lag); if (o) obs[k] = o; }
  const ks = Object.keys(obs);
  if (ks.length < 4) return null;
  const grid = [];
  for (let phi = -130; phi <= 150; phi++) {
    let sse = 0;
    for (const k of ks) { const [L, S] = archPredict(k, phi, a); const [l, s] = obs[k]; sse += (l - L) ** 2 + (s - S) ** 2; }
    grid.push([phi, sse]);
  }
  const min = Math.min(...grid.map(g => g[1]));
  const best = grid.find(g => g[1] === min)[0];
  const T = 0.02 * ks.length;
  const w = grid.map(([p, e]) => [p, Math.exp(-(e - min) / T)]);
  const tot = w.reduce((s, x) => s + x[1], 0);
  let acc = 0, lo = null, hi = null;
  for (const [p, x] of w) { acc += x / tot; if (lo == null && acc >= 0.1) lo = p; if (hi == null && acc >= 0.9) hi = p; }
  const per = {};
  for (const k of ks) {
    let bp = null, be = Infinity;
    for (let phi = -130; phi <= 150; phi++) {
      const [L, S] = archPredict(k, phi, a); const [l, s] = obs[k];
      const e = (l - L) ** 2 + (s - S) ** 2;
      if (e < be) { be = e; bp = phi; }
    }
    per[k] = { phi: bp, L: obs[k][0], S: obs[k][1] };
  }
  return { c, year, best, lo, hi, n: ks.length, profile: grid, weights: w.map(([p, x]) => [p, x / tot]), per };
}

/* Historische Analogien: standardisierte euklidische Distanz über gewählte Merkmale */
function analogSearch(D, query, featureWeights, opts) {
  opts = Object.assign({ top: 12, minShare: 0.75, dedupe: 8, excludeIso: null, excludeFrom: 9999, maxYear: 2016 }, opts);
  const F = D.analogs.features.length;
  const rows = D.analogs.rows;
  const mu = new Array(F).fill(0), sd = new Array(F).fill(0), cnt = new Array(F).fill(0);
  for (const r of rows) r.f.forEach((v, j) => { if (v != null) { mu[j] += v; cnt[j]++; } });
  for (let j = 0; j < F; j++) mu[j] /= Math.max(1, cnt[j]);
  for (const r of rows) r.f.forEach((v, j) => { if (v != null) sd[j] += (v - mu[j]) ** 2; });
  for (let j = 0; j < F; j++) sd[j] = Math.sqrt(sd[j] / Math.max(1, cnt[j] - 1)) || 1;
  const wsum = featureWeights.reduce((s, w, j) => s + (query.f[j] != null ? w : 0), 0);
  const res = [];
  for (const r of rows) {
    if (opts.excludeIso && r.iso === opts.excludeIso && r.y >= opts.excludeFrom) continue;
    if (r.y > opts.maxYear) continue;
    let d = 0, wu = 0;
    for (let j = 0; j < F; j++) {
      const w = featureWeights[j];
      if (!w || query.f[j] == null || r.f[j] == null) continue;
      const z = (r.f[j] - query.f[j]) / sd[j];
      d += w * z * z; wu += w;
    }
    if (wu < opts.minShare * wsum || wu === 0) continue;
    // fehlende Merkmale werden nicht belohnt: Distanz mit Abdeckungsanteil gewichten
    res.push({ r, d: Math.sqrt(d / wu) / Math.sqrt(wu / wsum), cover: wu / wsum });
  }
  res.sort((a, b) => a.d - b.d);
  const out = [];
  for (const x of res) {
    if (out.some(o => o.r.iso === x.r.iso && Math.abs(o.r.y - x.r.y) < opts.dedupe)) continue;
    out.push(x);
    if (out.length >= opts.top) break;
  }
  const med = arr => { const a = arr.filter(v => v != null && isFinite(v)).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const os = out.map(x => x.r.o).filter(Boolean);
  const summary = {
    n: os.length,
    dDebt: med(os.map(o => o.dDebt)),
    infl: med(os.map(o => o.infl)),
    bond: med(os.map(o => o.bond)),
    eq: med(os.map(o => o.eq)),
    crisisShare: os.filter(o => o.crisis != null).length ? os.filter(o => o.crisis === 1).length / os.filter(o => o.crisis != null).length : null,
    gpr: med(os.map(o => o.gpr)),
  };
  return { list: out, summary, sd, mu };
}

/* Schuldendynamik: Monte-Carlo-Simulation der Schuldenquote und der Zinslast */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function simulateDebt(p, opts) {
  opts = Object.assign({ paths: 2000, seed: 20261018 }, opts);
  const rnd = mulberry32(opts.seed);
  let spare = null;
  const gauss = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd();
    const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v);
  };
  const T = p.years;
  const debt = Array.from({ length: T + 1 }, () => new Float64Array(opts.paths));
  const intRev = Array.from({ length: T + 1 }, () => new Float64Array(opts.paths));
  const effRate = Array.from({ length: T + 1 }, () => new Float64Array(opts.paths));
  let crossInt = 0, crossDebt = 0;
  for (let k = 0; k < opts.paths; k++) {
    let d = p.d0, r = p.r0, m = p.m0, recLeft = 0, hitI = false, hitD = false;
    debt[0][k] = d; effRate[0][k] = r; intRev[0][k] = 100 * (r / 100 * d) / p.rev;
    for (let t = 1; t <= T; t++) {
      const rec = recLeft === 0 && rnd() < p.recProb / 100;
      if (rec) recLeft = 2;
      const inRec = recLeft > 0;
      const gReal = p.g + (inRec ? (recLeft === 2 ? -3.5 : 0.5) : 0) + 0.7 * gauss();
      const infl = p.pi + 0.5 * gauss() + (inRec && recLeft === 2 ? -0.8 : 0);
      m = m + 0.35 * (p.mBar - m) + p.rateVol * gauss() - (inRec && recLeft === 2 ? 1.0 : 0);
      m = Math.max(0, m);
      r = r + (m - r) / p.maturity;
      const gNom = (1 + gReal / 100) * (1 + infl / 100) - 1;
      const interest = r / 100 * d / (1 + gNom);
      const rev = p.rev - (inRec ? 0.8 : 0);
      let pd = p.pd + (inRec ? 2.2 : 0);
      if (p.capTotal != null) pd = Math.max(p.capTotal - interest, -6);
      d = d * (1 + r / 100) / (1 + gNom) + pd;
      if (recLeft > 0) recLeft--;
      debt[t][k] = d;
      effRate[t][k] = r;
      const ir = 100 * interest / rev;
      intRev[t][k] = ir;
      if (t <= 10 && ir >= p.thrInt) hitI = true;
      if (t <= 10 && d >= p.thrDebt) hitD = true;
    }
    if (hitI) crossInt++;
    if (hitD) crossDebt++;
  }
  // Quantile je Jahr: die Pfade einmal numerisch sortieren (Float64Array), dann alle fünf Quantile ablesen
  const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
  const band = arrs => arrs.map(arr => {
    const a = Float64Array.from(arr).sort();
    return qs.map(q => { const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); });
  });
  return { debt: band(debt), intRev: band(intRev), rate: band(effRate), pInt10: crossInt / opts.paths, pDebt10: crossDebt / opts.paths };
}

if (typeof module !== "undefined") module.exports = { MODEL, compositeSeries, fitPhase, archCurve, archLevel, archPredict, analogSearch, simulateDebt };
