"use strict";
/* Big-Cycle-Monitor: Live-Teil (täglich über den Worker) – Anlagebarometer, Konjunktur und Märkte */

let LIVE = null;   // dekodierter Snapshot (SIG.decodeSnapshot)
let BARO = null;   // Ergebnis von SIG.barometer
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

/* ------------------------------------------------------------------ Was steigt, was fällt (Kopfbereich) */
const MOVER_IDS = ["eq_us", "eq_ch", "eq_ea", "eq_cn", "gold_usd", "fx_chf", "bd_us", "brent"];
function trendWord(r) { const t = r.now.pillars.trend; if (!t) return "→ seitwärts"; return t.s > 0.3 ? "↑ Aufwärtstrend" : t.s < -0.3 ? "↓ Abwärtstrend" : "→ seitwärts"; }
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
  if (!items.length) return;
  host.replaceChildren(h("div", { class: "movers" },
    h("div", { class: "movers-head" }, h("div", { class: "eyebrow", text: "Was steigt, was fällt? Signale des Anlagebarometers" }), h("a", { href: "#barometer", class: "small", text: "Alle Signale" })),
    h("div", { class: "movers-grid" }, ...items.map(r => {
      const c = r.now.cat;
      return h("a", { class: "mover", href: "#baro-" + r.row.id, title: `${moverName(r)}: Signal ${c.label} (${fmt(r.now.score, 2)})` },
        h("span", { class: "m-name", text: moverName(r) }),
        h("span", { class: "m-sub", text: trendWord(r) }),
        h("span", { class: "m-perf", text: `1 Monat ${signed(100 * (r.perf.m1 ?? NaN), 1)} %` }),
        h("span", { class: "m-sig" }, h("span", { class: `sig-badge o${c.n}`, text: c.sym }), h("span", { class: "trend-arrow", text: c.label })));
    }))));
}

