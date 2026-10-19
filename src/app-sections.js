"use strict";
/* Big-Cycle-Monitor: Seitenlogik, Teil 2 (Schulden, innere und äußere Ordnung, Natur, Simulation, Methodik) */

const WARS = [{ x0: 1803, x1: 1815, label: "Napoleon" }, { x0: 1861, x1: 1865, label: "Bürgerkr." }, { x0: 1914, x1: 1918, label: "1. WK" }, { x0: 1939, x1: 1945, label: "2. WK" }];

/* ------------------------------------------------------------------ Stadienschätzung */
function percentileOf(arr, v) {
  const a = arr.filter(x => x != null && isFinite(x));
  if (!a.length || v == null) return null;
  return 100 * a.filter(x => x <= v).length / a.length;
}
function evalMarkers(markers) {
  return markers.map(m => {
    let value = null, ok = null, shown = "–";
    try { value = m.value(); } catch (e) { value = null; }
    if (value != null && (typeof value !== "number" || isFinite(value))) { ok = !!m.test(value); shown = m.fmt ? m.fmt(value) : fmt(value, 1); }
    return Object.assign({}, m, { v: value, ok, shown });
  });
}
function estimateStage(evald, stages, baseline) {
  const by = {};
  for (const m of evald) { if (m.ok == null) continue; (by[m.stage] = by[m.stage] || []).push(m.ok); }
  const share = s => (by[s] && by[s].length ? by[s].filter(Boolean).length / by[s].length : null);
  let stage = baseline ?? Math.min(...stages.map(s => s.n));
  for (const s of stages) { const sh = share(s.n); if (sh != null && sh >= 0.5) stage = Math.max(stage, s.n); }
  const next = stages.find(s => s.n === stage + 1);
  return { stage, name: (stages.find(s => s.n === stage) || {}).name, next: next ? { n: next.n, share: share(next.n) } : null, share };
}
function renderStagePanel(hostId, cfg) {
  const host = document.getElementById(hostId);
  const evald = evalMarkers(cfg.markers);
  const est = estimateStage(evald, cfg.stages, cfg.baseline);
  const sh = sheet(host, { title: cfg.title, sub: cfg.sub, src: cfg.src });
  const cur = cfg.stages.find(s => s.n === est.stage);
  const nextShare = est.next && est.next.share;
  const left = h("div", { style: "display:grid;gap:10px;align-content:start" },
    h("div", { class: "eyebrow", text: "Geschätztes Stadium" }),
    h("div", { style: "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap" },
      h("span", { style: "font-size:2.6rem;font-weight:700;line-height:1;font-variation-settings:'wdth' 110", text: String(est.stage) }),
      h("span", { style: "color:var(--muted)", text: `von ${cfg.stages.length}` }),
      h("span", { style: "font-weight:640;font-size:1.05rem", text: cur ? cur.name : "" })),
    stageTrack(cfg.stages.length, est.stage, nextShare != null && nextShare >= 0.25 ? est.stage + 1 : null),
    h("p", { class: "small", text: cur && cur.desc ? cur.desc : "" }),
    est.next ? h("p", { class: "small", text: `Marker für Stadium ${est.next.n}: ${est.next.share == null ? "keine Daten" : fmt(100 * est.next.share, 0) + " % erfüllt"}.` }) : null,
    cfg.source ? h("p", { class: "small" }, "Stadienbeschreibung: ", h("a", { href: cfg.source.url, target: "_blank", rel: "noopener", text: cfg.source.label })) : null,
    h("ol", { class: "small", style: "margin:4px 0 0;padding-left:18px;display:grid;gap:2px" }, ...cfg.stages.map(s => h("li", { style: s.n === est.stage ? "color:var(--ink);font-weight:600" : "", text: s.name }))));
  const tbl = h("table", { class: "markers" },
    h("thead", null, h("tr", null, h("th", { text: "Stadium" }), h("th", { text: "Marker" }), h("th", { text: "Schwelle" }), h("th", { text: "Wert", style: "text-align:right" }), h("th", { text: "Status" }))));
  const tb = h("tbody");
  let lastStage = null;
  for (const m of evald) {
    if (m.stage !== lastStage) { tb.append(h("tr", { class: "grouphead" }, h("td", { colspan: "5", text: `Stadium ${m.stage}: ${(cfg.stages.find(s => s.n === m.stage) || {}).name || ""}` }))); lastStage = m.stage; }
    tb.append(h("tr", null,
      h("td", { class: "stg", text: String(m.stage) }),
      h("td", null, m.label, m.basis ? h("div", { class: "small", text: m.basis }) : null),
      h("td", { class: "small", text: m.thr }),
      h("td", { class: "v", text: m.shown }),
      h("td", { class: "status-cell" }, statusPill(m.ok))));
  }
  tbl.append(tb);
  sh.body.append(h("div", { class: "stage-grid" }, left, h("div", { style: "overflow-x:auto;min-width:0" }, tbl)));
  return est;
}
function stageTrack(n, cur, next) {
  return h("div", null,
    h("div", { class: "stage-track", "aria-hidden": "true" }, ...Array.from({ length: n }, (_, i) => h("span", { class: i + 1 < cur ? "on" : i + 1 === cur ? "cur" : i + 1 === next ? "next" : "" }))),
    h("div", { class: "stage-nums", "aria-hidden": "true" }, ...Array.from({ length: n }, (_, i) => h("span", { text: String(i + 1) }))));
}
function statusPill(ok) {
  if (ok === true) return h("span", { class: "pill st-crit" }, h("span", { class: "dot" }), "erfüllt");
  if (ok === false) return h("span", { class: "pill st-good" }, h("span", { class: "dot" }), "nicht erfüllt");
  return h("span", { class: "pill st-none" }, h("span", { class: "dot" }), "keine Daten");
}

