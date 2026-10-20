"use strict";
/* Big-Cycle-Monitor: Seitenlogik, Teil 1 (Hilfen, Lagebild, Machtindex) */
let D = null;
const CC = { USA: "--s1", CHN: "--s2", GBR: "--s3", NLD: "--s4", DEU: "--s5", JPN: "--s6", RUS: "--s7", IND: "--s8" };
const SHORT = { USA: "USA", CHN: "China", GBR: "Großbritannien", NLD: "Niederlande", DEU: "Deutschland", JPN: "Japan", RUS: "Russland", IND: "Indien" };
const MSHORT = { education: "Bildung", innovation: "Innovation", competitiveness: "Wettbewerbsfähigkeit", output: "Wirtschaftsleistung", trade: "Welthandel", military: "Militär", finance: "Finanzzentrum", reserve: "Reservewährung" };
const ST = { countries: new Set(["USA", "CHN", "GBR", "NLD"]), minN: 3, weights: {}, fp: "USA" };
const charts = {};

function A(id, scale = 1) {
  const s = D.series[id];
  if (!s || s.start == null) return [];
  const sc = v => (v == null ? null : v * scale);
  if (s.freq === "M") { const [y, m] = s.start.split("-").map(Number); return s.values.map((v, i) => [y + (m - 1 + i) / 12, sc(v)]); }
  if (s.freq === "Q") { const [y, q] = s.start.split("-Q").map(Number); return s.values.map((v, i) => { const k = q - 1 + i; return [y + Math.floor(k / 4) + (k % 4) / 4 + 0.125, sc(v)]; }); }
  if (s.freq === "D") { const t0 = Math.round(Date.parse(s.start + "T00:00:00Z") / 864e5); return s.values.map((v, i) => [SIG.yearFrac(t0 + i), sc(v)]); }
  return s.values.map((v, i) => [s.start + i, sc(v)]);
}
function smooth(arr, k = 3) {
  const half = Math.floor(k / 2);
  return arr.map(([x], i) => {
    const w = arr.slice(Math.max(0, i - half), i + half + 1).map(p => p[1]).filter(v => v != null && isFinite(v));
    return [x, arr[i][1] == null || w.length < Math.min(k, 2) ? null : w.reduce((a, b) => a + b, 0) / w.length];
  });
}
const DE_NAMES = { AUS: "Australien", BEL: "Belgien", CAN: "Kanada", CHE: "Schweiz", DEU: "Deutschland", DNK: "Dänemark", ESP: "Spanien", FIN: "Finnland", FRA: "Frankreich", GBR: "Großbritannien", IRL: "Irland", ITA: "Italien", JPN: "Japan", NLD: "Niederlande", NOR: "Norwegen", PRT: "Portugal", SWE: "Schweden", USA: "USA" };
function lastPt(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i][1] != null) return arr[i]; return null; }
function valAt(arr, x) { const p = arr.find(q => Math.abs(q[0] - x) < 1e-6); return p ? p[1] : null; }
function maxPt(arr) { let b = null; for (const p of arr) if (p[1] != null && (!b || p[1] > b[1])) b = p; return b; }
function deDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00Z" : iso);
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function deShort(iso) { if (!iso) return "–"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d}.${+m}.${y}`; }
function deMonth(iso) { const d = new Date(iso + "T12:00:00Z"); return d.toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }); }
function deQuarter(iso) { const d = new Date(iso + "T12:00:00Z"); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`; }
function pct(v, d = 1) { return v == null ? "–" : fmt(v, d) + " %"; }
function signed(v, d = 0) { if (v == null || !isFinite(v)) return "–"; return (v > 0 ? "+" : v < 0 ? "−" : "±") + fmt(Math.abs(v), d); }

function srcLinks(foot, ids) {
  const seen = new Set();
  const list = ids.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
  foot.append("Quelle: ");
  list.forEach((id, i) => {
    if (i) foot.append(" · ");
    if (id.startsWith("fred:")) {
      const sid = id.slice(5);
      foot.append(h("a", { href: `https://fred.stlouisfed.org/series/${sid}`, target: "_blank", rel: "noopener", text: `FRED ${sid}` }));
    } else if (id.startsWith("live:")) {
      const s = LSRC[id.slice(5)];
      foot.append(s ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.name }) : id.slice(5));
    } else if (D.sources[id]) {
      foot.append(h("a", { href: D.sources[id].url, target: "_blank", rel: "noopener", text: D.sources[id].name }));
    } else foot.append(id);
  });
}
function sheet(parent, o) {
  const actions = h("div", { class: "chart-actions" });
  const head = h("header", null, h("div", { class: "titles" }, h("h3", null, o.title, o.info ? info(withTitle(o.info, o.title), o.title) : null), o.sub ? h("div", { class: "sub", text: o.sub }) : null), actions);
  const body = h("div");
  const el = h("section", { class: "sheet" + (o.cls ? " " + o.cls : "") }, head, body);
  if (o.src && o.src.length) { const f = h("footer", { class: "src" }); srcLinks(f, o.src); if (o.note) f.append(h("br"), o.note); el.append(f); }
  else if (o.note) el.append(h("footer", { class: "src", text: o.note }));
  parent.append(el);
  return { el, body, actions, head };
}
function chartSheet(parent, o, copts) {
  const sh = sheet(parent, o);
  const ch = new LineChart(sh.body, copts);
  const btn = h("button", { class: "btn-ghost", type: "button", "aria-pressed": "false", text: "Tabelle" });
  btn.addEventListener("click", () => ch.toggleTable(btn));
  sh.actions.append(btn);
  return ch;
}
function srcOf(...ids) { return ids.flatMap(id => (D.series[id] ? D.series[id].src : [])); }
/* Auf Telefonen werden breite Tabellen zu Karten: jede Zelle trägt die Spaltenüberschrift als Beschriftung,
   die Spalte titleCol wird zum Kartentitel (CSS: table.stack unter 560 px) */