/* ------------------------------------------------------------------ Anlagebarometer */
// Raster wie in einer Monatsübersicht: sechs Teilspalten, Balken über zwei davon; Startspalte = Stufe + 2
const GROUP_LABELS = { klassen: "Anlageklassen", aktien: "Aktien", anleihen: "Staatsanleihen", kredit: "Unternehmensanleihen", waehrungen: "Währungen gegenüber dem US-Dollar", rohstoffe: "Rohstoffe", relativ: "Relative Stärke" };
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
  return (q.u === "%" || q.u === "Pp." || q.u === "σ" ? signed(q.v, d) : fmt(q.v, d)) + unit;
}
function detailPanel(r) {
  const w = SIG.cfg.weights[r.row.kind];
  const cards = SIG.cfg.pillars.map(p => {
    if (!w[p.id]) return null;
    const pp = r.now.pillars[p.id];
    return h("div", { class: "pillar" },
      h("h5", null, h("span", { text: `${p.label} · Gewicht ${fmt(100 * w[p.id], 0)} %` }), h("span", null, pp ? signed(pp.s, 2) : "keine Daten", " ", pillarBar(pp ? pp.s : null))),
      pp ? h("ul", null, ...pp.parts.map(q => h("li", null, h("span", { text: q.k + (q.d ? ` (${q.d})` : "") }), h("span", { class: "v", text: q.v == null ? (q.s != null ? signed(q.s, 2) : "") : fmtPart(q) }))))
        : h("p", { class: "small", text: "Für diese Säule liegen keine Daten vor; sie entfällt, die übrigen Gewichte werden hochgerechnet." }));
  }).filter(Boolean);
  return h("div", { class: "pg-detail", hidden: true },
    h("div", { class: "pillars" }, ...cards),
    h("p", { class: "small", style: "margin-top:8px" },
      `${r.row.label}${r.row.sub ? " (" + r.row.sub + ")" : ""}: Gesamtwert ${signed(r.now.score, 2)} auf der Skala −2 bis +2, Datenstand ${deShort(SIG.isoOf(r.now.date))}; abgedeckt sind ${fmt(100 * r.now.coverage, 0)} % der Säulengewichte.`,
      r.prev && r.prev.cat ? ` Vor einem Monat: ${signed(r.prev.score, 2)} (${r.prev.cat.label}).` : "",
      r.now.raw && r.now.raw.n !== r.now.cat.n ? ` Die Stufe bleibt wegen des Toleranzbands bei „${r.now.cat.label}“; rechnerisch läge der Wert bei „${r.now.raw.label}“.` : "",
      r.perf ? ` Seit Jahresbeginn ${signed(100 * (r.perf.ytd ?? NaN), 1)} %, drei Monate ${signed(100 * (r.perf.m3 ?? NaN), 1)} %.` : ""));
}
function gridHead(extra = true) {
  return h("div", { class: "pg-group pg-hgroup" }, h("div", { class: "pg-glabel gl-h" }),
    h("div", { class: "pg-head" },
      h("div", { class: "pg-scale-h" }, h("span", { text: "negativ −" }), h("span", { text: "neutral o" }), h("span", { text: "positiv +" })),
      extra ? h("div", { class: "h spark-h", text: "6 Monate" }) : h("div"), extra ? h("div", { class: "h num-h m1-h", text: "1 Monat" }) : h("div"),
      extra ? h("div", { class: "h num-h", text: "12 Monate" }) : h("div"), h("div")));
}
function gridRow(r) {
  const c = r.now.cat, pc = r.prev && r.prev.cat ? r.prev.cat.n : null;
  const title = `${r.row.label}${r.row.sub ? " (" + r.row.sub + ")" : ""}: ${c.label} (${signed(r.now.score, 2)})${pc != null ? `; vor einem Monat ${r.prev.cat.label}` : ""}. ${trendWord(r)}.`;
  const st = staleNote(r);
  const row = h("div", { class: "pg-row", id: "baro-" + r.row.id, role: "button", tabindex: "0", "aria-expanded": "false", "aria-label": title + (st ? ` Datenstand: ${st.long}.` : "") },
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
  document.getElementById("baro-tag").textContent = `Stand ${deShort(SIG.isoOf(BARO.tNow))}`;
  let view = "scale";
  const draw = () => {
    host.replaceChildren();
    if (view === "scale") {
      const sh = sheet(host, { title: "Monatsübersicht der Signale", sub: `Einstufung zum ${deShort(SIG.isoOf(BARO.tNow))}; Zeile antippen für die Säulen im Einzelnen` });
      const grid = h("div", { class: "pgrid" }, gridHead(true));
      for (const g of BARO.groups) {
        const rows = BARO.rows.filter(r => r.row.group === g.id && r.now);
        if (!rows.length) continue;
        grid.append(h("div", { class: "pg-group" },
          h("div", { class: "pg-glabel" }, GROUP_LABELS[g.id] || g.label, g.note ? h("small", { text: g.note }) : null),
          h("div", { class: "pg-rows" }, ...rows.flatMap(gridRow))));
      }
      sh.body.append(h("div", { style: "overflow-x:auto" }, grid));
      fitBars(grid);
      const f = h("footer", { class: "src" });
      srcLinks(f, liveSrcIds(...new Set(BARO.rows.flatMap(r => collectIds(r.row.price)))));
      sh.el.append(f);
    } else {
      for (const g of BARO.groups) {
        const rows = BARO.rows.filter(r => r.row.group === g.id && r.now);
        if (!rows.length) continue;
        const sh = sheet(host, { title: GROUP_LABELS[g.id] || g.label, sub: g.note });
        sh.body.append(h("div", { style: "overflow-x:auto" }, heatTable(rows)));
      }
    }
    const missing = BARO.rows.filter(r => !r.now).map(r => r.row.label + (r.row.sub ? ` (${r.row.sub})` : ""));
    if (missing.length) host.append(h("p", { class: "small", text: `Derzeit ohne ausreichende Daten und daher nicht eingestuft: ${missing.join(", ")}.` }));
  };
  const seg = document.getElementById("baro-view");
  seg.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    view = b.dataset.v;
    seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  }));
  draw();
  renderBaroSummary();
  renderBaroMethod();
}
function collectIds(spec) {
  if (spec == null) return [];
  if (typeof spec === "string") return [spec];
  if (Array.isArray(spec)) return collectIds(spec[0]);
  if (spec.bond) return [spec.bond];
  if (spec.spread) return [spec.spread];
  if (spec.inv) return collectIds(spec.inv);
  return (spec.ratio || spec.product || spec.basket || []).flatMap(collectIds);
}
function heatTable(rows) {
  const P = SIG.cfg.pillars;
  const cell = s => h("td", null, h("div", { class: "heat-cell", style: `background:${heatColor(s)};color:${heatInk(s)}`, text: s == null ? "–" : signed(s, 1) }));
  return h("table", { class: "baro-table" },
    h("thead", null, h("tr", null, h("th", { text: "Anlage" }), ...P.map(p => h("th", { style: "text-align:center", title: p.desc, text: p.label })), h("th", { style: "text-align:center", text: "Gesamt" }), h("th", { style: "text-align:center", text: "Vormonat" }))),
    h("tbody", null, ...rows.map(r => h("tr", null,
      h("td", { class: "name" }, h("b", { text: r.row.label }), r.row.sub ? h("span", { class: "small", text: r.row.sub }) : null),
      ...P.map(p => (SIG.cfg.weights[r.row.kind][p.id] ? cell(r.now.pillars[p.id] ? r.now.pillars[p.id].s : null) : h("td", null, h("div", { class: "heat-cell", style: "color:var(--muted)", text: "·" })))),
      cell(r.now.score), cell(r.prev ? r.prev.score : null)))));
}
/* Indikatoren für die Risikoausrichtung: die Säulen des Weltaktien-Signals als eigene Zeilen */
function riskScorecard(host) {
  const w = BARO.rows.find(r => r.row.id === "eq_world" && r.now);
  if (!w) return;
  const rows = [["cycle", "Konjunkturzyklus"], ["liquidity", "Liquidität"], ["value", "Bewertung"], ["trend", "Technik und Trend"], ["risk", "Risiko und Geopolitik"]]
    .map(([k, label]) => ({ label, now: w.now.pillars[k] ? w.now.pillars[k].s : null, prev: w.prev && w.prev.pillars[k] ? w.prev.pillars[k].s : null }))
    .filter(x => x.now != null);
  rows.push({ label: "Modell gesamt", now: w.now.score, prev: w.prev ? w.prev.score : null, total: true });
  const sh = sheet(host, { title: "Indikatoren für die Risikoausrichtung", sub: "Säulen des Signals für Aktien weltweit: positiv = Umfeld spricht für riskante Anlagen, negativ = für sichere Häfen" });
  const grid = h("div", { class: "pgrid" },
    h("div", { class: "pg-group pg-hgroup no-label" }, h("div", { class: "pg-head score" },
      h("div", { class: "pg-scale-h" }, h("span", { text: "risikoscheu −" }), h("span", { text: "neutral o" }), h("span", { text: "risikofreudig +" })), h("div", { class: "h num-h", text: "Wert (Vormonat)" }))));
  const body = h("div", { class: "pg-group no-label" }, h("div", { class: "pg-rows" }, ...rows.map(x => {
    const pc = x.prev == null ? null : SIG.category(x.prev).n, c = SIG.category(x.now, pc);
    return h("div", { class: "pg-row score" + (x.total ? " total" : "") },
      h("div", { class: "pg-name", "aria-hidden": "true", text: x.label }),
      h("div", { class: "pg-track" }, barEl(x.label, x.label.split(" ")[0], c.n, pc, `${x.label}: ${c.label} (${signed(x.now, 2)})`)),
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
  const s3 = h("p", null, h("b", { text: "Risiko und Geopolitik. " }),
    ra ? `Der Risikoappetit liegt bei ${signed(ra.s, 2)} (${ra.s > 0.3 ? "Risikofreude" : ra.s < -0.3 ? "Risikoscheu" : "ausgeglichen"}). ` : "",
    tension ? `Die stärkste Zunahme der Berichterstattung verzeichnet die Konfliktlinie ${tension.label} (${signed(tension.z, 1)} Standardabweichungen über dem Viermonatsmittel).` : "");
  const chg = ok.filter(r => r.prev && r.prev.cat && r.prev.cat.n !== r.now.cat.n);
  const sh = sheet(host, { title: "Kurzüberblick", sub: `Automatisch aus den Signalen formuliert, Stand ${deShort(SIG.isoOf(BARO.tNow))}` });
  sh.body.append(h("div", { class: "inbrief" }, s1, s2, s3,
    chg.length ? h("div", { class: "summary-line", style: "margin-top:4px" }, h("span", { class: "lbl", text: "Geändert gegenüber dem Vormonat:" }),
      ...chg.map(r => h("a", { class: "chipline", href: "#baro-" + r.row.id, style: "text-decoration:none;color:inherit" }, h("span", { class: `sig-badge o${r.prev.cat.n}`, text: r.prev.cat.sym }), "→", h("span", { class: `sig-badge o${r.now.cat.n}`, text: r.now.cat.sym }), moverName(r)))) : null));
  riskScorecard(host);
}
function renderBaroMethod() {
  const host = document.getElementById("baro-method-body");
  const P = SIG.cfg.pillars, W = SIG.cfg.weights;
  const kinds = { equity: "Aktien", bond: "Staatsanleihen", credit: "Hochzinsanleihen", fx: "Währungen", gold: "Gold, Silber", commodity: "Rohstoffe", relative: "Relative Stärke" };
  host.replaceChildren(
    h("p", { text: "Jede Säule wird auf eine Skala von −2 (klar negativ) bis +2 (klar positiv) abgebildet. Rohwerte werden dazu durch eine typische Schwankungsbreite geteilt und weich begrenzt (2·tanh(z/2)). Die Gesamtnote ist das gewichtete Mittel der verfügbaren Säulen; fehlt eine Säule, werden die übrigen Gewichte hochgerechnet. Die Einstufung des Vormonats entsteht aus derselben Rechnung mit dem Datenstand von vor 30 Tagen; Monatsreihen zählen dabei erst nach ihrer üblichen Veröffentlichungsfrist." }),
    h("ul", { style: "margin:0;padding-left:18px;display:grid;gap:4px" }, ...P.map(p => h("li", null, h("b", { text: p.label + ": " }), p.desc))),
    h("div", { style: "overflow-x:auto" }, h("table", null,
      h("thead", null, h("tr", null, h("th", { text: "Gewichte" }), ...P.map(p => h("th", { text: p.label })))),
      h("tbody", null, ...Object.entries(W).map(([k, w]) => h("tr", null, h("td", { text: kinds[k] }), ...P.map(p => h("td", { text: w[p.id] ? fmt(100 * w[p.id], 0) + " %" : "–" }))))))),
    h("p", { text: `Einstufung nach Gesamtwert: ${SIG.cfg.cats.map((c, i) => `${c.sym} ${c.label} ${c.max === Infinity ? `über ${fmt(SIG.cfg.cats[i - 1].max, 1)}` : `bis ${fmt(c.max, 1)}`}`).join(" · ")}. Gegenüber der Vormonatsstufe gilt ein Toleranzband von ${fmt(SIG.cfg.hyst, 1)}: Die Stufe wechselt erst, wenn der Gesamtwert die Schwelle um mehr als diesen Betrag überschreitet. Das verhindert, dass Werte nahe einer Schwelle jeden Monat hin- und herspringen.` }),
    h("p", { text: "Anleihekurse werden aus der Rendite zehnjähriger Staatsanleihen geschätzt (Duration 8,5, Konvexität 85, laufender Kupon). Währungen sind als Preis der Währung in US-Dollar notiert; ein positives Signal bedeutet erwartete Aufwertung gegenüber dem Dollar. Die geopolitische Komponente nutzt den Spannungsmonitor: Steigt die Berichterstattung über eine Konfliktlinie deutlich über ihr Viermonatsmittel, belastet das die betroffenen Märkte (etwa China bei Spannungen mit den USA oder um Taiwan) und stützt Öl bei Spannungen im Nahen Osten." }),
    h("p", { class: "small", text: "Darstellung und Säulen lehnen sich an die monatliche Asset-Allocation-Übersicht von Pictet Asset Management an (Konjunkturzyklus, Liquidität, Bewertung, Technik und Stimmung). Der Monitor verwendet keine Daten oder Einschätzungen von Pictet; Regeln, Schwellen und Gewichte sind Setzungen dieses Monitors. Keine Anlageberatung." }));
}

/* ------------------------------------------------------------------ Konjunkturuhr */
const CLOCK_REGIONS = [["US", "cli_us"], ["EA", "cli_ea"], ["CN", "cli_cn"], ["JP", "cli_jp"], ["GB", "cli_gb"], ["IN", "cli_in"], ["CH", "cli_ch"], ["DE", "cli_de"]];
const PHASE_COL = { expansion: "--pos2", recovery: "--pos1", slowdown: "--neg1", contraction: "--neg2" };
function renderCycleClock() {
  const host = document.getElementById("cycle-clock");
  const regs = CLOCK_REGIONS.filter(([, id]) => LP(id).length > 12);
  if (!regs.length) return;
  const sh = sheet(host, {
    title: "Konjunkturuhr der großen Volkswirtschaften",
    sub: "OECD-Frühindikator (amplitudenbereinigt, langfristiges Mittel = 100): waagrecht das Niveau, senkrecht die Veränderung über drei Monate; Spur der letzten 18 Monate, Punkt = jüngster Wert",
    src: liveSrcIds(...regs.map(r => r[1])),
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
      h("h4", null, h("span", { text: RN[tr.r] }), ph ? h("span", { class: "phase-pill" }, h("i", { style: `background:var(${PHASE_COL[ph.id]})` }), ph.label) : null),
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
  if (pr.length) chartSheet(host, { title: "Leitzinsen", sub: "Leitzins der Zentralbanken, %; Eurozone: Einlagefazilität der EZB", src: liveSrcIds(...R.map(r => "pr_" + r.toLowerCase())) },
    { series: pr, height: 280, freq: liveFreq(R.map(r => "pr_" + r.toLowerCase())), refs: [{ y: 0 }], endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) + " %", ...SHORT_RANGE });
  const cpi = regionLines("cpi_", R, 1, x0);
  if (cpi.length) chartSheet(host, { title: "Inflation", sub: "Verbraucherpreise, Veränderung gegenüber dem Vorjahresmonat, %", src: liveSrcIds(...R.map(r => "cpi_" + r.toLowerCase())) },
    { series: cpi, height: 280, freq: "M", refs: [{ y: 0 }, { y: 2, label: "2 %" }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %", ...SHORT_RANGE });
  const y10 = ["US", "DE", "CH", "JP", "GB", "CN", "IN"].filter(r => LP("y10_" + r.toLowerCase()).length)
    .map(r => ({ id: r, label: r === "DE" ? "Deutschland" : RN[r], color: LC[r], data: LS("y10_" + r.toLowerCase()).filter(p => p[0] >= nowX() - 3) }));
  if (y10.length) chartSheet(host, { title: "Rendite zehnjähriger Staatsanleihen", sub: "%, letzte drei Jahre", src: liveSrcIds(...["us", "de", "ch", "jp", "gb", "cn", "in"].map(r => "y10_" + r)) },
    { series: y10, height: 280, freq: "D", refs: [{ y: 0 }], endValFmt: v => fmt(v, 2), tipFmt: v => fmt(v, 2) + " %", ...SHORT_RANGE });
  const un = regionLines("unemp_", R, 1, x0);
  if (un.length) chartSheet(host, { title: "Arbeitslosenquote", sub: "%, saisonbereinigt (OECD, harmonisiert)", src: liveSrcIds(...R.map(r => "unemp_" + r.toLowerCase())) },
    { series: un, height: 280, freq: "M", zero: true, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1) + " %", ...SHORT_RANGE });
}
function renderMarkets() {
  const host = document.getElementById("market-charts");
  const x1 = nowX() - 1;
  const fx = [["CH", "fx_chf"], ["EA", "fx_eur"], ["JP", "fx_jpy"], ["GB", "fx_gbp"], ["CN", "fx_cny"], ["IN", "fx_inr"]].filter(([, id]) => LP(id).length)
    .map(([r, id]) => ({ id: r, label: { CH: "Franken", EA: "Euro", JP: "Yen", GB: "Pfund", CN: "Renminbi", IN: "Rupie" }[r], color: LC[r], data: indexed(LS(id), x1) }));
  if (fx.length) chartSheet(host, { title: "Währungen gegenüber dem US-Dollar", sub: "Index, vor zwölf Monaten = 100; steigend = Aufwertung gegenüber dem Dollar", src: liveSrcIds("fx_chf", "fx_eur", "fx_jpy", "fx_cny") },
    { series: fx, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const eqDev = [["US", "eq_us", "USA"], ["CH", "eq_ch", "Schweiz"], ["EA", "eq_ea", "Eurozone"], ["JP", "eq_jp", "Japan"], ["GB", "eq_gb", "Großbritannien"]].filter(([, id]) => LP(id).length)
    .map(([r, id, l]) => ({ id: r, label: l, color: LC[r], data: indexed(LS(id), x1) }));
  if (eqDev.length) chartSheet(host, { title: "Aktienmärkte der Industrieländer", sub: "Index in Lokalwährung, vor zwölf Monaten = 100", src: liveSrcIds("eq_us", "eq_ch", "eq_ea", "eq_jp", "eq_gb") },
    { series: eqDev, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const eqEm = [["CN", "eq_cn", "China"], ["IN", "eq_in", "Indien"], ["RU", "eq_em", "Schwellenländer (MSCI EM)"], ["US", "eq_us", "USA (Vergleich)"]].filter(([, id]) => LP(id).length)
    .map(([r, id, l]) => ({ id: id, label: l, color: r === "RU" ? "--s7" : LC[r], data: indexed(LS(id), x1), dash: r === "US" ? "5 4" : null }));
  if (eqEm.length > 1) chartSheet(host, { title: "Aktienmärkte der Schwellenländer", sub: "Index, vor zwölf Monaten = 100; gestrichelt: S&P 500 zum Vergleich", src: liveSrcIds("eq_cn", "eq_in", "eq_em") },
    { series: eqEm, height: 280, freq: "D", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  const com = [["gold_usd", "Gold", "--s4"], ["silver_usd", "Silber", "--s7"], ["brent", "Brent", "--s2"], ["copper", "Kupfer", "--s3"]].filter(([id]) => LP(id).length)
    .map(([id, l, c]) => ({ id, label: l, color: c, data: indexed(LS(id), x1) }));
  if (com.length) chartSheet(host, { title: "Gold und Rohstoffe", sub: "Index in US-Dollar, vor zwölf Monaten = 100", src: liveSrcIds("gold_usd", "brent", "copper") },
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
    tiles.push(h("div", { class: "tile" },
      h("div", { class: "label", text: label }),
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
  if (deb.length) chartSheet(host, { title: "Staatsschulden der großen Volkswirtschaften", sub: `Bruttoschulden des Gesamtstaats in % des BIP; gestrichelt ab ${y0}: Projektion des IWF (World Economic Outlook)`, src: ["live:imf"], cls: "span-2" },
    { series: deb, height: 320, zero: true, vlines: [{ x: y0, label: "Projektion" }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1) + " %" });
  // Reale Leitzinsen: Leitzins minus Inflation (finanzielle Repression, wenn negativ)
  const R = ["US", "EA", "CH", "JP", "GB", "CN", "IN"];
  const real = R.filter(r => LP("pr_" + r.toLowerCase()).length && LP("cpi_" + r.toLowerCase()).length).map(r => {
    const pr = LP("pr_" + r.toLowerCase()), cpi = LP("cpi_" + r.toLowerCase());
    const data = cpi.filter(q => q.x >= nowX() - 8).map(q => { const p = SIG.valueAt(pr, q.e); return p ? [q.x, p.v - q.v] : null; }).filter(Boolean);
    return { id: r, label: RN[r], color: LC[r], data };
  });
  if (real.length) chartSheet(host, { title: "Reale Leitzinsen", sub: "Leitzins minus Inflationsrate, Prozentpunkte; negativ = Sparer verlieren real (finanzielle Repression)", src: liveSrcIds("pr_us", "cpi_us") },
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
    chartSheet(host, { title: "Währungen gemessen in Gold", sub: `Goldpreis in der jeweiligen Währung, Index ${fmtYearFrac(x0, "M")} = 100; je steiler, desto mehr Kaufkraft verliert die Währung gegenüber Gold`, src: liveSrcIds("gold_usd", "fx_chf", "fx_eur") },
      { series: ser, height: 280, freq: "D", endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 1), ...SHORT_RANGE });
  }
  const cof = [["cofer_usd", "US-Dollar", "--s1"], ["cofer_eur", "Euro", "--s5"], ["cofer_jpy", "Yen", "--s6"], ["cofer_gbp", "Pfund", "--s3"], ["cofer_cny", "Renminbi", "--s2"], ["cofer_chf", "Franken", "--s4"]].filter(([id]) => LP(id).length);
  if (cof.length) chartSheet(host, { title: "Anteile an den Weltdevisenreserven", sub: "IWF COFER, % der zugeordneten Reserven, Quartalswerte", src: ["live:imf_cofer"] },
    { series: cof.map(([id, l, c]) => ({ id, label: l, color: c, data: LS(id) })), height: 280, freq: "Q", log: true, logFloor: 0.1, endValFmt: v => fmt(v, 1), tipFmt: v => fmt(v, 2) + " %" });
  const cb = [["fed_assets", "Federal Reserve", "--s1"], ["ecb_assets", "Eurosystem", "--s5"], ["boj_assets", "Bank of Japan", "--s6"], ["snb_assets", "Nationalbank (SNB)", "--s4"]].filter(([id]) => LP(id).length);
  if (cb.length) chartSheet(host, { title: "Bilanzsummen der Zentralbanken", sub: "Index Januar 2019 = 100, in Landeswährung", src: liveSrcIds(...cb.map(c => c[0])) },
    { series: cb.map(([id, l, c]) => ({ id, label: l, color: c, data: indexed(LS(id), 2019) })), height: 280, freq: "M", refs: [{ y: 100 }], endValFmt: v => fmt(v, 0), tipFmt: v => fmt(v, 0) });
}