/* ------------------------------------------------------------------ Schuldenzyklus */
function renderDebt() {
  const C = D.curated || {};
  const L = D.latest;
  const fyGdp = L.fy_gdp_est ? L.fy_gdp_est.value : null;
  const intRevNow = L.mts_net_interest && L.mts_ytd ? 100 * L.mts_net_interest.current / L.mts_ytd.current.rcpt : null;
  const defNow = L.mts_ytd && fyGdp ? 100 * L.mts_ytd.current.def / fyGdp : null;
  const ffNowD = (L.dff || L.fedfunds).value;
  const realShort = ffNowD - L.cpi_yoy.value;
  const tenMinusFF = (L.us10y_d || L.us10y).value - ffNowD;
  const goldReal = A("gold_real");
  const goldRealNow = lastPt(goldReal);
  const goldRealPrevMax = maxPt(goldReal.filter(p => p[0] < 2020));
  const fedAssets = lastPt(A("us_fed_assets_gdp"));
  const usdShare = D.power.components.cofer.share.USA;
  const usdNow = usdShare[usdShare.length - 1], usd10 = usdShare[usdShare.length - 11];
  const ir = A("us_interest_revenue");
  const ir5 = valAt(ir, (L.fy_gdp_est ? L.fy_gdp_est.fy : 2026) - 5);
  const dp = A("us_debt_public_gdp");
  const dp5 = valAt(dp, 2021);
  const stagesDef = (C.framework && C.framework.debtStages) || [];
  const markers = DEBT_MARKERS({ intRevNow, ir5, defNow, realShort, tenMinusFF, goldRealNow, goldRealPrevMax, fedAssets, usdNow, usd10, dp5, L, C });
  const est = stagesDef.length ? renderStagePanel("debt-stage", {
    title: "Schuldenzyklus der USA: Stadienschätzung", sub: "Regelbasierte Prüfung beobachtbarer Marker; ein Stadium gilt als erreicht, wenn mindestens die Hälfte seiner Marker erfüllt ist",
    stages: stagesDef, markers, source: C.framework.debtSource, baseline: 1,
    src: ["treasury_debt", "treasury_mts", "fred", "gold", "imf_cofer"],
  }) : null;
  ST.debtStage = est;

  const host = document.getElementById("debt-charts");
  const weo = A("us_debt_gdp_weo");
  chartSheet(host, { title: "Staatsschulden in % des BIP", sub: "USA ab 1800, Großbritannien ab 1727, Niederlande ab 1814, Japan ab 1875; gestrichelt: IWF-Projektion USA", src: srcOf("us_debt_gdp", "us_debt_gdp_weo", "uk_debt_gdp", "nl_debt_gdp"), cls: "span-2" },
    { series: [
      { id: "USA", label: "USA", color: "--s1", data: A("us_debt_gdp") },
      { id: "USAp", label: "USA, IWF-Projektion", short: "USA (Proj.)", color: "--s1", data: weo, dash: "5 4", noLegend: false },
      { id: "GBR", label: "Großbritannien", color: "--s3", data: A("uk_debt_gdp") },
      { id: "NLD", label: "Niederlande", color: "--s4", data: A("nl_debt_gdp") },
      { id: "JPN", label: "Japan", color: "--s6", data: A("jp_debt_gdp") },
    ], height: 320, zero: true, shades: WARS, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Zinsausgaben des Staates in % des BIP", sub: "Großbritannien ab 1800, USA ab 1929", src: srcOf("us_interest_gdp", "uk_interest_gdp") },
    { series: [{ id: "GBR", label: "Großbritannien", color: "--s3", data: A("uk_interest_gdp") }, { id: "USA", label: "USA", color: "--s1", data: A("us_interest_gdp") }],
      height: 250, zero: true, shades: WARS, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) + " %" });
  const irData = ir.slice();
  if (intRevNow != null && L.fy_gdp_est) irData.push([L.fy_gdp_est.fy, intRevNow]);
  chartSheet(host, { title: "Zinsen in % der Bundeseinnahmen", sub: `Fiskaljahre 1940–${L.fy_gdp_est ? L.fy_gdp_est.fy : ""}; letzter Wert aus dem Monthly Treasury Statement`, src: srcOf("us_interest_revenue").concat(["treasury_mts"]) },
    { series: [{ id: "ir", label: "Zinsen/Einnahmen", color: "--s1", data: irData, area: true }], height: 250, zero: true, endValFmt: v => fmt(v, 1) + " %", tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Zinsen und Inflation in den USA", sub: "Jahresmittel; Inflation und Realrendite (10-jährige Rendite minus Inflation) als zentrierte 3-Jahres-Mittel", src: srcOf("us_10y", "us_cpi_infl", "us_3m"), cls: "span-2" },
    { series: [
      { id: "ten", label: "Rendite 10 Jahre", short: "10 J.", color: "--s1", data: A("us_10y") },
      { id: "infl", label: "Inflation (3-Jahres-Mittel)", short: "Inflation", color: "--s2", data: smooth(A("us_cpi_infl"), 3) },
      { id: "real", label: "Realrendite 10 Jahre (3-Jahres-Mittel)", short: "real", color: "--s3", data: smooth(A("us_real_10y"), 3) },
      { id: "bill", label: "Schatzwechsel 3 Monate", short: "3 M.", color: "--s7", data: A("us_3m") },
    ], hidden: ["bill"], height: 300, shades: WARS.slice(1), refs: [{ y: 0 }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) + " %" });
  const GV = (C.values || {}).gold, WG = (C.values || {}).wgc;
  const gNote = GV && WG ? `Rekord 2026: ${fmt(GV.athLbmaPm, 0)} US-$ je Unze (LBMA, ${deDate(GV.athDate)}). Zentralbanken kauften 2025 netto ${fmt(WG.cb2025, 0)} t Gold, im ersten Halbjahr 2026 ${fmt(WG.cbH1_2026, 0)} t (World Gold Council). Wert 2026 = Mittel bis zum letzten Monat.` : null;
  chartSheet(host, { title: "Gold in US-Dollar", sub: "Jahresmittel, logarithmische Skala; real in Preisen des letzten Jahres", src: srcOf("gold_usd", "gold_real"), note: gNote },
    { series: [{ id: "nom", label: "nominal", color: "--s4", data: A("gold_usd") }, { id: "real", label: "real", color: "--s1", data: A("gold_real") }],
      height: 260, log: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) + " US-$",
      vlines: [{ x: 1933, label: "1933" }, { x: 1971, label: "1971" }] });
  chartSheet(host, { title: "Geldschöpfung der Federal Reserve", sub: "Bilanzsumme ab 2002 und Geldbasis ab 1959, jeweils in % des BIP", src: srcOf("us_fed_assets_gdp", "us_base_gdp") },
    { series: [{ id: "bs", label: "Bilanzsumme", color: "--s1", data: A("us_fed_assets_gdp") }, { id: "mb", label: "Geldbasis", color: "--s7", data: A("us_base_gdp") }],
      height: 260, zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %" });
  const defData = A("us_deficit_gdp");
  if (defNow != null && L.fy_gdp_est) defData.push([L.fy_gdp_est.fy, -defNow]);
  chartSheet(host, { title: "Haushaltssaldo des Bundes in % des BIP", sub: "Fiskaljahre ab 1929; negativ = Defizit; Referenzlinie bei −3 %", src: srcOf("us_deficit_gdp").concat(["treasury_mts"]) },
    { series: [{ id: "def", label: "Saldo", color: "--s8", data: defData, area: true }], height: 260, refs: [{ y: -3, label: "−3 %" }], shades: WARS.slice(2), endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Kredite an Staat und Privatsektor", sub: "USA, % des BIP (BIS-Gesamtkredit, Quartalsende)", src: srcOf("us_private_credit_gdp", "us_gov_credit_gdp") },
    { series: [{ id: "priv", label: "Privater Nichtfinanzsektor", short: "privat", color: "--s1", data: A("us_private_credit_gdp") }, { id: "gov", label: "Gesamtstaat", short: "Staat", color: "--s2", data: A("us_gov_credit_gdp") }],
      height: 260, zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Britischer Zyklus: Zinsen und Inflation", sub: "Rendite der Consols, Bank Rate und Inflation (zentriertes 3-Jahres-Mittel), 1700–2016", src: srcOf("uk_consol", "uk_infl", "uk_bankrate"), cls: "span-2" },
    { series: [{ id: "consol", label: "Consols-Rendite", short: "Consols", color: "--s3", data: A("uk_consol") }, { id: "infl", label: "Inflation (3-Jahres-Mittel)", short: "Inflation", color: "--s2", data: smooth(A("uk_infl"), 3) }, { id: "bank", label: "Bank Rate", color: "--s7", data: A("uk_bankrate") }],
      hidden: ["bank"], xMin: 1700, height: 280, shades: WARS, refs: [{ y: 0 }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %" });
}

/* ------------------------------------------------------------------ Innere Ordnung */
function renderInternal() {
  const C = D.curated || {};
  const stagesDef = (C.framework && C.framework.internalStages) || [];
  const est = stagesDef.length ? renderStagePanel("int-stage", {
    title: "Innere Ordnung der USA: Stadienschätzung", sub: "Regelbasierte Prüfung; Ereignismarker stammen aus der kuratierten Liste im Abschnitt Äußere Ordnung",
    stages: stagesDef, markers: INTERNAL_MARKERS(C), source: C.framework.internalSource, baseline: 3,
    src: ["vdem", "voteview", "pew", "fred", "treasury_mts", "wid"],
  }) : null;
  ST.intStage = est;
  const host = document.getElementById("int-charts");
  chartSheet(host, { title: "Konzentration von Vermögen und Einkommen in den USA", sub: "Anteil des obersten 1 %; WID ab 1820 bzw. 1913, Fed-Verteilungsrechnung ab 1989", src: srcOf("top1_wealth_usa", "us_top1_income", "us_top1_wealth_dfa"), cls: "span-2" },
    { series: [
      { id: "w", label: "Vermögen (WID)", color: "--s1", data: A("top1_wealth_usa"), markers: false },
      { id: "dfa", label: "Vermögen (Fed DFA)", color: "--s7", data: A("us_top1_wealth_dfa") },
      { id: "inc", label: "Einkommen vor Steuern (WID)", short: "Einkommen", color: "--s2", data: A("us_top1_income") },
    ], height: 290, xMin: 1870, zero: true, shades: WARS.slice(2), endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Polarisierung im US-Kongress", sub: "Abstand der Parteimediane auf der ersten DW-NOMINATE-Dimension, Republikaner minus Demokraten", src: srcOf("us_congress_polar_house") },
    { series: [{ id: "h", label: "Repräsentantenhaus", short: "Haus", color: "--s1", data: A("us_congress_polar_house") }, { id: "s", label: "Senat", color: "--s2", data: A("us_congress_polar_senate") }],
      height: 260, shades: [{ x0: 1861, x1: 1865, label: "Bürgerkr." }], endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) });
  chartSheet(host, { title: "Polarisierung der Gesellschaft", sub: "V-Dem-Expertenschätzung; höhere Werte = feindseligere politische Lager", src: srcOf("polar_usa") },
    { series: ["USA", "GBR", "DEU", "CHN"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: A("polar_" + c.toLowerCase()) })), height: 260, shades: WARS.slice(2), endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) });
  chartSheet(host, { title: "Liberaler Demokratieindex", sub: "V-Dem, 0 bis 1", src: srcOf("libdem_usa") },
    { series: ["USA", "GBR", "DEU", "CHN"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: A("libdem_" + c.toLowerCase()) })), height: 260, yMin: 0, yMax: 1, xMin: 1900, endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 3) });
  chartSheet(host, { title: "Vertrauen in die Bundesregierung", sub: "Anteil, der der Regierung in Washington fast immer oder meistens vertraut (geglättet)", src: srcOf("us_trust_gov") },
    { series: [{ id: "t", label: "Vertrauen", color: "--s1", data: A("us_trust_gov"), area: true }], height: 240, yMin: 0, yMax: 100, endValFmt: v => fmt(v, 0) + " %", tipFmt: v => fmt(v, 0) + " %" });
  chartSheet(host, { title: "Misery-Index", sub: "Arbeitslosenquote plus Inflationsrate, Jahresmittel", src: srcOf("us_misery") },
    { series: [{ id: "m", label: "Misery-Index", color: "--s8", data: A("us_misery") }], height: 240, zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) });
}

