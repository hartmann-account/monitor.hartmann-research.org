"use strict";
/* Big-Cycle-Monitor: Live-Teil (täglich über den Worker) – Anlagebarometer, Konjunktur und Märkte */

let LIVE = null;   // dekodierter Snapshot (SIG.decodeSnapshot)
let BARO = null;   // Ergebnis von SIG.barometer für den gewählten Horizont
// Farben folgen dem Land, nicht dem Rang (gleiche Slots wie CC im Machtindex; die Schweiz nimmt den Slot der Niederlande)
const LC = { US: "--s1", CN: "--s2", GB: "--s3", CH: "--s4", EA: "--s5", DE: "--s5", JP: "--s6", RU: "--s7", IN: "--s8" };
const RN = { US: "USA", CN: "China", GB: "Großbritannien", CH: "Schweiz", EA: "Eurozone", DE: "Deutschland", JP: "Japan", RU: "Russland", IN: "Indien", WORLD: "Welt", EM: "Schwellenländer" };
const LSRC = {
  fred: { name: "FRED, Federal Reserve Bank of St. Louis", url: "https://fred.stlouisfed.org/" },
  ecb: { name: "Europäische Zentralbank, Data Portal", url: "https://data.ecb.europa.eu/" },
  snb: { name: "Schweizerische Nationalbank, Datenportal", url: "https://data.snb.ch/" },
  six: { name: "SIX Swiss Exchange, Indexkurse (15 Minuten verzögert)", url: "https://www.six-group.com/de/market-data/indices.html" },
  bundesbank: { name: "Deutsche Bundesbank, Zeitreihen-Datenbank", url: "https://www.bundesbank.de/de/statistiken/zeitreihen-datenbanken" },
  boe: { name: "Bank of England, Database", url: "https://www.bankofengland.co.uk/boeapps/database/" },
  mof: { name: "Japanisches Finanzministerium, JGB-Renditen", url: "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/index.htm" },
  oecd: { name: "OECD Data Explorer", url: "https://data-explorer.oecd.org/" },
  bis: { name: "Bank für Internationalen Zahlungsausgleich, Data Portal", url: "https://data.bis.org/" },
  imf: { name: "Internationaler Währungsfonds, World Economic Outlook (DataMapper)", url: "https://www.imf.org/external/datamapper/" },
  imf_cofer: { name: "IWF COFER", url: "https://data.imf.org/en/datasets/IMF.STA:COFER" },
  wb: { name: "Weltbank, World Development Indicators und Bevölkerungsprojektionen", url: "https://data.worldbank.org/" },
  treasury: { name: "U.S. Treasury, Fiscal Data", url: "https://fiscaldata.treasury.gov/" },
  gdelt: { name: "GDELT Project, Ereignisdatenbank (Event Export 2.0)", url: "https://www.gdeltproject.org/data.html#rawdatafiles" },
  polymarket: { name: "Polymarket (Prognosemarkt)", url: "https://polymarket.com/" },
  gdacs: { name: "GDACS, Global Disaster Alert and Coordination System", url: "https://www.gdacs.org/" },
  nasa: { name: "NASA GISS, GISTEMP v4", url: "https://data.giss.nasa.gov/gistemp/" },
  usgs: { name: "USGS Earthquake Hazards Program", url: "https://earthquake.usgs.gov/" },
  msci: { name: "MSCI, End-of-Day-Indexwerte", url: "https://www.msci.com/end-of-day-data-search" },
  epu: { name: "Economic Policy Uncertainty (Baker, Bloom, Davis)", url: "https://www.policyuncertainty.com/" },
  gpr: { name: "Geopolitical Risk Index (Caldara, Iacoviello)", url: "https://www.matteoiacoviello.com/gpr.htm" },
  nbp: { name: "Narodowy Bank Polski (Goldpreis und Wechselkurs)", url: "https://api.nbp.pl/" },
  boj: { name: "Bank of Japan, Statistik-API", url: "https://www.stat-search.boj.or.jp/" },
  pictet: { name: "Pictet Research Institute: Demographics and Technology (Oktober 2025)", url: "https://am.pictet.com/content/dam/am-pictet/media/global/investment-research/demographics-and-technology/PictetResearchInstitute_Demographics-and-Technology.pdf" },
};

/* ------------------------------------------------------------------ Zugriff auf Live-Reihen */
function LP(id) { return LIVE && LIVE.s[id] ? LIVE.s[id].pts : []; }
function LS(id, scale = 1) { return LP(id).map(p => [p.x, p.v * scale]); }
function LF(id) { return LIVE && LIVE.s[id] ? LIVE.s[id].f : "M"; }
function lastLive(id) { const p = LP(id); return p.length ? p[p.length - 1] : null; }
function liveDate(p, f) { if (!p) return "–"; const iso = SIG.isoOf(p.t); return f === "M" ? deMonth(iso) : f === "Q" ? deQuarter(iso) : f === "A" ? iso.slice(0, 4) : deShort(iso); }
function liveSrcIds(...ids) {
  const out = [];
  for (const id of ids) { const s = LIVE && LIVE.s[id]; if (s && s.src && !out.includes("live:" + s.src)) out.push("live:" + s.src); }
  return out;
}
// Index: erster Wert ab "fromX" = 100
function indexed(data, fromX) {
  const base = data.find(p => p[0] >= fromX && p[1] != null);
  if (!base) return [];
  return data.filter(p => p[0] >= base[0]).map(([x, v]) => [x, v == null ? null : 100 * v / base[1]]);
}
function nowX() { const p = lastLive("eq_us") || lastLive("y10_us"); return p ? p.x : new Date().getUTCFullYear() + new Date().getUTCMonth() / 12; }
function catOf(r) { return r && r.now ? r.now.cat : null; }

/* ------------------------------------------------------------------ Prognosehorizont */
// Barometer je Horizont (m1 = 1 Monat, y1 = 12 Monate, lt = 5–10 Jahre), bei Bedarf berechnet
const BAROS = {};
let HZ = "m1";
function baroFor(hz) {
  if (!LIVE) return null;
  if (!BAROS[hz]) { try { BAROS[hz] = SIG.barometer(LIVE, hz); } catch (e) { console.error("Barometer", hz, e); BAROS[hz] = null; } }
  return BAROS[hz];
}
function savedHorizon() {
  let v = null;
  try { v = localStorage.getItem("bcm-horizon"); } catch (e) { /* Speicher nicht verfügbar */ }
  return SIG.cfg.horizons.some(x => x.id === v) ? v : "m1";
}
function setHorizon(hz) {
  HZ = hz;
  BARO = baroFor(hz);
  try { localStorage.setItem("bcm-horizon", hz); } catch (e) { /* Speicher nicht verfügbar */ }
}
const hzWord = () => (BARO ? BARO.horizon.title : "");

/* ------------------------------------------------------------------ Was steigt, was fällt (Kopfbereich) */
const MOVER_IDS = ["eq_us", "eq_ch", "eq_ea", "eq_cn", "gold_usd", "fx_chf", "bd_us", "brent"];
// Trendsäule des Horizonts: 1 Monat Trend, 12 Monate Momentum, 5–10 Jahre Langfristtrend
function trendPillar(r) { const P = r.now.pillars; return P.trend || P.mom12 || P.trendLT || null; }
function trendWord(r) { const t = trendPillar(r); if (!t) return "→ seitwärts"; return t.s > 0.3 ? "↑ Aufwärtstrend" : t.s < -0.3 ? "↓ Abwärtstrend" : "→ seitwärts"; }
function moverName(r) {
  const { id, group, label } = r.row;
  if (id === "eq_world") return "Aktien weltweit";
  if (group === "aktien") return `Aktien ${label}`;
  if (group === "anleihen") return `Staatsanleihen ${label}`;
  return label;
}
/* Hinweis bei Zeilen, deren jüngster Kurs nicht tagesaktuell ist (Monatsreihen, verzögert veröffentlichte Reihen) */
function staleNote(r) {
  const p = r.now && r.now.price;
  if (!p || p.length < 2 || BARO.tNow == null) return null;
  const a = p[p.length - 1], b = p[p.length - 2], iso = SIG.isoOf(a.t);
  if (a.t - b.t > 20) {
    const m = new Date(iso + "T12:00:00Z");
    return { short: "Stand " + m.toLocaleDateString(LOCALE, { month: "short", timeZone: "UTC" }), long: `Monatswert ${deMonth(iso)}` };
  }
  if (BARO.tNow - a.t > 6) return { short: `Stand ${+iso.slice(8, 10)}.${+iso.slice(5, 7)}.`, long: `letzter Kurs vom ${deShort(iso)}` };
  return null;
}
function renderMovers() {
  const host = document.getElementById("movers");
  if (!BARO) { host.replaceChildren(); return; }
  const byId = Object.fromEntries(BARO.rows.map(r => [r.row.id, r]));
  const items = MOVER_IDS.map(id => byId[id]).filter(r => r && r.now);
  if (!items.length) { host.replaceChildren(); return; }
  const tp = BARO.pillars.find(p => ["trend", "mom12", "trendLT"].includes(p.id));
  host.replaceChildren(h("div", { class: "movers" },
    h("div", { class: "movers-head" }, h("div", { class: "eyebrow" }, `Was steigt, was fällt? ${hzWord()}`, info(() => ({ t: "Was steigt, was fällt?",
      d: `Acht Anlagen aus dem Anlagebarometer im Kurzformat, Horizont: ${BARO.horizon.title} (umschaltbar im Barometer).`,
      f: [`Signal: Stufe aus dem gewichteten Mittel der Säulen ${BARO.pillars.map(p => p.label).join(", ")} (Rechenweg im Barometer).`, `Trendpfeil: Säule ${tp ? tp.label : "Trend"} über +0,3 = Aufwärtstrend, unter −0,3 = Abwärtstrend, sonst seitwärts.`, "1 Monat: letzter Kurs ÷ Kurs vor 30 Tagen − 1."] }), "Was steigt, was fällt")), h("a", { href: "#barometer", class: "small", text: "Alle Signale" })),
    h("div", { class: "movers-grid" }, ...items.map(r => {
      const c = r.now.cat;
      return h("a", { class: "mover", href: "#baro-" + r.row.id, title: `${moverName(r)}: Signal ${c.label} (${fmt(r.now.score, 2)}), ${BARO.horizon.title}` },
        h("span", { class: "m-name", text: moverName(r) }),
        h("span", { class: "m-sub", text: trendWord(r) }),
        h("span", { class: "m-perf", text: `1 Monat ${signed(100 * (r.perf.m1 ?? NaN), 1)} %` }),
        h("span", { class: "m-sig" }, h("span", { class: `sig-badge o${c.n}`, text: c.sym }), h("span", { class: "trend-arrow", text: c.label })));
    }))));
}

