/* Kompaktes Reihenformat für den Snapshot.
   Täglich:     { f: "D", s: "2024-01-02", d: [0, 1, 1, 3, …], v: [...] }  d = Tage seit dem vorigen Punkt
   Wöchentlich: wie täglich (f: "W")
   Monatlich:   { f: "M", s: "2015-01", v: [...] }   lückenlos, fehlende Monate = null
   Quartal:     { f: "Q", s: "2015-Q1", v: [...] }
   Jährlich:    { f: "A", s: 1990, v: [...] }
   Dazu Metadaten: l (Bezeichnung), u (Einheit), src (Quellenkennung). */

export function sig(v, digits = 6) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Number(v.toPrecision(digits));
}

const DAY = 86400000;
const dayNum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;

/* points: [["YYYY-MM-DD", value], ...]; Nullwerte werden ausgelassen. */
export function dailySeries(points, meta = {}, freq = "D") {
  const pts = points.filter(p => p[1] != null && Number.isFinite(p[1])).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = { f: freq, ...meta, s: null, d: [], v: [] };
  let prev = null;
  for (const [date, val] of pts) {
    const n = dayNum(date);
    if (prev != null && n === prev) { out.v[out.v.length - 1] = sig(val); continue; }
    if (prev == null) out.s = date.slice(0, 10);
    out.d.push(prev == null ? 0 : n - prev);
    out.v.push(sig(val));
    prev = n;
  }
  return out;
}

const monthIdx = ym => +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1);

/* points: [["YYYY-MM", value], ...] */
export function monthlySeries(points, meta = {}) {
  const pts = points.filter(p => p[1] != null && Number.isFinite(p[1])).map(p => [p[0].slice(0, 7), p[1]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!pts.length) return { f: "M", ...meta, s: null, v: [] };
  const i0 = monthIdx(pts[0][0]), i1 = monthIdx(pts[pts.length - 1][0]);
  const v = new Array(i1 - i0 + 1).fill(null);
  for (const [ym, val] of pts) v[monthIdx(ym) - i0] = sig(val);
  return { f: "M", ...meta, s: pts[0][0], v };
}

const qIdx = q => +q.slice(0, 4) * 4 + (+q.slice(-1) - 1);

/* points: [["YYYY-Qn", value], ...] */
export function quarterlySeries(points, meta = {}) {
  const pts = points.filter(p => p[1] != null && Number.isFinite(p[1])).sort((a, b) => qIdx(a[0]) - qIdx(b[0]));
  if (!pts.length) return { f: "Q", ...meta, s: null, v: [] };
  const i0 = qIdx(pts[0][0]), i1 = qIdx(pts[pts.length - 1][0]);
  const v = new Array(i1 - i0 + 1).fill(null);
  for (const [q, val] of pts) v[qIdx(q) - i0] = sig(val);
  return { f: "Q", ...meta, s: pts[0][0], v };
}

/* points: [[year, value], ...] */
export function annualSeries(points, meta = {}) {
  const pts = points.filter(p => p[1] != null && Number.isFinite(p[1])).map(p => [+p[0], p[1]]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return { f: "A", ...meta, s: null, v: [] };
  const y0 = pts[0][0], y1 = pts[pts.length - 1][0];
  const v = new Array(y1 - y0 + 1).fill(null);
  for (const [y, val] of pts) v[y - y0] = sig(val);
  return { f: "A", ...meta, s: y0, v };
}

/* Letztes Beobachtungsdatum einer kompakten Reihe (für den Datenstatus). */
export function lastObs(s) {
  if (!s || s.s == null || !s.v.length) return null;
  if (s.f === "D" || s.f === "W") {
    const n = dayNum(s.s) + s.d.reduce((a, b) => a + b, 0);
    return new Date(n * DAY).toISOString().slice(0, 10);
  }
  let last = s.v.length - 1;
  while (last >= 0 && s.v[last] == null) last--;
  if (last < 0) return null;
  if (s.f === "M") { const i = monthIdx(s.s) + last; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; }
  if (s.f === "Q") { const i = qIdx(s.s) + last; return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`; }
  return String(s.s + last);
}

export function isoDaysAgo(n, now = Date.now()) {
  return new Date(now - n * DAY).toISOString().slice(0, 10);
}

/* Kompakte Reihe zurück in Punkte [[datum, wert], ...] (für das Fortschreiben gespeicherter Historien) */
export function toPoints(s) {
  if (!s || s.s == null || !s.v) return [];
  if (s.f === "D" || s.f === "W") {
    let n = dayNum(s.s);
    const out = [];
    for (let i = 0; i < s.v.length; i++) { n += s.d[i]; if (s.v[i] != null) out.push([new Date(n * DAY).toISOString().slice(0, 10), s.v[i]]); }
    return out;
  }
  if (s.f === "M") { const i0 = monthIdx(s.s); return s.v.map((v, i) => [`${Math.floor((i0 + i) / 12)}-${String(((i0 + i) % 12) + 1).padStart(2, "0")}`, v]).filter(p => p[1] != null); }
  if (s.f === "Q") { const i0 = qIdx(s.s); return s.v.map((v, i) => [`${Math.floor((i0 + i) / 4)}-Q${((i0 + i) % 4) + 1}`, v]).filter(p => p[1] != null); }
  return s.v.map((v, i) => [s.s + i, v]).filter(p => p[1] != null);
}

/* Neue Punkte mit gespeicherten zusammenführen (neue Werte haben Vorrang), optional auf "keepFrom" kürzen */
export function mergePoints(oldPts, newPts, keepFrom = null) {
  const m = new Map(oldPts.map(p => [String(p[0]), p[1]]));
  for (const [d, v] of newPts) if (v != null && Number.isFinite(v)) m.set(String(d), v);
  let out = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (keepFrom) out = out.filter(p => p[0] >= keepFrom);
  return out.map(([d, v]) => [typeof oldPts[0]?.[0] === "number" || typeof newPts[0]?.[0] === "number" ? +d : d, v]);
}

/* Ältere Tageswerte ausdünnen: Punkte vor "days" Tagen (gemessen am jüngsten Punkt) behalten nur den letzten Wert
   je Kalenderwoche. Trendrechnungen brauchen Tageswerte nur für die letzten gut zwei Jahre. */
export function thinOld(pts, days = 800) {
  if (pts.length < 2) return pts;
  const last = dayNum(String(pts[pts.length - 1][0]));
  const cut = last - days;
  const out = [];
  let wk = null;
  for (const p of pts) {
    const n = dayNum(String(p[0]));
    if (n >= cut) { out.push(p); continue; }
    const w = Math.floor((n + 3) / 7); // Wochen ab Donnerstag 1.1.1970, gleichbleibend je Mo–So-Woche
    if (w === wk) out[out.length - 1] = p; else out.push(p);
    wk = w;
  }
  return out;
}