/* ------------------------------------------------------------------ Äußere Ordnung */
function renderExternal() {
  const C = D.curated || {};
  const wars = (C.wars || []);
  const wHost = document.getElementById("wars");
  const sh = sheet(wHost, { title: "Fünf Formen des Konflikts zwischen USA und China", sub: "Status nach Daten und kuratierten Ereignissen; Stand des Datensatzes" });
  const tariff = D.latest.tariff_eff_q;
  const gprM = A("gpr_hist_m").filter(p => p[1] != null);
  const gprNow = lastPt(gprM);
  const gprPct = percentileOf(gprM.filter(p => p[0] >= 1985).map(p => p[1]), gprNow ? gprNow[1] : null);
  const tbl = h("table", { class: "markers" }, h("thead", null, h("tr", null, h("th", { text: "Konfliktform" }), h("th", { text: "Status" }), h("th", { text: "Beleg" }))));
  const tb = h("tbody");
  for (const w of wars) {
    let evidence = w.evidence || "";
    if (w.id === "trade" && tariff) evidence = `Effektiver US-Zollsatz ${fmt(tariff.value, 1)} % (${deQuarter(tariff.date)}). ` + evidence;
    if (w.id === "geo" && gprNow) evidence = `GPR-Index ${fmt(gprNow[1], 0)} (${fmtYearFrac(gprNow[0], "M")}), ${fmt(gprPct, 0)}. Perzentil seit 1985. ` + evidence;
    const cls = { aktiv: "st-crit", eskalierend: "st-crit", teilweise: "st-serious", latent: "st-warn", nein: "st-good" }[w.status] || "st-none";
    tb.append(h("tr", null, h("td", null, h("b", { text: w.name })), h("td", { class: "status-cell" }, h("span", { class: "pill " + cls }, h("span", { class: "dot" }), w.statusLabel || w.status)),
      h("td", null, evidence, (w.links || []).length ? h("div", { class: "small" }, ...w.links.flatMap((l, i) => [i ? " · " : "", h("a", { href: l.url, target: "_blank", rel: "noopener", text: l.label })])) : null)));
  }
  tbl.append(tb);
  sh.body.append(h("div", { style: "overflow-x:auto" }, tbl));

  const eHost = document.getElementById("events");
  const es = sheet(eHost, { title: "Kuratierte Ereignisse 2026", sub: "Auswahl mit Quellenangabe, Stand 18. Oktober 2026; im GitHub-Projekt in pipeline/curated.json gepflegt. Keine vollständige Chronik." });
  const evs = (C.events || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const evEl = e => h("div", { class: "event" },
    h("div", { class: "d", text: e.dateLabel || deDate(e.date) }),
    h("div", { class: "t" }, h("div", null, h("span", { class: "force-tag", style: "margin-right:6px", text: e.tag }), e.text), e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener", text: e.source || "Quelle" }) : null));
  es.body.append(h("div", { class: "events" }, ...evs.slice(0, 8).map(evEl)));
  if (evs.length > 8) es.body.append(h("details", { class: "more", style: "margin-top:10px" }, h("summary", { text: `Ältere Ereignisse (${evs.length - 8})` }), h("div", { class: "events" }, ...evs.slice(8).map(evEl))));
  if (!evs.length) es.body.append(h("p", { class: "small", text: "Keine kuratierten Ereignisse hinterlegt." }));

  const host = document.getElementById("ext-charts");
  chartSheet(host, { title: "Geopolitisches Risiko seit 1900", sub: "Caldara-Iacoviello-Index auf Basis von Zeitungsartikeln, Monatswerte; 1985–2019 = 100", src: srcOf("gpr_hist_m"), cls: "span-2" },
    { series: [{ id: "g", label: "GPR (historisch)", color: "--s8", data: A("gpr_hist_m"), area: true, width: 1.5 }], freq: "M", height: 280, zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0),
      shades: WARS.slice(2), refs: [{ y: 100, label: "100" }] });
  const cl = A("conflict_deaths_longrun"), cu = A("conflict_deaths_ucdp");
  chartSheet(host, { title: "Todesopfer in Kriegen und Konflikten weltweit", sub: "Logarithmische Skala; Conflict Catalog 1400–2000, UCDP/PRIO ab 1946 (abweichende Definitionen)", src: srcOf("conflict_deaths_longrun", "conflict_deaths_ucdp") },
    { series: [{ id: "cc", label: "Conflict Catalog", color: "--s7", data: cl }, { id: "u", label: "UCDP/PRIO", color: "--s8", data: cu }], height: 260, log: true, logFloor: 100, endValFmt: v => fmtAuto(v), tipFmt: v => fmt(v, 0) });
  chartSheet(host, { title: "Globalisierung", sub: "Weltwarenexporte in % des Welt-BIP (CEPII, bis 2014) und Welthandel in % des Welt-BIP (Weltbank, ab 1970)", src: srcOf("world_exports_gdp", "world_trade_gdp") },
    { series: [{ id: "x", label: "Warenexporte (CEPII)", short: "Exporte", color: "--s1", data: A("world_exports_gdp") }, { id: "t", label: "Exporte + Importe (Weltbank)", short: "Handel", color: "--s3", data: A("world_trade_gdp") }],
      height: 260, zero: true, shades: WARS.slice(2), endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  const V = (D.curated && D.curated.values) || {};
  const tNote = V.tariffs ? `Vergleich: Der durchschnittliche gesetzliche Zollsatz lag laut Yale Budget Lab am ${deDate(V.tariffs.yaleDate)} bei ${fmt(V.tariffs.yaleStatutory, 1)} %; die Tax Foundation beziffert den 2025 tatsächlich erhobenen Satz auf ${fmt(V.tariffs.tfEffective2025, 1)} %, den höchsten seit 1947. Abweichungen ergeben sich aus Abgrenzung der Importe und Erstattungen.` : null;
  chartSheet(host, { title: "Effektiver US-Zollsatz", sub: "Zolleinnahmen in % der Warenimporte (NIPA), Jahreswerte ab 1929; letzter Wert Quartalsdurchschnitt", src: srcOf("us_tariff_eff"), note: tNote },
    { series: [{ id: "t", label: "Zollsatz", color: "--s2", data: A("us_tariff_eff"), area: true }], height: 260, zero: true, vlines: [{ x: 1930, label: "Smoot-Hawley" }], endValFmt: v => fmt(v, 1) + " %", tipFmt: v => fmt(v, 2) + " %" });
  const mNote = V.sipri2025 ? `SIPRI für 2025 in laufenden Preisen: Welt ${fmt(V.sipri2025.world, 0)} Mrd. US-$, USA ${fmt(V.sipri2025.usa, 0)} Mrd. (${V.sipri2025.usaShare} %), China ${fmt(V.sipri2025.chn, 0)} Mrd. (${V.sipri2025.chnShare} %, Schätzung).` : null;
  chartSheet(host, { title: "Militärausgaben", sub: "SIPRI, Mrd. US-$ in konstanten Preisen", src: srcOf("milex_usa"), note: mNote },
    { series: ["USA", "CHN", "RUS"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: A("milex_" + c.toLowerCase()) })), xMin: 1988, height: 260, zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) + " Mrd." });
  chartSheet(host, { title: "Atomsprengköpfe", sub: "Geschätzte Bestände (Federation of American Scientists)", src: srcOf("nukes_usa") },
    { series: ["USA", "RUS", "CHN"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: A("nukes_" + c.toLowerCase()) })), height: 260, zero: true, endValFmt: v => fmtAuto(v), tipFmt: v => fmt(v, 0) });
}