function cellLabel(el) {
  const parts = [];
  el.childNodes.forEach(n => {
    if (n.nodeType === 3) parts.push(n.textContent);
    else if (n.nodeType === 1 && !n.classList.contains("info-btn")) parts.push(n.classList.contains("th-unit") ? `(${n.textContent})` : cellLabel(n));
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function stackTable(tbl, titleCol = 0) {
  const heads = [...tbl.querySelectorAll("thead tr:last-child th")].map(cellLabel);
  tbl.classList.add("stack");
  for (const tr of tbl.querySelectorAll("tbody tr")) {
    let col = 0;
    for (const td of tr.children) {
      const span = +(td.getAttribute("colspan") || 1);
      if (span > 1) td.classList.add("st-full");
      else {
        if (heads[col]) td.setAttribute("data-label", heads[col]);
        if (col === titleCol) td.classList.add("st-title");
        else if ((td.textContent || "").length > 42) td.classList.add("st-long");
      }
      col += span;
    }
  }
  return tbl;
}

/* ------------------------------------------------------------------ Machtindex */
function weightsArr() { return Object.fromEntries(D.power.measures.map(m => [m.id, ST.weights[m.id] ?? 1])); }
function composite(c) { return compositeSeries(D, c, weightsArr(), ST.minN); }
function powerSeries() {
  const out = [];
  for (const c of D.power.countries.map(x => x.id)) {
    if (!ST.countries.has(c)) continue;
    const comp = composite(c);
    const full = comp.map(p => [p.y, p.n >= 5 ? p.v : null]);
    const part = comp.map((p, i) => {
      if (p.v == null) return [p.y, null];
      if (p.n < 5) return [p.y, p.v];
      const nb = (comp[i - 1] && comp[i - 1].v != null && comp[i - 1].n < 5) || (comp[i + 1] && comp[i + 1].v != null && comp[i + 1].n < 5);
      return [p.y, nb ? p.v : null];
    });
    out.push({ id: c, label: SHORT[c], color: CC[c], data: full });
    out.push({ id: c + "_p", group: c, label: SHORT[c] + " (geringe Abdeckung)", color: CC[c], data: part, opacity: 0.4, noLegend: true, endLabel: false, noTable: true, noTip: true });
  }
  return out;
}
function renderPower() {
  const chipsEl = document.getElementById("country-chips");
  chipsEl.replaceChildren(...D.power.countries.map(({ id }) => {
    const b = h("button", { class: "chip", type: "button", "aria-pressed": String(ST.countries.has(id)) },
      h("span", { class: "sw", style: `background:var(${CC[id]})` }), SHORT[id]);
    b.addEventListener("click", () => {
      if (ST.countries.has(id)) { if (ST.countries.size > 1) ST.countries.delete(id); } else ST.countries.add(id);
      b.setAttribute("aria-pressed", String(ST.countries.has(id)));
      updatePower();
    });
    return b;
  }));
  document.querySelectorAll("#coverage button").forEach(b => b.addEventListener("click", () => {
    ST.minN = +b.dataset.n;
    document.querySelectorAll("#coverage button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    updatePower();
  }));
  const wEl = document.getElementById("weights");
  wEl.replaceChildren(...D.power.measures.map(m => {
    const id = "w-" + m.id;
    const out = h("output", { for: id, text: "1,00 ×" });
    const inp = h("input", { type: "range", id, min: "0", max: "2", step: "0.25", value: "1" });
    inp.addEventListener("input", () => { ST.weights[m.id] = +inp.value; out.textContent = fmt(+inp.value, 2) + " ×"; updatePower(); });
    return h("div", { class: "slider" }, h("label", { for: id }, MSHORT[m.id], out), inp);
  }));
  wEl.append(h("p", { class: "small", style: "grid-column:1/-1", text: "Gewicht 0 nimmt eine Messgröße aus dem Index. Die Phasenschätzung im Lagebild verwendet immer alle acht Größen einzeln und ist von diesen Gewichten unabhängig." }));

  const host = document.getElementById("power-main");
  charts.power = chartSheet(host, {
    title: "Machtindex 1820–2026",
    sub: "Gewichtetes Mittel der normierten Messgrößen, 0–100; blass gezeichnet, wo weniger als fünf Größen vorliegen",
    src: ["maddison", "owid_cepii", "owid_gmsd", "owid_sipri", "cow", "owid_leelee", "nobel", "owid_rd", "wb", "imf_cofer", "imf_weo"],
    info: powerInfo,
  }, { series: powerSeries(), height: 360, yMin: 0, yMax: 100, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), aria: "Machtindex je Land 1820 bis 2026",
       shades: [{ x0: 1914, x1: 1918, label: "1. WK" }, { x0: 1939, x1: 1945, label: "2. WK" }] });

  const grid = document.getElementById("measure-grid");
  charts.measures = {};
  for (const m of D.power.measures) {
    const comps = m.components.map(c => D.power.components[c.id]);
    const src = [...new Set(comps.flatMap(c => c.src))];
    charts.measures[m.id] = chartSheet(grid, {
      title: MSHORT[m.id], sub: comps.map(c => c.label).join("; "), src, info: () => measureInfo(m),
    }, { series: measureSeries(m.id), height: 170, yMin: 0, yMax: 100, endLabels: false, legend: false, tipFmt: v => fmt(v, 0), aria: `Messgröße ${MSHORT[m.id]}` });
  }
  renderFingerprint();
  renderGpi();
  renderBench();
}
/* Erklärungen zum Machtindex */
function powerInfo() {
  const yi = D.power.years.length - 1, y = D.power.years[yi];
  const W = weightsArr();
  const line = c => {
    const parts = D.power.measures.map(m => [m, D.power.score[m.id][c][yi]]).filter(([m, v]) => v != null && (W[m.id] ?? 1) > 0);
    const den = parts.reduce((a, [m]) => a + (W[m.id] ?? 1), 0);
    const num = parts.reduce((a, [m, v]) => a + (W[m.id] ?? 1) * v, 0);
    return parts.length ? `${SHORT[c]} ${y}: (${parts.map(([m, v]) => `${fmt((W[m.id] ?? 1), 2)}×${fmt(v, 2)}`).join(" + ")}) ÷ ${fmt(den, 2)} × 100 = ${fmt(100 * num / den, 1)}` : null;
  };
  return {
    d: "Relative Stärke der Länder nach Dalios acht Machtfaktoren, gemessen mit offenen Ersatzreihen.",
    f: ["1. Jede Komponente (z. B. Anteil am Welt-BIP, an den Weltexporten, an den Militärausgaben) wird jährlich interpoliert und mit einem zentrierten 5-Jahres-Mittel geglättet.",
      "2. Normierung: geteilt durch den höchsten Wert, den eines der acht Länder je erreicht hat (Kriegsjahre ausgenommen), also 0 bis 1.",
      "3. Messgröße = gewichtetes Mittel ihrer Komponenten, erneut auf das historische Maximum normiert.",
      `4. Machtindex = Σ (Gewicht × Messgröße) ÷ Σ Gewichte × 100 über die vorhandenen Messgrößen. Jahre mit weniger als ${ST.minN} Messgrößen bleiben leer.`],
    r: ["USA", "CHN"].map(line),
    s: "Gewichte und Mindestabdeckung lassen sich oberhalb der Grafik ändern.",
  };
}
function measureInfo(m) {
  const yi = D.power.years.length - 1;
  const comps = m.components.map(c => `${D.power.components[c.id].label} (Gewicht ${fmt(c.w * 100, 0)} %)`);
  const top = D.power.countries.map(c => [c.id, D.power.score[m.id][c.id][yi]]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    d: `Messgröße „${MSHORT[m.id]}“ im Machtindex.`,
    f: [`Komponenten: ${comps.join("; ")}.`, "Je Komponente: Anteil des Landes am Weltwert, geglättet (5-Jahres-Mittel) und durch den historischen Höchstwert der acht Länder geteilt. Messgröße = gewichtetes Mittel, erneut auf 0–100 normiert."],
    r: top.length ? `${D.power.years[yi]}: ${top.map(([c, v]) => `${SHORT[c]} ${fmt(100 * v, 0)}`).join(", ")}` : null,
  };
}
function rankOf(obj) {
  const ks = Object.keys(obj).sort((a, b) => obj[b] - obj[a]);
  return Object.fromEntries(ks.map((k, i) => [k, i + 1]));
}
function spearman(a, b) {
  const ks = Object.keys(a).filter(k => b[k] != null);
  const ra = rankOf(Object.fromEntries(ks.map(k => [k, a[k]]))), rb = rankOf(Object.fromEntries(ks.map(k => [k, b[k]])));
  const n = ks.length;
  const d2 = ks.reduce((s, k) => s + (ra[k] - rb[k]) ** 2, 0);
  return { rho: 1 - 6 * d2 / (n * (n * n - 1)), n, ra, rb };
}
function renderGpi() {
  const G = D.curated && D.curated.greatPowers2024;
  if (!G) return;
  const host = document.getElementById("gpi");
  const sh = sheet(host, { title: "Abgleich mit Dalios Great Powers Index 2024", sub: "Nur zum Vergleich, nicht als Eingabe verwendet: Rangfolge des Proxy-Index (Stand 2024, aktuelle Gewichte) gegenüber Dalios Stärkemaß", note: "Dalios Werte: " + G.label + "." });
  const yi = D.power.years.indexOf(2024);
  const ours = {};
  for (const c of Object.keys(G.values)) { const v = composite(c)[yi]; if (v && v.v != null) ours[c] = v.v; }
  const sp = spearman(ours, G.values);
  const rows = Object.keys(G.values).sort((a, b) => G.values[b] - G.values[a]);
  const d2 = Object.keys(sp.ra).reduce((a, c) => a + (sp.ra[c] - sp.rb[c]) ** 2, 0);
  sh.head.querySelector("h3").append(info({ t: "Rangkorrelation nach Spearman",
    d: "Wie gut die Rangfolge des offenen Proxy-Index mit Dalios eigener Rangfolge übereinstimmt: +1 = identisch, 0 = kein Zusammenhang, −1 = umgekehrt.",
    f: "ρ = 1 − 6 × Σ d² ÷ (n × (n² − 1)), d = Rang im Proxy-Index minus Rang bei Dalio, je Land",
    r: `Σ d² = ${fmt(d2, 0)}, n = ${sp.n}: ρ = 1 − 6 × ${fmt(d2, 0)} ÷ (${sp.n} × ${sp.n * sp.n - 1}) = ${fmt(sp.rho, 2)}` }, "Rangkorrelation"));
  const tbl = h("table", { class: "data" },
    h("thead", null, h("tr", null, h("th", { text: "Land" }), h("th", { text: "Proxy-Index 2024" }), h("th", { text: "Rang" }), h("th", { text: "Dalio 2024" }), h("th", { text: "Rang" }))),
    h("tbody", null, ...rows.map(c => h("tr", null,
      h("td", null, h("span", { style: `display:inline-block;width:10px;height:3px;margin-right:6px;vertical-align:middle;background:var(${CC[c]})` }), SHORT[c]),
      h("td", { text: ours[c] == null ? "–" : fmt(ours[c], 0) }), h("td", { text: sp.ra[c] ? String(sp.ra[c]) : "–" }),
      h("td", { text: fmt(G.values[c], 2) }), h("td", { text: String(sp.rb[c]) })))));
  sh.body.append(h("div", { class: "table-wrap", style: "max-height:none" }, stackTable(tbl)),
    h("p", { class: "small", style: "margin-top:8px", text: `Rangkorrelation nach Spearman: ${fmt(sp.rho, 2)} (n = ${sp.n}). ` + (() => {
      const diff = rows.filter(c => sp.ra[c] && Math.abs(sp.ra[c] - sp.rb[c]) >= 2).map(c => `${SHORT[c]} (${sp.ra[c]} statt ${sp.rb[c]})`);
      return diff.length ? `Größere Rangabweichungen: ${diff.join(", ")}. Dalio gewichtet Bildungsqualität und Pro-Kopf-Größen stärker, die offenen Ersatzreihen messen vor allem Mengen.` : "Die Rangfolgen weichen höchstens um einen Platz ab.";
    })() }),
    h("p", { class: "small" }, "Quelle: ", h("a", { href: G.url, target: "_blank", rel: "noopener", text: "economicprinciples.org" })));
}
function renderCompare() {
  const C = D.curated || {};
  const host = document.getElementById("compare");
  const sh = sheet(host, { title: "Modell und Dalios eigene Einordnung", sub: "Die Modellwerte stammen allein aus den offenen Daten dieses Monitors; Dalios Aussagen sind datiert und verlinkt",
    info: { d: "Gegenüberstellung der Modellergebnisse mit datierten Aussagen Ray Dalios.",
      f: ["Schuldenzyklus und innere Ordnung: Stadium aus der regelbasierten Markerprüfung (ein Stadium gilt als erreicht, wenn mindestens die Hälfte seiner Marker erfüllt ist).", "Äußere Ordnung: Konfliktformen mit Status „aktiv“ oder „eskalierend“ aus der kuratierten Liste.", "Gesamtbild: Phase relativ zum Zenit aus der Musteranpassung der acht Machtmessgrößen (siehe Lagebild)."] } });
  const view = (C.dalioView || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = topic => view.find(v => v.topic === topic);
  const wars = C.wars || [];
  const act = wars.filter(w => ["aktiv", "eskalierend"].includes(w.status)).map(w => w.short).join(", ");
  const rows = [
    ["Schuldenzyklus", ST.debtStage ? `Stadium ${ST.debtStage.stage} von 5 (${ST.debtStage.name}); Marker für Stadium ${ST.debtStage.next ? ST.debtStage.next.n : "–"} zu ${ST.debtStage.next && ST.debtStage.next.share != null ? fmt(100 * ST.debtStage.next.share, 0) : "–"} % erfüllt` : "–", latest("Schulden")],
    ["Innere Ordnung", ST.intStage ? `Stadium ${ST.intStage.stage} von 6 (${ST.intStage.name})` : "–", latest("Innere Ordnung")],
    ["Äußere Ordnung", act ? `Aktive Konfliktformen: ${act}` : "–", latest("Äußere Ordnung")],
    ["Gesamtbild", ST.fits && ST.fits.USA ? `USA rund ${Math.abs(ST.fits.USA.best)} Jahre ${ST.fits.USA.best >= 0 ? "nach" : "vor"} dem Zenit des Archetyps, China rund ${Math.abs(ST.fits.CHN.best)} Jahre ${ST.fits.CHN.best >= 0 ? "nach" : "vor"} dem Zenit` : "–", latest("Gesamtbild")],
  ];
  const tbl = h("table", { class: "markers" },
    h("thead", null, h("tr", null, h("th", { text: "Kraft" }), h("th", { text: "Dieser Monitor" }), h("th", { text: "Dalio (jüngste gefundene Aussage)" }))),
    h("tbody", null, ...rows.map(([k, m, d]) => h("tr", null, h("td", null, h("b", { text: k })), h("td", { text: m }),
      h("td", null, d ? h("span", null, h("span", { class: "small", text: d.dateLabel + ": " }), d.text, " ", h("a", { href: d.url, target: "_blank", rel: "noopener", class: "small", text: d.source })) : "–")))));
  sh.body.append(h("div", { style: "overflow-x:auto" }, stackTable(tbl)));
  sh.body.append(h("details", { class: "more", style: "margin-top:10px" }, h("summary", { text: `Alle gesammelten Aussagen Dalios (${view.length})` }),
    h("div", { class: "events" }, ...view.map(e => h("div", { class: "event" }, h("div", { class: "d", text: e.dateLabel }),
      h("div", { class: "t" }, h("div", null, h("span", { class: "force-tag", style: "margin-right:6px", text: e.topic }), e.text), h("a", { href: e.url, target: "_blank", rel: "noopener", text: e.source })))))));
}
function measureSeries(mid) {
  return D.power.countries.map(x => x.id).filter(c => ST.countries.has(c)).map(c => ({
    id: c, label: SHORT[c], color: CC[c], data: D.power.years.map((y, i) => [y, D.power.score[mid][c][i] == null ? null : 100 * D.power.score[mid][c][i]]),
  }));
}
function updatePower() {
  charts.power.update({ series: powerSeries() });
  for (const m of D.power.measures) charts.measures[m.id].update({ series: measureSeries(m.id) });
  renderVerdict();
}
function renderFingerprint() {
  const host = document.getElementById("fingerprint");
  const sh = sheet(host, {
    title: "Reihenfolge der Höhepunkte",
    sub: "Jede Messgröße relativ zu ihrem eigenen Höchststand im Land; schwarze Marke = Jahr des Höchststands",
    note: "Dalios Archetyp erwartet die Höhepunkte von Bildung und Innovation zuerst, die von Finanzzentrum und Reservewährung zuletzt.",
    info: { d: "Zeigt, in welcher Reihenfolge ein Land bei den acht Messgrößen seinen Höhepunkt erreicht hat.",
      f: "Zellwert = Messgröße im Jahr ÷ höchster Wert dieser Messgröße im selben Land (0 bis 1). Dunkel = nahe am eigenen Höchststand; die schwarze Marke steht im Jahr des Höchststands." },
  });
  const sel = h("select", { id: "fp-country", "aria-label": "Land für die Heatmap" }, ...D.power.countries.map(c => h("option", { value: c.id, text: SHORT[c.id] })));
  sel.style.cssText = "font:inherit;font-size:12.5px;padding:3px 8px;border:1px solid var(--rule);border-radius:999px;background:var(--sheet);color:var(--ink)";
  sh.actions.append(sel);
  const hs = new HeatStrip(sh.body, { years: D.power.years, rows: fpRows("USA"), aria: "Heatmap der Messgrößen" });
  sel.addEventListener("change", () => hs.update({ rows: fpRows(sel.value) }));
  sh.body.append(h("div", { class: "heat-legend" }, "niedrig", h("span", { class: "ramp", style: "background:linear-gradient(90deg,var(--q100),var(--q400),var(--q700))" }), "Höchststand des Landes"));
}
function fpRows(c) {
  return D.power.measures.map(m => {
    const arr = D.power.score[m.id][c];
    let mx = 0, py = null;
    arr.forEach((v, i) => { if (v != null && v > mx) { mx = v; py = D.power.years[i]; } });
    return { label: MSHORT[m.id], values: arr.map(v => (v == null || mx === 0 ? null : v / mx)), peak: py };
  });
}
function renderBench() {
  const host = document.getElementById("bench");
  const sh = sheet(host, { title: "Vor 1820: Anteile am Welt-BIP", sub: "Kaufkraftbereinigt, Stützjahre der Maddison-Datenbank; Weltwert aus der Langfristreihe von Our World in Data", src: ["maddison", "owid_longrun_gdp"],
    info: { f: "BIP des Landes zu Kaufkraftparitäten (Maddison) ÷ Welt-BIP zu Kaufkraftparitäten (Our World in Data) × 100, nur für die Jahre, für die Maddison Schätzungen vorlegt." } });
  const B = D.power.outputBenchmarks;
  const yrs = Object.keys(B).map(Number).sort((a, b) => a - b);
  const cs = D.power.countries.map(c => c.id).filter(c => yrs.some(y => B[y][c] != null));
  const mx = Math.max(...yrs.flatMap(y => cs.map(c => B[y][c] || 0)));
  const tbl = h("table", { class: "data" },
    h("thead", null, h("tr", null, h("th", { text: "Land" }), yrs.map(y => h("th", { text: String(y) })))),
    h("tbody", null, cs.map(c => h("tr", null, h("td", null, h("span", { style: `display:inline-block;width:10px;height:3px;margin-right:6px;vertical-align:middle;background:var(${CC[c]})` }), SHORT[c]),
      yrs.map(y => { const v = B[y][c]; return h("td", null, v == null ? "–" : h("span", null, h("span", { style: `display:inline-block;height:6px;width:${Math.max(1, 46 * v / mx)}px;background:var(--q400);border-radius:0 3px 3px 0;margin-right:6px;vertical-align:middle` }), fmt(v, 1) + " %")); })))));
  sh.body.append(h("div", { class: "table-wrap", style: "max-height:none" }, stackTable(tbl)));
  sh.body.append(h("p", { class: "small", style: "margin-top:8px", text: "Die Niederlande stellten auch auf dem Höhepunkt ihrer Macht im 17. Jahrhundert nur rund ein Prozent der Weltwirtschaft. Ihr Gewicht beruhte auf Handel, Finanzplatz und Gulden, für die vor 1820 keine vergleichbaren offenen Reihen vorliegen." }));
}

/* ------------------------------------------------------------------ Lagebild */
function renderArchetype() {
  const host = document.getElementById("archetype");
  const a = MODEL.arch;
  const fits = ["USA", "CHN", "GBR"].map(c => fitPhase(D, c, D.power.years[D.power.years.length - 1], a)).filter(Boolean);
  ST.fits = Object.fromEntries(fits.map(f => [f.c, f]));
  const chart = { render: () => drawArchetype(host, fits) };
  Charts.add(chart);
  new ResizeObserver(() => chart.render()).observe(host);
  const ttl = document.getElementById("arch-title");
  if (ttl && !ttl.querySelector(".info-btn")) ttl.append(info(() => {
    const per = f => Object.entries(f.per).map(([k, v]) => `${MSHORT[k]} ${signed(v.phi, 0)}`).join(", ");
    return { t: "Position im archetypischen Zyklus",
      d: "Schätzt, wie weit ein Land vor oder nach dem Zenit des typischen Auf- und Abstiegs nach Dalio steht.",
      f: ["Archetyp: Jede der acht Messgrößen erreicht ihren Höhepunkt zu einer festen Phase (Bildung −60 Jahre, Innovation −25, Wettbewerbsfähigkeit −20, Wirtschaftsleistung, Handel und Militär 0, Finanzzentrum +5, Reservewährung +65), geformt als Glockenkurve mit 45 Jahren Breite.",
        "Beobachtet wird je Messgröße das Niveau relativ zum bisherigen Höchststand des Landes und die Veränderung über 15 Jahre.",
        "Für jede Phase von −130 bis +150 Jahren: Summe der quadrierten Abweichungen zwischen Beobachtung und Archetyp. Die Phase mit der kleinsten Summe ist die Schätzung; das Band umfasst 80 % der Plausibilität (Gewicht je Phase ∝ e^(−(Abweichung − Minimum) ÷ T), T = 0,02 × Zahl der Messgrößen)."],
      r: fits.map(f => `${SHORT[f.c]}: ${signed(f.best, 0)} Jahre (Band ${signed(f.lo, 0)} bis ${signed(f.hi, 0)}); einzeln: ${per(f)}`) };
  }, "Position im archetypischen Zyklus"));
  const leg = document.getElementById("arch-legend");
  const src = D.curated && D.curated.framework && D.curated.framework.archetypeSource;
  leg.replaceChildren("Ziffern auf der Achse: Höhepunkt der Messgrößen im Archetyp. 1 Bildung · 2 Innovation · 3 Wettbewerbsfähigkeit · 4 Wirtschaftsleistung · 5 Welthandel · 6 Militär · 7 Finanzzentrum · 8 Reservewährung. Lage aus Dalios Archetyp-Grafik abgelesen", src ? h("span", null, " (", h("a", { href: src.url, target: "_blank", rel: "noopener", text: src.label }), ")") : null, "; Glockenform und Breite sind Annahmen dieses Modells.");
}
function drawArchetype(host, fits) {
  const W = Math.round(host.clientWidth);
  if (W < 60) return;
  const H = Math.max(260, Math.min(360, W * 0.5));
  const a = MODEL.arch;
  const p0 = -130, p1 = 150;
  const m = { l: 14, r: 14, t: 26, b: 40 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const X = p => m.l + (p - p0) / (p1 - p0) * pw;
  let peak = 0; for (let p = p0; p <= p1; p++) peak = Math.max(peak, archCurve(p, a));
  const Y = v => m.t + ph - v / peak * ph * 0.92;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Archetypische Zykluskurve mit Positionen von USA, China und Großbritannien" });
  const zones = [["Aufstieg", p0, -20], ["Zenit", -20, 20], ["Abstieg", 20, p1]];
  zones.forEach(([lab, z0, z1], i) => {
    if (i === 1) svg.append(sv("rect", { x: X(z0), y: m.t - 8, width: X(z1) - X(z0), height: ph + 8, fill: cssVar("--hover") }));
    const t = sv("text", { x: (X(z0) + X(z1)) / 2, y: m.t - 12, "text-anchor": "middle", class: "shade-label" }); t.textContent = lab; svg.append(t);
  });
  for (const k of Object.keys(a.offsets)) {
    let d = "";
    for (let p = p0; p <= p1; p += 2) d += (p === p0 ? "M" : "L") + X(p).toFixed(1) + "," + (m.t + ph - archLevel(k, p, a) * ph * 0.92 * 0.55).toFixed(1);
    svg.append(sv("path", { d, fill: "none", stroke: cssVar("--axis"), "stroke-width": 1 }));
  }
  let d = "";
  for (let p = p0; p <= p1; p++) d += (p === p0 ? "M" : "L") + X(p).toFixed(1) + "," + Y(archCurve(p, a)).toFixed(1);
  svg.append(sv("path", { d: d + `L${X(p1)},${m.t + ph}L${X(p0)},${m.t + ph}Z`, fill: cssVar("--ink"), "fill-opacity": 0.05 }));
  svg.append(sv("path", { d, fill: "none", stroke: cssVar("--ink"), "stroke-width": 2.5, "stroke-linecap": "round" }));
  svg.append(sv("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: "baseline" }));
  // Höhepunkte gleicher Lage zusammenfassen (z. B. 4/5/6 am Zenit), damit sich die Ziffern nicht überlagern
  const groups = [];
  Object.entries(a.offsets).forEach(([k, mu], i) => {
    const x = X(mu);
    const g = groups.find(q => Math.abs(q.x - x) < 14);
    if (g) g.ids.push(i + 1); else groups.push({ x, ids: [i + 1] });
  });
  for (const g of groups) {
    svg.append(sv("line", { x1: g.x, x2: g.x, y1: m.t + ph, y2: m.t + ph + 5, stroke: cssVar("--muted") }));
    const t = sv("text", { x: g.x, y: m.t + ph + 16, "text-anchor": "middle", class: "tick", style: `fill:${cssVar("--muted")};font-size:10.5px` });
    t.textContent = g.ids.join("·"); svg.append(t);
  }
  for (const v of [-100, -50, 0, 50, 100, 150]) {
    if (v < p0 || v > p1) continue;
    const t = sv("text", { x: X(v), y: H - 6, "text-anchor": "middle", style: `fill:${cssVar("--muted")};font-size:10.5px` });
    t.textContent = v === 0 ? "Zenit" : (v > 0 ? "+" : "−") + Math.abs(v) + " J.";
    svg.append(t);
  }
  const placed = [];
  for (const f of fits) {
    const col = cssVar(CC[f.c]);
    let bd = "";
    for (let p = f.lo; p <= f.hi; p++) bd += (p === f.lo ? "M" : "L") + X(p).toFixed(1) + "," + Y(archCurve(p, a)).toFixed(1);
    svg.append(sv("path", { d: bd, fill: "none", stroke: col, "stroke-width": 9, "stroke-opacity": 0.28, "stroke-linecap": "round" }));
    const cx = X(f.best), cy = Y(archCurve(f.best, a));
    svg.append(sv("circle", { cx, cy, r: 6, fill: col, stroke: cssVar("--sheet"), "stroke-width": 2.5 }));
    let ly = cy - 16;
    for (const q of placed) if (Math.abs(q.x - cx) < 110 && Math.abs(q.y - ly) < 16) ly = q.y - 16;
    placed.push({ x: cx, y: ly });
    const lab = `${SHORT[f.c]} ${f.best >= 0 ? "+" : "−"}${Math.abs(f.best)} J.`;
    const anchor = cx > W - 120 ? "end" : cx < 90 ? "start" : "middle";
    const t = sv("text", { x: cx, y: ly, "text-anchor": anchor, class: "endlabel", style: `fill:${cssVar("--ink")};font-weight:650` });
    t.textContent = lab; svg.append(t);
  }
  host.replaceChildren(svg);
}

function renderKpis() {
  const L = D.latest;
  const host = document.getElementById("kpis");
  const ni = L.mts_net_interest, ytd = L.mts_ytd, fy = L.fy_gdp_est;
  const items = [];
  const dp = L.debt_public_gdp_now;
  items.push({ label: "US-Schulden in Händen der Öffentlichkeit", value: fmt(dp.value, 1), unit: "% BIP", meta: deShort(dp.date), spark: A("us_debt_public_gdp").filter(p => p[0] >= 1990), color: "--s1",
    info: {
      d: "Schulden des Bundes, die bei Anlegern außerhalb der Bundesregierung liegen (ohne Bestände der Sozialversicherungsfonds), gemessen an der jährlichen Wirtschaftsleistung.",
      f: "Schulden in Händen der Öffentlichkeit (Treasury, „Debt to the Penny“, Tageswert) ÷ nominales BIP des letzten Quartals, auf ein Jahr hochgerechnet, × 100",
      r: L.debt_penny_public ? `${fmt(L.debt_penny_public.value, 2)} Bio. US-$ ÷ ${fmt(L.debt_penny_public.value / (dp.value / 100), 2)} Bio. US-$ × 100 = ${fmt(dp.value, 1)} %` : null,
      s: `Schuldenstand vom ${deShort(dp.date)}, BIP aus ${dp.gdpQuarter ? deQuarter(dp.gdpQuarter) : "dem letzten Quartal"} (FRED GDP). Linie: Jahreswerte seit 1990.`,
    } });
  if (ni && ytd) items.push({ label: `Nettozinsen in % der Bundeseinnahmen, Fiskaljahr ${fy ? fy.fy : ""}`, value: fmt(100 * ni.current / ytd.current.rcpt, 1), unit: "%", meta: `MTS ${deShort(ni.date)}`, spark: A("us_interest_revenue").filter(p => p[0] >= 1990).concat([[fy.fy, 100 * ni.current / ytd.current.rcpt]]), color: "--s1",
    info: {
      d: "Welcher Teil der Steuereinnahmen allein für Zinsen auf die Staatsschuld ausgegeben wird.",
      f: "Nettozinsausgaben des Bundes vom Beginn des Fiskaljahres (1. Oktober) bis zum Stichtag ÷ Bundeseinnahmen im selben Zeitraum × 100 (Monthly Treasury Statement)",
      r: [`${fmt(ni.current, 1)} Mrd. US-$ ÷ ${fmt(ytd.current.rcpt, 1)} Mrd. US-$ × 100 = ${fmt(100 * ni.current / ytd.current.rcpt, 1)} %`,
        ni.prior && ytd.prior ? `Vorjahr: ${fmt(ni.prior, 1)} ÷ ${fmt(ytd.prior.rcpt, 1)} × 100 = ${fmt(100 * ni.prior / ytd.prior.rcpt, 1)} %` : null],
      s: `Stichtag ${deShort(ni.date)}. Nettozinsen = Zinsausgaben minus Zinseinnahmen des Bundes.`,
    } });
  if (ytd && fy) items.push({ label: `Bundesdefizit Fiskaljahr ${fy.fy}`, value: fmt(100 * ytd.current.def / fy.value, 1), unit: "% BIP", meta: `${fmt(ytd.current.def, 0)} Mrd. US-$`, spark: A("us_deficit_gdp").filter(p => p[0] >= 1990).map(([x, y]) => [x, y == null ? null : -y]).concat([[fy.fy, 100 * ytd.current.def / fy.value]]), color: "--s8",
    info: {
      d: "Wie viel mehr der Bund ausgibt als er einnimmt, gemessen an der Wirtschaftsleistung.",
      f: "Ausgaben minus Einnahmen des Bundes vom Beginn des Fiskaljahres bis zum Stichtag ÷ nominales BIP des Fiskaljahres × 100. Das BIP ist das Mittel der bereits vorliegenden Quartale, auf ein Jahr hochgerechnet.",
      r: [`Defizit = ${fmt(ytd.current.outl, 1)} − ${fmt(ytd.current.rcpt, 1)} = ${fmt(ytd.current.def, 1)} Mrd. US-$`, `${fmt(ytd.current.def, 1)} ÷ ${fmt(fy.value, 0)} Mrd. US-$ × 100 = ${fmt(100 * ytd.current.def / fy.value, 1)} %`],
      s: `${fy.quarters} von 4 Quartalen des Fiskaljahres ${fy.fy} liegen vor (FRED GDP).`,
    } });
  // tagesaktuelle Werte des Workers haben Vorrang vor dem wöchentlichen Datensatz, sofern sie jünger sind
  const fresh = (id, base) => {
    const p = lastLive(id);
    if (!p) return base;
    const iso = SIG.isoOf(p.t);
    return !base || !base.date || iso >= base.date ? { ...(base || {}), value: p.v, date: iso, live: true } : base;
  };
  const t10 = fresh("y10_us", L.us10y_d || L.us10y), ffr = fresh("dff", L.dff || L.fedfunds);
  const cpiL = LP("cpi_us_index");
  let cpiCalc = null;
  if (cpiL.length > 13) {
    const a = cpiL[cpiL.length - 1], b = SIG.valueAt(cpiL, a.t - 360);
    const iso = SIG.isoOf(a.t);
    if (b && (!L.cpi_yoy || iso > L.cpi_yoy.date)) { L.cpi_yoy = { ...L.cpi_yoy, value: 100 * (a.v / b.v - 1), date: iso }; cpiCalc = { a, b }; }
  }
  const hi = LP("fed_hi"), lo = LP("fed_lo");
  if (hi.length && lo.length && (!L.fed_target || SIG.isoOf(hi[hi.length - 1].t) >= L.fed_target.date)) {
    const cur = hi[hi.length - 1].v;
    let i = hi.length - 1;
    while (i > 0 && hi[i - 1].v === cur) i--;
    L.fed_target = { ...L.fed_target, lo: lo[lo.length - 1].v, hi: cur, date: SIG.isoOf(hi[hi.length - 1].t),
      last_change: i > 0 ? SIG.isoOf(hi[i].t) : L.fed_target && L.fed_target.last_change, last_change_bp: i > 0 ? Math.round(100 * (cur - hi[i - 1].v)) : L.fed_target && L.fed_target.last_change_bp };
  }
  items.push({ label: "Rendite 10-jähriger Treasuries", value: fmt(t10.value, 2), unit: "%", meta: deShort(t10.date), spark: A("us_10y_m").filter(p => p[0] >= 2000), color: "--s1",
    sparkNote: t10.max_year ? `Hoch ${fmt(t10.max_year, 2)} % (${deShort(t10.max_date)})` : null,
    info: {
      d: "Marktrendite einer zehnjährigen US-Staatsanleihe. Sie ist der Bezugszins für Hypotheken, Unternehmensanleihen und die Bewertung von Aktien.",
      f: "Keine eigene Rechnung: Tageswert der Federal Reserve (FRED DGS10, konstante Laufzeit). „Hoch“ ist der höchste Tageswert des laufenden Kalenderjahres. Linie: Monatsmittel seit 2000.",
      r: `${fmt(t10.value, 2)} % am ${deShort(t10.date)}` + (t10.max_year ? `; Jahreshoch ${fmt(t10.max_year, 2)} % am ${deShort(t10.max_date)}` : ""),
    } });
  items.push({ label: `Inflation (VPI, ${deMonth(L.cpi_yoy.date)})`, value: fmt(L.cpi_yoy.value, 1), unit: "%", meta: `Realzins kurz ${signed(ffr.value - L.cpi_yoy.value, 2)} Pp.`, spark: A("us_cpi_infl").filter(p => p[0] >= 2000), color: "--s2",
    info: {
      d: "Anstieg der Verbraucherpreise in den USA gegenüber dem Vorjahresmonat. Der kurzfristige Realzins zeigt, ob der Leitzins über oder unter der Inflation liegt.",
      f: ["Inflation = Verbraucherpreisindex im Berichtsmonat ÷ Index im Vorjahresmonat − 1, in %", "Realzins kurz = effektiver Leitzins (Federal Funds Effective Rate) − Inflation, in Prozentpunkten"],
      r: [cpiCalc ? `${fmt(cpiCalc.a.v, 3)} ÷ ${fmt(cpiCalc.b.v, 3)} − 1 = ${fmt(L.cpi_yoy.value, 2)} %` : `Inflation ${fmt(L.cpi_yoy.value, 2)} % (${deMonth(L.cpi_yoy.date)})`,
        `${fmt(ffr.value, 2)} % − ${fmt(L.cpi_yoy.value, 2)} % = ${signed(ffr.value - L.cpi_yoy.value, 2)} Pp.`],
      s: cpiCalc ? "Index: CPIAUCSL (saisonbereinigt), tagesaktuell über den Worker." : "Index: CPIAUCNS (nicht saisonbereinigt), wöchentlicher Datensatz.",
    } });
  if (L.fed_target) items.push({ label: "Zielband der Federal Funds Rate", value: `${fmt(L.fed_target.lo, 2)}–${fmt(L.fed_target.hi, 2)}`, unit: "%", meta: L.fed_target.last_change ? `seit ${deShort(L.fed_target.last_change)}, ${signed(L.fed_target.last_change_bp, 0)} Bp.` : "", spark: A("us_fedfunds_m").filter(p => p[0] >= 2000), color: "--s7",
    info: {
      d: "Der Leitzins der US-Notenbank: Banken leihen sich Zentralbankgeld über Nacht zu einem Satz innerhalb dieses Bandes.",
      f: "Unter- und Obergrenze laut Federal Reserve (FRED DFEDTARL, DFEDTARU). Letzte Änderung = jüngster Tag, an dem sich die Obergrenze verschoben hat; 1 Basispunkt (Bp.) = 0,01 Prozentpunkte.",
      r: L.fed_target.last_change ? `Band ${fmt(L.fed_target.lo, 2)}–${fmt(L.fed_target.hi, 2)} % seit ${deShort(L.fed_target.last_change)}, Änderung ${signed(L.fed_target.last_change_bp, 0)} Bp.` : null,
    } });
  const G = D.curated && D.curated.values && D.curated.values.gold;
  const gl = LP("gold_usd");
  const glast = gl.length ? gl[gl.length - 1] : null;
  if (glast && (!G || SIG.isoOf(glast.t) > G.lbmaDate)) {
    const top = gl.reduce((m, q) => (q.v > m.v ? q : m), gl[0]);
    const ath = G && G.athLbmaPm > top.v ? { v: G.athLbmaPm, iso: G.athDate } : { v: top.v, iso: SIG.isoOf(top.t) };
    items.push({ label: "Goldpreis", value: fmt(glast.v, 0), unit: "US-$/oz", meta: deShort(SIG.isoOf(glast.t)), spark: A("gold_usd").filter(p => p[0] >= 2000).concat(gl.filter(q => q.x > (lastPt(A("gold_usd")) || [0])[0]).map(q => [q.x, q.v])), color: "--s4", sparkNote: `Höchststand ${fmt(ath.v, 0)} (${deShort(ath.iso)})`,
      info: {
        d: "Preis einer Feinunze Gold (31,1 Gramm) in US-Dollar.",
        f: ["Die polnische Notenbank veröffentlicht täglich einen Goldpreis in Złoty je Gramm und den Dollarkurs in Złoty.", "Goldpreis in US-$ = Złoty je Gramm × 31,1035 Gramm je Unze ÷ Złoty je US-Dollar", "Höchststand = höchster Tageswert der Reihe; Linie: Jahresmittel seit 2000, danach Tageswerte."],
        r: `${fmt(glast.v, 2)} US-$ am ${deShort(SIG.isoOf(glast.t))}; Höchststand ${fmt(ath.v, 0)} US-$ am ${deShort(ath.iso)}`,
        s: "Kann um wenige Dollar vom Londoner LBMA-Fixing abweichen.",
      } });
  } else if (G) items.push({ label: "Goldpreis (LBMA, Nachmittag)", value: fmt(G.lbmaPm, 0), unit: "US-$/oz", meta: deShort(G.lbmaDate), spark: A("gold_usd").filter(p => p[0] >= 2000), color: "--s4", sparkNote: `Rekord ${fmt(G.athLbmaPm, 0)} (${deShort(G.athDate)})`,
    info: { d: "Londoner Nachmittags-Fixing für eine Feinunze Gold.", f: "Keine eigene Rechnung: Wert aus der kuratierten Liste mit Quellenangabe.", s: G.lbmaSource } });
  else items.push({ label: "Goldpreis, Monatsmittel", value: fmt(L.gold_m.value, 0), unit: "US-$/oz", meta: deMonth(L.gold_m.date), spark: A("gold_usd").filter(p => p[0] >= 2000), color: "--s4",
    info: { f: "Mittel der Tagespreise eines Monats (Weltbank)." } });
  const usd = D.power.coferLatest && D.power.coferLatest.CI_USD;
  if (usd != null) items.push({ label: "US-Dollar-Anteil an den Devisenreserven", value: fmt(usd, 1), unit: "%", meta: D.power.coferLatestQuarter.replace("-", " "), spark: D.power.years.map((y, i) => [y, D.power.components.cofer.share.USA[i]]).filter(p => p[0] >= 1995), color: "--s1",
    info: {
      d: "Wie viel der Währungsreserven aller Zentralbanken in US-Dollar gehalten wird; Maß für die Rolle als Reservewährung.",
      f: "Dollarreserven der Zentralbanken ÷ alle Reserven mit gemeldeter Währung × 100 (IWF COFER, Quartalswerte)",
      r: `${fmt(usd, 2)} % (${D.power.coferLatestQuarter.replace("-", " ")})`,
    } });
  items.push({ label: "US-Zolleinnahmen in % der Warenimporte", value: fmt(L.tariff_eff_q.value, 1), unit: "%", meta: deQuarter(L.tariff_eff_q.date), spark: A("us_tariff_eff"), color: "--s2",
    info: {
      d: "Effektiver Zollsatz: welcher Anteil des Importwerts tatsächlich als Zoll bezahlt wird.",
      f: "Zolleinnahmen des Bundes ÷ Warenimporte × 100; beides aus der US-Volkswirtschaftlichen Gesamtrechnung (NIPA), Quartalswerte auf ein Jahr hochgerechnet (FRED B235RC1Q027SBEA, A255RC1Q027SBEA)",
      r: `${fmt(L.tariff_eff_q.value, 2)} % im ${deQuarter(L.tariff_eff_q.date)}`,
      s: "Linie: Jahreswerte seit 1929.",
    } });
  items.push({ label: "Vermögensanteil des obersten 1 % (USA)", value: fmt(L.top1_wealth.value, 1), unit: "%", meta: deQuarter(L.top1_wealth.date), spark: A("us_top1_wealth_dfa"), color: "--s7",
    info: {
      d: "Anteil des reichsten Prozents der Haushalte am gesamten Nettovermögen der privaten Haushalte.",
      f: "Nettovermögen des obersten 1 % ÷ Nettovermögen aller Haushalte × 100 (Federal Reserve, Distributional Financial Accounts, FRED WFRBST01134)",
      r: `${fmt(L.top1_wealth.value, 1)} % im ${deQuarter(L.top1_wealth.date)}`,
    } });
  const gs = D.series.gpr_daily, gd = A("gpr_daily");
  const gpr = lastPt(A("gpr_hist_m"));
  if (gd.length) {
    // 7-Tage-Mittel; Datum des letzten Tageswerts aus Start und Länge der Reihe
    const sm = smoothDaily(gd, 7).filter(p => p[1] != null);
    const iso = new Date(Date.parse(gs.start + "T00:00:00Z") + (gs.values.length - 1) * 864e5).toISOString().slice(0, 10);
    const last7 = gd.slice(-7).map(p => p[1]).filter(v => v != null);
    items.push({ label: "Geopolitischer Risikoindex (7-Tage-Mittel)", value: fmt(lastPt(sm)[1], 0), unit: "", meta: deShort(iso),
      spark: sm.filter((p, i, a) => p[0] >= a[a.length - 1][0] - 2 && (i % 7 === 0 || i === a.length - 1)), color: "--s8", sparkNote: "1985–2019 = 100",
      info: {
        d: "Wie häufig große Zeitungen über Kriegsgefahr, militärische Spannungen und Terror berichten (Caldara und Iacoviello).",
        f: ["Tageswert: Anteil der Artikel in zehn großen Zeitungen mit Begriffen zu geopolitischen Risiken, normiert auf das Mittel 1985–2019 = 100.", "Angezeigt: Mittel der letzten sieben Tageswerte; Linie: zwei Jahre, wöchentliche Punkte."],
        r: `(${last7.map(v => fmt(v, 0)).join(" + ")}) ÷ ${last7.length} = ${fmt(last7.reduce((a, b) => a + b, 0) / last7.length, 0)}`,
        s: `Letzter Tageswert vom ${deShort(iso)}; die Reihe wird wöchentlich übernommen.`,
      } });
  } else if (gpr) items.push({ label: "Geopolitischer Risikoindex (historisch)", value: fmt(gpr[1], 0), unit: "", meta: fmtYearFrac(gpr[0], "M"), spark: A("gpr_hist").filter(p => p[0] >= 1990), color: "--s8",
    info: { f: "Monatswert des historischen Index von Caldara und Iacoviello (1985–2019 = 100)." } });
  host.replaceChildren(...items.map(it => h("div", { class: "kpi" },
    h("div", { class: "label" }, it.label, it.info ? info(withTitle(it.info, it.label), it.label) : null),
    h("div", { class: "value" }, it.value, it.unit ? h("small", { text: it.unit }) : null),
    it.spark ? sparkline(it.spark, it.color) : h("div", { style: "height:28px" }),
    h("div", { class: "meta" }, h("span", { text: it.meta }), it.sparkNote ? h("span", { text: it.sparkNote }) : null))));
}

function renderVerdict() {
  const comp = c => compositeSeries(D, c, weightsArr(), 3);
  const us = comp("USA"), cn = comp("CHN");
  const lu = lastPt(us.map(p => [p.y, p.v])), lc = lastPt(cn.map(p => [p.y, p.v]));
  const pu = maxPt(us.map(p => [p.y, p.v]));
  const gap2000 = valAt(us.map(p => [p.y, p.v]), 2000) - valAt(cn.map(p => [p.y, p.v]), 2000);
  const L = D.latest;
  const fu = ST.fits && ST.fits.USA, fc = ST.fits && ST.fits.CHN;
  const el = document.getElementById("verdict");
  const debtSt = ST.debtStage, intSt = ST.intStage;
  el.replaceChildren(...[
    "Der Machtindex der USA liegt 2026 bei ", h("b", { text: fmt(lu[1], 0) }), ` Punkten (Höchststand ${fmt(pu[1], 0)} im Jahr ${pu[0]}), der Chinas bei `, h("b", { text: fmt(lc[1], 0) }),
    `. Der Abstand ist seit 2000 von ${fmt(gap2000, 0)} auf ${fmt(lu[1] - lc[1], 0)} Punkte geschrumpft. `,
    "Die US-Schulden in Händen der Öffentlichkeit entsprechen ", h("b", { text: fmt(L.debt_public_gdp_now.value, 0) + " % des BIP" }),
    L.mts_net_interest ? `, die Nettozinsen binden ${fmt(100 * L.mts_net_interest.current / L.mts_ytd.current.rcpt, 1)} % der Bundeseinnahmen. ` : ". ",
    L.us10y_d && L.us10y_d.max_higher_last ? `Die Rendite zehnjähriger Treasuries stieg am ${deDate(L.us10y_d.max_date)} auf ${fmt(L.us10y_d.max_year, 2)} %, den höchsten Stand seit ${deMonth(L.us10y_d.max_higher_last)}. ` : null,
    debtSt ? h("span", null, "Die Indikatoren verorten den Schuldenzyklus in ", h("b", { text: `Stadium ${debtSt.stage}` }), ` (${debtSt.name}) und die innere Ordnung in `, h("b", { text: `Stadium ${intSt.stage}` }), ` (${intSt.name}). `) : null,
    fu && fc ? `Das Muster der Messgrößen legt für die USA eine Position etwa ${Math.abs(fu.best)} Jahre ${fu.best >= 0 ? "nach" : "vor"} dem Zenit nahe, für China etwa ${Math.abs(fc.best)} Jahre ${fc.best >= 0 ? "nach" : "vor"} dem Zenit.` : ""
  ].filter(x => x != null && x !== ""));
  if (typeof verdictLive === "function") verdictLive(el);
  el.append(info({ t: "So entsteht der Lagetext",
    d: "Der Text wird bei jedem Aufruf automatisch aus den aktuellen Kennzahlen zusammengesetzt; es gibt keine redaktionelle Wertung.",
    f: ["Machtindex: gewichtetes Mittel der acht Messgrößen (siehe Machtindex), Abstand USA minus China.",
      "Schulden und Zinsen: Treasury-Daten (Schulden in Händen der Öffentlichkeit ÷ BIP; Nettozinsen ÷ Einnahmen).",
      "Stadien: regelbasierte Markerprüfung im Schuldenzyklus und in der inneren Ordnung.",
      "Phase: Musteranpassung an den Archetyp (siehe Grafik im Lagebild).",
      "Anlagebarometer: die drei am höchsten und die drei am niedrigsten eingestuften Anlagen mit Stufe über bzw. unter üblich (Ertrag gegenüber dem Durchschnitt der Anlage, nicht die Richtung der Kurse)."],
    r: [`Machtindex USA ${fmt(lu[1], 1)}, China ${fmt(lc[1], 1)}, Abstand ${fmt(lu[1] - lc[1], 1)} (2000: ${fmt(gap2000, 1)})`,
      L.mts_net_interest ? `Zinsen ÷ Einnahmen = ${fmt(L.mts_net_interest.current, 1)} ÷ ${fmt(L.mts_ytd.current.rcpt, 1)} × 100 = ${fmt(100 * L.mts_net_interest.current / L.mts_ytd.current.rcpt, 1)} %` : null] }, "Lagetext"));
}
