"use strict";
/* Big-Cycle-Monitor: Geopolitik – Spannungsmonitor (GDELT), Prognosemärkte, Unsicherheitsindizes */

const LOW_EVENTS = 30;
const TENSION_FOCUS = ["us_cn", "cn_tw", "ru_ua", "ru_eu", "il_ir", "us_ir", "us_ru", "cn_jp", "in_pk", "in_cn", "kp", "us_eu", "us_ch"];
function movAvg(pts, n) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const w = pts.slice(Math.max(0, i - n + 1), i + 1).map(p => p.v);
    if (w.length >= Math.min(n, 3)) out.push({ ...pts[i], v: w.reduce((a, b) => a + b, 0) / w.length });
  }
  return out;
}
function levelWord(pct) {
  if (pct == null) return ["keine Daten", "st-none"];
  if (pct >= 90) return ["sehr hoch", "st-crit"];
  if (pct >= 70) return ["erhöht", "st-serious"];
  if (pct >= 40) return ["mittel", "st-warn"];
  return ["niedrig", "st-good"];
}
function renderTension() {
  const host = document.getElementById("tension");
  const T = LIVE && LIVE.tension;
  if (!T || !Object.keys(T.pairs).length) {
    host.replaceChildren(h("p", { class: "small", text: "Der Spannungsmonitor erscheint, sobald der Worker die GDELT-Ereignisdaten verarbeitet hat." }));
    return;
  }
  const sh = sheet(host, {
    title: "Spannungsmonitor der großen Mächte",
    sub: "Konfliktintensität in der Weltpresse je Länderpaar: Erwähnungen konfliktträchtiger Ereignisse, gewichtet mit der Goldstein-Skala, je 10.000 Erwähnungen aller Ereignisse. Index = Perzentil des 7-Tage-Mittels innerhalb der letzten 90 Tage",
    src: ["live:gdelt"],
    note: "Methode nach dem Vorbild von World Monitor: Σ Erwähnungen × max(0, −Goldstein) über Ereignisse der Klassen 3 und 4 (verbale und materielle Konflikte). Medienintensität misst Aufmerksamkeit und Ton, nicht das tatsächliche Geschehen.",
  });
  const rows = TENSION_FOCUS.map(id => T.pairs[id]).filter(Boolean).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  const tb = h("tbody");
  let thin = 0;
  for (const t of rows) {
    const [w, cls] = levelWord(t.pct);
    const few = t.events7 != null && t.events7 < LOW_EVENTS;
    if (few) thin++;
    tb.append(h("tr", null,
      h("td", null, h("b", { text: t.label }), few ? h("span", { class: "low-data", title: `Nur ${fmt(t.events7, 0)} erfasste Ereignisse in sieben Tagen: Index schwankt stark`, text: " wenig Daten" }) : null),
      h("td", null, h("span", { class: "meter", title: `Perzentil ${fmt(t.pct, 0)}` }, h("i", { style: `width:${Math.max(2, t.pct || 0)}%;background:var(${cls === "st-crit" ? "--crit" : cls === "st-serious" ? "--serious" : cls === "st-warn" ? "--warn" : "--good"})` })), " ", h("span", { class: "num", text: t.pct == null ? "–" : fmt(t.pct, 0) })),
      h("td", { class: "status-cell" }, h("span", { class: "pill " + cls }, h("span", { class: "dot" }), w)),
      h("td", { class: "num", title: "7-Tage-Mittel gegenüber den sieben Tagen davor", text: t.wow == null ? "–" : (t.wow > 0.1 ? "↑ " : t.wow < -0.1 ? "↓ " : "→ ") + signed(100 * t.wow, 0) + " %" }),
      h("td", { class: "num", title: "Anteil konfliktträchtiger Erwähnungen an Konflikt plus Kooperation", text: t.share == null ? "–" : fmt(100 * t.share, 0) + " %" }),
      h("td", { class: "num", text: t.events7 == null ? "–" : fmt(t.events7, 0) }),
      h("td", { class: "spark" }, sparkline(t.spark, "--s8"))));
  }
  sh.body.append(h("div", { style: "overflow-x:auto" }, h("table", { class: "tension-table" },
    h("thead", null, h("tr", null, h("th", { text: "Konfliktlinie" }), h("th", { text: "Spannungsindex (0–100)" }), h("th", { text: "Stufe" }), h("th", { style: "text-align:right", text: "Woche" }), h("th", { style: "text-align:right", text: "Konfliktanteil" }), h("th", { style: "text-align:right", text: "Ereignisse 7 T." }), h("th", { text: "120 Tage" }))),
    tb)));
  if (thin) sh.body.append(h("p", { class: "small", style: "margin-top:8px", text: `„wenig Daten“: weniger als ${LOW_EVENTS} erfasste Ereignisse in sieben Tagen. Bei so kleinen Zahlen bewegen einzelne Meldungen den Index stark.` }));
  const g = T.global;
  if (g) sh.body.append(h("p", { class: "small", style: "margin-top:8px", text: `Durchschnittliche Abweichung der letzten 14 Tage vom Viermonatsmittel über alle Konfliktlinien: ${signed(g.z, 2)} Standardabweichungen. Dieser Wert fließt als geopolitische Komponente in die Risikosäule des Anlagebarometers ein. Letzter verarbeiteter Tag: ${deShort(T.last)}.` }));

  const ch = document.getElementById("tension-charts");
  const sel = ["us_cn", "ru_ua", "il_ir", "cn_tw", "ru_eu", "in_pk"].filter(id => LP("gdelt_c_" + id).length > 20);
  const colors = { us_cn: "--s1", ru_ua: "--s2", il_ir: "--s3", cn_tw: "--s4", ru_eu: "--s5", in_pk: "--s6" };
  if (sel.length) chartSheet(ch, { title: "Konfliktintensität ausgewählter Konfliktlinien", sub: "7-Tage-Mittel, Erwähnungen × negative Goldstein-Skala je 10.000 Erwähnungen", src: ["live:gdelt"], cls: "span-2" },
    { series: sel.map(id => ({ id, label: T.pairs[id] ? T.pairs[id].label : id, color: colors[id], data: movAvg(LP("gdelt_c_" + id), 7).map(p => [p.x, p.v]) })),
      height: 300, freq: "D", zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2), ...SHORT_RANGE });
  const gd = A("gpr_daily");
  if (gd.length) chartSheet(ch, { title: "Geopolitischer Risikoindex, täglich", sub: "Caldara-Iacoviello (GPRD), 7-Tage-Mittel; 1985–2019 = 100", src: ["gpr"] },
    { series: [{ id: "gprd", label: "GPR täglich", color: "--s8", data: smoothDaily(gd, 7).filter(p => p[0] >= nowX() - 3), area: true, width: 1.5 }], freq: "D", height: 260, zero: true, refs: [{ y: 100, label: "100" }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0), ...SHORT_RANGE });
  const gc = ["USA", "CHN", "RUS", "UKR", "ISR", "TWN", "IRN", "DEU", "JPN", "IND"].filter(c => (D.series["gprc_" + c.toLowerCase()] || {}).values);
  if (gc.length) {
    const lastV = c => { const p = lastPt(A("gprc_" + c.toLowerCase())); return p ? p[1] : -1; };
    const top = gc.sort((a, b) => lastV(b) - lastV(a)).slice(0, 6);
    const name = { USA: "USA", CHN: "China", RUS: "Russland", UKR: "Ukraine", ISR: "Israel", TWN: "Taiwan", IRN: "Iran", DEU: "Deutschland", JPN: "Japan", IND: "Indien" };
    const col = { USA: "--s1", CHN: "--s2", RUS: "--s7", UKR: "--s4", ISR: "--s3", TWN: "--s5", IRN: "--s8", DEU: "--s5", JPN: "--s6", IND: "--s8" };
    chartSheet(ch, { title: "Geopolitisches Risiko nach Ländern", sub: "Caldara-Iacoviello, Anteil der Artikel mit geopolitischem Risiko, die das Land nennen (%), Monatswerte; die sechs derzeit höchsten", src: ["gpr"] },
      { series: top.map(c => ({ id: c, label: name[c], color: col[c], data: A("gprc_" + c.toLowerCase()).filter(p => p[0] >= nowX() - 6) })), freq: "M", height: 260, zero: true, endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) + " %" });
  }
}
function smoothDaily(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const w = arr.slice(Math.max(0, i - n + 1), i + 1).map(p => p[1]).filter(v => v != null);
    out.push([arr[i][0], w.length ? w.reduce((a, b) => a + b, 0) / w.length : null]);
  }
  return out;
}

