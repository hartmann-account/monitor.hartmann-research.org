"use strict";
/* Kleine SVG-Diagrammschicht ohne Abhängigkeiten.
   Linien mit Lücken, Fächerbänder, Schattierungen, Referenzlinien, Fadenkreuz-Tooltip,
   Endbeschriftungen, Legende mit Ein-/Ausblenden und Tabellenansicht. */
const NS = "http://www.w3.org/2000/svg";
const LOCALE = "de-DE";
const Charts = new Set();

// Farbwerte der CSS-Variablen zwischengespeichert (getComputedStyle bei jedem Aufruf ist teuer); ein Wechsel des
// Farbschemas leert den Speicher (onThemeChange unten)
const CSS_VARS = new Map();
function cssVar(name) {
  let v = CSS_VARS.get(name);
  if (v === undefined) CSS_VARS.set(name, (v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()));
  return v;
}
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
function sv(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}
// ein Zahlenformat je Zahl der Nachkommastellen (toLocaleString mit Optionen baut bei jedem Aufruf ein neues)
const NUM_FMT = new Map();
function fmt(v, d = 1) {
  if (v == null || !isFinite(v)) return "–";
  let f = NUM_FMT.get(d);
  if (!f) NUM_FMT.set(d, (f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(Number(v));
}
function fmtAuto(v) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return fmt(v / 1e9, 1) + " Mrd.";
  if (a >= 1e6) return fmt(v / 1e6, 1) + " Mio.";
  if (a >= 1e4) return fmt(v, 0);
  if (a >= 100) return fmt(v, 0);
  if (a >= 10) return fmt(v, 1);
  if (a >= 1) return fmt(v, 1);
  return fmt(v, 2);
}
function fmtTick(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return fmt(v / 1e6, a % 1e6 ? 1 : 0) + " Mio.";
  if (a >= 1e4) return fmt(v / 1e3, a % 1e3 ? 1 : 0) + " Tsd.";
  const d = a === 0 ? 0 : a < 0.1 ? 2 : a < 1 ? (Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2) : (Math.abs(v - Math.round(v)) < 1e-6 ? 0 : 1);
  return fmt(v, d);
}
const _mctx = document.createElement("canvas").getContext("2d");
function textW(t, size = 11.5, weight = 560) {
  _mctx.font = `${weight} ${size}px Archivo, Arial, sans-serif`;
  return _mctx.measureText(t).width;
}
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
function linTicks(min, max, count) {
  const st = niceStep(max - min, count);
  const t = [];
  for (let v = Math.ceil(min / st - 1e-9) * st; v <= max + st * 1e-9; v += st) t.push(+v.toFixed(10));
  return t;
}
function niceDomain(min, max, count, zero) {
  if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { max = min + 1; }
  const st = niceStep(max - min, count);
  return [Math.floor(min / st + 1e-9) * st, Math.ceil(max / st - 1e-9) * st];
}
function logTicks(min, max) {
  const t = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min * 0.999 && v <= max * 1.001) t.push(v);
    }
  }
  if (t.length > 9) return t.filter(v => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
  return t;
}
function yearTicks(min, max, width) {
  const n = Math.max(2, Math.floor(width / 78));
  const span = max - min;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
  const st = steps.find(s => span / s <= n) || 1000;
  const t = [];
  for (let v = Math.ceil(min / st) * st; v <= max + 1e-9; v += st) t.push(v);
  return t;
}
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
/* Achsenticks für kurze Zeiträume: Monatsanfänge, ausgedünnt nach verfügbarer Breite */
function monthTicks(min, max, width) {
  const n = Math.max(2, Math.floor(width / 64));
  const months = Math.max(1, Math.round((max - min) * 12));
  const step = [1, 2, 3, 4, 6, 12, 24].find(s => months / s <= n) || 36;
  const t = [];
  for (let k = Math.ceil(min * 12 - 1e-6); k / 12 <= max + 1e-9; k++) if (((k % 12) + 12) % 12 % (step >= 12 ? 12 : step) === 0 && (step < 12 || Math.floor(k / 12) % (step / 12) === 0)) t.push(k / 12);
  return t;
}
function monthTickFmt(v) {
  const k = Math.round(v * 12), y = Math.floor(k / 12), m = ((k % 12) + 12) % 12;
  return m === 0 ? String(y) : `${MONTHS[m]} ${String(y).slice(2)}`;
}
const SHORT_RANGE = { xTicks: (a, b, w) => (b - a > 4 ? yearTicks(a, b, w) : monthTicks(a, b, w)), xTickFmt: v => (Math.abs(v * 12 - Math.round(v * 12)) < 1e-6 && Math.round(v * 12) % 12 !== 0 ? monthTickFmt(v) : String(Math.round(v))) };
function dayFromYearFrac(x) {
  const y = Math.floor(x + 1e-9);
  const a = Date.UTC(y, 0, 1), b = Date.UTC(y + 1, 0, 1);
  return new Date(a + Math.round((x - y) * (b - a) / 86400000) * 86400000);
}
function fmtYearFrac(x, freq) {
  if (freq === "D") { const d = dayFromYearFrac(x); return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  if (freq === "M") { const y = Math.floor(x + 1e-6); const m = Math.round((x - y) * 12); return `${MONTHS[Math.min(11, m)]} ${y}`; }
  if (freq === "Q") { const y = Math.floor(x); const q = Math.floor((x - y) * 4) + 1; return `Q${q} ${y}`; }
  return String(Math.round(x));
}
function nearestIdx(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m; else hi = m; }
  return Math.abs(arr[lo] - x) <= Math.abs(arr[hi] - x) ? lo : hi;
}
function valueAt(data, x, tol) {
  let best = null, bd = Infinity;
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (data[m][0] < x) lo = m; else hi = m; }
  for (const i of [lo - 1, lo, hi, hi + 1]) {
    if (i < 0 || i >= data.length) continue;
    const d = Math.abs(data[i][0] - x);
    if (d < bd && data[i][1] != null && isFinite(data[i][1])) { bd = d; best = data[i]; }
  }
  return bd <= tol ? best : null;
}

