"use strict";
/* Big-Cycle-Monitor: Start. Lädt den historischen Datensatz (data/bigcycle.json, wöchentlich über GitHub Actions)
   und den Live-Snapshot (/api/snapshot des Workers, Cron alle zehn Minuten; Rückfall: statischer Seed data/live.json),
   und rendert danach alle Kapitel. Fehler in einem Kapitel halten die übrigen nicht auf. */

function setupNav() {
  const links = [...document.querySelectorAll(".nav a")];
  const secs = links.map(a => document.querySelector(a.getAttribute("href")));
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { const i = secs.indexOf(e.target); links.forEach((a, k) => a.classList.toggle("active", k === i)); }
  }, { rootMargin: "-45% 0px -50% 0px" });
  secs.forEach(s => s && io.observe(s));
}
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function loadLive() {
  const meta = document.querySelector('meta[name="live-api"]');
  const urls = [meta ? meta.content : "/api/snapshot", "data/live.json"];
  for (const u of urls) {
    try { const j = await fetchJson(u); if (j && j.data) return j; } catch (e) { console.warn("Live-Daten nicht geladen:", u, e.message); }
  }
  return null;
}
/* Ergänzt die Live-Daten um zusammengeführte Reihen und lange Historien aus dem wöchentlichen Datensatz */
function enrichLive() {
  if (!LIVE) return;
  const g = D && D.series.gold_usd_m;
  SIG.prepareLive(LIVE, { gold_usd_m: g ? { f: "M", s: g.start, v: g.values } : null, cape: D && D.latest && D.latest.cape });
}
function liveStamp() {
  if (!LIVE) return "";
  const p = ["eq_us", "y10_us", "fx_chf"].map(lastLive).filter(Boolean).sort((a, b) => b.t - a.t)[0];
  return p ? `Märkte ${deShort(SIG.isoOf(p.t))}` : "";
}
async function boot() {
  setupNav();
  const [hist, snap] = await Promise.all([fetchJson("data/bigcycle.json").catch(e => ({ __error: e })), loadLive()]);
  if (hist.__error) {
    document.getElementById("verdict").replaceChildren(h("span", { class: "err", text: `Die Datendatei data/bigcycle.json konnte nicht geladen werden (${hist.__error.message}). Lokal die Seite über einen Webserver öffnen, etwa mit npx wrangler dev.` }));
    return;
  }
  D = hist;
  if (snap) {
    try { LIVE = SIG.decodeSnapshot(snap); enrichLive(); BARO = SIG.barometer(LIVE); } catch (e) { console.error("Live-Daten", e); }
  }
  const st = [liveStamp(), "Historie " + deShort(D.meta.generated.slice(0, 10))].filter(Boolean).join(" · ");
  document.getElementById("stamp").textContent = "Datenstand: " + st;
  const steps = [renderArchetype, renderKpis, renderMovers, renderBarometer, renderCycleClock, renderMacro, renderMarkets, renderRiskTiles,
    renderDebtWorld, renderPower, renderDebt, renderInternal, renderTension, renderPredictions, renderUncertainty, renderExternal,
    renderDemography, renderNatureLive, renderNature, renderSim, renderMethods, renderDataStatus, renderForces, renderCompare, renderVerdict, renderLeads];
  for (const f of steps) { try { f(); } catch (e) { console.error(f.name, e); } }
  if (location.hash) { const el = document.querySelector(location.hash); if (el) el.scrollIntoView(); }
}
function renderLeads() {
  const C = D.curated || {};
  const du = C.framework && C.framework.durations;
  if (du) {
    const el = document.getElementById("debt-lead");
    el.append(` Ein langer Schuldenzyklus dauert nach Dalio ${du.long} Jahre, ein kurzer ${du.short}.`);
  }
}
function verdictLive(el) {
  if (!BARO) return;
  const ok = BARO.rows.filter(r => r.now && r.row.group !== "relativ" && r.row.group !== "klassen");
  const top = ok.filter(r => r.now.cat.n >= 1).sort((a, b) => b.now.score - a.now.score).slice(0, 3).map(moverName);
  const bot = ok.filter(r => r.now.cat.n <= -1).sort((a, b) => a.now.score - b.now.score).slice(0, 3).map(moverName);
  const list = a => a.length > 1 ? a.slice(0, -1).join(", ") + " und " + a[a.length - 1] : a[0];
  const parts = [];
  if (top.length) parts.push(`positiv für ${list(top)}`);
  if (bot.length) parts.push(`negativ für ${list(bot)}`);
  if (parts.length) el.append(" Das Anlagebarometer fällt derzeit ", h("b", { text: parts.join(", ") }), " aus.");
}