/* ------------------------------------------------------------------ Natur und Technik */
function renderNature() {
  const host = document.getElementById("nat-charts");
  chartSheet(host, { title: "Globale Temperaturabweichung", sub: "Gegenüber 1861–1890, °C (HadCRUT5)", src: srcOf("temp_anomaly") },
    { series: [{ id: "t", label: "Abweichung", color: "--s8", data: A("temp_anomaly") }], height: 250, refs: [{ y: 0 }, { y: 1.5, label: "1,5 °C" }], endValFmt: v => fmt(v, 2) + " °C", tipFmt: v => fmt(v, 2) + " °C" });
  if (D.series.disasters_n) chartSheet(host, { title: "Erfasste Naturkatastrophen", sub: "EM-DAT; der Anstieg spiegelt auch bessere Erfassung", src: srcOf("disasters_n") },
    { series: [{ id: "d", label: "Ereignisse", color: "--s7", data: A("disasters_n") }], height: 250, zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
  const comp = (cid, c) => D.power.years.map((y, i) => [y, D.power.components[cid].share[c][i]]);
  chartSheet(host, { title: "Forschung und Entwicklung", sub: "Anteil an den weltweiten F&E-Ausgaben zu Kaufkraftparitäten, %", src: D.power.components.rd.src },
    { series: ["USA", "CHN", "JPN", "DEU"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: comp("rd", c) })), xMin: 1996, height: 250, zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %" });
  chartSheet(host, { title: "Naturwissenschaftliche Nobelpreise", sub: "Anteil nach Land der Forschungseinrichtung, gleitende 20 Jahre, %", src: D.power.components.nobel.src },
    { series: ["USA", "GBR", "DEU", "JPN", "CHN"].map(c => ({ id: c, label: SHORT[c], color: CC[c], data: comp("nobel", c) })), xMin: 1910, height: 250, zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
}

/* ------------------------------------------------------------------ Simulation */
function simDefaults() {
  const L = D.latest;
  const fy = L.fy_gdp_est;
  const pdNow = L.mts_ytd && L.mts_net_interest && fy ? 100 * (L.mts_ytd.current.def - L.mts_net_interest.current) / fy.value : 3;
  const rev = L.mts_ytd && fy ? 100 * L.mts_ytd.current.rcpt / fy.value : 17;
  const mNow = 0.3 * L.us3m.value + 0.7 * (L.us10y_d || L.us10y).value;
  // effektiver Nettozins: Nettozinsen des Fiskaljahres / mittlere Schuld in Händen der Öffentlichkeit
  const debtEnd = L.debt_penny_public.value * 1000;
  const r0 = L.mts_net_interest && L.mts_ytd ? 100 * L.mts_net_interest.current / (debtEnd - L.mts_ytd.current.def / 2) : L.avg_rate_marketable.value;
  return { years: 30, d0: L.debt_public_gdp_now.value, r0, m0: mNow, mBar: Math.round(mNow * 4) / 4, maturity: 6, g: 1.8, pi: 2.5,
    pd: Math.round(pdNow * 10) / 10, rev: Math.round(rev * 10) / 10, recProb: 12, rateVol: 0.5, thrInt: 25, thrDebt: 130, capTotal: null };
}
function renderSim() {
  const host = document.getElementById("sim-debt");
  const base = simDefaults();
  const P = Object.assign({}, base);
  const y0 = D.latest.fy_gdp_est ? D.latest.fy_gdp_est.fy : 2026;
  const sh = sheet(host, {
    title: "Monte-Carlo-Projektion der US-Staatsverschuldung",
    sub: `${fmt(2000, 0)} Pfade über 30 Jahre ab Fiskaljahr ${y0}; Startwerte aus Treasury- und FRED-Daten, Zufallsschocks bei Wachstum, Inflation, Zinsen und Rezessionen`,
    src: ["treasury_debt", "treasury_rates", "treasury_mts", "fred"],
  });
  const presets = [
    { id: "base", label: "Marktzinsen fortgeschrieben", set: { ...base } },
    { id: "cbo", label: "CBO-nahe Annahmen", set: { ...base, mBar: 4.0, pi: 2.2, g: 1.8, pd: 2.5 } },
    { id: "dalio", label: "Gesamtdefizit 3 % des BIP", set: { ...base, capTotal: 3 } },
    { id: "repress", label: "Finanzielle Repression", set: { ...base, pi: 4.5, mBar: Math.max(1, base.mBar - 1.0) } },
    { id: "stress", label: "Anleihestress", set: { ...base, mBar: base.mBar + 2, rateVol: 1.0, g: 1.2 } },
  ];
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Szenario" });
  presets.forEach((p, i) => {
    const b = h("button", { type: "button", "aria-pressed": String(i === 0), text: p.label });
    b.addEventListener("click", () => { Object.assign(P, p.set); seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); syncSliders(); run(); });
    seg.append(b);
  });
  const defs = [
    ["pd", "Primärdefizit", "% BIP", -2, 8, 0.1],
    ["mBar", "Zins für Neuemissionen", "%", 0.5, 9, 0.25],
    ["g", "Reales Wachstum", "%", -1, 4, 0.1],
    ["pi", "Inflation", "%", 0, 9, 0.1],
    ["recProb", "Rezessionswahrscheinlichkeit", "% p. a.", 0, 30, 1],
    ["rateVol", "Zinsschwankung", "Pp. p. a.", 0, 1.5, 0.1],
    ["maturity", "Durchschnittliche Restlaufzeit", "Jahre", 2, 12, 0.5],
    ["rev", "Bundeseinnahmen", "% BIP", 14, 22, 0.1],
  ];
  const sl = h("div", { class: "sliders" });
  const inputs = {};
  for (const [k, lab, unit, mn, mx, st] of defs) {
    const id = "sim-" + k;
    const out = h("output", { for: id });
    const inp = h("input", { type: "range", id, min: String(mn), max: String(mx), step: String(st), value: String(P[k]) });
    inp.addEventListener("input", () => { P[k] = +inp.value; out.textContent = `${fmt(P[k], st < 1 ? (st < 0.1 ? 2 : 1) : 0)} ${unit}`; if (k === "pd") P.capTotal = null; seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false")); run(); });
    inputs[k] = { inp, out, unit, st };
    sl.append(h("div", { class: "slider" }, h("label", { for: id }, lab, out), inp));
  }
  function syncSliders() { for (const [k, o] of Object.entries(inputs)) { o.inp.value = P[k]; o.out.textContent = `${fmt(P[k], o.st < 1 ? (o.st < 0.1 ? 2 : 1) : 0)} ${o.unit}`; } }
  syncSliders();
  const res = h("div", { class: "outcomes" });
  const capNote = h("p", { class: "small" });
  const g2 = h("div", { class: "grid-2" });
  const cboV = ((D.curated || {}).values || {}).cbo;
  const cboNote = cboV ? h("p", { class: "small" }, `Referenz: Die CBO erwartet für 2036 eine Schuldenquote von ${fmt(cboV.debt2036, 1)} % und Nettozinsen von ${fmt(cboV.netInterest2036Gdp, 1)} % des BIP, bei einem Durchschnittszins von ${fmt(cboV.avgRate2026, 1)} % (2026) bis ${fmt(cboV.avgRate2032, 1)} % (ab 2032) und rund ${fmt(cboV.nominalGrowth, 1)} % nominalem Wachstum. Die CBO unterstellte für 2026 eine Zehnjahresrendite von 4,1 %. `, h("a", { href: cboV.url, target: "_blank", rel: "noopener", text: cboV.label })) : null;
  sh.body.append(h("div", { style: "display:grid;gap:14px" }, h("div", { class: "controls" }, seg), sl, capNote, cboNote, res, g2));
  const sd = h("div"), si = h("div");
  g2.append(sd, si);
  const mk = (title) => { const s = h("div", null, h("h4", { text: title, style: "margin:0 0 4px" })); return s; };
  const dHost = mk("Schulden in Händen der Öffentlichkeit, % des BIP"); sd.append(dHost);
  const iHost = mk("Zinsausgaben in % der Bundeseinnahmen"); si.append(iHost);
  const hist = A("us_debt_public_gdp").filter(p => p[0] >= 1990);
  const histI = A("us_interest_revenue").filter(p => p[0] >= 1990);
  if (D.latest.mts_net_interest && D.latest.mts_ytd) histI.push([y0, 100 * D.latest.mts_net_interest.current / D.latest.mts_ytd.current.rcpt]);
  const cD = new LineChart(dHost, { series: [], height: 270, zero: true, endLabels: false, legend: true, tipFmt: v => fmt(v, 0) + " %" });
  const cI = new LineChart(iHost, { series: [], height: 270, zero: true, endLabels: false, legend: true, tipFmt: v => fmt(v, 1) + " %" });
  function fan(band, key) {
    const xs = band.map((_, t) => y0 + t);
    return {
      fans: [
        { lo: band.map((q, t) => [xs[t], q[0]]), hi: band.map((q, t) => [xs[t], q[4]]), color: "--s1", opacity: 0.12, legend: "5.–95. Perzentil", tipLabel: "90-%-Band" },
        { lo: band.map((q, t) => [xs[t], q[1]]), hi: band.map((q, t) => [xs[t], q[3]]), color: "--s1", opacity: 0.2, legend: "25.–75. Perzentil" },
      ],
      med: band.map((q, t) => [xs[t], q[2]]),
    };
  }
  function run() {
    const r = simulateDebt(P);
    const fd = fan(r.debt), fi = fan(r.intRev);
    const cbo = ((D.curated || {}).values || {}).cbo;
    cD.update({ series: [{ id: "hist", label: "Ist", color: "--ink-2", data: hist.concat([[y0, P.d0]]) }, { id: "med", label: "Median", color: "--s1", data: fd.med }], fans: fd.fans, refs: [{ y: P.thrDebt, label: `${P.thrDebt} %` }],
      points: cbo ? [{ x: 2036, y: cbo.debt2036, label: `CBO 2036: ${fmt(cbo.debt2036, 0)} %`, color: "--ink" }] : [] });
    cI.update({ series: [{ id: "hist", label: "Ist", color: "--ink-2", data: histI }, { id: "med", label: "Median", color: "--s1", data: fi.med }], fans: fi.fans, refs: [{ y: P.thrInt, label: `${P.thrInt} %` }],
      points: cbo ? [{ x: 2036, y: cbo.netInterest2036Rev, label: `CBO 2036: ${fmt(cbo.netInterest2036Rev, 0)} %`, color: "--ink" }] : [] });
    const t10 = 10;
    res.replaceChildren(
      oc(fmt(r.debt[t10][2], 0) + " %", `Schuldenquote ${y0 + t10}, Median (90-%-Band ${fmt(r.debt[t10][0], 0)}–${fmt(r.debt[t10][4], 0)} %)`),
      oc(fmt(r.debt[30][2], 0) + " %", `Schuldenquote ${y0 + 30}, Median`),
      oc(fmt(r.intRev[t10][2], 1) + " %", `Zinsen/Einnahmen ${y0 + t10}, Median`),
      oc(fmt(100 * r.pInt10, 0) + " %", `Wahrscheinlichkeit, dass Zinsen bis ${y0 + t10} mindestens ${P.thrInt} % der Einnahmen binden`),
      oc(fmt(100 * r.pDebt10, 0) + " %", `Wahrscheinlichkeit einer Schuldenquote von mindestens ${P.thrDebt} % bis ${y0 + t10}`));
    capNote.textContent = P.capTotal != null ? `Szenario mit fixiertem Gesamtdefizit: Das Primärdefizit passt sich jedes Jahr so an, dass das Gesamtdefizit ${fmt(P.capTotal, 0)} % des BIP beträgt (in Rezessionsjahren höher).` : `Startwerte: Schuldenquote ${fmt(P.d0, 1)} %, effektiver Nettozins ${fmt(P.r0, 2)} % (Nettozinsen ${y0} / mittlere Schuld; Durchschnittszins der marktgängigen Schuld ${fmt(D.latest.avg_rate_marketable.value, 2)} %), Primärdefizit ${fmt(base.pd, 1)} % und Einnahmen ${fmt(base.rev, 1)} % des BIP im Fiskaljahr ${y0}.`;
  }
  function oc(v, l) { return h("div", { class: "outcome" }, h("div", { class: "o-v", text: v }), h("div", { class: "o-l", text: l })); }
  run();

  renderAnalogs();
  renderPhase();
}

function renderAnalogs() {
  const host = document.getElementById("analogs");
  const q = D.analogs.query;
  const F = D.analogs.features;
  const W = F.map(f => ({ debt: 2, interest: 1, ltrate: 1, infl3: 1, real: 0, wealth: 1, polar: 1, libdem: 0.5, gpr: 0.5, relsize: 1 })[f.id] ?? 1);
  const sh = sheet(host, {
    title: "Historische Analogien zur Lage der USA",
    sub: `Nächste Nachbarn unter ${fmt(D.analogs.rows.length, 0)} Land-Jahren (18 Industrieländer, 1870–2016), standardisierte Distanz über die gewählten Merkmale; je Episode der nächstgelegene Jahrgang`,
    src: ["jst", "imf_fpp", "imf_hpdd", "wid", "vdem", "gpr", "maddison", "imf_weo", "fred"],
  });
  const chips = h("div", { class: "chips", "aria-label": "Merkmale und Gewichte" });
  const cycle = [0, 0.5, 1, 2];
  F.forEach((f, j) => {
    const b = h("button", { class: "chip", type: "button", "aria-pressed": String(W[j] > 0) });
    const lab = () => { b.replaceChildren(f.label + (q.f[j] == null ? " (fehlt)" : ""), h("span", { class: "mono", text: W[j] ? `×${fmt(W[j], W[j] % 1 ? 1 : 0)}` : "aus" })); b.setAttribute("aria-pressed", String(W[j] > 0)); };
    lab();
    b.addEventListener("click", () => { W[j] = cycle[(cycle.indexOf(W[j]) + 1) % cycle.length]; lab(); run(); });
    chips.append(b);
  });
  const qline = h("p", { class: "small" });
  const tblWrap = h("div", { style: "overflow-x:auto" });
  const outc = h("div", { class: "outcomes" });
  sh.body.append(h("div", { style: "display:grid;gap:12px" }, h("p", { class: "small", text: "Merkmal antippen, um das Gewicht zu ändern (aus → 0,5 → 1 → 2)." }), chips, qline, tblWrap,
    h("h4", { text: "Was in den zehn Jahren danach geschah (Median der gelisteten Analogien)" }), outc));
  const FDq = { debt: 0, interest: 2, ltrate: 2, infl3: 1, real: 1, wealth: 1, polar: 2, libdem: 2, gpr: 0, relsize: 2 };
  qline.replaceChildren("Abfrage: ", h("b", { text: q.label }), " · ", ...F.flatMap((f, j) => [j ? " · " : "", `${f.label.replace(/ \(.*\)/, "")} ${q.f[j] == null ? "–" : fmt(q.f[j], FDq[f.id] ?? 1)}`]));
  function run() {
    const r = analogSearch(D, q, W, { excludeIso: "USA", excludeFrom: 2006 });
    const name = iso => DE_NAMES[iso] || D.analogs.names[iso] || iso;
    const FD = { debt: 0, interest: 2, ltrate: 2, infl3: 1, real: 1, wealth: 0, polar: 2, libdem: 2, gpr: 0, relsize: 2 };
    const maxd = Math.max(...r.list.map(x => x.d), 0.01);
    const show = [0, 1, 3, 5, 6, 9].filter(j => W[j] > 0 || [0, 3].includes(j));
    const t = h("table", { class: "analog-table" },
      h("thead", null, h("tr", null, h("th", { text: "Land" }), h("th", { text: "Jahr" }), h("th", { text: "Distanz" }), ...show.map(j => h("th", { text: F[j].label.replace(/ \(.*\)/, "") })), h("th", { text: "Δ Schulden 10 J." }), h("th", { text: "Inflation 10 J." }), h("th", { text: "Anleihen real p. a." }), h("th", { text: "Krise" }))),
      h("tbody", null, ...r.list.map(x => h("tr", null,
        h("td", { text: name(x.r.iso) }), h("td", { text: String(x.r.y) }),
        h("td", null, h("span", { class: "dist", style: `width:${Math.round(44 * x.d / maxd)}px` }), fmt(x.d, 2)),
        ...show.map(j => h("td", { text: x.r.f[j] == null ? "–" : fmt(x.r.f[j], FD[F[j].id] ?? 1) })),
        h("td", { text: x.r.o && x.r.o.dDebt != null ? signed(x.r.o.dDebt, 0) + " Pp." : "–" }),
        h("td", { text: x.r.o && x.r.o.infl != null ? (x.r.o.infl > 100 ? "> 100 %" : fmt(x.r.o.infl, 1) + " %") : "–" }),
        h("td", { text: x.r.o && x.r.o.bond != null ? fmt(x.r.o.bond, 1) + " %" : "–" }),
        h("td", { text: x.r.o && x.r.o.crisis != null ? (x.r.o.crisis ? "ja" : "nein") : "–" })))));
    tblWrap.replaceChildren(t);
    const s = r.summary;
    outc.replaceChildren(
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.dDebt == null ? "–" : signed(s.dDebt, 0) + " Pp." }), h("div", { class: "o-l", text: "Veränderung der Schuldenquote" })),
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.infl == null ? "–" : fmt(s.infl, 1) + " %" }), h("div", { class: "o-l", text: "Inflation p. a." })),
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.bond == null ? "–" : fmt(s.bond, 1) + " %" }), h("div", { class: "o-l", text: "Reale Anleiherendite p. a." })),
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.eq == null ? "–" : fmt(s.eq, 1) + " %" }), h("div", { class: "o-l", text: "Reale Aktienrendite p. a." })),
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.crisisShare == null ? "–" : fmt(100 * s.crisisShare, 0) + " %" }), h("div", { class: "o-l", text: "Anteil mit Bankenkrise (JST-Definition)" })),
      h("div", { class: "outcome" }, h("div", { class: "o-v", text: s.gpr == null ? "–" : fmt(s.gpr, 0) }), h("div", { class: "o-l", text: "Höchster GPR-Jahreswert" })));
  }
  run();
}

