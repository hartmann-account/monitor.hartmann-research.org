"use strict";
/* Marker für die Stadienschätzung. Jede Regel nennt Datenbasis, Schwelle und Test.
   Die Schwellen sind Setzungen dieses Modells und im Frontend offen ausgewiesen. */

function INTERNAL_MARKERS(C) {
  const L = D.latest;
  const fy = L.fy_gdp_est;
  const defNow = L.mts_ytd && fy ? 100 * L.mts_ytd.current.def / fy.value : null;
  const intRev = L.mts_net_interest && L.mts_ytd ? 100 * L.mts_net_interest.current / L.mts_ytd.current.rcpt : null;
  const pol = A("polar_usa"), polNow = lastPt(pol), pol10 = valAt(pol, polNow[0] - 10);
  const lib = A("libdem_usa"), libNow = lastPt(lib), lib10 = valAt(lib, libNow[0] - 10);
  const cong = A("us_congress_polar_house"), congNow = lastPt(cong);
  const congPct = percentileOf(cong.map(p => p[1]), congNow[1]);
  const trust = lastPt(A("us_trust_gov"));
  const dfaNow = lastPt(A("us_top1_wealth_dfa"));
  const since = (C.violenceSince || "2024-10-01");
  const violence = (C.events || []).filter(e => e.kind === "political_violence" && e.date >= since).length;
  const flags = C.flags || {};
  return [
    { stage: 4, label: "Hohe Staatsverschuldung", basis: "Schulden in Händen der Öffentlichkeit", thr: "≥ 90 % des BIP", value: () => L.debt_public_gdp_now.value, test: v => v >= 90, fmt: v => pct(v, 1) },
    { stage: 4, label: "Hohes Defizit ohne Rezession", basis: `Bundesdefizit bei Arbeitslosenquote ${fmt(L.unrate.value, 1)} %`, thr: "≥ 5 % des BIP und Arbeitslosenquote < 5 %", value: () => defNow, test: v => v >= 5 && L.unrate.value < 5, fmt: v => pct(v, 1) },
    { stage: 4, label: "Vermögenskonzentration", basis: "Anteil des obersten 1 % am Nettovermögen (Fed DFA)", thr: "≥ 30 %", value: () => dfaNow[1], test: v => v >= 30, fmt: v => pct(v, 1) },
    { stage: 4, label: "Zunehmende Polarisierung", basis: `V-Dem, Veränderung ${polNow[0] - 10}–${polNow[0]}`, thr: "> +0,5 Punkte", value: () => polNow[1] - pol10, test: v => v > 0.5, fmt: v => signed(v, 2) },
    { stage: 5, label: "Schuldendienst belastet den Haushalt", basis: "Nettozinsen in % der Bundeseinnahmen, laufendes Fiskaljahr", thr: "≥ 15 %", value: () => intRev, test: v => v >= 15, fmt: v => pct(v, 1) },
    { stage: 5, label: "Feindselige politische Lager", basis: `V-Dem-Polarisierung ${polNow[0]}`, thr: "≥ 2,0", value: () => polNow[1], test: v => v >= 2, fmt: v => fmt(v, 2) },
    { stage: 5, label: "Parteiabstand im Kongress", basis: "Perzentil aller Kongresse seit 1789 (Repräsentantenhaus)", thr: "≥ 95. Perzentil", value: () => congPct, test: v => v >= 95, fmt: v => fmt(v, 0) + ". Perz." },
    { stage: 5, label: "Geringes Vertrauen in die Regierung", basis: `Pew Research Center, ${trust[0]}`, thr: "≤ 25 %", value: () => trust[1], test: v => v <= 25, fmt: v => pct(v, 0) },
    { stage: 5, label: "Erosion demokratischer Normen", basis: `V-Dem-Index liberaler Demokratie, Veränderung ${libNow[0] - 10}–${libNow[0]}`, thr: "≤ −0,10", value: () => libNow[1] - lib10, test: v => v <= -0.1, fmt: v => signed(v, 2) },
    { stage: 5, label: "Politisch motivierte Gewalt", basis: `Anschläge und Angriffe auf Amtsträger oder Kandidaten seit ${deDate(since)} (kuratierte Liste)`, thr: "≥ 2 Ereignisse", value: () => violence, test: v => v >= 2, fmt: v => fmt(v, 0) },
    { stage: 6, label: "Bewaffneter innerstaatlicher Konflikt", basis: "kuratierte Einschätzung nach UCDP-Schwelle (25 Todesopfer pro Jahr)", thr: "vorhanden", value: () => (flags.domesticArmedConflict ? 1 : 0), test: v => v >= 1, fmt: v => (v ? "ja" : "nein") },
    { stage: 6, label: "Ausgesetzte Wahlen oder verfassungswidrige Machtübernahme", basis: "kuratierte Einschätzung", thr: "vorhanden", value: () => (flags.unconstitutionalSeizure ? 1 : 0), test: v => v >= 1, fmt: v => (v ? "ja" : "nein") },
  ];
}