/* ------------------------------------------------------------------ Anlagebarometer */
// Raster wie in einer Monatsübersicht: sechs Teilspalten, Balken über zwei davon; Startspalte = Stufe + 2
const GROUP_LABELS = { klassen: "Anlageklassen", aktien: "Aktien", anleihen: "Staatsanleihen", kredit: "Unternehmensanleihen", waehrungen: "Währungen gegenüber dem US-Dollar", rohstoffe: "Rohstoffe", relativ: "Relative Stärke", gold: "Gold und Silber" };
function barEl(label, short, n, prevN, title) {
  const chg = prevN != null && prevN !== n;
  const sym = (SIG.cfg.cats.find(c => c.n === n) || {}).sym || "";
  const el = h("span", { class: `pg-bar c${n}${chg ? " chg " + (n > prevN ? "up" : "down") : ""}`, style: `left:${(n + 2) * 16.6667}%`, title, "data-short": short || "", "data-sym": sym },
    chg ? h("i", { "aria-hidden": "true" }) : null, h("b", { text: label }));
  if (chg) el.style.setProperty("box-shadow", "none"), el.style.setProperty("background", `var(--o${n})`);
  return el;
}
function fitBars(root) { // Namen, die nicht in den Balken passen, durch die Kurzform ersetzen
  const run = () => root.querySelectorAll(".pg-bar").forEach(b => {
    const t = b.querySelector("b");
    if (!t.dataset.full) t.dataset.full = t.textContent;
    t.textContent = t.dataset.full;
    if (t.scrollWidth > t.clientWidth + 1 && b.dataset.short) t.textContent = b.dataset.short;
  });
  new ResizeObserver(run).observe(root);
  requestAnimationFrame(run);
}
function perfDiv(v, cls) {
  if (v == null || !isFinite(v)) return h("div", { class: "pg-num " + cls, text: "–" });
  return h("div", { class: `pg-num ${cls} ${v > 0.0005 ? "up" : v < -0.0005 ? "down" : ""}`, text: signed(100 * v, 1) + " %" });
}
function heatColor(s) {
  if (s == null) return "transparent";
  const c = SIG.category(s).n;
  return cssVar(["--neg2", "--neg1", "--neu", "--pos1", "--pos2"][c + 2]);
}
function heatInk(s) { const c = s == null ? 0 : SIG.category(s).n; return Math.abs(c) === 2 ? "#fff" : cssVar("--ink"); }
function pillarBar(s) {
  const w = s == null ? 0 : Math.min(1, Math.abs(s) / 2) * 50;
  return h("span", { class: "pbar", "aria-hidden": "true" }, s == null ? null : h("i", { style: `${s >= 0 ? "left:50%" : `left:${50 - w}%`};width:${w}%;background:${heatColor(s)}` }));
}
function fmtPart(q) {
  if (q.v == null) return "";
  const d = Math.abs(q.v) >= 100 ? 0 : Math.abs(q.v) >= 10 ? 1 : 2;
  const unit = q.u === "%" ? " %" : q.u === "Pp." ? " Pp." : q.u === "σ" ? " σ" : q.u ? " " + q.u : "";
  return (q.u === "%" || q.u === "Pp." || q.u === "σ" || q.u === "% p. a." ? signed(q.v, d) : fmt(q.v, d)) + unit;
}
const SOFT = "Jeder Teilwert wird weich auf −2 bis +2 begrenzt: 2 × tanh(z ÷ 2).";
const VINTAGE = "IWF-Prognosen und Bevölkerungsprojektionen gibt es nur im jüngsten Stand; Vormonat und Rückrechnung verwenden ihn ebenfalls.";
const G_PARTS = ["Je Land: IWF-Prognose des realen Wachstums, Mittel der nächsten fünf Jahre: (Wachstum − 2 %) ÷ 1,5 Pp.", "Bevölkerung von 15 bis 64 Jahren (Projektion der Weltbank), Veränderung pro Jahr über die nächsten zehn Jahre ÷ 0,5 %.", "BIP je Erwerbstätigem, Wachstum pro Jahr über die letzten zehn Jahre: (Wachstum − 1 %) ÷ 1 Pp.", "Länderwert = Mittel der Teile; Körbe und Welt: gewichtetes Mittel der Länder."];
const D_PARTS = ["Schuldenlast je Land: Staatsschulden (Quote − 60 %) ÷ 40 Pp.; Veränderung der Quote bis in fünf Jahren laut IWF ÷ 10 Pp.; Haushaltssaldo −(Saldo + 3 %) ÷ 3 Pp.; Zins minus nominales Wachstum (Rendite 10 Jahre minus IWF-Prognose für Wachstum und Inflation) ÷ 1,5 Pp.", "Schuldenlast = Mittel der Teile (positiv = hohe Last)."];
const P_PARTS = ["Je Land: Veränderung des Anteils an der Weltwirtschaft (Kaufkraftparitäten, IWF) pro Jahr über zehn Jahre (fünf zurück, fünf Projektion) ÷ 1 %.", "Leistungsbilanz, Mittel der nächsten fünf Jahre (IWF) ÷ 3 % des BIP.", "Länderwert = Mittel; Körbe: gewichtetes Mittel."];
const C12 = ["Teilsäule Frühindikator: wie beim Ausblick 1 Monat.", "Teilsäule IWF-Prognose: Wachstum der nächsten zwölf Monate = (1 − a) × Prognose laufendes Jahr + a × Prognose nächstes Jahr (a = abgelaufener Teil des Jahres), ebenso für die letzten zwölf Monate; Wert = (künftig − bisher) ÷ 0,7 Pp.", "Säule = Mittel beider Teilsäulen."];
const PILLAR_RULES = {
  trend: { all: ["Rendite über 3, 6 und 12 Monate ÷ (annualisierte Volatilität × √(Monate ÷ 12)) ergibt je Zeitraum einen z-Wert.", "Abstand zum 200-Tage-Schnitt (bei Monatsreihen: 10-Monats-Schnitt) ÷ (Volatilität × 0,45).", "Säule = 0,6 × Mittel der Renditewerte + 0,4 × Abstandswert."] },
  cycle: {
    equity: ["OECD-Frühindikator der Region: Wert = 1,4 × Veränderung über 3 Monate + 0,3 × (Niveau − 100); bei mehreren Regionen das Mittel."],
    commodity: ["OECD-Frühindikator der Region bzw. der Welt (Mittel aus USA, Eurozone, China, Japan, Großbritannien, Indien): 1,4 × Veränderung über 3 Monate + 0,3 × (Niveau − 100)."],
    bond: ["Wachstum: −0,7 × Frühindikator-Wert der Region (gute Konjunktur belastet Anleihen).", "Inflation: −(Veränderung der Inflationsrate über 6 Monate ÷ 0,8 Pp.).", "Säule = Mittel beider Werte."],
    fx: ["Wachstumsvorsprung = Frühindikator-Wert der Region − Wert der USA (beim Dollar: USA − Welt; bei EUR/CHF: Eurozone − Schweiz)."],
    gold: ["Weltkonjunktur: −0,5 × Frühindikator-Wert der Welt.", "US-Inflation: Veränderung der Inflationsrate über 6 Monate ÷ 0,8 Pp.", "Säule = Mittel beider Werte."],
    relative: ["Wachstumsvorsprung der ersten gegenüber der zweiten Region; Aktien vs. Anleihen: US-Frühindikator; Gold vs. Aktien: −0,6 × US-Frühindikator; Gold vs. Anleihen: Veränderung der US-Inflation über 6 Monate ÷ 0,8 Pp."],
  },
  value: {
    equity: ["Gerade durch die logarithmierten Monatskurse der letzten 10 Jahre; z = Abstand des heutigen Kurses zur Geraden ÷ Standardabweichung der Abstände.", "Wert = −z ÷ 1,2 (deutlich über dem Trend = teuer = negativ).", "USA zusätzlich Shiller-KGV: 4 × (0,5 − Perzentil seit 1881); Säule = Mittel beider."],
    commodity: ["Gerade durch die logarithmierten Monatskurse der letzten 10 Jahre; z = Abstand des heutigen Kurses ÷ Standardabweichung der Abstände.", "Wert = −z ÷ 1,2."],
    bond: ["Realrendite = Rendite 10 Jahre − Inflationsrate.", "z = (Realrendite − Mittel der letzten 10 Jahre) ÷ Standardabweichung; Wert = 0,9 × z (hohe Realrendite = günstig = positiv). Ohne Historie: Realrendite ÷ 1,2."],
    credit: ["z = (Risikoprämie − Mittel der letzten 10 Jahre) ÷ Standardabweichung; hohe Prämie = günstig = positiv."],
    fx: ["Abweichung des realen effektiven Wechselkurses (BIZ) von seinem 10-Jahres-Mittel in %.", "Wert = −Abweichung ÷ 7 %. Gegenüber dem Dollar zählt der Unterschied: −(Abweichung der Währung − Abweichung des Dollars) ÷ 10 %."],
    gold: ["Realer Goldpreis = Goldpreis ÷ US-Verbraucherpreisindex; z = Abstand zum 10-Jahres-Trend (wie bei Aktien).", "Wert = −z ÷ 1,2."],
    relative: ["z = Abstand des Verhältnisses zu seinem log-linearen 10-Jahres-Trend ÷ Standardabweichung der Abstände.", "Wert = −z ÷ 1,2 (weit vorn = Rückschlagrisiko)."],
  },
  liquidity: {
    equity: ["Leitzinsänderung über 12 Monate: −Änderung ÷ 0,6 Pp. (Senkungen stützen).", "Zinskurve = Rendite 10 Jahre − Leitzins, geteilt durch 1 Pp.", "USA: Fed-Bilanz über 6 Monate ÷ 3 %.", "Schwellenländer und Rohstoffe: −Veränderung des Dollarindex über 6 Monate ÷ 4 %.", "Säule = Mittel der vorhandenen Teile."],
    bond: ["Leitzinsänderung über 6 Monate: −Änderung ÷ 0,4 Pp.", "USA: Markterwartung = 2-jährige Rendite − Leitzins, Wert = −Erwartung ÷ 0,5 Pp. (erwartete Senkungen stützen).", "Säule = Mittel."],
    fx: ["Veränderung der Zinsdifferenz zur Vergleichswährung über 6 Monate ÷ 0,5 Pp.", "Niveau der Zinsdifferenz ÷ 3 Pp. × 0,5.", "Dollar: Fed-Leitzinsänderung über 6 Monate ÷ 0,5 Pp.", "Säule = Mittel."],
    gold: ["Reale US-Rendite (TIPS), Veränderung über 6 Monate: −Änderung ÷ 0,4 Pp.", "Dollarindex über 6 Monate: −Veränderung ÷ 4 %.", "Säule = Mittel."],
  },
  risk: { all: ["Risikoappetit = Mittel aus: VIX gegenüber seinem Jahresmedian (−Abweichung ÷ 5), Hochzins-Risikoprämie über 3 Monate (−Änderung ÷ 0,6 Pp.), Finanzstressindex (−Wert ÷ 1,2) und geopolitischem Risiko (−Abweichung ÷ 1,5 σ).", "Säule = Risikoappetit × Risikobeta der Anlage (Aktien +1, Schwellenländer +1,2, Rohstoffe +0,7, Gold −0,7, Franken und Yen −0,9 …) + Gewicht × Spannungsabweichung der betroffenen Konfliktlinien, begrenzt auf ±2."] },
  cycle12: {
    equity: [...C12, "Körbe und Welt: gewichtetes Mittel der Länder.", VINTAGE],
    bond: [...C12, "Anleihen: Wachstumsprognose invers (× −0,7) und IWF-Inflationsprognose: −(künftig − bisher) ÷ 0,6 Pp.", VINTAGE],
    fx: [...C12, "Währungen: Vorsprung der Region vor den USA (Dollar: USA vor Welt; EUR/CHF: Eurozone vor Schweiz).", VINTAGE],
    gold: [...C12, "Gold: Weltwachstum invers (× −0,5).", VINTAGE],
    relative: [...C12, "Vorsprung der ersten Region; Aktien vs. Anleihen: US-Wachstum; Gold vs. Aktien: −0,6 × US-Wachstum; Gold vs. Anleihen: US-Inflation (künftig − bisher) ÷ 0,6 Pp.", VINTAGE],
  },
  mom12: { all: ["Rendite der letzten zwölf Monate ohne den jüngsten Monat ÷ annualisierte Volatilität (Zeitreihen-Momentum; der letzte Monat bleibt außen vor, weil kurzfristige Ausschläge oft umkehren).", "Abstand zum Zwölfmonatsmittel ÷ (Volatilität × 0,5).", "Säule = 0,7 × Momentum + 0,3 × Abstand."] },
  valueLT: {
    equity: ["Gerade durch die logarithmierten Monatskurse der letzten bis zu 20 Jahre; z = Abstand des heutigen Kurses ÷ Standardabweichung der Abstände; Wert = −z ÷ 1,2.", "USA: Shiller-KGV, 4 × (0,5 − Perzentil seit 1881); Säule = 0,4 × Trendwert + 0,6 × KGV-Wert (das KGV sagt die Rendite der nächsten zehn Jahre am besten voraus)."],
    commodity: ["Realer Preis (Preis ÷ US-Verbraucherpreisindex) gegenüber seinem log-linearen Trend der letzten bis zu 20 Jahre; Wert = −z ÷ 1,2."],
    bond: ["Erwartete Realrendite = Rendite 10 Jahre − mittlere IWF-Inflationsprognose der nächsten fünf Jahre.", "Wert = (Realrendite − 1 %) ÷ 1 Pp.; über 1 % gilt als attraktiv. Körbe: gewichtetes Mittel der Länder.", VINTAGE],
    credit: ["Risikoprämie − langjähriger Median (ICE BofA seit 1997: Hochzins USA 4,5, Investment Grade 1,3, Hochzins Euro 4,3 Pp.), geteilt durch 1,5 Pp.; hohe Prämie = günstig = positiv."],
    fx: ["Abweichung des realen effektiven Wechselkurses (BIZ) vom Mittel seit Beginn der Reihe (meist 2000) in %; gegenüber dem Dollar zählt der Unterschied zur Abweichung des Dollars.", "Wert = −Unterschied ÷ 12 %."],
    gold: ["Realer Goldpreis = Goldpreis ÷ US-Verbraucherpreisindex, Monatswerte seit August 1971 (Ende der Goldbindung des Dollars).", "Perzentil des heutigen Werts: 3 × (0,5 − Perzentil); dazu z-Abstand zum log-linearen Trend seit 1971: −z ÷ 1,2; Säule = Mittel.", "Gold in Franken und Euro nutzt den Dollarpreis (Gold hat weltweit einen Preis); Silber: realer Preis seit 2005."],
    relative: ["z = Abstand des Verhältnisses zu seinem log-linearen Trend der letzten bis zu 20 Jahre; Wert = −z ÷ 1,2."],
  },
  growth: {
    equity: [...G_PARTS, VINTAGE],
    bond: [...G_PARTS, "Anleihen: −0,5 × Länderwert (kräftiges Wachstum hebt die Realzinsen).", VINTAGE],
    fx: [...G_PARTS, "Währungen: Länderwert minus Wert der USA (Dollar: USA minus Welt; EUR/CHF: Eurozone minus Schweiz).", VINTAGE],
    commodity: [...G_PARTS, "Rohstoffe: Weltwirtschaft; Kupfer mit Schwerpunkt China.", VINTAGE],
    relative: [...G_PARTS, "Vorsprung der ersten Region; Aktien vs. Anleihen: USA; Gold vs. Aktien: −0,5 × USA.", VINTAGE],
  },
  debt: {
    equity: [...D_PARTS, "Aktien und Unternehmensanleihen: −0,6 × Schuldenlast.", VINTAGE],
    bond: [...D_PARTS, "Staatsanleihen: −1 × Schuldenlast.", VINTAGE],
    fx: [...D_PARTS, "Währungen: −(Last des Landes − Last der Vergleichswährung), weich begrenzt; Dollar: −0,8 × Last der USA.", VINTAGE],
    gold: [...D_PARTS, "Gold: Schuldenlast der Reservewährungsländer (USA 50 %, Eurozone 15 %, Japan 15 %, Großbritannien 10 %, China 10 %), positiv gewertet: hohe Schulden sprechen für Gold als Wertspeicher.", VINTAGE],
    relative: [...D_PARTS, "Vorsprung: −0,6 × Mehrbelastung der ersten Region; Gold vs. Aktien +0,8 × Last der USA, Gold vs. Anleihen +1 × Last der USA, Aktien vs. Anleihen +0,4 × Last der USA.", VINTAGE],
  },
  power: {
    equity: [...P_PARTS, VINTAGE],
    fx: [...P_PARTS, "Währungen zusätzlich: Anteil an den Weltdevisenreserven (IWF COFER), Veränderung über fünf Jahre ÷ 2 Pp.", "Wert = Länderwert minus Wert der USA; Dollar: Wert der USA.", VINTAGE],
    gold: [...P_PARTS, "Zusätzlich der Dollaranteil an den Weltdevisenreserven, Veränderung über fünf Jahre ÷ 2 Pp.", "Gold: −0,8 × Machtposition der USA (nachlassende Dominanz des Dollars stützt Gold).", VINTAGE],
    relative: [...P_PARTS, "Vorsprung der ersten Region; Gold-Verhältnisse wie Gold.", VINTAGE],
  },
  trendLT: { all: ["Steigung des log-linearen Zehnjahrestrends (pro Jahr) ÷ (Volatilität × 0,5).", "Rendite über drei Jahre ÷ (Volatilität × √3).", "Säule = Mittel beider Werte."] },
};
function pillarRules(pid, kind) {
  const R = PILLAR_RULES[pid];
  if (!R) return [];
  if (R.all) return R.all;
  return R[kind] || R.equity || [];
}
// Unternehmensanleihen folgen bei Konjunktur, Liquidität und den Strukturfaktoren der Aktienlogik
const ruleKind = (row, pid) => (row.kind === "credit" && pid !== "value" && pid !== "valueLT" ? "equity" : row.kind);
function pillarInfo(r, p) {
  return () => {
    const pp = r.now.pillars[p.id];
    const w = BARO.weights[r.row.kind][p.id];
    return {
      t: `${r.row.label}: ${p.label} (${BARO.horizon.label})`,
      d: p.desc,
      f: [...pillarRules(p.id, ruleKind(r.row, p.id)), SOFT],
      r: pp ? [...pp.parts.map(q => `${q.sub ? "· " : ""}${q.k}${q.d ? ` (${q.d})` : ""}: ${q.v == null ? "" : fmtPart(q) + (q.s == null ? "" : " → ")}${q.s == null ? "" : "Teilwert " + signed(q.s, 2)}`), `Säule = ${signed(pp.s, 2)}, Gewicht ${fmt(100 * w, 0)} %`] : "Keine Daten für diese Säule.",
    };
  };
}
function scoreInfo(r) {
  return () => {
    const W = BARO.weights[r.row.kind];
    const used = BARO.pillars.filter(p => W[p.id] && r.now.pillars[p.id]);
    const den = used.reduce((a, p) => a + W[p.id], 0);
    return {
      t: `${r.row.label}: Gesamtwert und Stufe (${BARO.horizon.label})`,
      d: `Der Gesamtwert fasst die Säulen des Horizonts „${BARO.horizon.title}“ zusammen und bestimmt die Stufe auf der Skala.`,
      f: ["Gesamtwert = Σ (Gewicht × Säulenwert) ÷ Σ Gewichte der vorhandenen Säulen.", `Stufen: ${SIG.cfg.cats.map((c, i) => `${c.sym} ${c.max === Infinity ? `über ${fmt(SIG.cfg.cats[i - 1].max, 1)}` : `bis ${fmt(c.max, 1)}`}`).join(", ")}.`, `Toleranzband: Gegenüber der Vormonatsstufe wechselt die Stufe erst, wenn die Schwelle um mehr als ${fmt(SIG.cfg.hyst, 1)} überschritten ist.`],
      r: [`(${used.map(p => `${fmt(W[p.id], 2)} × ${signed(r.now.pillars[p.id].s, 2)}`).join(" + ")}) ÷ ${fmt(den, 2)} = ${signed(r.now.score, 2)}`,
        `Stufe: ${r.now.cat.sym} ${r.now.cat.label}` + (r.now.raw && r.now.raw.n !== r.now.cat.n ? ` (rechnerisch ${r.now.raw.label}, Toleranzband)` : "") + (r.prev && r.prev.cat ? `; Vormonat ${signed(r.prev.score, 2)} (${r.prev.cat.label})` : "")],
    };
  };
}
function detailPanel(r) {
  const w = BARO.weights[r.row.kind];
  const cards = BARO.pillars.map(p => {
    if (!w[p.id]) return null;
    const pp = r.now.pillars[p.id];
    return h("div", { class: "pillar" },
      h("h5", null, h("span", null, p.label, info(pillarInfo(r, p), `${p.label} für ${r.row.label}`), h("span", { class: "nowrap", text: ` · Gewicht ${fmt(100 * w[p.id], 0)} %` })), h("span", null, pp ? signed(pp.s, 2) : "keine Daten", " ", pillarBar(pp ? pp.s : null))),
      pp ? h("ul", null, ...pp.parts.filter(q => q.v != null || q.s != null).map(q => h("li", { class: q.sub ? "sub" : null }, h("span", { text: q.k + (q.d ? ` (${q.d})` : "") }), h("span", { class: "v", text: q.v == null ? (q.s != null ? signed(q.s, 2) : "") : fmtPart(q) }))))
        : h("p", { class: "small", text: "Für diese Säule liegen keine Daten vor; sie entfällt, die übrigen Gewichte werden hochgerechnet." }));
  }).filter(Boolean);
  const H = signalHistory(BARO.hz);
  const strip = H && H.rows[r.row.id] ? (() => {
    const cols = historyCols(H, 13);
    const out = h("div", { class: "small hist-mini-read", text: "" });
    return h("div", { class: "hist-mini" }, h("span", { class: "small", text: "Verlauf 12 Monate" }),
      h("span", { class: "hist-mini-cells" }, ...cols.map(c => histCell(H, r.row.id, c, t => { out.textContent = t; }))), out);
  })() : null;
  return h("div", { class: "pg-detail", hidden: true },
    h("div", { class: "pillars" }, ...cards),
    strip,
    h("p", { class: "small", style: "margin-top:8px" },
      `${r.row.label}${r.row.sub ? " (" + r.row.sub + ")" : ""}, ${BARO.horizon.title}: Gesamtwert ${signed(r.now.score, 2)} auf der Skala −2 bis +2, Datenstand ${deShort(SIG.isoOf(r.now.date))}; abgedeckt sind ${fmt(100 * r.now.coverage, 0)} % der Säulengewichte.`,
      r.prev && r.prev.cat ? ` Vor einem Monat: ${signed(r.prev.score, 2)} (${r.prev.cat.label}).` : "",
      r.now.raw && r.now.raw.n !== r.now.cat.n ? ` Die Stufe bleibt wegen des Toleranzbands bei „${r.now.cat.label}“; rechnerisch läge der Wert bei „${r.now.raw.label}“.` : "",
      r.perf ? ` Seit Jahresbeginn ${signed(100 * (r.perf.ytd ?? NaN), 1)} %, drei Monate ${signed(100 * (r.perf.m3 ?? NaN), 1)} %.` : "",
      info(scoreInfo(r), `Gesamtwert ${r.row.label}`)));
}
function gridHead(extra = true) {
  return h("div", { class: "pg-group pg-hgroup" }, h("div", { class: "pg-glabel gl-h" }),
    h("div", { class: "pg-head" },
      h("div", { class: "pg-scale-h" }, h("span", { text: "negativ −" }), h("span", { text: "neutral o" }), h("span", { text: "positiv +" })),
      extra ? h("div", { class: "h spark-h", text: "6 Monate" }) : h("div"), extra ? h("div", { class: "h num-h m1-h", text: "1 Monat" }) : h("div"),
      extra ? h("div", { class: "h num-h", text: "12 Monate" }) : h("div"), h("div")));
}
function gridRow(r, prefix = "baro-") {
  const c = r.now.cat, pc = r.prev && r.prev.cat ? r.prev.cat.n : null;
  const title = `${r.row.label}${r.row.sub ? " (" + r.row.sub + ")" : ""}: ${c.label} (${signed(r.now.score, 2)})${pc != null ? `; vor einem Monat ${r.prev.cat.label}` : ""}. ${trendWord(r)}.`;
  const st = staleNote(r);
  const row = h("div", { class: "pg-row", id: prefix + r.row.id, role: "button", tabindex: "0", "aria-expanded": "false", "aria-label": title + (st ? ` Datenstand: ${st.long}.` : "") },
    h("div", { class: "pg-name", "aria-hidden": "true", text: r.row.label }),
    h("div", { class: "pg-track" }, barEl(r.row.label, r.row.short, c.n, pc, title),
      st ? h("span", { class: `pg-stale ${c.n >= 1 ? "l" : "r"}`, title: st.long, text: st.short }) : null),
    h("div", { class: "pg-spark" }, sparkline(r.spark, "--ink-2")),
    perfDiv(r.perf.m1, "m1"), perfDiv(r.perf.y1, "y1"),
    h("div", { class: "pg-caret", "aria-hidden": "true", text: "▸" }));
  const det = detailPanel(r);
  const toggle = () => { det.hidden = !det.hidden; row.setAttribute("aria-expanded", String(!det.hidden)); row.lastChild.textContent = det.hidden ? "▸" : "▾"; };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  return [row, det];
}
function renderHorizonDesc() {
  const el = document.getElementById("baro-hz-desc");
  if (!el || !BARO) return;
  el.replaceChildren(h("b", { text: BARO.horizon.title + ": " }), BARO.horizon.desc, ` Säulen: ${BARO.pillars.map(p => p.label).join(", ")}.`);
}
function renderBarometer() {
  const host = document.getElementById("baro-groups");
  const legend = document.getElementById("baro-legend");
  if (!BARO) {
    host.replaceChildren(h("p", { class: "small", text: "Die Live-Daten konnten nicht geladen werden. Das Barometer erscheint, sobald der Worker einen Datenstand liefert." }));
    return;
  }
  legend.replaceChildren(
    ...SIG.cfg.cats.map(c => h("span", { class: "lg" }, h("span", { class: "lg-bar", style: `background:var(--o${c.n})` }), `${c.sym} ${c.label}`)),
    h("span", { class: "lg" }, h("span", { class: "lg-chev" }), "geändert gegenüber dem Vormonat (Pfeilrichtung)"));
  let view = "scale";
  const draw = () => {
    document.getElementById("baro-tag").textContent = `${BARO.horizon.label} · Stand ${deShort(SIG.isoOf(BARO.tNow))}`;
    host.replaceChildren();
    if (view === "scale") {
      const sh = sheet(host, { title: `Monatsübersicht der Signale · ${BARO.horizon.title}`, sub: `Einstufung zum ${deShort(SIG.isoOf(BARO.tNow))}; Zeile antippen für die Säulen im Einzelnen. Gold, Silber und Gold im Vergleich: eigene Übersicht unten`, info: baroInfo });
      const grid = h("div", { class: "pgrid" }, gridHead(true));
      for (const g of BARO.groups) {
        if (g.id === "gold") continue;
        const rows = BARO.rows.filter(r => r.row.group === g.id && r.now);
        if (!rows.length) continue;
        grid.append(h("div", { class: "pg-group" },
          h("div", { class: "pg-glabel" }, GROUP_LABELS[g.id] || g.label, g.note ? h("small", { text: g.note }) : null),
          h("div", { class: "pg-rows" }, ...rows.flatMap(r => gridRow(r)))));
      }
      sh.body.append(h("div", { style: "overflow-x:auto" }, grid));
      fitBars(grid);
      const f = h("footer", { class: "src" });
      srcLinks(f, liveSrcIds(...new Set(BARO.rows.flatMap(r => collectIds(r.row.price)))));
      sh.el.append(f);
    } else if (view === "hist") {
      renderHistory(host);
    } else {
      for (const g of BARO.groups) {
        const rows = BARO.rows.filter(r => r.row.group === g.id && r.now);
        if (!rows.length) continue;
        const sh = sheet(host, { title: GROUP_LABELS[g.id] || g.label, sub: g.note === "eigene Monatsübersicht" ? BARO.horizon.title : [g.note, BARO.horizon.title].filter(Boolean).join(" · "), info: () => ({ d: `Säulenwerte der Anlagen dieser Gruppe auf der Skala −2 bis +2 (${BARO.horizon.title}); Farbe = Stufe des Werts.`, f: [`Spalten ${BARO.pillars.map(p => p.label).join(", ")}: Säulenwerte (Rechenweg im Barometer: Zeile antippen, dann ⓘ an der Säule).`, "Gesamt = gewichtetes Mittel der Säulen; Vormonat = dieselbe Rechnung mit dem Datenstand von vor 30 Tagen.", "· = Säule zählt für diese Anlageart in diesem Horizont nicht."] }) });
        sh.body.append(h("div", { style: "overflow-x:auto" }, heatTable(rows)));
      }
    }
    const missing = BARO.rows.filter(r => !r.now && !(r.row.horizons && !r.row.horizons.includes(BARO.hz))).map(r => r.row.label + (r.row.sub ? ` (${r.row.sub})` : ""));
    const skipped = BARO.rows.filter(r => r.row.horizons && !r.row.horizons.includes(BARO.hz)).map(r => r.row.label);
    if (missing.length) host.append(h("p", { class: "small", text: `Derzeit ohne ausreichende Daten und daher nicht eingestuft: ${missing.join(", ")}.` }));
    if (skipped.length) host.append(h("p", { class: "small", text: `Ohne langfristige Einstufung, weil ein fundamentaler Bewertungsanker fehlt: ${skipped.join(", ")}.` }));
  };
  const seg = document.getElementById("baro-view");
  seg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    view = b.dataset.v;
    seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
  const hzSeg = document.getElementById("baro-hz");
  const markHz = () => hzSeg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.h === HZ)));
  hzSeg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.h === HZ) return;
    setHorizon(b.dataset.h);
    if (!BARO) { setHorizon("m1"); }
    markHz();
    renderHorizonDesc();
    draw();
    for (const f of [renderGold, renderBaroSummary, renderBaroMethod, renderMovers]) { try { f(); } catch (e) { console.error(f.name, e); } }
  }));
  markHz();
  renderHorizonDesc();
  draw();
  renderGold();
  renderBaroSummary();
  renderBaroMethod();
}
function collectIds(spec) {
  if (spec == null) return [];
  if (typeof spec === "string") return [spec === "gold_usd_long" ? "gold_usd" : spec];
  if (Array.isArray(spec)) return collectIds(spec[0]);
  if (spec.bond) return [spec.bond];
  if (spec.spread) return [spec.spread];
  if (spec.inv) return collectIds(spec.inv);
  return (spec.ratio || spec.product || spec.basket || []).flatMap(collectIds);
}
function heatTable(rows) {
  const P = BARO.pillars;
  const cell = s => h("td", null, h("div", { class: "heat-cell", style: `background:${heatColor(s)};color:${heatInk(s)}`, text: s == null ? "–" : signed(s, 1) }));
  return h("table", { class: "baro-table" },
    h("thead", null, h("tr", null, h("th", { text: "Anlage" }), ...P.map(p => h("th", { style: "text-align:center", title: p.desc, text: p.label })), h("th", { style: "text-align:center", text: "Gesamt" }), h("th", { style: "text-align:center", text: "Vormonat" }))),
    h("tbody", null, ...rows.map(r => h("tr", null,
      h("td", { class: "name" }, h("b", { text: r.row.label }), r.row.sub ? h("span", { class: "small", text: r.row.sub }) : null),
      ...P.map(p => (BARO.weights[r.row.kind][p.id] ? cell(r.now.pillars[p.id] ? r.now.pillars[p.id].s : null) : h("td", null, h("div", { class: "heat-cell", style: "color:var(--muted)", text: "·" })))),
      cell(r.now.score), cell(r.prev ? r.prev.score : null)))));
}
function baroInfo() {
  const H = BARO.horizon;
  return {
    d: [`Für jede Anlage ein Signal von klar negativ bis klar positiv. ${H.desc}`, `Säulen in diesem Horizont: ${BARO.pillars.map(p => p.label).join(", ")}. Der Umschalter über der Übersicht wechselt zwischen 1 Monat, 12 Monaten und 5–10 Jahren; mit dem Horizont wechseln Säulen und Gewichte.`],
    f: ["Jede Säule rechnet Rohwerte (Renditen, Zinsänderungen, Bewertungsabstände, Prognosen …) in z-Werte um und begrenzt sie weich auf −2 bis +2.",
      "Gesamtwert = gewichtetes Mittel der Säulen; die Gewichte hängen von Anlageart und Horizont ab (Methodik unten).",
      "Stufen: bis −0,9 klar negativ, bis −0,3 negativ, bis +0,3 neutral, bis +0,9 positiv, darüber klar positiv; Toleranzband 0,1 gegenüber dem Vormonat.",
      "Pfeilbalken: Stufe hat sich gegenüber dem Vormonat geändert (Datenstand vor 30 Tagen, Monatsreihen nach ihrer Veröffentlichungsfrist).",
      "1 Monat und 12 Monate: letzter Kurs ÷ Kurs vor 30 bzw. 365 Tagen − 1. „Stand …“: jüngster Wert älter als eine Woche oder nur als Monatswert verfügbar."],
    s: "Rechenweg je Anlage: Zeile antippen, dann ⓘ an der Säule oder am Gesamtwert. Keine Anlageberatung.",
  };
}

