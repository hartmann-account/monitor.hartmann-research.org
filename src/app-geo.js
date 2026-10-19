"use strict";
/* Big-Cycle-Monitor: Geopolitik – Spannungsmonitor (GDELT), Prognosemärkte, Unsicherheitsindizes */

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
  for (const t of rows) {
    const [w, cls] = levelWord(t.pct);
    tb.append(h("tr", null,
      h("td", null, h("b", { text: t.label })),
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

function renderPredictions() {
  const host = document.getElementById("predictions");
  const items = LIVE && LIVE.items && LIVE.items.polymarket;
  if (!items || !items.length) { host.replaceChildren(); return; }
  const sh = sheet(host, { title: "Was Prognosemärkte erwarten", sub: "Implizite Wahrscheinlichkeiten ausgewählter geopolitischer und wirtschaftlicher Fragen auf Polymarket, nach Handelsvolumen", src: ["live:polymarket"],
    note: "Prognosemärkte spiegeln Wetten von Marktteilnehmern, keine Prognose dieses Monitors. Bei geringem Volumen sind die Kurse wenig aussagekräftig." });
  const list = h("div", { class: "pred-list" });
  for (const it of items.slice(0, 10)) {
    list.append(h("div", { class: "pred" },
      h("div", { class: "q" }, it.url ? h("a", { href: it.url, target: "_blank", rel: "noopener", text: it.q }) : it.q),
      h("div", { class: "p", text: fmt(100 * it.p, 0) + " %" }),
      h("div", { class: "bar", "aria-hidden": "true" }, h("i", { style: `width:${Math.max(1, 100 * it.p)}%` })),
      h("div", { class: "meta", text: `${it.event ? it.event + " · " : ""}Volumen ${fmtAuto(it.vol)} US-$${it.end ? " · bis " + deShort(it.end) : ""}${it.d1 != null ? ` · 24 h ${signed(100 * it.d1, 0)} Pp.` : ""}` })));
  }
  sh.body.append(list);
}

function renderUncertainty() {
  const host = document.getElementById("uncertainty-charts");
  const epu = [["epu_us", "USA (täglich, 30-Tage-Mittel)", "--s1"], ["epu_global", "Welt", "--ink-2"], ["epu_cn", "China", "--s2"], ["epu_eu", "Europa", "--s5"], ["epu_gb", "Großbritannien", "--s3"], ["epu_jp", "Japan", "--s6"]].filter(([id]) => LP(id).length);
  if (epu.length) {
    const ser = epu.map(([id, l, c]) => {
      const pts = LIVE.s[id].f === "D" ? smoothDaily(LS(id), 30).filter((p, i, a) => i % 7 === 0 || i === a.length - 1) : LS(id);
      return { id, label: l, color: c, data: pts.filter(p => p[0] >= nowX() - 8) };
    });
    chartSheet(host, { title: "Wirtschaftspolitische Unsicherheit", sub: "Economic Policy Uncertainty Index (Baker, Bloom, Davis), Zeitungsauswertung; Langfristmittel ≈ 100", src: liveSrcIds(...epu.map(e => e[0])) },
      { series: ser, height: 280, freq: "M", zero: true, hidden: ["epu_gb", "epu_jp"], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
  }
  const tpu = A("tpu_m");
  if (tpu.length) chartSheet(host, { title: "Handelspolitische Unsicherheit", sub: "Trade Policy Uncertainty Index (Caldara u. a.), Monatswerte", src: ["gpr"] },
    { series: [{ id: "tpu", label: "TPU", color: "--s2", data: tpu.filter(p => p[0] >= 2000), area: true }], height: 280, freq: "M", zero: true, endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
  else {
    const tar = A("us_tariff_eff");
    if (tar.length) chartSheet(host, { title: "Effektiver US-Zollsatz seit 1990", sub: "Zolleinnahmen in % der Warenimporte", src: srcOf("us_tariff_eff") },
      { series: [{ id: "t", label: "Zollsatz", color: "--s2", data: tar.filter(p => p[0] >= 1990), area: true }], height: 280, zero: true, endValFmt: v => fmt(v, 1) + " %", tipFmt: v => fmt(v, 2) + " %" });
  }
}