function renderForces() {
  const host = document.getElementById("forces");
  const C = D.curated || {};
  const L = D.latest;
  const cards = [];
  const intRev = L.mts_net_interest && L.mts_ytd ? 100 * L.mts_net_interest.current / L.mts_ytd.current.rcpt : null;
  const fs = C.framework && C.framework.forces ? C.framework.forces : ["Schulden- und Geldzyklus", "Innere Ordnung", "Äußere Ordnung", "Naturereignisse", "Technologie"];
  if (ST.debtStage) cards.push(forceCard(fs[0], `Stadium ${ST.debtStage.stage} von ${C.framework.debtStages.length}`, stageTrack(C.framework.debtStages.length, ST.debtStage.stage, ST.debtStage.next && ST.debtStage.next.share >= 0.25 ? ST.debtStage.stage + 1 : null),
    `${ST.debtStage.name}. Schulden ${fmt(L.debt_public_gdp_now.value, 0)} % des BIP, Zinsen ${fmt(intRev, 1)} % der Einnahmen.`, "#schulden",
    { f: ["Stadium aus der regelbasierten Markerprüfung im Abschnitt Schuldenzyklus: Ein Stadium gilt als erreicht, wenn mindestens die Hälfte seiner Marker erfüllt ist.", "Schulden = Schulden in Händen der Öffentlichkeit ÷ BIP; Zinsen = Nettozinsen ÷ Bundeseinnahmen im laufenden Fiskaljahr."],
      r: ST.debtStage.next ? `Marker für Stadium ${ST.debtStage.next.n}: ${ST.debtStage.next.share == null ? "keine Daten" : fmt(100 * ST.debtStage.next.share, 0) + " % erfüllt"}` : null }));
  if (ST.intStage) cards.push(forceCard(fs[1], `Stadium ${ST.intStage.stage} von ${C.framework.internalStages.length}`, stageTrack(C.framework.internalStages.length, ST.intStage.stage, ST.intStage.next && ST.intStage.next.share >= 0.25 ? ST.intStage.stage + 1 : null),
    `${ST.intStage.name}. Polarisierung (V-Dem) ${fmt(lastPt(A("polar_usa"))[1], 1)}, Vertrauen in die Regierung ${fmt(lastPt(A("us_trust_gov"))[1], 0)} %.`, "#innen",
    { f: ["Stadium aus der regelbasierten Markerprüfung im Abschnitt Innere Ordnung (Schulden, Vermögenskonzentration, Polarisierung, Vertrauen, politische Gewalt).", "Polarisierung: V-Dem-Expertenschätzung, höher = feindseligere Lager; Vertrauen: Pew Research Center, Anteil mit Vertrauen „fast immer“ oder „meistens“."] }));
  const wars = C.wars || [];
  const cls = { aktiv: "st-crit", eskalierend: "st-crit", teilweise: "st-serious", latent: "st-warn", nein: "st-good" };
  cards.push(forceCard(fs[2], `${wars.filter(w => ["aktiv", "eskalierend"].includes(w.status)).length} von ${wars.length} Konfliktformen aktiv`,
    h("div", { class: "wars" }, ...wars.map(w => h("span", { class: "pill " + (cls[w.status] || "st-none"), title: w.statusLabel || w.status }, h("span", { class: "dot" }), w.short || w.name))), null, "#geopolitik",
    { f: "Zählt die Konfliktformen zwischen den USA und China (Handel, Technologie, Kapital, Geopolitik, Militär), deren Status in der kuratierten Liste „aktiv“ oder „eskalierend“ lautet. Rot = aktiv oder eskalierend, orange = teilweise, gelb = latent." }));
  const temp = lastPt(A("temp_anomaly"));
  cards.push(forceCard(fs[3], temp ? `${fmt(temp[1], 2)} °C über 1861–1890 (${Math.round(temp[0])})` : "", null, "Nicht in der Stadienschätzung; Klimarisiken wirken als Kostenschock und Konfliktverstärker.", "#natur",
    { f: "Abweichung der globalen bodennahen Jahresmitteltemperatur vom Mittel 1861–1890 (HadCRUT5 über Our World in Data), keine eigene Umrechnung." }));
  const inn = D.power.score.innovation;
  const iu = inn.USA[inn.USA.length - 1], ic = inn.CHN[inn.CHN.length - 1];
  const i10u = inn.USA[inn.USA.length - 11], i10c = inn.CHN[inn.CHN.length - 11];
  cards.push(forceCard(fs[4], `Innovationsindex USA ${fmt(100 * iu, 0)}, China ${fmt(100 * ic, 0)}`, null, `Vor zehn Jahren: USA ${fmt(100 * i10u, 0)}, China ${fmt(100 * i10c, 0)} (0–100, normiert auf den historischen Höchstwert).`, "#macht",
    { f: ["Messgröße Innovation des Machtindex: gewichtetes Mittel der Anteile an naturwissenschaftlichen Nobelpreisen (40 %), an den weltweiten F&E-Ausgaben (40 %) und an den Patentanmeldungen (20 %).", "Jede Komponente geglättet (5-Jahres-Mittel) und durch den höchsten je erreichten Wert der acht Länder geteilt; Ergebnis × 100."],
      r: `USA ${fmt(100 * i10u, 0)} → ${fmt(100 * iu, 0)}, China ${fmt(100 * i10c, 0)} → ${fmt(100 * ic, 0)} (zehn Jahre)` }));
  host.replaceChildren(...cards);
}
function forceCard(title, read, visual, text, href, inf) {
  return h("article", { class: "force" },
    h("div", { class: "f-head" }, h("h3", null, title, inf ? info(withTitle(inf, title), title) : null), h("a", { href, class: "small", text: "Details" })),
    read ? h("div", { style: "font-weight:640", text: read }) : null,
    visual,
    text ? h("div", { class: "f-read", text }) : null);
}