/* ------------------------------------------------------------------ Monatsübersicht Gold */
const GOLD_IDS = ["gold_usd", "gold_chf", "gold_eur", "silver", "rel_gold_eq", "rel_gold_bd"];
function goldFacts() {
  const g = LP("gold_usd"), long = LP("gold_usd_long");
  if (!g.length) return [];
  const a = g[g.length - 1], DAYMS = 864e5;
  const inCur = id => { const b = SIG.valueAt(LP(id), a.t); return b && a.t - b.t <= 7 && b.v ? { v: a.v / b.v, d: b.t } : null; };
  const y = new Date(a.t * DAYMS).getUTCFullYear();
  const y0 = SIG.valueAt(g, Date.UTC(y, 0, 1) / DAYMS - 1);
  const ytd = y0 && y0.t > Date.UTC(y - 1, 11, 1) / DAYMS ? a.v / y0.v - 1 : null;
  const ath = (long.length ? long : g).reduce((m, q) => (q.v > m.v ? q : m), a);
  const real = SIG.realMonthly(LIVE, long.length ? long : g, null).filter(q => q.x >= 1971.6);
  const rl = real[real.length - 1];
  const pct = rl ? real.filter(q => q.v <= rl.v).length / real.length : null;
  const sil = LP("silver_usd"), sl = sil[sil.length - 1];
  const gm = sl ? SIG.monthlyMeans(long.length ? long : g) : [];
  const gAt = sl ? gm.find(q => q.t === sl.t) : null;
  const ratios = sil.map(q => { const m = gm.find(x => x.t === q.t); return m ? m.v / q.v : null; }).filter(v => v != null);
  const chf = inCur("fx_chf"), eur = inCur("fx_eur");
  const out = [
    { label: "Gold in US-Dollar", value: fmt(a.v, 0), unit: "US-$/Unze", meta: [deShort(SIG.isoOf(a.t)), ytd == null ? "" : `seit Jahresbeginn ${signed(100 * ytd, 1)} %`],
      info: { t: "Gold in US-Dollar", f: ["Tagespreis: Goldpreis der polnischen Notenbank (PLN je Gramm) × 31,1035 g je Feinunze ÷ Dollarkurs der Notenbank (PLN je US-$).", "Seit Jahresbeginn: Preis ÷ letzter Preis des Vorjahres − 1."], r: ytd == null ? null : calc(fmt(a.v, 0), "÷", fmt(y0.v, 0), "− 1 =", signed(100 * ytd, 1) + " %") } },
    chf && { label: "Gold in Franken", value: fmt(chf.v, 0), unit: "CHF/Unze", meta: ["Dollarpreis ÷ Franken in US-$"],
      info: { t: "Gold in Franken", f: "Goldpreis in US-Dollar ÷ Preis eines Frankens in US-Dollar (EZB-Referenzkurse: USD je EUR ÷ CHF je EUR), gleicher Tag oder bis zu sieben Tage zuvor.", r: calc(fmt(a.v, 0), "÷", fmt(a.v / chf.v, 4), "=", fmt(chf.v, 0) + " CHF") } },
    eur && { label: "Gold in Euro", value: fmt(eur.v, 0), unit: "EUR/Unze", meta: ["Dollarpreis ÷ Euro in US-$"],
      info: { t: "Gold in Euro", f: "Goldpreis in US-Dollar ÷ Euro-Referenzkurs der EZB (US-$ je Euro).", r: calc(fmt(a.v, 0), "÷", fmt(a.v / eur.v, 4), "=", fmt(eur.v, 0) + " EUR") } },
    { label: "Abstand zum Höchststand", value: signed(100 * (a.v / ath.v - 1), 1), unit: "%", meta: [`Hoch ${fmt(ath.v, 0)} US-$`, ath.t >= a.t - 400 ? deShort(SIG.isoOf(ath.t)) : deMonth(SIG.isoOf(ath.t))],
      info: { t: "Abstand zum Höchststand", f: ["Höchster Wert der Goldreihe (Monatsmittel seit 1960, ab 2023 Tageswerte) in US-Dollar, nicht inflationsbereinigt.", "Abstand = heutiger Preis ÷ Höchststand − 1."], r: calc(fmt(a.v, 0), "÷", fmt(ath.v, 0), "− 1 =", signed(100 * (a.v / ath.v - 1), 1) + " %") } },
    pct != null && { label: "Realer Goldpreis", value: fmt(100 * pct, 0), unit: ". Perzentil", meta: ["seit August 1971", "in heutiger Kaufkraft"],
      info: { t: "Realer Goldpreis im historischen Vergleich", d: "Wie teuer Gold heute in Kaufkraft gemessen ist, verglichen mit allen Monaten seit dem Ende der Goldbindung des Dollars.", f: ["Realer Preis = Monatsmittel des Goldpreises ÷ US-Verbraucherpreisindex.", "Perzentil = Anteil der Monate seit August 1971 mit gleich hohem oder niedrigerem realen Preis × 100."], r: `${real.filter(q => q.v <= rl.v).length} von ${real.length} Monaten ≤ heute → ${fmt(100 * pct, 0)}. Perzentil` } },
    gAt && ratios.length > 24 && { label: "Gold-Silber-Verhältnis", value: fmt(gAt.v / sl.v, 1), unit: "", meta: [deMonth(SIG.isoOf(sl.t)), `Mittel seit ${SIG.isoOf(sil[0].t).slice(0, 4)}: ${fmt(SIG.mean(ratios), 0)}`],
      info: { t: "Gold-Silber-Verhältnis", d: "Wie viele Unzen Silber eine Unze Gold kostet. Hohe Werte zeigen Gold teuer gegenüber Silber, typisch in Krisen.", f: "Monatsmittel Gold ÷ Monatsmittel Silber (IWF-Rohstoffpreise), gleicher Monat; Mittel über alle Monate seit Beginn der Silberreihe.", r: calc(fmt(gAt.v, 0), "÷", fmt(sl.v, 2), "=", fmt(gAt.v / sl.v, 1)) } },
  ];
  return out.filter(Boolean);
}
const GOLD_INFO = () => ({
  d: ["Eigene Monatsübersicht für Gold: Gold in US-Dollar, Franken und Euro, Silber sowie Gold im Verhältnis zu Aktien und Anleihen, jeweils mit Stufe und Änderung zum Vormonat.", `Horizont: ${BARO.horizon.title}. Die Treiber darunter zeigen die Säulen des Signals für Gold in US-Dollar.`],
  f: ["Gold in Franken und Euro: Dollarpreis ÷ Wechselkurs; gleiche Säulenlogik wie Gold in Dollar, die Währungsentwicklung fließt über Trend und Momentum ein.",
    "Gold vs. Aktien und Gold vs. Anleihen: Verhältnis des Goldpreises zum S&P 500 bzw. zum Kursindex 10-jähriger Treasuries; positiv = Gold vorn.",
    "Stufen, Toleranzband und Pfeilbalken wie im Barometer."],
  s: "Rechenweg je Zeile: antippen, dann ⓘ an der Säule. Keine Anlageberatung.",
});
function renderGold() {
  const host = document.getElementById("gold");
  if (!host) return;
  host.replaceChildren();
  if (!BARO) return;
  const rows = GOLD_IDS.map(id => BARO.rows.find(r => r.row.id === id)).filter(r => r && r.now);
  if (!rows.length) return;
  const g = rows.find(r => r.row.id === "gold_usd");
  const sh = sheet(host, { title: `Monatsübersicht Gold · ${BARO.horizon.title}`, sub: `Gold in Dollar, Franken und Euro, Silber sowie Gold im Vergleich zu Aktien und Anleihen; Einstufung zum ${deShort(SIG.isoOf(BARO.tNow))}`, info: GOLD_INFO, cls: "gold-sheet" });
  const facts = goldFacts();
  if (facts.length) sh.body.append(h("div", { class: "gold-facts" }, ...facts.map(x => h("div", { class: "tile" },
    h("div", { class: "label" }, x.label, info(x.info, x.label)),
    h("div", { class: "value" }, x.value, x.unit ? h("small", { text: x.unit }) : null),
    h("div", { class: "meta" }, ...x.meta.filter(Boolean).map(m => h("span", { text: m })))))));
  const grid = h("div", { class: "pgrid" }, gridHead(true), h("div", { class: "pg-group" },
    h("div", { class: "pg-glabel" }, "Gold und Silber", h("small", { text: "positiv = steigend erwartet" })),
    h("div", { class: "pg-rows" }, ...rows.flatMap(r => gridRow(r, "gold-")))));
  sh.body.append(h("div", { style: "overflow-x:auto" }, grid));
  fitBars(grid);
  if (g) {
    sh.body.append(h("h4", { class: "gold-sub" }, `Treiber des Goldsignals (${BARO.horizon.label})`, info(() => ({ t: "Treiber des Goldsignals", d: "Die Säulen des Signals für Gold in US-Dollar einzeln: positiv = stützt den Goldpreis, negativ = belastet ihn.", f: [`Säulen und Gewichte im Horizont ${BARO.horizon.title}: ${BARO.pillars.filter(p => BARO.weights.gold[p.id]).map(p => `${p.label} ${fmt(100 * BARO.weights.gold[p.id], 0)} %`).join(", ")}.`, "Rechenweg je Säule: ⓘ am Säulennamen."], r: `Gesamtwert ${signed(g.now.score, 2)} → ${g.now.cat.label}` }), "Treiber des Goldsignals")));
    const drv = BARO.pillars.filter(p => BARO.weights.gold[p.id]).map(p => ({ p, now: g.now.pillars[p.id] ? g.now.pillars[p.id].s : null, prev: g.prev && g.prev.pillars[p.id] ? g.prev.pillars[p.id].s : null }));
    const dg = h("div", { class: "pgrid" },
      h("div", { class: "pg-group pg-hgroup no-label" }, h("div", { class: "pg-head score drv" }, h("div"),
        h("div", { class: "pg-scale-h" }, h("span", { text: "belastet −" }), h("span", { text: "neutral o" }), h("span", { text: "stützt +" })), h("div", { class: "h num-h", text: "Wert (Vormonat)" }))),
      h("div", { class: "pg-group no-label" }, h("div", { class: "pg-rows" }, ...drv.map(x => {
        if (x.now == null) return h("div", { class: "pg-row score drv" }, h("div", { class: "pg-name", text: x.p.label }), h("div", { class: "pg-track" }, h("span", { class: "small", style: "padding-left:6px", text: "keine Daten" })), h("div", { class: "pg-num y1", text: "–" }));
        const pc = x.prev == null ? null : SIG.category(x.prev).n, c = SIG.category(x.now, pc);
        return h("div", { class: "pg-row score drv" },
          h("div", { class: "pg-name" }, x.p.label, info(pillarInfo(g, x.p), `${x.p.label} für Gold`)),
          h("div", { class: "pg-track" }, barEl(x.p.label, x.p.short, c.n, pc, `${x.p.label}: ${c.label} (${signed(x.now, 2)})`)),
          h("div", { class: "pg-num y1", text: `${signed(x.now, 2)} (${x.prev == null ? "–" : signed(x.prev, 2)})` }));
      }))));
    sh.body.append(h("div", { style: "overflow-x:auto" }, dg));
    fitBars(dg);
  }
  const f = h("footer", { class: "src" });
  srcLinks(f, liveSrcIds("gold_usd", "gold_usd_imf", "silver_usd", "fx_chf", "eq_us", "y10_us", "real10_us", "cpi_us_index"));
  sh.el.append(f);
}