/* Prognosemärkte: Fragen der beobachteten Märkte auf Deutsch (unbekannte Muster bleiben im Original) */
const PM_LAND = { "U.S.": "USA", US: "USA", USA: "USA", "United States": "USA", China: "China", Taiwan: "Taiwan", Russia: "Russland", Ukraine: "Ukraine", NATO: "NATO", Iran: "Iran", Israel: "Israel", India: "Indien", Pakistan: "Pakistan", "North Korea": "Nordkorea", Japan: "Japan", EU: "EU" };
const PM_ACC = { Iran: "den Iran", Ukraine: "die Ukraine" };
const PM_MONTH = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
function pmLand(x) { return PM_LAND[x.trim()] || x.trim(); }
function pmWhen(prep, w) {
  w = w.trim();
  let m;
  if ((m = /^end of (\d{4})$/i.exec(w))) return `bis Ende ${m[1]}`;
  if ((m = /^([A-Z][a-z]+) (\d{1,2}),? (\d{4})$/.exec(w)) && PM_MONTH[m[1]]) w = `${+m[2]}.${PM_MONTH[m[1]]}.${m[3]}`;
  else if ((m = /^([A-Z][a-z]+) (\d{4})$/.exec(w)) && PM_MONTH[m[1]]) w = deMonth(`${m[2]}-${String(PM_MONTH[m[1]]).padStart(2, "0")}-01`);
  const p = prep.toLowerCase();
  return p === "before" ? `vor ${w}` : p === "in" ? (/^\d{4}$/.test(w) ? `im Jahr ${w}` : `im ${w}`) : `bis ${w}`;
}
function pmFed(o) {
  o = o.trim();
  if (/^no change$/i.test(o)) return "keine Änderung";
  const m = /^(\d+)\+? ?bps? (increase|decrease|hike|cut)$/i.exec(o);
  if (m) return `${/increase|hike/i.test(m[2]) ? "Anhebung" : "Senkung"} um ${fmt(m[1] / 100, 2)} Pp.${/\+/.test(o) ? " oder mehr" : ""}`;
  return o;
}
const PM_RULES = [
  [/^Will (?:the )?(.+?) invade (.+?) (before|by|in) (.+?)\?$/i, m => `${pmLand(m[1]) === "USA" ? "Marschieren die USA" : "Marschiert " + pmLand(m[1])} ${pmWhen(m[3], m[4])} in ${PM_ACC[pmLand(m[2])] || pmLand(m[2])} ein?`],
  [/^Will (.+?) blockade (.+?) (before|by|in) (.+?)\?$/i, m => `Blockiert ${pmLand(m[1])} ${pmLand(m[2])} ${pmWhen(m[3], m[4])}?`],
  [/^(.+?) x (.+?) military clash (before|by|in) (.+?)\?$/i, m => `Militärischer Zusammenstoß ${pmLand(m[1])}–${pmLand(m[2])} ${pmWhen(m[3], m[4])}?`],
  [/^(.+?) x (.+?) ceasefire(?: agreement)? (before|by|in) (.+?)\?$/i, m => `Waffenstillstand ${pmLand(m[1])}–${pmLand(m[2])} ${pmWhen(m[3], m[4])}?`],
  [/^(?:US|U\.S\.) recession (before|by|in) (.+?)\?$/i, m => `Rezession in den USA ${pmWhen(m[1], m[2])}?`],
  [/^Fed Decision in ([A-Z][a-z]+)\??: (.+)$/i, m => `Zinsentscheid der Fed im ${PM_MONTH[m[1]] ? deMonth(`2000-${String(PM_MONTH[m[1]]).padStart(2, "0")}-01`).split(" ")[0] : m[1]}: ${pmFed(m[2])}`],
  [/^(?:US|U\.S\.) tariff rate on China on (.+?)\??$/i, m => `US-Zollsatz auf Importe aus China am ${pmWhen("by", m[1]).slice(4)}`],
];
function pmGerman(q) {
  for (const [re, f] of PM_RULES) { const m = re.exec(q || ""); if (m) return f(m); }
  return q;
}