/* Marker des Schuldenzyklus. Die Zuordnung der Marker zu Stadien steht in curated.json
   (framework.debtMarkerStages), damit sie ohne Codeänderung angepasst werden kann. */
function DEBT_MARKERS(x) {
  const { L, C } = x;
  const map = (C.framework && C.framework.debtMarkerStages) || {};
  const fy = L.fy_gdp_est;
  const dp = A("us_debt_public_gdp");
  const dNow = L.debt_public_gdp_now.value;
  const d10 = valAt(dp, (fy ? fy.fy : 2026) - 10);
  const ir = A("us_interest_revenue");
  const ir5 = valAt(ir, (fy ? fy.fy : 2026) - 5);
  const t10 = A("us_10y_m"), ff = A("us_fedfunds_m");
  const t10Now = lastPt(t10), ffNow = lastPt(ff);
  const t10Prev = t10.find(p => Math.abs(p[0] - (t10Now[0] - 1)) < 0.02), ffPrev = ff.find(p => Math.abs(p[0] - (ffNow[0] - 1)) < 0.02);
  const gold = A("gold_usd");
  const gNow = lastPt(gold), g5 = valAt(gold, Math.round(gNow[0]) - 5);
  const flags = C.flags || {};
  const fsh = L.foreign_share;
  const fhist = fsh ? Object.entries(fsh.history).map(([k, v]) => [new Date(k + "T00:00:00Z").getUTCFullYear() + new Date(k + "T00:00:00Z").getUTCMonth() / 12, v]) : [];
  const f10 = fhist.length ? fhist.find(p => Math.abs(p[0] - (fhist[fhist.length - 1][0] - 10)) < 0.13) : null;
  const realLong = (L.us10y_d || L.us10y).value - L.cpi_yoy.value;
  const d5 = valAt(dp, (fy ? fy.fy : 2026) - 5);
  const defs = [
    { id: "debt_level", label: "Hohe Verschuldung relativ zum Einkommen", basis: "Schulden in Händen der Öffentlichkeit", thr: "≥ 90 % des BIP", value: () => dNow, test: v => v >= 90, fmt: v => pct(v, 1) },
    { id: "debt_trend", label: "Schulden wachsen schneller als die Einkommen", basis: `Veränderung der Schuldenquote seit ${(fy ? fy.fy : 2026) - 10}`, thr: "> +10 Pp. in 10 Jahren", value: () => dNow - d10, test: v => v > 10, fmt: v => signed(v, 1) + " Pp." },
    { id: "interest_trend", label: "Schuldendienst wächst schneller als die Einnahmen", basis: `Zinsen in % der Einnahmen, Veränderung seit Fiskaljahr ${(fy ? fy.fy : 2026) - 5}`, thr: "> +5 Pp. in 5 Jahren", value: () => x.intRevNow - ir5, test: v => v > 5, fmt: v => signed(v, 1) + " Pp." },
    { id: "deficit_peacetime", label: "Hohes Defizit ohne Krieg und Rezession", basis: `Bundesdefizit bei Arbeitslosenquote ${fmt(L.unrate.value, 1)} %`, thr: "≥ 5 % des BIP bei Arbeitslosenquote < 5 %", value: () => x.defNow, test: v => v >= 5 && L.unrate.value < 5, fmt: v => pct(v, 1) },
    { id: "interest_burden", label: "Schuldendienst verdrängt andere Ausgaben", basis: "Nettozinsen in % der Bundeseinnahmen (ohne Tilgung)", thr: "≥ 15 %", value: () => x.intRevNow, test: v => v >= 15, fmt: v => pct(v, 1) },
    { id: "borrow_for_interest", label: "Neue Schulden bezahlen alte Zinsen", basis: "Defizit im Verhältnis zu den Nettozinsen", thr: "Defizit ≥ Nettozinsen", value: () => L.mts_ytd.current.def / L.mts_net_interest.current, test: v => v >= 1, fmt: v => fmt(v, 2) + " ×" },
    { id: "long_up_short_down", label: "Langfristzinsen steigen trotz niedrigerer Leitzinsen", basis: `10-jährige Rendite, ${fmtYearFrac(t10Now[0], "M")} gegenüber Vorjahresmonat; Leitzins ${signed(ffNow[1] - ffPrev[1], 2)} Pp.`, thr: "Rendite ≥ +0,25 Pp. bei gesunkenem Leitzins", value: () => (t10Prev && ffPrev ? t10Now[1] - t10Prev[1] : null), test: v => v >= 0.25 && ffNow[1] < ffPrev[1], fmt: v => signed(v, 2) + " Pp." },
    { id: "gold_vs_usd", label: "Währung verliert gegenüber Gold", basis: `Goldpreis in US-$ seit ${Math.round(gNow[0]) - 5}`, thr: "> +50 % in 5 Jahren", value: () => 100 * (gNow[1] / g5 - 1), test: v => v > 50, fmt: v => signed(v, 0) + " %" },
    { id: "foreign_demand", label: "Ausländische Nachfrage nach Staatsanleihen lässt nach", basis: fsh ? `Anteil ausländischer Halter, ${deQuarter(fsh.date)} gegenüber zehn Jahren zuvor` : "Anteil ausländischer Halter", thr: "≤ −5 Pp. in 10 Jahren", value: () => (fsh && f10 ? fsh.value - f10[1] : null), test: v => v <= -5, fmt: v => `${signed(v, 1)} Pp. (jetzt ${fmt(fsh.value, 1)} %)` },
    { id: "cb_buying", label: "Zentralbank weitet Bilanz wieder aus", basis: `Bilanzsumme der Fed ${fmt(x.fedAssets[1], 1)} % des BIP, Veränderung über 12 Monate`, thr: "Wachstum > 0 bei Bilanz ≥ 15 % des BIP", value: () => L.fed_assets.change12m, test: v => v > 0 && x.fedAssets[1] >= 15, fmt: v => signed(v, 1) + " %" },
    { id: "real_short_neg", label: "Negative reale Leitzinsen", basis: `Federal Funds Effective Rate minus Inflation (${deMonth(L.cpi_yoy.date)})`, thr: "< 0 Pp.", value: () => x.realShort, test: v => v < 0, fmt: v => signed(v, 2) + " Pp." },
    { id: "policy_zero", label: "Leitzins nahe null", basis: "Federal Funds Effective Rate", thr: "≤ 1 %", value: () => (L.dff || L.fedfunds).value, test: v => v <= 1, fmt: v => pct(v, 2) },
    { id: "usd_reserve_down", label: "Reservewährungsstatus erodiert", basis: "US-Dollar-Anteil an den Weltdevisenreserven, 10 Jahre", thr: "≤ −5 Pp.", value: () => x.usdNow - x.usd10, test: v => v <= -5, fmt: v => signed(v, 1) + " Pp." },
    { id: "gold_real_record", label: "Flucht in hartes Geld", basis: x.goldRealPrevMax ? `realer Goldpreis gegenüber früherem Höchststand (${Math.round(x.goldRealPrevMax[0])})` : "realer Goldpreis", thr: "über früherem Höchststand", value: () => x.goldRealNow[1] / x.goldRealPrevMax[1], test: v => v > 1, fmt: v => fmt(100 * v, 0) + " % des Rekords" },
    { id: "capital_controls", label: "Kapitalverkehrskontrollen oder Sondersteuern auf Vermögen", basis: "kuratierte Einschätzung", thr: "eingeführt", value: () => (flags.capitalControls ? 1 : 0), test: v => v >= 1, fmt: v => (v ? "ja" : "nein") },
    { id: "restructuring", label: "Zahlungsausfall, Umschuldung oder erzwungene Abwertung", basis: "kuratierte Einschätzung", thr: "eingetreten", value: () => (flags.debtRestructuring ? 1 : 0), test: v => v >= 1, fmt: v => (v ? "ja" : "nein") },
    { id: "debt_falling", label: "Schuldenquote sinkt deutlich", basis: `Veränderung seit ${(fy ? fy.fy : 2026) - 5}`, thr: "≤ −10 Pp. in 5 Jahren", value: () => dNow - d5, test: v => v <= -10, fmt: v => signed(v, 1) + " Pp." },
    { id: "real_high", label: "Hohe Realzinsen machen Kredite wieder lohnend", basis: "10-jährige Rendite minus Inflation", thr: "≥ 3 Pp.", value: () => realLong, test: v => v >= 3, fmt: v => signed(v, 2) + " Pp." },
  ];
  return defs.filter(d => map[d.id] != null).map(d => Object.assign(d, { stage: map[d.id] })).sort((a, b) => a.stage - b.stage);
}