/* ------------------------------------------------------------------ Signalverlauf (D1) */
// Verlauf je Horizont aus dem Snapshot (Job signal_history); ältere Snapshots haben nur einen Eintrag (1 Monat)
function signalHistory(hz = HZ) {
  const items = LIVE && LIVE.items && LIVE.items.signal_history;
  if (!items || !items.length) return null;
  return items.find(x => (x.hz || "m1") === hz) || null;
}
/* je Monat der letzte gespeicherte Tag, dazu der jüngste Tag; höchstens `max` Spalten */
function historyCols(H, max = 25) {
  const cols = H.dates.map((d, i) => ({ d, i, kind: H.kinds[i] })).filter((c, k, a) => k === a.length - 1 || a[k + 1].d.slice(0, 7) !== c.d.slice(0, 7));
  return cols.slice(-max);
}
// Verlauf in zweifarbiger Skala (rot negativ, grau neutral, blau positiv), damit die Richtung ohne Skala lesbar ist
const DIV_VARS = ["--neg2", "--neg1", "--neu", "--pos1", "--pos2"];
const MONTH_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
function histCell(H, id, c, onShow) {
  const n = H.rows[id] ? H.rows[id].c[c.i] : null, sc = H.rows[id] ? H.rows[id].s[c.i] : null;
  const cat = n == null ? null : SIG.cfg.cats.find(x => x.n === n);
  const text = `${deShort(c.d)}: ${cat ? `${cat.sym} ${cat.label}, Gesamtwert ${signed(sc, 2)}` : "keine Einstufung"} (${c.kind === "live" ? "gespeichert" : "rückgerechnet"})`;
  const el = h("span", { class: `hc${n == null ? " none" : ""}${c.kind === "live" ? " live" : ""}`, style: n == null ? null : `background:var(${DIV_VARS[n + 2]})`, title: text, role: "img", "aria-label": text });
  el.addEventListener("mouseenter", () => onShow(text));
  el.addEventListener("click", () => onShow(text));
  return el;
}
function renderHistory(host) {
  const H = signalHistory(BARO.hz);
  if (!H || !H.dates || !H.dates.length) {
    host.append(h("p", { class: "note-box", text: `Der Signalverlauf für den Horizont „${BARO.horizon.title}“ erscheint, sobald der Worker die Einstufungen in der D1-Datenbank gespeichert hat (Job „signal_history“, alle sechs Stunden).` }));
    return;
  }
  const cols = historyCols(H, window.innerWidth <= 560 ? 13 : 25);
  const firstLive = H.dates[H.kinds.indexOf("live")];
  const sh = sheet(host, {
    title: `Signalverlauf der letzten Monate · ${BARO.horizon.title}`, sub: `Stufe jeder Anlage zum Monatsende, rechts der jüngste Tag; Feld antippen für den Wert`,
    info: { d: "Wie sich die Einstufung jeder Anlage über die Zeit entwickelt hat, getrennt für jeden Horizont.",
      f: ["Monatsenden vor dem Start der Datenbank: rückgerechnet mit demselben Modell und nur mit Daten, die zum jeweiligen Monatsende veröffentlicht gewesen wären (Monatsreihen nach ihrer üblichen Frist); das Shiller-KGV mit dem damals bekannten Monatswert, IWF-Prognosen und Bevölkerungsprojektionen mit dem jüngsten Stand.",
        "Ab dem Start: der Worker rechnet das Barometer alle sechs Stunden für alle drei Horizonte und speichert den Stand des Tages in einer D1-Datenbank. Spätere Datenrevisionen ändern diese Werte nicht mehr.",
        "Farbe = Stufe (gleiche Skala wie im Barometer, Toleranzband zur Vorperiode). Umrandete Felder: gespeicherte Tageswerte."],
      r: [`${H.dates.length} Stichtage, ${Object.keys(H.rows).length} Anlagen`, firstLive ? `gespeichert seit ${deShort(firstLive)}` : "noch keine gespeicherten Tageswerte"],
      s: `Abrufbar als JSON oder CSV: /api/signals?h=${BARO.hz} (mit &format=csv&pillars=1 samt Säulenwerten).` },
  });
  const readout = h("div", { class: "hist-readout", "aria-live": "polite", text: "Feld antippen oder mit der Maus darüberfahren, um Datum und Wert zu sehen." });
  const show = name => text => { readout.textContent = `${name} · ${text}`; };
  const head = h("div", { class: "hist-row hist-head" }, h("span", { class: "hist-name" }),
    ...cols.map((c, k) => { const m = +c.d.slice(5, 7) - 1; const lab = k === cols.length - 1 ? "jetzt" : (m % 3 === 0 || k === 0) ? `${MONTH_SHORT[m]} ${c.d.slice(2, 4)}` : ""; return h("span", { class: "hist-m", text: lab }); }));
  const grid = h("div", { class: "hist-grid", style: `--cols:${cols.length}` }, head);
  for (const g of BARO.groups) {
    const rows = BARO.rows.filter(r => r.row.group === g.id && H.rows[r.row.id]);
    if (!rows.length) continue;
    grid.append(h("div", { class: "hist-group", text: GROUP_LABELS[g.id] || g.label }));
    for (const r of rows) {
      const name = r.row.label;
      grid.append(h("div", { class: "hist-row" }, h("span", { class: "hist-name", text: name, title: moverName(r) }), ...cols.map(c => histCell(H, r.row.id, c, show(moverName(r))))));
    }
  }
  const legend = h("div", { class: "hist-legend" }, ...SIG.cfg.cats.map(c => h("span", { class: "lg" }, h("span", { class: "hc", style: `background:var(${DIV_VARS[c.n + 2]})` }), `${c.sym} ${c.label}`)),
    h("span", { class: "lg" }, h("span", { class: "hc live", style: "background:var(--neu)" }), "gespeicherter Tageswert"));
  sh.body.append(legend, h("div", { class: "hist-wrap" }, grid), readout);
}