function renderPhase() {
  const host = document.getElementById("phase");
  const fits = ["USA", "CHN", "GBR", "DEU", "JPN", "RUS", "IND"].map(c => fitPhase(D, c, D.power.years[D.power.years.length - 1])).filter(Boolean);
  const sh = sheet(host, {
    title: "Phasenschätzung aus dem Muster der Messgrößen",
    sub: "Kurve: relative Plausibilität jeder Phase in Prozent je Jahr (Summe 100 %). Verglichen werden für jede Messgröße das Niveau relativ zum eigenen Höchststand und der Trend über 15 Jahre",
  });
  const g = h("div", { class: "grid-2", style: "align-items:start" });
  sh.body.append(g);
  const cHost = h("div");
  g.append(cHost);
  new LineChart(cHost, {
    series: fits.filter(f => ["USA", "CHN", "GBR"].includes(f.c)).map(f => ({ id: f.c, label: SHORT[f.c], color: CC[f.c], data: f.weights.map(([p, w]) => [p, 100 * w]) })),
    height: 260, zero: true, endLabels: false, xLabel: "Phase", yFmt: v => fmt(v, 1), xTickFmt: v => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v), xFmt: v => `Phase ${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)} Jahre`,
    xTicks: () => [-120, -90, -60, -30, 0, 30, 60, 90, 120, 150], tipFmt: v => fmt(v, 2) + " %", refs: [], vlines: [{ x: 0, label: "Zenit" }],
  });
  const keys = Object.keys(MODEL.arch.offsets);
  const t = h("table", { class: "data" },
    h("thead", null, h("tr", null, h("th", { text: "Messgröße" }), h("th", { text: "Höhepunkt im Archetyp" }), ...fits.map(f => h("th", { text: SHORT[f.c] })))),
    h("tbody", null,
      ...keys.map(k => h("tr", null, h("td", { text: MSHORT[k] }), h("td", { text: signed(MODEL.arch.offsets[k], 0) + " J." }),
        ...fits.map(f => { const p = f.per[k]; return h("td", { title: p ? `Niveau ${fmt(100 * p.L, 0)} % des Höchststands, Trend ${signed(100 * p.S, 0)} Pp. in 15 Jahren` : "keine Daten", text: p ? signed(p.phi, 0) : "–" }); }))),
      h("tr", null, h("td", null, h("b", { text: "Gesamtschätzung" })), h("td", { text: "" }), ...fits.map(f => h("td", null, h("b", { text: signed(f.best, 0) }), h("div", { class: "small", text: `${signed(f.lo, 0)} bis ${signed(f.hi, 0)}` }))))));
  g.append(h("div", { style: "display:grid;gap:8px;min-width:0" }, h("div", { class: "table-wrap", style: "max-height:none" }, t),
    h("p", { class: "small", text: "Zellen: Phase, die die jeweilige Messgröße für sich allein nahelegt. Streuen diese Werte stark, passt das Land schlecht zum Archetyp. " + (() => {
      const u = fits.find(f => f.c === "USA");
      if (!u) return "";
      const e = Object.entries(u.per).sort((a, b) => a[1].phi - b[1].phi);
      const lo = e[0], hi = e[e.length - 1];
      return `Bei den USA reicht die Spanne von ${MSHORT[lo[0]]} (${signed(lo[1].phi, 0)} Jahre) bis ${MSHORT[hi[0]]} (${signed(hi[1].phi, 0)} Jahre).`;
    })() })));
}