/* ------------------------------------------------------------------ Natur: Live-Reihen und aktuelle Warnungen */
function renderNatureLive() {
  const host = document.getElementById("nat-live");
  const t = LS("temp_gistemp");
  if (t.length) {
    const yr = [];
    const by = new Map();
    for (const [x, v] of t) { const y = Math.floor(x + 1e-6); const e = by.get(y) || []; e.push(v); by.set(y, e); }
    for (const [y, a] of by) if (a.length === 12) yr.push([y, a.reduce((s, v) => s + v, 0) / 12]);
    chartSheet(host, { title: "Globale Temperaturabweichung, monatlich", sub: "NASA GISTEMP v4, gegenüber 1951–1980 in °C; Linie = Jahresmittel vollständiger Jahre", src: ["live:nasa"],
      info: () => { const y = yr[yr.length - 1]; return { f: ["Monatswert: Abweichung der globalen Land- und Meerestemperatur vom Mittel 1951–1980 (NASA GISTEMP v4).", "Jahresmittel = Summe der zwölf Monatswerte ÷ 12, nur für vollständige Jahre.", "Referenzlinie 1,2 °C: entspricht etwa 1,5 °C über dem vorindustriellen Niveau, weil 1951–1980 bereits rund 0,3 °C wärmer war."],
        r: y ? `Jahresmittel ${y[0]}: ${fmt(y[1], 2)} °C` : null }; } },
      { series: [{ id: "m", label: "Monatswert", color: "--s8", data: t.filter(p => p[0] >= 1990), width: 1, opacity: 0.45, endLabel: false }, { id: "y", label: "Jahresmittel", color: "--s8", data: yr.filter(p => p[0] >= 1990), markers: false }],
        height: 260, freq: "M", refs: [{ y: 0 }, { y: 1.2, label: "≈ 1,5 °C über vorindustriell" }], endValFmt: v => fmt(v, 2) + " °C", tipFmt: v => fmt(v, 2) + " °C" });
  }
  const items = LIVE && LIVE.items && LIVE.items.gdacs;
  if (items && items.length) {
    const sh = sheet(host, { title: "Aktuelle Naturgefahren mit Warnstufe", sub: "GDACS-Meldungen der letzten 30 Tage mit oranger oder roter Warnstufe (Erdbeben, Wirbelstürme, Überschwemmungen, Vulkane, Dürren)", src: ["live:gdacs"],
      info: { f: "Keine eigene Rechnung: Das Global Disaster Alert and Coordination System von EU und UN vergibt die Warnstufe aus Stärke des Ereignisses, betroffener Bevölkerung und Verwundbarkeit der Region. Gezeigt: orange und rot, die jüngsten zehn." } });
    const lvl = { Red: ["rot", "st-crit"], Orange: ["orange", "st-serious"], Green: ["grün", "st-good"] };
    sh.body.append(h("div", { class: "events" }, ...items.slice(0, 10).map(e => h("div", { class: "event" },
      h("div", { class: "d", text: deShort(e.date) }),
      h("div", { class: "t" }, h("div", null, h("span", { class: "pill " + (lvl[e.level] || ["", "st-none"])[1], style: "margin-right:6px" }, h("span", { class: "dot" }), (lvl[e.level] || [e.level])[0]), `${e.type}: ${e.name}`), e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener", text: "GDACS-Bericht" }) : null)))));
  }
}

/* ------------------------------------------------------------------ Datenstatus der Abrufjobs */
function renderDataStatus() {
  const host = document.getElementById("datastatus");
  if (!LIVE) {
    host.replaceChildren(h("div", { class: "note-box", text: "Der Live-Datenstand des Workers konnte nicht geladen werden; angezeigt werden nur die wöchentlich aktualisierten historischen Reihen." }));
    return;
  }
  const S = Object.entries(LIVE.status || {});
  const now = Date.now();
  const age = s => (s.okAt ? (now - Date.parse(s.okAt)) / 3600000 : null);
  const state = s => {
    if (s.ok == null && !s.okAt) return ["noch nicht geladen", "st-none"];
    const a = age(s);
    if (a != null && a > Math.max(3 * s.every, s.every + 24)) return ["veraltet", "st-serious"];
    if (s.ok === false) return ["Fehler, letzter Stand", "st-warn"];
    return ["aktuell", "st-good"];
  };
  const counts = S.reduce((c, [, s]) => { const k = state(s)[1]; c[k] = (c[k] || 0) + 1; return c; }, {});
  const sh = sheet(host, {
    info: { d: "Zeigt für jeden Abrufjob, wann er zuletzt Daten geladen hat und ob dabei Fehler auftraten.",
      f: ["Der Cron-Trigger des Workers läuft alle zehn Minuten und lädt die Jobs, deren Takt abgelaufen ist (mit 10 % Toleranz), höchstens acht je Lauf.",
        "aktuell: letzter Abruf erfolgreich. Fehler, letzter Stand: letzter Versuch fehlgeschlagen, die alten Daten bleiben stehen; neuer Versuch nach 1, 2, 4, 8, 12 bzw. 24 Stunden.",
        "veraltet: letzter erfolgreicher Abruf liegt mehr als das Dreifache des Takts und mindestens einen Tag über dem Takt zurück.",
        "Jüngster Wert: Datum der neuesten Beobachtung in den geladenen Reihen (bei Monatswerten der Monat)."] },
    title: "Datenstatus der täglichen Abrufe",
    sub: `Snapshot vom ${LIVE.generated ? deDate(LIVE.generated.slice(0, 10)) + ", " + LIVE.generated.slice(11, 16) + " UTC" : "–"} (${LIVE.origin === "worker" ? "Cloudflare-Worker" : "statischer Seed"}). Der Cron-Trigger läuft alle zehn Minuten und lädt jeweils die fälligen Quellen; fällt eine Quelle aus, bleibt ihr letzter guter Stand stehen.`,
  });
  sh.body.append(h("div", { class: "ds-summary" },
    h("span", { class: "status-dot" }, h("i", { style: "background:var(--good)" }), `${counts["st-good"] || 0} aktuell`),
    h("span", { class: "status-dot" }, h("i", { style: "background:var(--warn)" }), `${counts["st-warn"] || 0} mit Fehler beim letzten Versuch`),
    h("span", { class: "status-dot" }, h("i", { style: "background:var(--serious)" }), `${counts["st-serious"] || 0} veraltet`),
    h("span", { class: "status-dot" }, h("i", { style: "background:var(--axis)" }), `${counts["st-none"] || 0} noch nicht geladen`)));
  const rows = S.sort((a, b) => a[1].source.localeCompare(b[1].source) || a[1].label.localeCompare(b[1].label));
  const tbl = h("table", { class: "sources ds-table" },
    h("thead", null, h("tr", null, h("th", { text: "Abruf" }), h("th", { text: "Quelle" }), h("th", { text: "Takt" }), h("th", { text: "Letzter Abruf" }), h("th", { text: "Jüngster Wert" }), h("th", { text: "Status" }))),
    h("tbody", null, ...rows.map(([id, s]) => {
      const [w, cls] = state(s);
      const src = LSRC[s.source];
      return h("tr", null,
        h("td", null, s.label, h("div", { class: "small mono", text: id })),
        h("td", null, src ? h("a", { href: src.url, target: "_blank", rel: "noopener", text: src.name }) : s.source),
        h("td", { class: "when", text: s.every >= 24 ? `${fmt(s.every / 24, 0)} T.` : `${fmt(s.every, s.every < 1 ? 2 : 0)} h` }),
        h("td", { class: "when", text: s.okAt ? `${deShort(s.okAt.slice(0, 10))} ${s.okAt.slice(11, 16)}` : "–" }),
        h("td", { class: "when", text: s.latest || "–" }),
        h("td", null, h("span", { class: "pill " + cls }, h("span", { class: "dot" }), w), s.error ? h("div", { class: "err-text", text: s.error }) : null));
    })));
  sh.body.append(h("details", { class: "more", style: "margin-top:10px" }, h("summary", { text: `Alle ${rows.length} Abrufjobs anzeigen` }), h("div", { style: "overflow-x:auto" }, stackTable(tbl))));
}
document.addEventListener("DOMContentLoaded", boot);