/* Indikatoren für die Risikoausrichtung: die Säulen des Weltaktien-Signals als eigene Zeilen */
const RISK_LABELS = { cycle: "Konjunkturzyklus", liquidity: "Liquidität", value: "Bewertung", trend: "Technik und Trend", risk: "Risiko und Geopolitik", cycle12: "Konjunktur und Wachstumsprognose", mom12: "Momentum 12 Monate", valueLT: "Bewertung (langfristig)", growth: "Wachstum und Demografie", debt: "Schulden", power: "Machtposition", trendLT: "Langfristtrend" };
function riskScorecard(host) {
  const w = BARO.rows.find(r => r.row.id === "eq_world" && r.now);
  if (!w) return;
  const W = BARO.weights.equity;
  const rows = BARO.pillars.filter(p => W[p.id])
    .map(p => ({ id: p.id, label: RISK_LABELS[p.id] || p.label, short: p.label, now: w.now.pillars[p.id] ? w.now.pillars[p.id].s : null, prev: w.prev && w.prev.pillars[p.id] ? w.prev.pillars[p.id].s : null }))
    .filter(x => x.now != null);
  rows.push({ label: "Modell gesamt", now: w.now.score, prev: w.prev ? w.prev.score : null, total: true });
  const sh = sheet(host, { title: "Indikatoren für die Risikoausrichtung", sub: `Säulen des Signals für Aktien weltweit (${BARO.horizon.title}): positiv = Umfeld spricht für riskante Anlagen, negativ = für sichere Häfen`,
    info: () => ({ d: "Die Säulen des Signals für Aktien weltweit, einzeln gezeigt wie in Pictets Übersicht der Risikoausrichtung.",
      f: ["Aktien weltweit = Korb nach ungefährer Börsengewichtung: USA 62 %, Eurozone 10 %, Japan 6 %, China 5 %, Großbritannien 4 %, Schweiz 3 %, Indien 3 % (jede Reihe auf den Start indexiert; Strukturdaten mit denselben Gewichten).", "Säulen wie im Barometer; Modell gesamt = gewichtetes Mittel."],
      r: rows.map(x => `${x.label}: ${signed(x.now, 2)}${x.total ? "" : ` (Gewicht ${fmt(100 * W[x.id], 0)} %)`}; Vormonat ${x.prev == null ? "–" : signed(x.prev, 2)}`) }) });
  const grid = h("div", { class: "pgrid" },
    h("div", { class: "pg-group pg-hgroup no-label" }, h("div", { class: "pg-head score" },
      h("div", { class: "pg-scale-h" }, h("span", { text: "risikoscheu −" }), h("span", { text: "neutral o" }), h("span", { text: "risikofreudig +" })), h("div", { class: "h num-h", text: "Wert (Vormonat)" }))));
  const body = h("div", { class: "pg-group no-label" }, h("div", { class: "pg-rows" }, ...rows.map(x => {
    const pc = x.prev == null ? null : SIG.category(x.prev).n, c = SIG.category(x.now, pc);
    return h("div", { class: "pg-row score" + (x.total ? " total" : "") },
      h("div", { class: "pg-name", "aria-hidden": "true", text: x.label }),
      h("div", { class: "pg-track" }, barEl(x.label, x.short || x.label.split(" ")[0], c.n, pc, `${x.label}: ${c.label} (${signed(x.now, 2)})`)),
      h("div", { class: "pg-num y1", text: `${signed(x.now, 2)} (${x.prev == null ? "–" : signed(x.prev, 2)})` }));
  })));
  grid.append(body);
  sh.body.append(h("div", { style: "overflow-x:auto" }, grid));
  fitBars(grid);
}
function renderBaroSummary() {
  const host = document.getElementById("baro-summary");
  host.replaceChildren();
  const ok = BARO.rows.filter(r => r.now);
  const by = id => ok.find(r => r.row.id === id);
  const word = r => (r ? r.now.cat.label : "ohne Daten");
  const list = arr => arr.length ? arr.slice(0, -1).join(", ") + (arr.length > 1 ? " und " : "") + arr[arr.length - 1] : "";
  const eqs = ok.filter(r => r.row.group === "aktien").sort((a, b) => b.now.score - a.now.score);
  const fx = ok.filter(r => r.row.group === "waehrungen" && r.row.id !== "fx_usd" && r.row.id !== "fx_eurchf");
  const s1 = h("p", null, h("b", { text: "Anlageklassen. " }), `Aktien weltweit ${word(by("eq_world"))}, Staatsanleihen ${word(by("bd_core"))}, Hochzinsanleihen ${word(by("credit_hy"))}, Gold ${word(by("gold_usd"))}, Rohstoffe ${word(by("commod"))}.`);
  const s2 = h("p", null, h("b", { text: "Regionen und Währungen. " }),
    eqs.length ? `Am stärksten eingestuft sind die Aktienmärkte ${list(eqs.slice(0, 2).map(r => r.row.label))}, am schwächsten ${list(eqs.slice(-2).reverse().map(r => r.row.label))}. ` : "",
    fx.length ? `Gegenüber dem Dollar: ${fx.map(r => `${r.row.label} ${r.now.cat.sym}`).join(", ")}.` : "");
  const ra = BARO.risk;
  const tension = LIVE && LIVE.tension && LIVE.tension.pairs ? Object.values(LIVE.tension.pairs).filter(t => t.z != null).sort((a, b) => b.z - a.z)[0] : null;
  const gold = GOLD_IDS.map(by).filter(Boolean);
  const s3 = BARO.hz === "lt"
    ? h("p", null, h("b", { text: "Langfristige Kräfte. " }), (() => {
      const top = ok.filter(r => r.now.pillars.power && r.row.group === "waehrungen").sort((a, b) => b.now.pillars.power.s - a.now.pillars.power.s)[0];
      const debt = ok.filter(r => r.now.pillars.debt && r.row.group === "anleihen").sort((a, b) => a.now.pillars.debt.s - b.now.pillars.debt.s)[0];
      return [top ? `Die stärkste Machtposition unter den Währungen hat ${top.row.label} (${signed(top.now.pillars.power.s, 2)}). ` : "", debt ? `Am stärksten von der Schuldenlast belastet sind Staatsanleihen ${debt.row.label} (${signed(debt.now.pillars.debt.s, 2)}).` : ""].join("");
    })())
    : h("p", null, h("b", { text: "Risiko und Geopolitik. " }),
      ra ? `Der Risikoappetit liegt bei ${signed(ra.s, 2)} (${ra.s > 0.3 ? "Risikofreude" : ra.s < -0.3 ? "Risikoscheu" : "ausgeglichen"}). ` : "",
      tension ? `Die stärkste Zunahme der Berichterstattung verzeichnet die Konfliktlinie ${tension.label} (${signed(tension.z, 1)} Standardabweichungen über dem Viermonatsmittel).` : "");
  const s4 = gold.length ? h("p", null, h("b", { text: "Gold. " }), `${gold.map(r => `${r.row.label} ${r.now.cat.sym}`).join(", ")} (eigene Übersicht unten).`) : null;
  const chg = ok.filter(r => r.prev && r.prev.cat && r.prev.cat.n !== r.now.cat.n);
  const sh = sheet(host, { title: `Kurzüberblick · ${BARO.horizon.title}`, sub: `Automatisch aus den Signalen formuliert, Stand ${deShort(SIG.isoOf(BARO.tNow))}`,
    info: { d: "Kurze Sätze, die bei jedem Aufruf aus den Signalen des gewählten Horizonts erzeugt werden.",
      f: ["Anlageklassen: Stufen der Zeilen Aktien weltweit, Staatsanleihen, Hochzinsanleihen, Gold und Rohstoffe.", "Regionen: die zwei Aktienmärkte mit dem höchsten und dem niedrigsten Gesamtwert; Währungen mit ihrer Stufe gegenüber dem Dollar.",
        "1 Monat und 12 Monate – Risiko: Risikoappetit (Mittel aus VIX, Hochzinsprämie, Finanzstress, Geopolitik) und die Konfliktlinie mit der größten Abweichung der Berichterstattung vom Viermonatsmittel. 5–10 Jahre – langfristige Kräfte: Währung mit der höchsten Säule Machtposition, Staatsanleihen mit der niedrigsten Säule Schulden.",
        "Gold: Stufen der Zeilen der Gold-Übersicht.", "Geändert: Anlagen, deren Stufe sich gegenüber dem Vormonat verschoben hat."] } });
  sh.body.append(h("div", { class: "inbrief" }, s1, s2, s3, s4,
    chg.length ? h("div", { class: "summary-line", style: "margin-top:4px" }, h("span", { class: "lbl", text: "Geändert gegenüber dem Vormonat:" }),
      ...chg.map(r => h("a", { class: "chipline", href: (r.row.group === "gold" ? "#gold-" : "#baro-") + r.row.id, style: "text-decoration:none;color:inherit" }, h("span", { class: `sig-badge o${r.prev.cat.n}`, text: r.prev.cat.sym }), "→", h("span", { class: `sig-badge o${r.now.cat.n}`, text: r.now.cat.sym }), moverName(r)))) : null));
  riskScorecard(host);
}
function renderBaroMethod() {
  const host = document.getElementById("baro-method-body");
  const kinds = { equity: "Aktien", bond: "Staatsanleihen", credit: "Unternehmensanleihen", fx: "Währungen", gold: "Gold, Silber", commodity: "Rohstoffe", relative: "Relative Stärke" };
  const weightTable = H => {
    const P = H.pillars.map(SIG.pillarDef);
    return h("div", { style: "overflow-x:auto" }, stackTable(h("table", null,
      h("thead", null, h("tr", null, h("th", { text: `Gewichte · ${H.title}` }), ...P.map(p => h("th", { text: p.label })))),
      h("tbody", null, ...Object.entries(H.weights).map(([k, w]) => h("tr", null, h("td", { text: kinds[k] }), ...P.map(p => h("td", { text: w[p.id] ? fmt(100 * w[p.id], 0) + " %" : "–" }))))))));
  };
  const cur = BARO.horizon;
  const others = SIG.cfg.horizons.filter(x => x.id !== cur.id);
  host.replaceChildren(
    h("p", { text: "Jede Säule wird auf eine Skala von −2 (klar negativ) bis +2 (klar positiv) abgebildet. Rohwerte werden dazu durch eine typische Schwankungsbreite geteilt und weich begrenzt (2·tanh(z/2)). Die Gesamtnote ist das gewichtete Mittel der verfügbaren Säulen; fehlt eine Säule, werden die übrigen Gewichte hochgerechnet. Die Einstufung des Vormonats entsteht aus derselben Rechnung mit dem Datenstand von vor 30 Tagen; Monatsreihen zählen dabei erst nach ihrer üblichen Veröffentlichungsfrist." }),
    h("p", null, h("b", { text: "Drei Horizonte. " }), SIG.cfg.horizons.map(x => `${x.title}: ${x.desc}`).join(" ")),
    h("ul", { style: "margin:0;padding-left:18px;display:grid;gap:4px" }, ...BARO.pillars.map(p => h("li", null, h("b", { text: p.label + ": " }), p.desc))),
    weightTable(cur),
    h("details", { class: "more" }, h("summary", { text: `Säulen und Gewichte der anderen Horizonte (${others.map(x => x.label).join(", ")})` }),
      ...others.flatMap(x => [h("ul", { style: "margin:8px 0 0;padding-left:18px;display:grid;gap:4px" }, ...x.pillars.map(SIG.pillarDef).map(p => h("li", null, h("b", { text: `${x.label}, ${p.label}: ` }), p.desc))), weightTable(x)])),
    h("p", { text: `Einstufung nach Gesamtwert: ${SIG.cfg.cats.map((c, i) => `${c.sym} ${c.label} ${c.max === Infinity ? `über ${fmt(SIG.cfg.cats[i - 1].max, 1)}` : `bis ${fmt(c.max, 1)}`}`).join(" · ")}. Gegenüber der Vormonatsstufe gilt ein Toleranzband von ${fmt(SIG.cfg.hyst, 1)}: Die Stufe wechselt erst, wenn der Gesamtwert die Schwelle um mehr als diesen Betrag überschreitet. Das verhindert, dass Werte nahe einer Schwelle jeden Monat hin- und herspringen.` }),
    h("p", { text: "Anleihekurse werden aus der Rendite zehnjähriger Staatsanleihen geschätzt (Duration 8,5, Konvexität 85, laufender Kupon). Währungen sind als Preis der Währung in US-Dollar notiert; ein positives Signal bedeutet erwartete Aufwertung gegenüber dem Dollar. Die geopolitische Komponente nutzt den Spannungsmonitor: Steigt die Berichterstattung über eine Konfliktlinie deutlich über ihr Viermonatsmittel, belastet das die betroffenen Märkte (etwa China bei Spannungen mit den USA oder um Taiwan) und stützt Öl bei Spannungen im Nahen Osten. Die langfristigen Säulen nutzen IWF-Projektionen (World Economic Outlook), Bevölkerungsprojektionen der Weltbank und die Reservewährungsstatistik COFER." }),
    h("p", { class: "small", text: "Darstellung und Säulen lehnen sich an die monatliche Asset-Allocation-Übersicht von Pictet Asset Management an (Konjunkturzyklus, Liquidität, Bewertung, Technik und Stimmung); die langfristigen Säulen folgen Dalios großem Zyklus. Der Monitor verwendet keine Daten oder Einschätzungen von Pictet; Regeln, Schwellen und Gewichte sind Setzungen dieses Monitors. Keine Anlageberatung." }));
}