/* Punkte einer Linie für das Zeichnen verdichten: je halber Pixelspalte nur der erste, kleinste, größte und letzte
   Wert. Das Bild bleibt gleich (Spitzen bleiben erhalten), die Pfade werden bei langen Tagesreihen viel kürzer. */
function perPixel(pts, X) {
  if (pts.length < 600) return pts;
  const out = [];
  let col = null, first, lo, hi, last;
  const flush = () => { if (first) out.push(...[first, lo, hi, last].filter((p, i, a) => a.indexOf(p) === i).sort((a, b) => a[0] - b[0])); };
  for (const p of pts) {
    if (first && p[0] < last[0]) return pts; // nur für zeitlich geordnete Reihen
    const c = Math.floor(X(p[0]) * 2);
    if (c !== col) { flush(); col = c; first = lo = hi = last = p; continue; }
    if (p[1] < lo[1]) lo = p;
    if (p[1] > hi[1]) hi = p;
    last = p;
  }
  flush();
  return out;
}
class LineChart {
  constructor(host, o) {
    this.o = Object.assign({
      height: 260, endLabels: true, legend: true, zero: false, log: false, freq: "A",
      yFmt: fmtTick, tipFmt: v => fmtAuto(v), xFmt: null, minEndLabelW: 520,
    }, o);
    this.hidden = new Set(this.o.hidden || []);
    this.root = h("div", { class: "chart" });
    host.append(this.root);
    this.plot = h("div", { style: "position:relative" });
    this.root.append(this.plot);
    this.tip = h("div", { class: "tooltip", hidden: true, role: "status" });
    this.plot.append(this.tip);
    this.legendEl = h("div", { class: "legend" });
    this.root.append(this.legendEl);
    this.tableEl = h("div", { class: "table-wrap", hidden: true });
    this.root.append(this.tableEl);
    // nur bei geänderter Breite neu zeichnen: der erste Aufruf nach observe() folgt sonst direkt auf update()
    this.ro = new ResizeObserver(() => { if (Math.round(this.root.clientWidth) !== this.drawnW) this.render(); });
    this.ro.observe(this.root);
    Charts.add(this);
  }
  update(o) { Object.assign(this.o, o); if (o.hidden) this.hidden = new Set(o.hidden); this.render(); if (!this.tableEl.hidden) this.buildTable(); }
  toggleTable(btn) {
    this.tableEl.hidden = !this.tableEl.hidden;
    if (btn) btn.setAttribute("aria-pressed", String(!this.tableEl.hidden));
    if (!this.tableEl.hidden) this.buildTable();
  }
  color(s) { return s.color && s.color.startsWith("--") ? cssVar(s.color) : (s.color || cssVar("--ink-2")); }
  buildTable() {
    const o = this.o;
    const ser = o.series.filter(s => !s.noTable);
    const xsSet = new Set();
    ser.forEach(s => s.data.forEach(([x, y]) => { if (y != null && isFinite(y)) xsSet.add(+x.toFixed(4)); }));
    let xs = [...xsSet].sort((a, b) => a - b);
    if (o.xMin != null) xs = xs.filter(x => x >= o.xMin - 1e-6);
    if (o.xMax != null) xs = xs.filter(x => x <= o.xMax + 1e-6);
    let step = 1;
    if (xs.length > 320) step = Math.ceil(xs.length / 320);
    const rows = xs.filter((_, i) => i % step === 0 || i === xs.length - 1).reverse();
    const tol = o.freq === "D" ? 0.006 : o.freq === "M" ? 0.02 : o.freq === "Q" ? 0.1 : 0.4;
    const tbl = h("table", { class: "data" });
    const thead = h("thead", null, h("tr", null, h("th", { text: o.xLabel || "Jahr" }), ser.map(s => h("th", { text: s.label + (s.unit ? ` (${s.unit})` : "") }))));
    const tb = h("tbody");
    for (const x of rows) {
      tb.append(h("tr", null, h("td", { text: (o.xFmt || (v => fmtYearFrac(v, o.freq)))(x) }),
        ser.map(s => { const p = valueAt(s.data, x, tol); return h("td", { text: p ? o.tipFmt(p[1], s) : "–" }); })));
    }
    tbl.append(thead, tb);
    this.tableEl.replaceChildren(tbl);
    if (step > 1) this.tableEl.append(h("p", { class: "small", style: "padding:6px 8px", text: `Jeder ${step}. Wert angezeigt.` }));
  }
  render() {
    const o = this.o;
    const W = Math.round(this.root.clientWidth);
    this.drawnW = W;
    if (W < 60) return;
    const H = o.height;
    const vis = o.series.filter(s => !this.hidden.has(s.id));
    const xs = [], ys = [];
    const inX = x => (o.xMin == null || x >= o.xMin) && (o.xMax == null || x <= o.xMax);
    for (const s of vis) for (const [x, y] of s.data) if (y != null && isFinite(y) && inX(x)) { xs.push(x); ys.push(y); }
    for (const f of (o.fans || [])) { for (const [x, y] of f.lo) if (y != null && inX(x)) { xs.push(x); ys.push(y); } for (const [x, y] of f.hi) if (y != null && inX(x)) { xs.push(x); ys.push(y); } }
    for (const r of (o.refs || [])) if (r.inDomain !== false) ys.push(r.y);
    if (!xs.length) { this.plot.replaceChildren(h("p", { class: "loading", text: "Keine Daten im gewählten Bereich." }), this.tip); this.legend(vis); return; }
    let x0 = o.xMin ?? Math.min(...xs), x1 = o.xMax ?? Math.max(...xs);
    if (x0 === x1) x1 = x0 + 1;
    let yLo = Math.min(...ys), yHi = Math.max(...ys);
    if (o.yMin != null) yLo = o.yMin;
    if (o.yMax != null) yHi = Math.max(o.yMax, o.yMaxSoft ? yHi : o.yMax);
    let yT, y0, y1;
    if (o.log) {
      yLo = Math.max(yLo, o.logFloor || 1e-9);
      y0 = Math.pow(10, Math.floor(Math.log10(yLo)));
      y1 = Math.pow(10, Math.ceil(Math.log10(yHi)));
      yT = logTicks(y0, y1);
    } else {
      [y0, y1] = niceDomain(yLo, yHi, Math.max(3, Math.round(H / 55)), o.zero);
      if (o.yMin != null) y0 = o.yMin;
      if (o.yMax != null && !o.yMaxSoft) y1 = o.yMax;
      yT = linTicks(y0, y1, Math.max(3, Math.round(H / 55)));
    }
    const yLabelW = Math.max(...yT.map(v => textW(o.yFmt(v), 11, 400))) + 10;
    const showEnd = o.endLabels && W >= o.minEndLabelW && vis.some(s => s.endLabel !== false);
    const endItems = [];
    if (showEnd) {
      for (const s of vis) {
        if (s.endLabel === false) continue;
        let last = null;
        for (let i = s.data.length - 1; i >= 0; i--) { const [x, y] = s.data[i]; if (y != null && isFinite(y) && inX(x)) { last = s.data[i]; break; } }
        if (!last) continue;
        const txt = s.short || s.label;
        const val = o.endValFmt ? o.endValFmt(last[1], s) : null;
        endItems.push({ s, last, txt, val, w: textW(txt) + (val ? textW(" " + val, 11, 400) + 4 : 0) });
      }
    }
    const mR = showEnd && endItems.length ? Math.min(W * 0.36, Math.max(...endItems.map(e => e.w)) + 22) : 14;
    const m = { l: yLabelW + 4, r: mR, t: 12, b: 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = x => m.l + (x - x0) / (x1 - x0) * pw;
    const Y = o.log ? (v => m.t + ph - (Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) * ph)
                    : (v => m.t + ph - (v - y0) / (y1 - y0) * ph);
    this.scale = { X, Y, x0, x1, y0, y1, m, pw, ph };
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": o.aria || "Diagramm" });
    // Schattierungen
    for (const sh of (o.shades || [])) {
      const a = Math.max(x0, sh.x0), b = Math.min(x1, sh.x1);
      if (b <= a) continue;
      svg.append(sv("rect", { x: X(a), y: m.t, width: Math.max(1, X(b) - X(a)), height: ph, fill: cssVar("--hover") }));
      if (sh.label && X(b) - X(a) > textW(sh.label, 10.5, 400) + 6) { const t = sv("text", { x: X(a) + 4, y: m.t + 11, class: "shade-label" }); t.textContent = sh.label; svg.append(t); }
    }
    // Gitter und Achsen
    const g = sv("g", { class: "grid" });
    for (const v of yT) { g.append(sv("line", { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v) })); }
    svg.append(g);
    const ticks = sv("g", { class: "tick" });
    for (const v of yT) { const t = sv("text", { x: m.l - 6, y: Y(v) + 3.5, "text-anchor": "end" }); t.textContent = o.yFmt(v); ticks.append(t); }
    const xT = o.xTicks ? o.xTicks(x0, x1, pw) : yearTicks(x0, x1, pw);
    for (const v of xT) { const t = sv("text", { x: X(v), y: H - 8, "text-anchor": "middle" }); t.textContent = o.xTickFmt ? o.xTickFmt(v) : String(v); ticks.append(t); }
    svg.append(ticks);
    const baseY = !o.log && y0 <= 0 && y1 >= 0 ? Y(0) : m.t + ph;
    svg.append(sv("line", { class: "baseline", x1: m.l, x2: m.l + pw, y1: baseY, y2: baseY }));
    // Referenzlinien
    for (const r of (o.refs || [])) {
      if (r.y < y0 || r.y > y1) continue;
      svg.append(sv("line", { x1: m.l, x2: m.l + pw, y1: Y(r.y), y2: Y(r.y), stroke: cssVar("--axis"), "stroke-width": 1 }));
      if (r.label) { const t = sv("text", { x: m.l + 4, y: Y(r.y) - 4, class: "ref-label" }); t.textContent = r.label; svg.append(t); }
    }
    for (const r of (o.vlines || [])) {
      if (r.x < x0 || r.x > x1) continue;
      svg.append(sv("line", { x1: X(r.x), x2: X(r.x), y1: m.t, y2: m.t + ph, stroke: cssVar("--axis"), "stroke-width": 1 }));
      if (r.label) { const t = sv("text", { x: X(r.x) + 4, y: m.t + 11, class: "ref-label" }); t.textContent = r.label; svg.append(t); }
    }
    // Fächer
    for (const f of (o.fans || [])) {
      const col = f.color.startsWith("--") ? cssVar(f.color) : f.color;
      const hi = f.hi.filter(p => p[1] != null && inX(p[0])), lo = f.lo.filter(p => p[1] != null && inX(p[0]));
      if (!hi.length) continue;
      let d = "M" + hi.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L");
      d += "L" + lo.slice().reverse().map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + "Z";
      svg.append(sv("path", { d, fill: col, "fill-opacity": f.opacity ?? 0.14, stroke: "none" }));
    }
    // Linien
    const lineG = sv("g", { fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" });
    for (const s of vis) {
      const col = this.color(s);
      let areaD = "", seg = [];
      const segs = [];
      for (const p of s.data) {
        const [x, y] = p;
        if (!inX(x)) continue;
        if (y == null || !isFinite(y) || (o.log && y <= 0)) { if (seg.length) { segs.push(seg); seg = []; } continue; }
        seg.push(p);
      }
      if (seg.length) segs.push(seg);
      const thin = segs.map(sg => perPixel(sg, X));
      const d = thin.map(sg => "M" + sg.map(([x, y]) => X(x).toFixed(1) + "," + Y(y).toFixed(1)).join("L")).join("");
      if (s.area) {
        for (const sg of thin) {
          areaD += "M" + sg.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + `L${X(sg[sg.length - 1][0]).toFixed(1)},${baseY}L${X(sg[0][0]).toFixed(1)},${baseY}Z`;
        }
        svg.append(sv("path", { d: areaD, fill: col, "fill-opacity": 0.1, stroke: "none" }));
      }
      lineG.append(sv("path", { d, stroke: col, "stroke-width": s.width || 2, "stroke-dasharray": s.dash || null, opacity: s.opacity ?? 1 }));
      if (s.markers) {
        for (const sg of segs) for (const [x, y] of sg) lineG.append(sv("circle", { cx: X(x), cy: Y(y), r: 3, fill: col, stroke: cssVar("--sheet"), "stroke-width": 1.5 }));
      }
    }
    svg.append(lineG);
    // Punkte und Anmerkungen
    for (const p of (o.points || [])) {
      if (!inX(p.x) || p.y == null) continue;
      const col = p.color ? (p.color.startsWith("--") ? cssVar(p.color) : p.color) : cssVar("--ink");
      svg.append(sv("circle", { cx: X(p.x), cy: Y(p.y), r: 4.5, fill: col, stroke: cssVar("--sheet"), "stroke-width": 2 }));
      if (p.label) {
        const anchor = X(p.x) > m.l + pw * 0.75 ? "end" : "start";
        const t = sv("text", { x: X(p.x) + (anchor === "end" ? -8 : 8), y: Y(p.y) - 8, class: "ref-label", "text-anchor": anchor });
        t.textContent = p.label; svg.append(t);
      }
    }
    // Endbeschriftungen mit Kollisionsauflösung
    if (showEnd && endItems.length) {
      endItems.forEach(e => { e.y0 = Y(e.last[1]); e.y = e.y0; });
      endItems.sort((a, b) => a.y - b.y);
      const gap = 13;
      for (let i = 1; i < endItems.length; i++) if (endItems[i].y - endItems[i - 1].y < gap) endItems[i].y = endItems[i - 1].y + gap;
      const over = endItems.length ? endItems[endItems.length - 1].y - (m.t + ph) : 0;
      if (over > 0) endItems.forEach(e => { e.y -= over; });
      for (let i = endItems.length - 2; i >= 0; i--) if (endItems[i + 1].y - endItems[i].y < gap) endItems[i].y = endItems[i + 1].y - gap;
      for (const e of endItems) {
        const xe = X(e.last[0]);
        const col = this.color(e.s);
        const lx = m.l + pw + 8;
        if (Math.abs(e.y - e.y0) > 3 || xe < m.l + pw - 2) {
          svg.append(sv("path", { d: `M${xe + 2},${e.y0}L${lx - 6},${e.y0}L${lx - 2},${e.y}`, stroke: cssVar("--axis"), "stroke-width": 1, fill: "none" }));
        }
        svg.append(sv("circle", { cx: xe, cy: e.y0, r: 3.5, fill: col, stroke: cssVar("--sheet"), "stroke-width": 1.5 }));
        const t = sv("text", { x: lx, y: e.y + 4, class: "endlabel" });
        t.textContent = e.txt;
        if (e.val) { const ts = sv("tspan", { class: "endlabel-val", dx: 4 }); ts.textContent = e.val; t.append(ts); }
        svg.append(t);
      }
    }
    // Interaktion: Fadenkreuz
    let allXs = null;
    const allX = () => allXs || (allXs = [...new Set(vis.flatMap(s => s.data.filter(p => p[1] != null && inX(p[0])).map(p => +p[0].toFixed(4))))].sort((a, b) => a - b));
    const cross = sv("line", { class: "crosshair", y1: m.t, y2: m.t + ph, visibility: "hidden" });
    const dots = sv("g", { visibility: "hidden" });
    svg.append(cross, dots);
    const overlay = sv("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent", tabindex: 0, style: "cursor:crosshair;outline:none" });
    svg.append(overlay);
    const tol = o.freq === "D" ? 0.012 : o.freq === "M" ? 0.05 : o.freq === "Q" ? 0.15 : 0.6;
    let idx = -1;
    const show = (i, px, py) => {
      const xs = allX();
      if (i < 0 || i >= xs.length) return;
      idx = i;
      const x = xs[i];
      cross.setAttribute("x1", X(x)); cross.setAttribute("x2", X(x)); cross.setAttribute("visibility", "visible");
      dots.replaceChildren(); dots.setAttribute("visibility", "visible");
      const rows = [];
      for (const s of vis) {
        if (s.noTip) continue;
        const p = valueAt(s.data, x, s.tol ?? tol);
        if (!p) continue;
        const col = this.color(s);
        dots.append(sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 4, fill: col, stroke: cssVar("--sheet"), "stroke-width": 2 }));
        rows.push({ s, v: p[1], col });
      }
      for (const f of (o.fans || [])) {
        if (!f.tipLabel) continue;
        const lo = valueAt(f.lo, x, tol), hi = valueAt(f.hi, x, tol);
        if (lo && hi) rows.push({ s: { label: f.tipLabel }, v: null, range: [lo[1], hi[1]], col: f.color.startsWith("--") ? cssVar(f.color) : f.color });
      }
      rows.sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
      this.tip.replaceChildren(h("div", { class: "tt-x", text: (o.xFmt || (v => fmtYearFrac(v, o.freq)))(x) }),
        ...rows.map(r => h("div", { class: "tt-row" },
          h("span", { class: "k", style: `background:${r.col}` }),
          h("span", { class: "v", text: r.range ? `${o.tipFmt(r.range[0], r.s)} – ${o.tipFmt(r.range[1], r.s)}` : o.tipFmt(r.v, r.s) }),
          h("span", { class: "n", text: r.s.label }))));
      if (!rows.length) this.tip.append(h("div", { class: "small", text: "Kein Wert" }));
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let left = (px ?? X(x)) + 14;
      if (left + tw > W - 4) left = (px ?? X(x)) - tw - 14;
      left = Math.max(4, left);
      let top = (py ?? m.t + 10) - th / 2;
      top = Math.max(0, Math.min(H - th, top));
      this.tip.style.left = left + "px"; this.tip.style.top = top + "px";
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); dots.setAttribute("visibility", "hidden"); this.tip.hidden = true; };
    overlay.addEventListener("pointermove", ev => {
      const r = svg.getBoundingClientRect();
      const sx = (ev.clientX - r.left) * (W / r.width), sy = (ev.clientY - r.top) * (H / r.height);
      const x = x0 + (sx - m.l) / pw * (x1 - x0);
      show(nearestIdx(allX(), x), sx, sy);
    });
    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("blur", hide);
    overlay.addEventListener("focus", () => show(allX().length - 1));
    overlay.addEventListener("keydown", ev => {
      if (ev.key === "ArrowLeft") { show(Math.max(0, idx - 1)); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { show(Math.min(allX().length - 1, idx + 1)); ev.preventDefault(); }
      else if (ev.key === "Escape") hide();
    });
    this.plot.replaceChildren(svg, this.tip);
    this.legend(vis);
  }
  legend() {
    const o = this.o;
    const items = o.series.filter(s => !s.noLegend);
    if (!o.legend || items.length < 2) { this.legendEl.replaceChildren(); return; }
    this.legendEl.replaceChildren(...items.map(s => {
      const b = h("button", { type: "button", "aria-pressed": String(!this.hidden.has(s.id)), title: "Reihe ein- oder ausblenden" },
        h("span", { class: "key" + (s.dash ? " dash" : ""), style: s.dash ? `color:${this.color(s)}` : `background:${this.color(s)}` }), s.label);
      b.addEventListener("click", () => {
        if (this.hidden.has(s.id)) this.hidden.delete(s.id); else this.hidden.add(s.id);
        this.render();
        if (!this.tableEl.hidden) this.buildTable();
      });
      return b;
    }));
    if (o.fans && o.fans.some(f => f.legend)) {
      for (const f of o.fans.filter(f => f.legend)) {
        const col = f.color.startsWith("--") ? cssVar(f.color) : f.color;
        this.legendEl.append(h("span", { class: "small", style: "display:inline-flex;align-items:center;gap:6px;padding:3px 7px" },
          h("span", { style: `width:14px;height:10px;border-radius:2px;background:${col};opacity:${(f.opacity ?? 0.14) * 2.2}` }), f.legend));
      }
    }
  }
}