/* ------------------------------------------------------------------ Methodik und Quellen */
function renderMethods() {
  const C = D.curated || {};
  const m = document.getElementById("method-text");
  (C.methodText || []).forEach(p => m.append(h("p", { text: p })));
  const l = document.getElementById("limits-text");
  (C.limitsText || []).forEach(p => l.append(h("p", { text: p })));
  document.getElementById("verify-note").textContent = C.verifyNote || "";
  const host = document.getElementById("sources");
  const ids = Object.keys(D.sources);
  document.getElementById("src-count").textContent = `${ids.length} Quellen`;
  const sh = sheet(host, { title: "Quellenregister", sub: `Abruf und Verarbeitung: ${deDate(D.meta.generated.slice(0, 10))}; Zitate der Our-World-in-Data-Reihen aus deren Metadaten übernommen` });
  const tbl = h("table", { class: "sources" }, h("thead", null, h("tr", null, h("th", { text: "Kennung" }), h("th", { text: "Quelle" }), h("th", { text: "Zitat bzw. Bezug" }), h("th", { text: "Stand" }))),
    h("tbody", null, ...ids.map(id => { const s = D.sources[id]; return h("tr", null, h("td", { class: "id", text: id }), h("td", null, h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.name }), s.via ? h("div", { class: "small", text: "über " + s.via }) : null), h("td", { class: "small", text: s.citation || "–" }), h("td", { class: "small", text: s.lastUpdated || "Abruf " + D.meta.generated.slice(0, 10) })); })));
  sh.body.append(h("div", { style: "overflow-x:auto" }, tbl));
  const fl = D.meta.fredLabels || {};
  sh.body.append(h("details", { class: "more", style: "margin-top:10px" }, h("summary", { text: `Verwendete FRED-Reihen (${Object.keys(fl).length})` }),
    h("ul", { class: "small", style: "columns:2;column-gap:28px;margin:0;padding-left:18px" }, ...Object.entries(fl).map(([k, v]) => h("li", null, h("a", { href: `https://fred.stlouisfed.org/series/${k}`, target: "_blank", rel: "noopener", class: "mono", text: k }), " ", v)))));
  const p = document.getElementById("pipeline-text");
  (C.pipelineText || []).forEach(x => p.append(h("p", { text: x })));
}