/* ------------------------------------------------------------------ Konjunkturuhr */
const CLOCK_REGIONS = [["US", "cli_us"], ["EA", "cli_ea"], ["CN", "cli_cn"], ["JP", "cli_jp"], ["GB", "cli_gb"], ["IN", "cli_in"], ["CH", "cli_ch"], ["DE", "cli_de"]];
const PHASE_COL = { expansion: "--pos2", recovery: "--pos1", slowdown: "--neg1", contraction: "--neg2" };
const CLOCK_INFO = {
  d: "Zeigt, in welcher Phase des kurzen Konjunkturzyklus sich jede Volkswirtschaft befindet.",
  f: ["Grundlage: OECD-Frühindikator (Composite Leading Indicator), amplitudenbereinigt, langfristiges Mittel = 100; Schweiz und Eurozone: Geschäftsklima-Indikator der OECD.",
    "Waagrecht: Niveau − 100 (über null = Konjunktur über dem Trend). Senkrecht: Veränderung gegenüber dem Wert von vor drei Monaten.",
    "Aufschwung = über dem Trend und steigend; Abschwung = über dem Trend, aber fallend; Abschwächung = unter dem Trend und fallend; Erholung = unter dem Trend, aber steigend."],
};
function renderCycleClock() {
  const host = document.getElementById("cycle-clock");
  const regs = CLOCK_REGIONS.filter(([, id]) => LP(id).length > 12);
  if (!regs.length) return;
  const sh = sheet(host, {
    title: "Konjunkturuhr der großen Volkswirtschaften",
    sub: "OECD-Frühindikator (amplitudenbereinigt, langfristiges Mittel = 100): waagrecht das Niveau, senkrecht die Veränderung über drei Monate; Spur der letzten 18 Monate, Punkt = jüngster Wert",
    src: liveSrcIds(...regs.map(r => r[1])),
    info: CLOCK_INFO,
  });
  const trails = regs.map(([r, id]) => {
    const p = LP(id);
    const pts = [];
    for (let i = 0; i < p.length; i++) { const b = SIG.valueAt(p, p[i].t - 85); if (b && p[i].t - b.t < 120) pts.push({ t: p[i].t, lvl: p[i].v - 100, mom: p[i].v - b.v }); }
    return { r, id, pts: pts.slice(-18), phase: SIG.cyclePhase(p) };
  });
  const mx = Math.max(1.5, ...trails.flatMap(t => t.pts.map(q => Math.abs(q.lvl)))) * 1.08;
  const my = Math.max(0.6, ...trails.flatMap(t => t.pts.map(q => Math.abs(q.mom)))) * 1.12;
  const grid = h("div", { class: "clock-grid" });
  for (const tr of trails) {
    const W = 240, H = 170, m = 6;
    const X = v => m + (v + mx) / (2 * mx) * (W - 2 * m), Y = v => m + (my - v) / (2 * my) * (H - 2 * m);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Konjunkturuhr ${RN[tr.r]}: ${tr.phase ? tr.phase.label : "keine Daten"}` });
    svg.append(sv("rect", { x: X(0), y: m, width: X(mx) - X(0), height: Y(0) - m, fill: cssVar("--hover") }));
    svg.append(sv("rect", { x: m, y: Y(0), width: X(0) - m, height: H - m - Y(0), fill: cssVar("--hover") }));
    svg.append(sv("line", { x1: X(0), x2: X(0), y1: m, y2: H - m, class: "baseline" }));
    svg.append(sv("line", { x1: m, x2: W - m, y1: Y(0), y2: Y(0), class: "baseline" }));
    const lab = (x, y, t, a) => { const e = sv("text", { x, y, "text-anchor": a, class: "q-label" }); e.textContent = t; svg.append(e); };
    lab(W - m - 2, m + 10, "Aufschwung", "end"); lab(W - m - 2, H - m - 4, "Abschwung", "end");
    lab(m + 2, H - m - 4, "Abschwächung", "start"); lab(m + 2, m + 10, "Erholung", "start");
    const col = cssVar(LC[tr.r]);
    const pts = tr.pts;
    for (let i = 1; i < pts.length; i++) {
      svg.append(sv("line", { x1: X(pts[i - 1].lvl), y1: Y(pts[i - 1].mom), x2: X(pts[i].lvl), y2: Y(pts[i].mom), stroke: col, "stroke-width": 2, "stroke-linecap": "round", opacity: 0.25 + 0.75 * i / pts.length }));
    }
    const a = pts[pts.length - 1];
    if (a) {
      svg.append(sv("circle", { cx: X(a.lvl), cy: Y(a.mom), r: 5, fill: col, stroke: cssVar("--sheet"), "stroke-width": 2 }));
      const t = sv("text", { x: X(a.lvl) + (X(a.lvl) > W - 70 ? -8 : 8), y: Y(a.mom) - 7, "text-anchor": X(a.lvl) > W - 70 ? "end" : "start", class: "endlabel", style: "font-size:10.5px" });
      t.textContent = deMonth(SIG.isoOf(a.t)).replace(/ (\d{2})(\d{2})$/, " $2$2").replace(/(\w{3})\w* (\d{4})/, (s, mo, y) => `${mo} ${y.slice(2)}`);
      svg.append(t);
    }
    const ph = tr.phase;
    grid.append(h("div", { class: "clock" },
      h("h4", null, h("span", null, RN[tr.r], ph ? info({ t: `Konjunkturuhr ${RN[tr.r]}`, f: CLOCK_INFO.f.slice(1),
        r: [`Niveau: ${fmt(100 + ph.lvl, 2)} − 100 = ${signed(ph.lvl, 2)} (${ph.lvl >= 0 ? "über" : "unter"} dem Trend)`, `Veränderung über 3 Monate: ${signed(ph.mom, 2)} Punkte (${ph.mom >= 0 ? "steigend" : "fallend"})`, `→ ${ph.label} (${deMonth(ph.date + "-01")})`] }, `Konjunkturuhr ${RN[tr.r]}`) : null),
        ph ? h("span", { class: "phase-pill" }, h("i", { style: `background:var(${PHASE_COL[ph.id]})` }), ph.label) : null),
      svg,
      ph ? h("div", { class: "small", text: `Index ${fmt(100 + ph.lvl, 1)} · 3 Monate ${signed(ph.mom, 2)} · ${deMonth(ph.date + "-01")}` }) : null));
  }
  sh.body.append(grid);
  const order = { expansion: 0, recovery: 1, slowdown: 2, contraction: 3 };
  const txt = trails.filter(t => t.phase).sort((a, b) => order[a.phase.id] - order[b.phase.id]).map(t => `${RN[t.r]}: ${t.phase.label}`).join(" · ");
  sh.body.append(h("p", { class: "small", style: "margin-top:8px", text: `Phasen: ${txt}. Aufschwung = über dem Trend und steigend; Abschwung = über dem Trend, aber fallend; Abschwächung = unter dem Trend und fallend; Erholung = unter dem Trend, aber steigend.` }));
}

/* ------------------------------------------------------------------ Makro- und Marktdiagramme */
function regionLines(prefix, regs, scale = 1, from = null) {
  return regs.filter(r => LP(prefix + r.toLowerCase()).length).map(r => ({ id: r, label: RN[r], color: LC[r], data: LS(prefix + r.toLowerCase(), scale).filter(p => from == null || p[0] >= from) }));
}
function liveFreq(ids) { const fs = ids.map(id => LF(id)); return fs.includes("D") ? "D" : fs.includes("W") ? "D" : fs.includes("M") ? "M" : "Q"; }
function renderMacro() {
  const host = document.getElementById("macro-charts");
  const x0 = nowX() - 7;
  const R = ["US", "EA", "CH", "JP", "GB", "CN", "IN"];
  const pr = regionLines("pr_", R, 1, x0);
  if (pr.length) chartSheet(host, { title: "Leitzinsen", sub: "Leitzins der Zentralbanken, %; Eurozone: Einlagefazilität der EZB", src: liveSrcIds(...R.map(r => "pr_" + r.toLowerCase())),
      info: { f: "Keine eigene Rechnung: Leitzinsen aus der Statistik der Bank für Internationalen Zahlungsausgleich (tägliche Werte); fehlt ein Land dort, die Angabe der Zentralbank selbst (EZB-Einlagesatz, SNB, Bank of England, Fed Funds Effective Rate)." } },
    { series: pr, height: 280, freq: liveFreq(R.map(r => "pr_" + r.toLowerCase())), refs: [{ y: 0 }], endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) + " %", ...SHORT_RANGE });
  const cpi = regionLines("cpi_", R, 1, x0);
  if (cpi.length) chartSheet(host, { title: "Inflation", sub: "Verbraucherpreise, Veränderung gegenüber dem Vorjahresmonat, %", src: liveSrcIds(...R.map(r => "cpi_" + r.toLowerCase())),
      info: { f: "Verbraucherpreisindex im Monat ÷ Index im Vorjahresmonat − 1, in % (von der OECD berechnet und so übernommen; Russland und Iran: IWF). Referenzlinie bei 2 %, dem Inflationsziel der meisten Notenbanken." } },
    { series: cpi, height: 280, freq: "M", refs: [{ y: 0 }, { y: 2, label: "2 %" }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %", ...SHORT_RANGE });
  const y10 = ["US", "DE", "CH", "JP", "GB", "CN", "IN"].filter(r => LP("y10_" + r.toLowerCase()).length)
    .map(r => ({ id: r, label: r === "DE" ? "Deutschland" : RN[r], color: LC[r], data: LS("y10_" + r.toLowerCase()).filter(p => p[0] >= nowX() - 3) }));
  if (y10.length) chartSheet(host, { title: "Rendite zehnjähriger Staatsanleihen", sub: "%, letzte drei Jahre", src: liveSrcIds(...["us", "de", "ch", "jp", "gb", "cn", "in"].map(r => "y10_" + r)),
      info: { f: ["Tageswerte der Notenbanken bzw. Finanzministerien: USA (Fed), Deutschland (Bundesbank), Schweiz (SNB), Japan (Finanzministerium), Großbritannien (Bank of England).", "China und Indien sowie fehlende Tage: Monatswerte der OECD bzw. FRED. Schweiz und Japan: Monatswerte bis zum Beginn der Tagesreihe, danach Tageswerte."] } },
    { series: y10, height: 280, freq: "D", refs: [{ y: 0 }], endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) + " %", ...SHORT_RANGE });
  const un = regionLines("unemp_", R, 1, x0);
  if (un.length) chartSheet(host, { title: "Arbeitslosenquote", sub: "%, saisonbereinigt (OECD, harmonisiert)", src: liveSrcIds(...R.map(r => "unemp_" + r.toLowerCase())),
      info: { f: "Keine eigene Rechnung: harmonisierte Arbeitslosenquote der OECD (Arbeitslose ÷ Erwerbspersonen × 100, saisonbereinigt); Schweiz: Quartalswerte." } },
    { series: un, height: 280, freq: "M", zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %", ...SHORT_RANGE });
}
function renderMarkets() {
  const host = document.getElementById("market-charts");
  const x1 = nowX() - 1;
  const fx = [["CH", "fx_chf"], ["EA", "fx_eur"], ["JP", "fx_jpy"], ["GB", "fx_gbp"], ["CN", "fx_cny"], ["IN", "fx_inr"]].filter(([, id]) => LP(id).length)
    .map(([r, id]) => ({ id: r, label: { CH: "Franken", EA: "Euro", JP: "Yen", GB: "Pfund", CN: "Renminbi", IN: "Rupie" }[r], color: LC[r], data: indexed(LS(id), x1) }));
  if (fx.length) chartSheet(host, { title: "Währungen gegenüber dem US-Dollar", sub: "Index, vor zwölf Monaten = 100; steigend = Aufwertung gegenüber dem Dollar", src: liveSrcIds("fx_chf", "fx_eur", "fx_jpy", "fx_cny"),
      info: () => ({ f: ["Preis der Währung in US-Dollar aus den EZB-Referenzkursen: z. B. Franken = (USD je Euro) ÷ (CHF je Euro).", "Index = Wert ÷ Wert am ersten Tag des Zeitraums (vor zwölf Monaten) × 100. Über 100 = gestiegen."],
        r: fx.map(sr => { const a = lastPt(sr.data); return a ? `${sr.label}: ${fmt(a[1], 1)} (${signed(a[1] - 100, 1)} %)` : null; }) }) },
    { series: fx, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const eqDev = [["US", "eq_us", "USA"], ["CH", "eq_ch", "Schweiz"], ["EA", "eq_ea", "Eurozone"], ["JP", "eq_jp", "Japan"], ["GB", "eq_gb", "Großbritannien"]].filter(([, id]) => LP(id).length)
    .map(([r, id, l]) => ({ id: r, label: l, color: LC[r], data: indexed(LS(id), x1) }));
  if (eqDev.length) chartSheet(host, { title: "Aktienmärkte der Industrieländer", sub: "Index in Lokalwährung, vor zwölf Monaten = 100", src: liveSrcIds("eq_us", "eq_ch", "eq_ea", "eq_jp", "eq_gb"),
      info: () => ({ f: ["Indexstand in Landeswährung (S&P 500, SMI, Euro Stoxx 50, Nikkei 225, FTSE 100).", "Index = Wert ÷ Wert am ersten Tag des Zeitraums (vor zwölf Monaten) × 100. Über 100 = gestiegen.", "Eurozone und Großbritannien nur als Monatswerte (EZB, OECD)."],
        r: eqDev.map(sr => { const a = lastPt(sr.data); return a ? `${sr.label}: ${fmt(a[1], 1)} (${signed(a[1] - 100, 1)} %)` : null; }) }) },
    { series: eqDev, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const eqEm = [["CN", "eq_cn", "China"], ["IN", "eq_in", "Indien"], ["RU", "eq_em", "Schwellenländer (MSCI EM)"], ["US", "eq_us", "USA (Vergleich)"]].filter(([, id]) => LP(id).length)
    .map(([r, id, l]) => ({ id: id, label: l, color: r === "RU" ? "--s7" : LC[r], data: indexed(LS(id), x1), dash: r === "US" ? "5 4" : null }));
  if (eqEm.length > 1) chartSheet(host, { title: "Aktienmärkte der Schwellenländer", sub: "Index, vor zwölf Monaten = 100; gestrichelt: S&P 500 zum Vergleich", src: liveSrcIds("eq_cn", "eq_in", "eq_em"),
      info: () => ({ f: ["Aktienindizes Chinas und Indiens (Monatswerte der OECD), S&P 500 zum Vergleich.", "Index = Wert ÷ Wert am ersten Tag des Zeitraums (vor zwölf Monaten) × 100. Über 100 = gestiegen."],
        r: eqEm.map(sr => { const a = lastPt(sr.data); return a ? `${sr.label}: ${fmt(a[1], 1)}` : null; }) }) },
    { series: eqEm, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const com = [["gold_usd", "Gold", "--s4"], ["silver_usd", "Silber", "--s7"], ["brent", "Brent", "--s2"], ["copper", "Kupfer", "--s3"]].filter(([id]) => LP(id).length)
    .map(([id, l, c]) => ({ id, label: l, color: c, data: indexed(LS(id), x1) }));
  if (com.length) chartSheet(host, { title: "Gold und Rohstoffe", sub: "Index in US-Dollar, vor zwölf Monaten = 100", src: liveSrcIds("gold_usd", "brent", "copper"),
      info: () => ({ f: ["Preise in US-Dollar: Gold täglich (polnische Notenbank, umgerechnet), Brent täglich (FRED), Silber und Kupfer als Monatsmittel (IWF).", "Index = Wert ÷ Wert am ersten Tag des Zeitraums (vor zwölf Monaten) × 100. Über 100 = gestiegen."],
        r: com.map(sr => { const a = lastPt(sr.data); return a ? `${sr.label}: ${fmt(a[1], 1)} (${signed(a[1] - 100, 1)} %)` : null; }) }) },
    { series: com, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
}

/* ------------------------------------------------------------------ Risiko-Kacheln */
function pctRank(arr, v) { const a = arr.filter(x => x != null && isFinite(x)); if (!a.length || v == null) return null; return 100 * a.filter(x => x <= v).length / a.length; }
function renderRiskTiles() {
  const host = document.getElementById("risk-tiles");
  const defs = [
    ["vix", "Volatilität (VIX)", "", 1, "Optionsmarkt, S&P 500"],
    ["hy_oas", "Risikoprämie Hochzinsanleihen USA", "Pp.", 2, "ICE BofA US High Yield, Aufschlag"],
    ["stlfsi", "Finanzstress USA", "", 2, "St. Louis Fed; 0 = normal"],
    ["ciss_ea", "Systemischer Stress Eurozone", "", 3, "EZB CISS; 0 bis 1"],
    ["epu_us", "Wirtschaftspolitische Unsicherheit USA", "", 0, "Baker, Bloom, Davis; Tageswert"],
    ["epu_global", "Wirtschaftspolitische Unsicherheit Welt", "", 0, "BIP-gewichtet; Monatswert"],
    ["real10_us", "Reale Rendite 10 Jahre USA", "%", 2, "inflationsindexierte Treasuries (TIPS)"],
    ["be10_us", "Inflationserwartung 10 Jahre USA", "%", 2, "Breakeven: nominal minus real"],
  ];
  const tiles = [];
  for (const [id, label, unit, d, note] of defs) {
    const p = LP(id);
    if (p.length < 5) continue;
    const a = p[p.length - 1];
    const hist = p.filter(q => q.t > a.t - 3653).map(q => q.v);
    const pr = pctRank(hist, a.v);
    const n10 = hist.length, below = hist.filter(v => v <= a.v).length;
    tiles.push(h("div", { class: "tile" },
      h("div", { class: "label" }, label, info({ t: label, d: note,
        f: ["Wert: jüngste Beobachtung der Quelle, keine eigene Umrechnung.", "Perzentil (10 J.) = Anteil der Beobachtungen der letzten zehn Jahre, die gleich hoch oder niedriger waren, × 100. 90. Perzentil = höher als an 90 % der Tage."],
        r: pr == null ? null : `${below} von ${n10} Werten ≤ ${fmt(a.v, d)} → ${fmt(pr, 0)}. Perzentil` }, label)),
      h("div", { class: "value" }, fmt(a.v, d), unit ? h("small", { text: unit }) : null),
      sparkline(p.filter(q => q.t > a.t - 730).map(q => [q.x, q.v]), "--s7"),
      h("div", { class: "meta" }, h("span", { text: liveDate(a, LF(id)) }), h("span", { text: pr == null ? note : `${fmt(pr, 0)}. Perzentil (10 J.)` }))));
  }
  if (!tiles.length) return;
  host.replaceChildren(...tiles);
}

/* ------------------------------------------------------------------ Schuldenzyklus im Ländervergleich */
const DEBT_C = [["USA", "US"], ["CHN", "CN"], ["JPN", "JP"], ["DEU", "DE"], ["GBR", "GB"], ["IND", "IN"], ["CHE", "CH"], ["RUS", "RU"]];
function renderDebtWorld() {
  const host = document.getElementById("debt-world");
  const y0 = new Date().getUTCFullYear() - 1;
  const deb = DEBT_C.filter(([iso]) => LP("debt_" + iso.toLowerCase()).length).flatMap(([iso, r]) => {
    const d = LS("debt_" + iso.toLowerCase()).filter(p => p[0] >= 2000);
    return [
      { id: iso, label: RN[r], color: LC[r], data: d.filter(p => p[0] <= y0), endLabel: false },
      { id: iso + "_p", group: iso, label: RN[r] + " (Projektion)", short: RN[r], color: LC[r], dash: "4 4", data: d.filter(p => p[0] >= y0), noLegend: true },
    ];
  });
  if (deb.length) chartSheet(host, { title: "Staatsschulden der großen Volkswirtschaften", sub: `Bruttoschulden des Gesamtstaats in % des BIP; gestrichelt ab ${y0}: Projektion des IWF (World Economic Outlook)`, src: ["live:imf"], cls: "span-2",
      info: { f: "Keine eigene Rechnung: Bruttoschulden des Gesamtstaats (Bund, Länder, Gemeinden, Sozialversicherung) ÷ BIP × 100 laut IWF World Economic Outlook; ab dem laufenden Jahr Projektion des IWF." } },
    { series: deb, height: 320, zero: true, vlines: [{ x: y0, label: "Projektion" }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  // Reale Leitzinsen: Leitzins minus Inflation (finanzielle Repression, wenn negativ)
  const R = ["US", "EA", "CH", "JP", "GB", "CN", "IN"];
  const real = R.filter(r => LP("pr_" + r.toLowerCase()).length && LP("cpi_" + r.toLowerCase()).length).map(r => {
    const pr = LP("pr_" + r.toLowerCase()), cpi = LP("cpi_" + r.toLowerCase());
    const data = cpi.filter(q => q.x >= nowX() - 8).map(q => { const p = SIG.valueAt(pr, q.e); return p ? [q.x, p.v - q.v] : null; }).filter(Boolean);
    return { id: r, label: RN[r], color: LC[r], data };
  });
  if (real.length) chartSheet(host, { title: "Reale Leitzinsen", sub: "Leitzins minus Inflationsrate, Prozentpunkte; negativ = Sparer verlieren real (finanzielle Repression)", src: liveSrcIds("pr_us", "cpi_us"),
      info: () => ({ f: "Realer Leitzins = Leitzins am Monatsende − Inflationsrate des Monats (Vorjahresvergleich), in Prozentpunkten",
        r: real.map(sr => { const a = sr.data[sr.data.length - 1]; if (!a) return null; const prA = LP("pr_" + sr.id.toLowerCase()), cp = LP("cpi_" + sr.id.toLowerCase()); const c = cp[cp.length - 1]; const p = c ? SIG.valueAt(prA, c.e) : null; return p && c ? `${sr.label}: ${fmt(p.v, 2)} % − ${fmt(c.v, 1)} % = ${signed(p.v - c.v, 2)} Pp.` : null; }) }) },
    { series: real, height: 280, freq: "M", refs: [{ y: 0 }], endValFmt: v => fmt(v, 1), tipFmt: v => signed(v, 2) + " Pp.", ...SHORT_RANGE });
  // Währungen gemessen in Gold: Goldpreis in der jeweiligen Währung, Index
  const g = LP("gold_usd");
  if (g.length > 200) {
    const fx = { USD: null, CHF: "fx_chf", EUR: "fx_eur", JPY: "fx_jpy", GBP: "fx_gbp", CNY: "fx_cny" };
    const col = { USD: "--s1", CHF: "--s4", EUR: "--s5", JPY: "--s6", GBP: "--s3", CNY: "--s2" };
    const x0 = g[0].x;
    const ser = Object.entries(fx).map(([c, id]) => {
      const pts = id ? SIG.combine(g, LP(id), (a, b) => a / b, 7) : g;
      return pts.length ? { id: c, label: `Gold in ${c}`, color: col[c], data: indexed(pts.map(q => [q.x, q.v]), x0) } : null;
    }).filter(Boolean);
    chartSheet(host, { title: "Währungen gemessen in Gold", sub: `Goldpreis in der jeweiligen Währung, Index ${fmtYearFrac(x0, "M")} = 100; je steiler, desto mehr Kaufkraft verliert die Währung gegenüber Gold`, src: liveSrcIds("gold_usd", "fx_chf", "fx_eur"),
      info: () => ({ f: ["Goldpreis in Währung X = Goldpreis in US-Dollar ÷ Preis der Währung X in US-Dollar (gleicher Tag, höchstens 7 Tage Abstand).", `Index = Wert ÷ Wert am ${fmtYearFrac(x0, "M")} × 100. 300 bedeutet: Gold kostet in dieser Währung dreimal so viel wie zu Beginn.`],
        r: ser.map(sr => { const a = lastPt(sr.data); return a ? `${sr.label}: ${fmt(a[1], 0)}` : null; }) }) },
      { series: ser, height: 280, freq: "D", endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  }
  const cof = [["cofer_usd", "US-Dollar", "--s1"], ["cofer_eur", "Euro", "--s5"], ["cofer_jpy", "Yen", "--s6"], ["cofer_gbp", "Pfund", "--s3"], ["cofer_cny", "Renminbi", "--s2"], ["cofer_chf", "Franken", "--s4"]].filter(([id]) => LP(id).length);
  if (cof.length) chartSheet(host, { title: "Anteile an den Weltdevisenreserven", sub: "IWF COFER, % der zugeordneten Reserven, Quartalswerte", src: ["live:imf_cofer"],
      info: { f: "Reserven der Zentralbanken in der jeweiligen Währung ÷ alle Reserven mit gemeldeter Währung × 100 (IWF COFER). Logarithmische Skala, damit kleine Anteile sichtbar bleiben." } },
    { series: cof.map(([id, l, c]) => ({ id, label: l, color: c, data: LS(id) })), height: 280, freq: "Q", log: true, logFloor: 0.1, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) + " %" });
  const cb = [["fed_assets", "Federal Reserve", "--s1"], ["ecb_assets", "Eurosystem", "--s5"], ["boj_assets", "Bank of Japan", "--s6"], ["snb_assets", "Nationalbank (SNB)", "--s4"]].filter(([id]) => LP(id).length);
  if (cb.length) chartSheet(host, { title: "Bilanzsummen der Zentralbanken", sub: "Index Januar 2019 = 100, in Landeswährung", src: liveSrcIds(...cb.map(c => c[0])),
      info: () => ({ f: "Bilanzsumme in Landeswährung ÷ Bilanzsumme im Januar 2019 × 100. Über 100 = Bilanz größer als vor der Pandemie (Anleihekäufe), sinkend = Bilanzabbau.",
        r: cb.map(([id, l]) => { const d = indexed(LS(id), 2019); const a = lastPt(d); return a ? `${l}: ${fmt(a[1], 0)}` : null; }) }) },
    { series: cb.map(([id, l, c]) => ({ id, label: l, color: c, data: indexed(LS(id), 2019) })), height: 280, freq: "M", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
}