/* Heatmap: Zeilen x Jahre, Werte 0..1, sequentielle Ein-Farben-Skala */
class HeatStrip {
  constructor(host, o) {
    this.o = Object.assign({ rowH: 22 }, o);
    this.root = h("div", { class: "chart" });
    host.append(this.root);
    this.plot = h("div", { style: "position:relative" });
    this.tip = h("div", { class: "tooltip", hidden: true });
    this.root.append(this.plot);
    this.ro = new ResizeObserver(() => { if (Math.round(this.root.clientWidth) !== this.drawnW) this.render(); });
    this.ro.observe(this.root);
    Charts.add(this);
  }
  update(o) { Object.assign(this.o, o); this.render(); }
  ramp(t) {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark") || matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.getAttribute("data-theme") !== "light";
    const stops = ["--q100", "--q200", "--q300", "--q400", "--q500", "--q600", "--q700"].map(cssVar);
    const st = dark ? stops.slice().reverse().slice(0, 6) : stops;
    const p = Math.max(0, Math.min(1, t)) * (st.length - 1);
    const i = Math.min(st.length - 2, Math.floor(p)), f = p - i;
    const a = hex2rgb(st[i]), b = hex2rgb(st[i + 1]);
    return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
  }
  render() {
    const o = this.o;
    const W = Math.round(this.root.clientWidth);
    this.drawnW = W;
    if (W < 60 || !o.rows) return;
    const labW = Math.min(170, Math.max(...o.rows.map(r => textW(r.label, 12, 500))) + 14);
    const m = { l: labW, r: 8, t: 6, b: 24 };
    const n = o.years.length;
    const pw = W - m.l - m.r;
    const cw = pw / n;
    const H = m.t + o.rows.length * o.rowH + m.b;
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": o.aria || "Heatmap" });
    o.rows.forEach((r, ri) => {
      const y = m.t + ri * o.rowH;
      const t = sv("text", { x: 0, y: y + o.rowH / 2 + 4, class: "endlabel" });
      t.textContent = r.label; svg.append(t);
      svg.append(sv("rect", { x: m.l, y: y + 2, width: pw, height: o.rowH - 4, fill: cssVar("--hover") }));
      let runStart = null, runVal = null;
      for (let i = 0; i <= n; i++) {
        const v = i < n ? r.values[i] : undefined;
        const key = v == null ? null : Math.round(v * 40) / 40;
        if (i < n && runStart !== null && key === runVal) continue;
        if (runStart !== null && runVal !== null) svg.append(sv("rect", { x: m.l + runStart * cw, y: y + 2, width: Math.max(0.5, (i - runStart) * cw + 0.3), height: o.rowH - 4, fill: this.ramp(runVal) }));
        runStart = i; runVal = key;
      }
      if (r.peak != null) {
        const xi = o.years.indexOf(r.peak);
        if (xi >= 0) svg.append(sv("rect", { x: m.l + xi * cw + cw / 2 - 1.5, y: y + 1, width: 3, height: o.rowH - 2, fill: cssVar("--ink") }));
      }
    });
    const ticks = sv("g", { class: "tick" });
    for (const v of yearTicks(o.years[0], o.years[n - 1], pw)) {
      const i = o.years.indexOf(v); if (i < 0) continue;
      const t = sv("text", { x: m.l + (i + 0.5) * cw, y: H - 7, "text-anchor": "middle" }); t.textContent = v; ticks.append(t);
    }
    svg.append(ticks);
    const overlay = sv("rect", { x: m.l, y: m.t, width: pw, height: o.rows.length * o.rowH, fill: "transparent" });
    svg.append(overlay);
    overlay.addEventListener("pointermove", ev => {
      const rc = svg.getBoundingClientRect();
      const sx = (ev.clientX - rc.left) * (W / rc.width), sy = (ev.clientY - rc.top) * (H / rc.height);
      const ci = Math.max(0, Math.min(n - 1, Math.floor((sx - m.l) / cw)));
      const ri = Math.max(0, Math.min(o.rows.length - 1, Math.floor((sy - m.t) / o.rowH)));
      const r = o.rows[ri], v = r.values[ci];
      this.tip.replaceChildren(h("div", { class: "tt-x", text: `${r.label} · ${o.years[ci]}` }),
        h("div", { class: "tt-row" }, h("span"), h("span", { class: "v", text: v == null ? "keine Daten" : fmt(v * 100, 0) + " % des Höchststands" }), h("span")));
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.max(4, Math.min(W - tw - 4, sx + 12)) + "px";
      this.tip.style.top = Math.max(0, sy - 46) + "px";
    });
    overlay.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    this.plot.replaceChildren(svg, this.tip);
  }
}
function hex2rgb(hx) {
  const s = hx.replace("#", "");
  const n = s.length === 3 ? s.split("").map(c => c + c).join("") : s;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
}

function sparkline(values, color) {
  const pts = values.filter(p => p[1] != null && isFinite(p[1]));
  const svg = sv("svg", { viewBox: "0 0 120 28", preserveAspectRatio: "none", "aria-hidden": "true" });
  if (pts.length < 2) return svg;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = x => 2 + (x - x0) / (x1 - x0 || 1) * 112, Y = y => 25 - (y - y0) / (y1 - y0 || 1) * 21;
  const d = "M" + pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L");
  const col = color.startsWith("--") ? cssVar(color) : color;
  svg.append(sv("path", { d: d + `L${X(x1)},27L${X(x0)},27Z`, fill: col, "fill-opacity": 0.1 }));
  svg.append(sv("path", { d, fill: "none", stroke: col, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
  const [lx, ly] = pts[pts.length - 1];
  svg.append(sv("circle", { cx: X(lx), cy: Y(ly), r: 2.4, fill: col }));
  return svg;
}

function onThemeChange(fn) {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fn);
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
onThemeChange(() => { CSS_VARS.clear(); for (const c of Charts) c.render(); });