function renderPredictions() {
  const host = document.getElementById("predictions");
  const items = LIVE && LIVE.items && LIVE.items.polymarket;
  if (!items || !items.length) { host.replaceChildren(); return; }
  const sh = sheet(host, { title: "Was Prognosemärkte erwarten", sub: "Implizite Wahrscheinlichkeiten ausgewählter geopolitischer und wirtschaftlicher Fragen auf Polymarket, nach Handelsvolumen", src: ["live:polymarket"],
    note: "Prognosemärkte spiegeln Wetten von Marktteilnehmern, keine Prognose dieses Monitors. Bei geringem Volumen sind die Kurse wenig aussagekräftig." });
  const list = h("div", { class: "pred-list" });
  for (const it of items.slice(0, 10)) {
    list.append(h("div", { class: "pred" },
      h("div", { class: "q", title: it.q }, it.url ? h("a", { href: it.url, target: "_blank", rel: "noopener", text: pmGerman(it.q) }) : pmGerman(it.q)),
      h("div", { class: "p", text: fmt(100 * it.p, 0) + " %" }),
      h("div", { class: "bar", "aria-hidden": "true" }, h("i", { style: `width:${Math.max(1, 100 * it.p)}%` })),
      h("div", { class: "meta", text: `Volumen ${it.vol >= 1e6 ? fmtAuto(it.vol) : fmt(it.vol / 1e3, 0) + " Tsd."} US-$${it.end ? " · Marktende " + deShort(it.end) : ""}${it.d1 != null && it.d1 !== 0 ? ` · 24 h ${signed(100 * it.d1, 1)} Pp.` : ""}` })));
  }
  sh.body.append(list);
}

