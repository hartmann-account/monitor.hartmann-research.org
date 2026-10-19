"use strict";
/* Big-Cycle-Monitor: Demografie und Technologie (Rahmen: Pictet Research Institute, "Demographics and Technology", 2025) */

const DEMO = [
  { iso: "USA", r: "US", name: "USA" }, { iso: "CHN", r: "CN", name: "China" }, { iso: "EUU", r: null, name: "Europäische Union" },
  { iso: "DEU", r: "DE", name: "Deutschland" }, { iso: "JPN", r: "JP", name: "Japan" }, { iso: "GBR", r: "GB", name: "Großbritannien" },
  { iso: "IND", r: "IN", name: "Indien" }, { iso: "RUS", r: "RU", name: "Russland" }, { iso: "CHE", r: "CH", name: "Schweiz" },
];
function annualAt(id, year) { const p = LP(id).find(q => Math.round(q.x) === year); return p ? p.v : null; }
function lastAnnual(id, maxYear = 2100) { const p = LP(id).filter(q => q.x <= maxYear); return p.length ? p[p.length - 1] : null; }
function cagr(a, b, n) { return a != null && b != null && a > 0 && b > 0 ? Math.pow(b / a, 1 / n) - 1 : null; }
const CUR_YEAR = 2024;

function renderDemography() {
  const host = document.getElementById("demo-table");
  const have = DEMO.filter(c => LP("pop_" + c.iso.toLowerCase()).length);
  if (!have.length) { host.replaceChildren(h("p", { class: "small", text: "Die Bevölkerungsdaten werden vom Worker wöchentlich geladen und erscheinen nach dem ersten Abruf." })); renderTechFrame(); return; }
  const k = (p, c) => p + c.iso.toLowerCase();
  const rows = have.map(c => {
    const pop24 = annualAt(k("pop_", c), CUR_YEAR), pop50 = annualAt(k("pop_", c), 2050);
    return {
      c, popChg: pop24 && pop50 ? 100 * (pop50 / pop24 - 1) : null,
      dep24: annualAt(k("dep_", c), CUR_YEAR), dep50: annualAt(k("dep_", c), 2050),
      wa24: annualAt(k("wa_", c), CUR_YEAR), wa50: annualAt(k("wa_", c), 2050),
      le: lastAnnual(k("le_", c), CUR_YEAR), tfr: lastAnnual(k("tfr_", c), CUR_YEAR),
    };
  });
  const maxDep = Math.max(...rows.map(r => r.dep50 || 0));
  const bar = (v, mx) => h("span", { class: "barcell" }, h("i", { style: `width:${Math.max(1, 46 * (v || 0) / mx)}px` }), fmt(v, 1) + " %");
  const sh = sheet(host, {
    title: "Demografische Kennzahlen der großen Volkswirtschaften",
    sub: "Aufbau wie Tabelle 1 der Pictet-Studie: Bevölkerungsveränderung 2024–2050, Altersquotient (65-Jährige und Ältere je 100 Personen von 15 bis 64 Jahren), Anteil der Bevölkerung im erwerbsfähigen Alter; Projektionen nach der mittleren Variante",
    src: ["live:wb", "live:pictet"],
    note: "Die Projektionen setzen die bisherige Zuwanderung fort. Restriktivere Einwanderungspolitik würde vor allem die Werte der USA, Großbritanniens und der Schweiz verschlechtern.",
  });
  sh.body.append(h("div", { style: "overflow-x:auto" }, stackTable(h("table", { class: "data demo-table" },
    h("thead", null, h("tr", null, h("th", { text: "Land" }),
      thInfo("Bevölkerung 2024–2050", { t: "Bevölkerungsveränderung 2024–2050", f: "Bevölkerung 2050 (Projektion, mittlere Variante) ÷ Bevölkerung 2024 − 1, in %", r: rows.slice(0, 3).map(r => { const a = annualAt("pop_" + r.c.iso.toLowerCase(), CUR_YEAR), b = annualAt("pop_" + r.c.iso.toLowerCase(), 2050); return a && b ? `${r.c.name}: ${fmt(b / 1e6, 1)} Mio. ÷ ${fmt(a / 1e6, 1)} Mio. − 1 = ${signed(r.popChg, 1)} %` : null; }) }),
      thInfo("Altersquotient 2024", { t: "Altersquotient", f: "Personen ab 65 Jahren ÷ Personen von 15 bis 64 Jahren × 100. 40 % heißt: auf 100 Menschen im Erwerbsalter kommen 40 Ältere." }),
      thInfo("Altersquotient 2050", { t: "Altersquotient 2050", f: "Wie 2024, aus der Bevölkerungsprojektion der Weltbank (mittlere Variante)." }),
      thInfo("Erwerbsalter 2024", { t: "Anteil im Erwerbsalter", f: "Personen von 15 bis 64 Jahren ÷ Gesamtbevölkerung × 100." }),
      thInfo("Erwerbsalter 2050", { t: "Anteil im Erwerbsalter 2050", f: "Wie 2024, aus der Projektion." }),
      thInfo("Lebenserwartung", { t: "Lebenserwartung", f: "Lebenserwartung bei Geburt in Jahren, jüngster verfügbarer Wert (Weltbank); Jahr in Klammern." }),
      thInfo("Geburten je Frau", { t: "Geburten je Frau", f: "Zusammengefasste Geburtenziffer: Kinder je Frau bei den Geburtenraten des Jahres. Rund 2,1 halten die Bevölkerung ohne Zuwanderung stabil." }))),
    h("tbody", null, ...rows.map(r => h("tr", null,
      h("td", null, r.c.r ? h("span", { style: `display:inline-block;width:10px;height:3px;margin-right:6px;vertical-align:middle;background:var(${LC[r.c.r]})` }) : null, r.c.name),
      h("td", { text: r.popChg == null ? "–" : signed(r.popChg, 1) + " %" }),
      h("td", { text: r.dep24 == null ? "–" : fmt(r.dep24, 1) + " %" }),
      h("td", null, r.dep50 == null ? "–" : bar(r.dep50, maxDep)),
      h("td", { text: r.wa24 == null ? "–" : fmt(r.wa24, 1) + " %" }),
      h("td", { text: r.wa50 == null ? "–" : fmt(r.wa50, 1) + " %" }),
      h("td", { text: r.le ? `${fmt(r.le.v, 1)} J. (${Math.round(r.le.x)})` : "–" }),
      h("td", { text: r.tfr ? `${fmt(r.tfr.v, 2)} (${Math.round(r.tfr.x)})` : "–" }))))))));

  const ch = document.getElementById("demo-charts");
  const lines = DEMO.filter(c => c.r && LP("dep_" + c.iso.toLowerCase()).length);
  const split = (id, c) => {
    const d = LS(id);
    return [
      { id: c.iso, label: c.name, color: LC[c.r], data: d.filter(p => p[0] <= CUR_YEAR) },
      { id: c.iso + "_p", group: c.iso, label: c.name + " (Projektion)", color: LC[c.r], dash: "4 4", data: d.filter(p => p[0] >= CUR_YEAR), noLegend: true, endLabel: true, short: c.name },
    ];
  };
  if (lines.length) chartSheet(ch, { title: "Altersquotient 1960–2050", sub: "65-Jährige und Ältere je 100 Personen im Alter von 15 bis 64 Jahren; gestrichelt: Projektion", src: ["live:wb"],
      info: { f: "Personen ab 65 Jahren ÷ Personen von 15 bis 64 Jahren × 100 (Weltbank); ab 2025 Projektion der Weltbank-Bevölkerungsstatistik (mittlere Variante)." } },
    { series: lines.flatMap(c => split("dep_" + c.iso.toLowerCase(), c)).map(s => s.id.endsWith("_p") ? s : { ...s, endLabel: false }), height: 300, zero: true, vlines: [{ x: CUR_YEAR, label: String(CUR_YEAR) }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  const wa = DEMO.filter(c => c.r && LP("wa_" + c.iso.toLowerCase()).length && LP("pop_" + c.iso.toLowerCase()).length).map(c => {
    const pop = LP("pop_" + c.iso.toLowerCase()), share = LP("wa_" + c.iso.toLowerCase());
    const abs = share.map(q => { const p = pop.find(x => Math.round(x.x) === Math.round(q.x)); return p ? [q.x, q.v / 100 * p.v] : null; }).filter(Boolean);
    const base = abs.find(p => Math.round(p[0]) === CUR_YEAR);
    return base ? { id: c.iso, label: c.name, color: LC[c.r], data: abs.filter(p => p[0] >= 1990).map(([x, v]) => [x, 100 * v / base[1]]) } : null;
  }).filter(Boolean);
  if (wa.length) chartSheet(ch, { title: "Bevölkerung im erwerbsfähigen Alter", sub: "Personen von 15 bis 64 Jahren, Index 2024 = 100; ab 2025 Projektion", src: ["live:wb"],
      info: () => ({ f: ["Erwerbsbevölkerung = Gesamtbevölkerung × Anteil der 15- bis 64-Jährigen.", "Index = Erwerbsbevölkerung im Jahr ÷ Erwerbsbevölkerung 2024 × 100."],
        r: wa.map(sr => { const p = sr.data.find(q => Math.round(q[0]) === 2050); return p ? `${sr.label} 2050: ${fmt(p[1], 0)}` : null; }) }) },
    { series: wa, height: 300, refs: [{ y: 100 }], vlines: [{ x: CUR_YEAR, label: "Projektion" }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) });
  renderGrowthBalance();
  renderTech();
  renderTechFrame();
}

/* Wachstumsbilanz 2025–2050: demografische Komponenten gegen das Produktivitätswachstum der letzten zehn Jahre (wie Pictet, Abb. 15) */
function renderGrowthBalance() {
  const host = document.getElementById("growth-balance");
  const rows = DEMO.map(c => {
    const k = p => p + c.iso.toLowerCase();
    const pg = cagr(annualAt(k("pop_"), 2025), annualAt(k("pop_"), 2050), 25);
    const wg = cagr(annualAt(k("wa_"), 2025), annualAt(k("wa_"), 2050), 25);
    const pr = LP(k("prod_"));
    const last = pr.length ? pr[pr.length - 1] : null;
    const prev = last ? pr.find(q => Math.round(q.x) === Math.round(last.x) - 10) : null;
    const prod = last && prev ? cagr(prev.v, last.v, 10) : null;
    if (pg == null || wg == null) return null;
    return { c, pg: 100 * pg, wg: 100 * wg, prod: prod == null ? null : 100 * prod, prodYears: last && prev ? `${Math.round(prev.x)}–${Math.round(last.x)}` : null };
  }).filter(Boolean);
  if (!rows.length) return;
  rows.forEach(r => { r.demo = r.pg + r.wg; r.total = r.prod == null ? null : r.demo + r.prod; });
  rows.sort((a, b) => (b.total ?? b.demo) - (a.total ?? a.demo));
  const sh = sheet(host, {
    title: "Wachstumsbilanz 2025–2050: Demografie gegen Produktivität",
    sub: "Jährliche Wachstumsbeiträge in Prozent: Bevölkerung und Anteil der Erwerbsfähigen (Projektion 2025–2050) sowie Produktivität (BIP je Erwerbstätigem, Wachstum der letzten zehn Jahre). Punkt = Summe, also das BIP-Wachstum bei gleichbleibender Produktivitätsdynamik, Erwerbsquote und Arbeitszeit",
    src: ["live:wb", "live:pictet"],
    note: "Nachbildung der Abbildung 15 der Pictet-Studie mit offenen Daten; Pictet verwendet die Produktivität je Arbeitsstunde (The Conference Board), hier steht das BIP je Erwerbstätigem (Weltbank/ILO).",
    info: () => ({ d: "Wie stark Demografie das Wirtschaftswachstum bis 2050 bremst oder stützt, und ob die Produktivität das ausgleichen kann.",
      f: ["Jährliche Wachstumsrate (CAGR) = (Endwert ÷ Anfangswert)^(1 ÷ Jahre) − 1.", "Bevölkerung: CAGR der Bevölkerung 2025–2050. Anteil im Erwerbsalter: CAGR des Anteils der 15- bis 64-Jährigen 2025–2050. Beide zusammen ≈ Wachstum der Erwerbsbevölkerung.",
        "Produktivität: CAGR des BIP je Erwerbstätigem über die letzten zehn verfügbaren Jahre.", "Summe = Bevölkerung + Erwerbsanteil + Produktivität ≈ BIP-Wachstum pro Jahr, wenn die Produktivität so weiterwächst wie bisher."],
      r: rows.slice(0, 4).map(r => `${r.c.name}: ${signed(r.pg, 2)} ${r.wg < 0 ? "−" : "+"} ${fmt(Math.abs(r.wg), 2)}${r.prod == null ? "" : ` ${r.prod < 0 ? "−" : "+"} ${fmt(Math.abs(r.prod), 2)}`} = ${signed(r.total ?? r.demo, 2)} % p. a.`) }),
  });
  const comps = [["pg", "Bevölkerung", "--s1"], ["wg", "Anteil im Erwerbsalter", "--s2"], ["prod", "Produktivität (10 J.)", "--s3"]];
  const wrap = h("div", { class: "chart" });
  sh.body.append(wrap);
  const legend = h("div", { class: "legend" }, ...comps.map(([, l, c]) => h("span", { class: "small", style: "display:inline-flex;align-items:center;gap:6px;padding:3px 7px" }, h("span", { style: `width:12px;height:10px;border-radius:2px;background:var(${c})` }), l)),
    h("span", { class: "small", style: "display:inline-flex;align-items:center;gap:6px;padding:3px 7px" }, h("span", { style: "width:9px;height:9px;border-radius:50%;background:var(--ink)" }), "Summe"));
  const draw = () => {
    const W = Math.round(wrap.clientWidth);
    if (W < 60) return;
    const rowH = 46, labW = Math.min(150, Math.max(...rows.map(r => textW(r.c.name, 12, 560))) + 16), m = { t: 8, b: 26, r: 46 };
    const H = m.t + rows.length * rowH + m.b;
    const vals = rows.flatMap(r => [r.pg, r.wg, r.prod, r.total].filter(v => v != null));
    let [lo, hi] = niceDomain(Math.min(0, ...vals), Math.max(0, ...vals), 6, true);
    const X = v => labW + (v - lo) / (hi - lo) * (W - labW - m.r);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Wachstumsbilanz je Land" });
    const g = sv("g", { class: "grid" });
    for (const t of linTicks(lo, hi, 6)) {
      g.append(sv("line", { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b }));
      const tx = sv("text", { x: X(t), y: H - 8, "text-anchor": "middle", class: "tick", style: `fill:${cssVar("--muted")};font-size:11px` }); tx.textContent = fmt(t, 1); svg.append(tx);
    }
    svg.append(g);
    svg.append(sv("line", { x1: X(0), x2: X(0), y1: m.t, y2: H - m.b, class: "baseline" }));
    rows.forEach((r, i) => {
      const y = m.t + i * rowH;
      const t = sv("text", { x: 0, y: y + rowH / 2 + 4, class: "endlabel" }); t.textContent = r.c.name; svg.append(t);
      comps.forEach(([key, , col], j) => {
        const v = r[key]; if (v == null) return;
        const by = y + 7 + j * 11;
        const x0 = X(Math.min(0, v)), x1 = X(Math.max(0, v));
        svg.append(sv("rect", { x: x0, y: by, width: Math.max(1, x1 - x0), height: 9, rx: 2, fill: cssVar(col) }));
      });
      if (r.total != null) {
        svg.append(sv("circle", { cx: X(r.total), cy: y + rowH / 2 - 1, r: 5, fill: cssVar("--ink"), stroke: cssVar("--sheet"), "stroke-width": 2 }));
        const lt = sv("text", { x: Math.min(W - 4, X(Math.max(r.total, r.pg, r.wg, r.prod ?? -99)) + 10), y: y + rowH / 2 + 3, class: "endlabel-val", style: "font-weight:650" });
        lt.textContent = signed(r.total, 1); svg.append(lt);
      }
      const ov = sv("rect", { x: 0, y, width: W, height: rowH, fill: "transparent" });
      const tt = sv("title"); tt.textContent = `${r.c.name}: Bevölkerung ${signed(r.pg, 2)} %, Erwerbsanteil ${signed(r.wg, 2)} %, Produktivität ${r.prod == null ? "–" : signed(r.prod, 2) + " % (" + r.prodYears + ")"}; Summe ${r.total == null ? "–" : signed(r.total, 2) + " %"} p. a.`;
      ov.append(tt); svg.append(ov);
    });
    wrap.replaceChildren(svg, legend);
  };
  Charts.add({ render: draw });
  new ResizeObserver(draw).observe(wrap);
  const tblBtn = h("button", { class: "btn-ghost", type: "button", "aria-pressed": "false", text: "Tabelle" });
  const tbl = h("div", { class: "table-wrap", hidden: true }, h("table", { class: "data" },
    h("thead", null, h("tr", null, h("th", { text: "Land" }), h("th", { text: "Bevölkerung" }), h("th", { text: "Erwerbsanteil" }), h("th", { text: "Produktivität" }), h("th", { text: "Summe" }))),
    h("tbody", null, ...rows.map(r => h("tr", null, h("td", { text: r.c.name }), h("td", { text: signed(r.pg, 2) + " %" }), h("td", { text: signed(r.wg, 2) + " %" }), h("td", { text: r.prod == null ? "–" : `${signed(r.prod, 2)} % (${r.prodYears})` }), h("td", { text: r.total == null ? "–" : signed(r.total, 2) + " %" }))))));
  tblBtn.addEventListener("click", () => { tbl.hidden = !tbl.hidden; tblBtn.setAttribute("aria-pressed", String(!tbl.hidden)); });
  sh.actions.append(tblBtn);
  sh.body.append(tbl);
  const worst = rows.filter(r => r.total != null).sort((a, b) => a.total - b.total)[0];
  const demoWorst = rows.slice().sort((a, b) => a.demo - b.demo)[0];
  sh.body.append(h("p", { class: "small", style: "margin-top:6px", text: `Den stärksten demografischen Gegenwind hat ${demoWorst.c.name} (${signed(demoWorst.demo, 2)} % pro Jahr aus Bevölkerung und Erwerbsanteil). ${worst ? `Rechnet man das Produktivitätswachstum der letzten zehn Jahre fort, bleibt ${worst.c.name} mit ${signed(worst.total, 2)} % pro Jahr am schwächsten.` : ""} Ob Automatisierung und KI die Lücke schließen, entscheidet nach Pictet über Stagnation oder weiteres Wachstum.` }));
}

const TECH = [
  ["rd_", "F&E-Ausgaben", "% des BIP", 2],
  ["res_", "Forschende", "je Mio. Einwohner", 0],
  ["htx_", "Hightech-Exporte", "% der Industriegüterexporte", 1],
  ["net_", "Internetnutzung", "% der Bevölkerung", 0],
];
function renderTech() {
  const host = document.getElementById("tech-charts");
  const cs = DEMO.filter(c => TECH.some(([p]) => LP(p + c.iso.toLowerCase()).length));
  if (!cs.length) return;
  const sh = sheet(host, { title: "Technologie-Infrastruktur", sub: "Voraussetzung, damit Automatisierung und KI Produktivität schaffen (dritte Bedingung der Pictet-Studie); jüngster verfügbarer Wert je Land", src: ["live:wb"], cls: "span-2",
    info: { f: ["F&E-Ausgaben in % des BIP, Forschende je Million Einwohner, Hightech-Exporte in % der Industriegüterexporte, Internetnutzung in % der Bevölkerung: Weltbank-Indikatoren ohne eigene Umrechnung, jüngstes verfügbares Jahr in Klammern.", "Patente je Million Einwohner = Patentanmeldungen von Inländern ÷ Bevölkerung × 1.000.000.", "Balken: Wert ÷ höchster Wert der Spalte."] } });
  const maxOf = p => Math.max(...cs.map(c => { const l = lastAnnual(p + c.iso.toLowerCase()); return l ? l.v : 0; }));
  const mx = Object.fromEntries(TECH.map(([p]) => [p, maxOf(p)]));
  const pat = c => { const a = lastAnnual("pat_" + c.iso.toLowerCase()); if (!a) return null; const pop = LP("pop_" + c.iso.toLowerCase()).find(q => Math.round(q.x) === Math.round(a.x)); return pop ? { v: 1e6 * a.v / pop.v, x: a.x } : null; };
  const patMax = Math.max(...cs.map(c => (pat(c) || { v: 0 }).v));
  const cell = (l, max, d) => l ? h("td", null, h("span", { class: "barcell" }, h("i", { style: `width:${Math.max(1, 46 * l.v / max)}px` }), `${fmt(l.v, d)} `, h("span", { class: "small", text: `(${Math.round(l.x)})` }))) : h("td", { text: "–" });
  sh.body.append(h("div", { style: "overflow-x:auto" }, stackTable(h("table", { class: "data demo-table" },
    h("thead", null, h("tr", null, h("th", { text: "Land" }), ...TECH.map(([, l, u]) => h("th", null, l, h("div", { class: "th-unit", text: u }))),
      h("th", null, h("span", { class: "th-i" }, "Patente", info({ t: "Patente je Million Einwohner", f: "Patentanmeldungen von Inländern im Jahr ÷ Bevölkerung desselben Jahres × 1.000.000 (Weltbank)." }, "Patente")), h("div", { class: "th-unit", text: "Anmeldungen je Mio. Einw." })))),
    h("tbody", null, ...cs.map(c => h("tr", null, h("td", { text: c.name }), ...TECH.map(([p, , , d]) => cell(lastAnnual(p + c.iso.toLowerCase()), mx[p], d)), cell(pat(c), patMax, 0))))))));
  const rd = DEMO.filter(c => c.r && LP("rd_" + c.iso.toLowerCase()).length);
  if (rd.length) chartSheet(host, { title: "Ausgaben für Forschung und Entwicklung", sub: "% des BIP", src: ["live:wb"],
      info: { f: "Keine eigene Rechnung: Bruttoinlandsausgaben für Forschung und Entwicklung ÷ BIP × 100 (Weltbank, UNESCO-Daten)." } },
    { series: rd.map(c => ({ id: c.iso, label: c.name, color: LC[c.r], data: LS("rd_" + c.iso.toLowerCase()).filter(p => p[0] >= 1996) })), height: 260, zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) + " %" });
  const pr = DEMO.filter(c => c.r && LP("prod_" + c.iso.toLowerCase()).length);
  if (pr.length) chartSheet(host, { title: "Produktivität: BIP je Erwerbstätigem", sub: "Index 2000 = 100, konstante Kaufkraftparitäten (ILO-Schätzung)", src: ["live:wb"],
      info: () => ({ f: ["BIP je Erwerbstätigem zu konstanten Kaufkraftparitäten (ILO-Modellschätzung über die Weltbank).", "Index = Wert im Jahr ÷ Wert 2000 × 100; logarithmische Skala, gleiche Abstände = gleiche Wachstumsraten."],
        r: pr.map(c => { const d = indexed(LS("prod_" + c.iso.toLowerCase()), 2000); const a = lastPt(d); return a ? `${c.name} ${Math.round(a[0])}: ${fmt(a[1], 0)}` : null; }) }) },
    { series: pr.map(c => ({ id: c.iso, label: c.name, color: LC[c.r], data: indexed(LS("prod_" + c.iso.toLowerCase()), 2000) })), height: 260, log: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
}

/* Rahmen der Pictet-Studie: J-Kurve der Technologiediffusion (schematisch) und Kernaussagen */
function renderTechFrame() {
  const host = document.getElementById("tech-frame");
  if (host.childElementCount) return;
  const left = sheet(host, { title: "Die Produktivitäts-J-Kurve der Basistechnologien", sub: "Schematische Darstellung nach Pictet Research Institute (Abb. 8 und 9): Neue Basistechnologien drücken die gemessene Produktivität zunächst, bevor sie sie heben; keine Messwerte", src: ["live:pictet"],
    info: { f: "Keine Berechnung: Die Kurven sind schematisch gezeichnet (Glockenkurve für die anfängliche Delle plus S-Kurve für den späteren Anstieg) und geben nur den Verlauf aus der Pictet-Studie wieder. KI ist ab der Gegenwart gestrichelt, weil ihr Verlauf offen ist." } });
  const wrap = h("div", { class: "chart" });
  left.body.append(wrap);
  const curves = [
    { id: "el", label: "Elektrizität", color: "--s4", f: x => -0.9 * Math.exp(-((x - 9) ** 2) / 30) + 2.4 / (1 + Math.exp(-(x - 24) / 4.2)) },
    { id: "net", label: "Internet", color: "--s3", f: x => -0.7 * Math.exp(-((x - 7) ** 2) / 20) + 2.1 / (1 + Math.exp(-(x - 19) / 3.6)) },
    { id: "rob", label: "Robotik", color: "--s7", f: x => 1.6 / (1 + Math.exp(-(x - 18) / 4.5)) - 0.05 },
    { id: "ai", label: "Künstliche Intelligenz", color: "--s1", f: x => -0.8 * Math.exp(-((x - 13) ** 2) / 22) + 2.3 / (1 + Math.exp(-(x - 22) / 3)), dashFrom: 11 },
  ];
  const draw = () => {
    const W = Math.round(wrap.clientWidth); if (W < 60) return;
    const H = 270, m = { l: 12, r: 120, t: 26, b: 30 };
    const X = x => m.l + x / 40 * (W - m.l - m.r), Y = y => m.t + (2.6 - y) / 3.8 * (H - m.t - m.b);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Schematische J-Kurven der Produktivität für Elektrizität, Internet, Robotik und KI" });
    [["1 Entwicklung", 0, 11], ["2 Skalierung", 11, 25], ["3 Integration", 25, 40]].forEach(([l, a, b], i) => {
      if (i === 1) svg.append(sv("rect", { x: X(a), y: m.t, width: X(b) - X(a), height: H - m.t - m.b, fill: cssVar("--hover") }));
      const t = sv("text", { x: (X(a) + X(b)) / 2, y: m.t - 10, "text-anchor": "middle", class: "shade-label" }); t.textContent = l; svg.append(t);
    });
    svg.append(sv("line", { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), class: "baseline" }));
    const items = [];
    for (const c of curves) {
      let d1 = "", d2 = "";
      for (let x = 0; x <= 40; x += 0.5) {
        const pt = `${X(x).toFixed(1)},${Y(c.f(x)).toFixed(1)}`;
        if (c.dashFrom == null || x <= c.dashFrom) d1 += (d1 ? "L" : "M") + pt;
        if (c.dashFrom != null && x >= c.dashFrom) d2 += (d2 ? "L" : "M") + pt;
      }
      svg.append(sv("path", { d: d1, fill: "none", stroke: cssVar(c.color), "stroke-width": 2, "stroke-linecap": "round" }));
      if (d2) svg.append(sv("path", { d: d2, fill: "none", stroke: cssVar(c.color), "stroke-width": 2, "stroke-dasharray": "5 4" }));
      items.push({ c, y: Y(c.f(40)) });
    }
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 14) items[i].y = items[i - 1].y + 14;
    for (const it of items) { const t = sv("text", { x: X(40) + 8, y: it.y + 4, class: "endlabel" }); t.textContent = it.c.label; svg.append(t); }
    const ax = X(11);
    svg.append(sv("circle", { cx: ax, cy: Y(curves[3].f(11)), r: 5, fill: cssVar("--s1"), stroke: cssVar("--sheet"), "stroke-width": 2 }));
    const at = sv("text", { x: ax + 8, y: Y(curves[3].f(11)) + 16, class: "ref-label" }); at.textContent = "KI heute"; svg.append(at);
    const xl = sv("text", { x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle", class: "tick", style: `fill:${cssVar("--muted")};font-size:11px` });
    xl.textContent = "Jahre seit der ersten breiten Anwendung"; svg.append(xl);
    wrap.replaceChildren(svg);
  };
  Charts.add({ render: draw });
  new ResizeObserver(draw).observe(wrap);
  left.body.append(h("p", { class: "small", text: "KI beendet nach Pictet gerade die erste Phase und beginnt zu skalieren. Viele alternde Volkswirtschaften dürften in den nächsten fünf bis zehn Jahren den Tiefpunkt ihrer KI-J-Kurve durchlaufen, also genau dann, wenn der demografische Gegenwind zunimmt. Der Produktivitätsgewinn wird zwischen rund 0,4 % (Acemoglu) und 1,0 bis 1,5 % pro Jahr (Pictet, gestützt auf Autor) veranschlagt." }));

  const right = sheet(host, { title: "Kernaussagen für Anleger", sub: "Zusammenfassung der Studie „Demographics and Technology“ (Pictet Research Institute, Oktober 2025)", src: ["live:pictet"] });
  right.body.append(h("div", { class: "frame-cards" },
    h("div", { class: "frame-card" }, h("h4", { text: "Drei Bedingungen für die Gewinner von morgen" }),
      h("p", { text: "Eine Anlageidee braucht (1) Nachfrage aus dem demografischen Wandel, (2) eine Branche, die sich für Automatisierung und KI eignet, und (3) eine Volkswirtschaft mit der Infrastruktur, die diese Technologien produktiv macht." })),
    h("div", { class: "frame-card" }, h("h4", { text: "Erst Ersatz, dann Produktivität" }),
      h("p", { text: "Alternde Länder setzen zuerst Roboter ein, die fehlende Arbeitskräfte ersetzen, später solche, die die Stundenproduktivität heben. Japan ist im zweiten Schritt, Deutschland nutzt noch 39 % seiner Roboter zum Ersatz von Arbeit. Roboterdichte 2023 je 1.000 Industriebeschäftigte: Südkorea 101, Singapur 77, China, Deutschland und Japan über 40, Weltmittel 16 (IFR)." })),
    h("div", { class: "frame-card" }, h("h4", { text: "Produktivitätspotenzial der Automatisierung" }),
      h("p", { text: "Erreicht jede Branche die höchste bereits beobachtete Automatisierung, steigt das jährliche Produktivitätswachstum in China um 1,7 (zurückhaltend 1,1), in der EU um 1,4 (0,7), in den USA um 0,6 (0,3) und in Japan um 0,3 (0,2) Prozentpunkte. Die US-Schuldenquote läge 2035 dann bei 112 bis 115 % statt 118 % (CBO)." })),
    h("div", { class: "frame-card" }, h("h4", { text: "Strukturelle Gewinner und Verlierer" }),
      h("div", { class: "ws-list" },
        h("div", { class: "ws" }, h("span", { class: "tag win", text: "Gewinner" }), h("b", { text: "Wohnen" }), h("span", { text: "Baumaterialien, Smart Home" })),
        h("div", { class: "ws" }, h("span", { class: "tag win", text: "Gewinner" }), h("b", { text: "Gesundheit" }), h("span", { text: "Medizintechnik, Pharma, Langlebigkeit" })),
        h("div", { class: "ws" }, h("span", { class: "tag win", text: "Gewinner" }), h("b", { text: "Nahrungsmittel" }), h("span", { text: "Produktion und Verarbeitung" })),
        h("div", { class: "ws" }, h("span", { class: "tag lose", text: "Verlierer" }), h("b", { text: "Personentransport, Bekleidung" }), h("span", { text: "sinkende Nachfrage, wenig automatisierbar" }))))));
}