function renderUncertainty() {
  const host = document.getElementById("uncertainty-charts");
  const epu = [["epu_us", "USA (täglich, 30-Tage-Mittel)", "--s1"], ["epu_global", "Welt", "--ink-2"], ["epu_eu", "Europa", "--s5"], ["epu_gb", "Großbritannien", "--s3"], ["epu_in", "Indien", "--s8"], ["epu_ru", "Russland", "--s7"]].filter(([id]) => LP(id).length);
  if (epu.length) {
    const ser = epu.map(([id, l, c]) => {
      const pts = LIVE.s[id].f === "D" ? smoothDaily(LS(id), 30).filter((p, i, a) => i % 7 === 0 || i === a.length - 1) : LS(id);
      return { id, label: l, color: c, data: pts.filter(p => p[0] >= nowX() - 8) };
    });
    chartSheet(host, { title: "Wirtschaftspolitische Unsicherheit", sub: "Economic Policy Uncertainty Index (Baker, Bloom, Davis), Auswertung von Zeitungsartikeln; Langfristmittel ≈ 100", src: liveSrcIds(...epu.map(e => e[0])) },
      { series: ser, height: 280, freq: "M", zero: true, hidden: ["epu_gb", "epu_in", "epu_ru"], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
  }
  const wui = [["wui_world", "Welt", "--ink-2"], ["wui_us", "USA", "--s1"], ["wui_cn", "China", "--s2"], ["wui_de", "Deutschland", "--s5"], ["wui_ch", "Schweiz", "--s4"], ["wui_jp", "Japan", "--s6"], ["wui_gb", "Großbritannien", "--s3"], ["wui_in", "Indien", "--s8"], ["wui_ru", "Russland", "--s7"]].filter(([id]) => LP(id).length);
  // Welt- und Länderreihen haben unterschiedliche Skalen: jede Reihe auf ihr eigenes Mittel 2008–2019 = 100 bezogen
  const norm = id => {
    const d = LS(id), base = d.filter(p => p[0] >= 2008 && p[0] < 2020).map(p => p[1]);
    const m = base.length ? base.reduce((a, b) => a + b, 0) / base.length : null;
    return m ? d.map(([x, v]) => [x, 100 * v / m]) : [];
  };
  if (wui.length) chartSheet(host, { title: "World Uncertainty Index", sub: "Ahir, Bloom, Furceri: Häufigkeit des Wortes „Unsicherheit“ in den Länderberichten der Economist Intelligence Unit, Quartalswerte; je Reihe Mittel 2008–2019 = 100", src: liveSrcIds(...wui.map(e => e[0])) },
    { series: wui.map(([id, l, c]) => ({ id, label: l, color: c, data: norm(id).filter(p => p[0] >= 2005) })), height: 280, freq: "Q", zero: true,
      hidden: ["wui_jp", "wui_gb", "wui_in", "wui_ru"], refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
  const tpu = A("tpu_m");
  if (tpu.length) chartSheet(host, { title: "Handelspolitische Unsicherheit", sub: "Trade Policy Uncertainty Index (Caldara, Iacoviello, Molligo, Prestipino, Raffo), Monatswerte; 1985–2010 = 100", src: srcOf("tpu_m") },
    { series: [{ id: "tpu", label: "TPU", color: "--s2", data: tpu.filter(p => p[0] >= 2000), area: true }], height: 280, freq: "M", zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
}
