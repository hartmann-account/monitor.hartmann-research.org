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
// ohne cache: "no-cache": der Snapshot darf fünf Minuten, data/* eine Viertelstunde aus dem Browser-Speicher kommen
// (Cache-Control von Worker und public/_headers); so greifen auch die Vorab-Ladeanweisungen im Kopf der Seite
async function fetchJson(url) {
  const r = await fetch(url);
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
  const m = id => { const x = D && D.series[id]; return x ? { f: "M", s: x.start, v: x.values } : null; };
  SIG.prepareLive(LIVE, { gold_usd_m: m("gold_usd_m"), sp500_m: m("sp500_m"), cape_m: m("cape_m"), gpr_m: m("gpr_hist_m"), cape: D && D.latest && D.latest.cape });
}
function liveStamp() {
  if (!LIVE) return "";
  const p = ["eq_us", "y10_us", "fx_chf"].map(lastLive).filter(Boolean).sort((a, b) => b.t - a.t)[0];
  return p ? `Märkte ${deShort(SIG.isoOf(p.t))}` : "";
}
async function boot() {
  setupNav();
  // Backtest-Kennzahlen: Rückfall, solange der Worker sie noch nicht im Snapshot liefert
  const [hist, snap, bt, rob] = await Promise.all([fetchJson("data/bigcycle.json").catch(e => ({ __error: e })), loadLive(), fetchJson("data/backtest.json").catch(() => null),
    fetchJson("data/robustness.json").catch(() => null)]);
  BT_SEED = bt;
  ROBUST = rob;
  if (hist.__error) {
    document.getElementById("lage").classList.remove("laedt");
    document.getElementById("verdict").replaceChildren(h("span", { class: "err", text: `Die Datendatei data/bigcycle.json konnte nicht geladen werden (${hist.__error.message}). Lokal die Seite über einen Webserver öffnen, etwa mit npx wrangler dev.` }));
    return;
  }
  D = hist;
  if (snap) {
    try { LIVE = SIG.decodeSnapshot(snap); enrichLive(); setHorizon(savedHorizon()); if (!BARO) setHorizon("m1"); } catch (e) { console.error("Live-Daten", e); }
  }
  const st = [liveStamp(), "Historie " + deShort(D.meta.generated.slice(0, 10))].filter(Boolean).join(" · ");
  document.getElementById("stamp").textContent = "Datenstand: " + st;
  const run = f => { try { f(); } catch (e) { console.error(f.name, e); } };
  // oberer Teil (Lage, Kräfte, Kennzahlen, Barometer) in einem Zug, damit dort nichts nachrutscht
  [estimateStages, renderArchetype, renderVerdict, renderMovers, renderForces, renderKpis, renderCompare, renderBarometer].forEach(run);
  document.getElementById("lage").classList.remove("laedt");
  // übrige Abschnitte einzeln, dazwischen zeichnet der Browser und reagiert auf Eingaben
  let moved = false;
  const mark = () => { moved = true; };
  const evs = ["wheel", "touchstart", "keydown", "pointerdown"];
  evs.forEach(t => addEventListener(t, mark, { once: true, passive: true }));
  for (const f of [renderCycleClock, renderMacro, renderMarkets, renderRiskTiles, renderDebtWorld, renderPower, renderDebt, renderInternal,
    renderTension, renderPredictions, renderUncertainty, renderExternal, renderDemography, renderNatureLive, renderNature, renderSim,
    renderMethods, renderDataStatus, renderLeads]) { await yieldToBrowser(); run(f); }
  evs.forEach(t => removeEventListener(t, mark));
  // Sprungziel aus der Adresse erst jetzt anfahren (Abschnitte darüber sind fertig), aber nicht gegen den Nutzer
  if (location.hash && !moved) { const el = document.querySelector(location.hash); if (el) el.scrollIntoView(); }
}
// kurz an den Browser abgeben; scheduler.yield, sonst eine Nachricht über MessageChannel (anders als setTimeout in
// Hintergrund-Tabs nicht auf eine Sekunde gedrosselt)
function yieldToBrowser() {
  if (globalThis.scheduler && typeof scheduler.yield === "function") return scheduler.yield();
  return new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(null); });
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
  const B = baroFor("m1");
  if (!B) return;
  const ok = B.rows.filter(r => r.now && r.row.group !== "relativ" && r.row.group !== "klassen" && r.row.group !== "gold");
  const top = ok.filter(r => r.now.cat.n >= 1).sort((a, b) => b.now.score - a.now.score).slice(0, 3).map(moverName);
  const bot = ok.filter(r => r.now.cat.n <= -1).sort((a, b) => a.now.score - b.now.score).slice(0, 3).map(moverName);
  const list = a => a.length > 1 ? a.slice(0, -1).join(", ") + " und " + a[a.length - 1] : a[0];
  const parts = [];
  if (top.length) parts.push(`positiv für ${list(top)}`);
  if (bot.length) parts.push(`negativ für ${list(bot)}`);
  if (parts.length) el.append(" Das Anlagebarometer fällt auf Sicht eines Monats ", h("b", { text: parts.join(", ") }), " aus.");
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
  const archCell = s => {
    if (!s.arch) return s.source === "d1" ? "schreibt selbst" : "–";
    if (s.arch.err) return "Fehler beim Schreiben";
    const deep = s.deep === undefined ? "" : s.deep ? (s.deep === "übersprungen" ? "" : " · volle Historie übernommen") : " · volle Historie folgt";
    return `${fmt(s.arch.points || 0, 0)} Werte geschrieben${deep}`;
  };
  const tbl = h("table", { class: "sources ds-table" },
    h("thead", null, h("tr", null, h("th", { text: "Abruf" }), h("th", { text: "Quelle" }), h("th", { text: "Takt" }), h("th", { text: "Letzter Abruf" }), h("th", { text: "Jüngster Wert" }), h("th", { text: "Archiv (D1)" }), h("th", { text: "Status" }))),
    h("tbody", null, ...rows.map(([id, s]) => {
      const [w, cls] = state(s);
      const src = LSRC[s.source];
      return h("tr", null,
        h("td", null, s.label, h("div", { class: "small mono", text: id })),
        h("td", null, src ? h("a", { href: src.url, target: "_blank", rel: "noopener", text: src.name }) : s.source === "d1" ? "Cloudflare D1 (eigene Datenbank)" : s.source),
        h("td", { class: "when", text: s.every >= 24 ? `${fmt(s.every / 24, 0)} T.` : s.every < 1 ? `${fmt(s.every * 60, 0)} min` : `${fmt(s.every, 0)} h` }),
        h("td", { class: "when", text: s.okAt ? `${deShort(s.okAt.slice(0, 10))} ${s.okAt.slice(11, 16)}` : "–" }),
        h("td", { class: "when", text: s.latest || "–" }),
        h("td", { class: "small", text: archCell(s), title: s.arch && s.arch.err ? s.arch.err : null }),
        h("td", null, h("span", { class: "pill " + cls }, h("span", { class: "dot" }), w), s.error ? h("div", { class: "err-text", text: s.error }) : null));
    })));
  sh.body.append(h("details", { class: "more", style: "margin-top:10px" }, h("summary", { text: `Alle ${rows.length} Abrufjobs anzeigen` }), h("div", { style: "overflow-x:auto" }, stackTable(tbl))));
  renderArchive(host);
}

/* ------------------------------------------------------------------ Datenarchiv (D1) */
const FREQ_DE = { D: "täglich", W: "wöchentlich", M: "monatlich", B: "zweimonatlich", Q: "vierteljährlich", S: "halbjährlich", A: "jährlich" };
function apiBase() { const m = document.querySelector('meta[name="live-api"]'); return (m ? m.content : "/api/snapshot").replace(/\/api\/snapshot$/, ""); }
function renderArchive(host) {
  const box = h("div");
  host.append(box);
  // das Verzeichnis (rund 180 KB) erst laden, wenn der Abschnitt in die Nähe kommt
  if (typeof IntersectionObserver !== "function") return loadArchive(box);
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); loadArchive(box); } }, { rootMargin: "800px 0px" });
  io.observe(box);
}
function loadArchive(box) {
  fetch(apiBase() + "/api/archive").then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(A => {
    const t = A.totals || {};
    if (!t.series) throw new Error("leer");
    const base = apiBase();
    const sh = sheet(box, { title: "Datenarchiv (D1)", sub: "Jede abgerufene Beobachtung wird in einer eigenen Cloudflare-D1-Datenbank gespeichert und bei jedem Abruf ergänzt; Revisionen der Quellen überschreiben den gespeicherten Wert",
      info: { d: "Die Historie gehört dem Monitor: Auch wenn eine Quelle ältere Werte nicht mehr anbietet (etwa die ICE-BofA-Risikoprämien auf FRED nach drei Jahren), bleiben sie im Archiv.",
        f: ["Bei jedem erfolgreichen Abruf schreibt der Worker alle neuen Beobachtungen in die Tabelle obs (Reihe, Datum, Wert); bekannte Tage werden nur bei geänderten Werten überschrieben.",
          "Beim ersten Archivlauf eines Abrufs lädt der Worker die ganze Historie der Quelle (FRED etwa seit den 1950er-Jahren, EZB seit 1999, OECD seit 1990) und speichert sie vollständig, auch wenn der Snapshot der Seite nur die letzten Jahre enthält.",
          "Datum = Beginn der Periode (Monat 2026-09 → 2026-09-01, Quartal → erster Tag des Quartals, Jahr → 1. Januar). Langfristreihen des wöchentlichen Datensatzes tragen das Präfix h_, Prognosemärkte pm_.",
          "Zusätzlich gespeichert: der Signalverlauf aller drei Horizonte (Tabelle signal_hist) und die GDACS-Meldungen (Tabelle events)."],
        r: `${fmt(t.series, 0)} Reihen, ${fmt(t.obs, 0)} Beobachtungen, ältester Wert ${t.first || "–"}` } });
    sh.body.append(h("div", { class: "arch-sum" },
      ...[["Reihen", fmt(t.series, 0), ""], ["Beobachtungen", fmt(t.obs, 0), ""], ["Ältester Wert", t.first ? t.first.slice(0, 4) : "–", t.first ? deShort(t.first) : ""], ["Zuletzt ergänzt", t.updated ? deShort(t.updated.slice(0, 10)) : "–", t.updated ? t.updated.slice(11, 16) + " UTC" : ""]]
        .map(([l, v, m]) => h("div", { class: "tile" }, h("div", { class: "label", text: l }), h("div", { class: "value", text: v }), h("div", { class: "meta" }, h("span", { text: m }))))));
    sh.body.append(h("div", { class: "arch-links" }, h("span", { class: "small", text: "Herunterladen (CSV):" }),
      ...SIG.cfg.horizons.map(x => h("a", { href: `${base}/api/signals?h=${x.id}&format=csv&pillars=1`, text: `Signalverlauf ${x.label}` })),
      h("a", { href: `${base}/api/archive`, text: "Reihenverzeichnis (JSON)" }),
      (A.events || []).length ? h("a", { href: `${base}/api/events`, text: `GDACS-Meldungen (${fmt(A.events.reduce((a, e) => a + e.n, 0), 0)})` }) : null));
    const q = h("input", { type: "search", placeholder: "Reihe suchen, etwa gold, y10, debt_usa …", "aria-label": "Reihe im Archiv suchen", class: "arch-q" });
    const tb = h("tbody");
    const tbl = h("table", { class: "sources ds-table" }, h("thead", null, h("tr", null, h("th", { text: "Reihe" }), h("th", { text: "Frequenz, Einheit" }), h("th", { text: "von" }), h("th", { text: "bis" }), h("th", { text: "Werte" }), h("th", { text: "Abruf" }))), tb);
    const fill = () => {
      const s = q.value.trim().toLowerCase();
      const list = A.series.filter(x => !s || x.id.toLowerCase().includes(s) || (x.label || "").toLowerCase().includes(s)).slice(0, 300);
      tb.replaceChildren(...list.map(x => h("tr", null,
        h("td", null, x.label || x.id, h("div", { class: "small mono", text: x.id })),
        h("td", { class: "small", text: [FREQ_DE[x.freq] || x.freq, x.unit].filter(Boolean).join(", ") }),
        h("td", { class: "when", text: x.first ? (x.freq === "A" ? x.first.slice(0, 4) : x.first) : "–" }),
        h("td", { class: "when", text: x.last ? (x.freq === "A" ? x.last.slice(0, 4) : x.last) : "–" }),
        h("td", { class: "when", text: fmt(x.n || 0, 0) }),
        h("td", null, h("a", { href: `${base}/api/series?id=${encodeURIComponent(x.id)}&format=csv`, text: "CSV" }), " · ", h("a", { href: `${base}/api/series?id=${encodeURIComponent(x.id)}`, text: "JSON" })))));
      stackTable(tbl); // auf dem Telefon als Karten
    };
    q.addEventListener("input", fill);
    // die Tabelle (Tausende Elemente) erst beim Aufklappen bauen
    const more = h("details", { class: "more" }, h("summary", { text: `Alle ${fmt(A.series.length, 0)} archivierten Reihen anzeigen` }), q, h("div", { style: "overflow-x:auto" }, tbl));
    more.addEventListener("toggle", () => { if (more.open && !tb.firstChild) fill(); });
    sh.body.append(more);
    if (A.dbnomics && A.dbnomics.providers) renderDbnomics(box, A.dbnomics, base);
  }).catch(() => {
    box.append(h("p", { class: "note-box", text: "Das Datenarchiv (Cloudflare D1) ist über den Worker erreichbar, sobald die Datenbank gebunden ist und die ersten Abrufe gespeichert sind; in der statischen Vorschau gibt es kein Archiv." }));
  });
}
/* ------------------------------------------------------------------ DBnomics-Bestand (eigene D1-Datenbank, Rohdaten in R2) */
const DBN_P = { IMF: "Internationaler Währungsfonds", OECD: "OECD", Eurostat: "Eurostat", ECB: "Europäische Zentralbank", BIS: "Bank für Internationalen Zahlungsausgleich",
  WB: "Weltbank", FED: "Federal Reserve", ISM: "Institute for Supply Management", EC: "Europäische Kommission (Konjunkturumfragen)", NBS: "Statistikamt China",
  BCB: "Banco Central do Brasil", TCMB: "Zentralbank der Türkei", SARB: "South African Reserve Bank", BI: "Bank Indonesia", MOSPI: "Statistikministerium Indien",
  INEGI: "Statistikamt Mexiko", SAFE: "Devisenbehörde China" };
function renderDbnomics(box, D, base) {
  const t = D.totals || {}, P = D.progress || null;
  const prog = !P ? ["–", "noch nicht begonnen"]
    : P.doneAt ? ["vollständig", `Durchgang ${P.round} am ${deShort(P.doneAt.slice(0, 10))}; nächste Prüfung ab ${deShort(P.nextRound.slice(0, 10))}`]
      : [`${fmt(P.at, 0)} / ${fmt(P.datasets || 0, 0)}`, P.current ? `Durchgang ${P.round}, gerade ${P.current.ds}` : P.planned ? `Durchgang ${P.round} läuft (Datensätze bearbeitet / geplant)` : `Durchgang ${P.round}, Liste wird aufgestellt`];
  const sh = sheet(box, { title: "DBnomics-Bestand (eigene D1-Datenbank und R2)",
    sub: "Relevante Datensätze von IWF (alle WEO-Ausgaben seit 2008), OECD, Eurostat, EZB, BIZ, Weltbank, Fed, ISM, EU-Kommission und Schwellenländern als eigener Bestand; die Antworten der Schnittstelle liegen zusätzlich unverändert im R2-Bucket",
    info: { d: "DBnomics bündelt die Daten von über 90 Statistikanbietern. Der Monitor übernimmt die für Konjunktur, Zinsen, Kredit, Preise und Prognosen relevanten Datensätze in eine eigene Datenbank, damit sie auch dann verfügbar bleiben, wenn eine Quelle ältere Stände nicht mehr anbietet.",
      f: ["Der Job dbnomics lädt alle zehn Minuten einige Seiten (je Seite bis zu 1.000 Reihen mit allen Beobachtungen), bis alle Datensätze übernommen sind; danach prüft er wöchentlich, welche Datensätze DBnomics neu indexiert hat, und lädt nur diese neu.",
        "Große Datensätze sind auf die rund 25 Länder des Monitors begrenzt (etwa IFS des IWF, Weltbank-Indikatoren); die Echtzeit-Datensätze (WEO-Ausgaben, Eurostat-Vintages, EZB-Projektionen und -Umfragen) bleiben vollständig.",
        "Reihen: Anzahl der übernommenen Reihen. Beobachtungen: gespeicherte Werte ohne fehlende (NA). Kennung im Monitor: dbn.<Anbieter>.<Datensatz>.<Reihe>.",
        "R2 (Bucket monitor): dbnomics/<Anbieter>/<Datensatz>/<Stand>/… mit jeder Antwort der Schnittstelle, dazu datensatz.json mit Dimensionen, Filter und Umfang; ältere Stände bleiben erhalten. Fed Z.1 (42.000 Reihen) liegt nur in R2."],
      r: `${fmt(t.datasets || 0, 0)} Datensätze, ${fmt(t.series || 0, 0)} Reihen, ${fmt(t.obs || 0, 0)} Beobachtungen` } });
  sh.body.append(h("div", { class: "arch-sum" },
    ...[["Datensätze", fmt(t.datasets || 0, 0), ""], ["Reihen", fmt(t.series || 0, 0), ""], ["Beobachtungen", fmt(t.obs || 0, 0), ""], ["Import", prog[0], prog[1]]]
      .map(([l, v, m]) => h("div", { class: "tile" }, h("div", { class: "label", text: l }), h("div", { class: "value", text: v }), h("div", { class: "meta" }, h("span", { text: m }))))));
  // fehlgeschlagene Datensätze mit Namen und Fehler (der Job versucht sie im nächsten Durchgang erneut)
  const fl = P && P.failedList ? P.failedList : [];
  if (fl.length) sh.body.append(h("p", { class: "small" }, h("b", { text: `${fl.length === 1 ? "Ein Datensatz" : fl.length + " Datensätze"} nicht übernommen` }),
    " (neuer Versuch im nächsten Durchgang): ", ...fl.flatMap((x, i) => [i ? "; " : "", h("span", { class: "mono", text: x.ds }), x.error ? ` – ${x.error}` : ""])));
  const pt = h("table", { class: "sources ds-table" },
    h("thead", null, h("tr", null, h("th", { text: "Anbieter" }), h("th", { text: "Datensätze" }), h("th", { text: "Reihen" }), h("th", { text: "Beobachtungen" }), h("th", { text: "Zuletzt übernommen" }))),
    h("tbody", null, ...(D.providers || []).map(r => h("tr", null,
      h("td", null, h("a", { href: `https://db.nomics.world/${r.p}`, target: "_blank", rel: "noopener", text: DBN_P[r.p] || r.p }), h("div", { class: "small mono", text: r.p })),
      h("td", { class: "when", text: fmt(r.datasets, 0) }),
      h("td", { class: "when", text: fmt(r.series || 0, 0) }),
      h("td", { class: "when", text: r.raw === r.datasets ? "nur R2" : fmt(r.obs || 0, 0) }),
      h("td", { class: "when", text: r.updated ? `${deShort(r.updated.slice(0, 10))} ${r.updated.slice(11, 16)}` : "–" })))));
  stackTable(pt);
  sh.body.append(h("div", { style: "overflow-x:auto" }, pt));
  sh.body.append(h("div", { class: "arch-links" }, h("span", { class: "small", text: "Verzeichnis (JSON):" }),
    h("a", { href: `${base}/api/dbnomics?datasets=1`, text: "alle Datensätze" }), h("a", { href: `${base}/api/dbnomics?q=`, text: "Reihen (erste 200)" }),
    h("a", { href: `${base}/api/rohdaten?prefix=dbnomics/`, text: "Rohdaten im R2-Bucket" })));
  // Suche über die Schnittstelle (der Bestand ist zu groß für eine Liste auf der Seite)
  const q = h("input", { type: "search", placeholder: "DBnomics-Reihe suchen, etwa unemployment, NGDP_RPCH, PMI …", "aria-label": "Reihe im DBnomics-Bestand suchen", class: "arch-q" });
  const tb = h("tbody"), note = h("p", { class: "small" });
  const tbl = h("table", { class: "sources ds-table" }, h("thead", null, h("tr", null, h("th", { text: "Reihe" }), h("th", { text: "Frequenz, Einheit" }), h("th", { text: "von" }), h("th", { text: "bis" }), h("th", { text: "Werte" }), h("th", { text: "Abruf" }))), tb);
  let timer = null, seq = 0, list = [], shown = 0;
  // Treffer in Schritten von 50 zeigen (auf dem Telefon wird jede Zeile zur Karte)
  const more = h("button", { type: "button", class: "btn-more", text: "Weitere Treffer zeigen" });
  more.hidden = true;
  const show = n => {
    shown = Math.min(list.length, n);
    more.hidden = shown >= list.length;
    tb.replaceChildren(...list.slice(0, shown).map(x => h("tr", null,
        h("td", null, x.label || x.id, h("div", { class: "small mono", text: x.id })),
        h("td", { class: "small", text: [FREQ_DE[x.freq] || x.freq, x.unit].filter(Boolean).join(", ") }),
        h("td", { class: "when", text: x.first ? (x.freq === "A" ? x.first.slice(0, 4) : x.first) : "–" }),
        h("td", { class: "when", text: x.last ? (x.freq === "A" ? x.last.slice(0, 4) : x.last) : "–" }),
        h("td", { class: "when", text: fmt(x.n || 0, 0) }),
        h("td", null, h("a", { href: `${base}/api/series?id=${encodeURIComponent(x.id)}&format=csv`, text: "CSV" }), " · ", h("a", { href: `${base}/api/series?id=${encodeURIComponent(x.id)}`, text: "JSON" })))));
    stackTable(tbl);
  };
  more.addEventListener("click", () => show(shown + 50));
  const search = () => {
    const s = q.value.trim();
    if (s.length < 2) { list = []; show(0); note.textContent = "Mindestens zwei Zeichen eingeben; gesucht wird in Bezeichnung und Kennung."; return; }
    const my = ++seq;
    note.textContent = "Suche …";
    fetch(`${base}/api/dbnomics?q=${encodeURIComponent(s)}`).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(R => {
      if (my !== seq) return;
      list = R.series || [];
      note.textContent = list.length ? `${list.length >= 200 ? "Mehr als 200 Treffer, gezeigt werden die ersten 200; die Suche lässt sich mit weiteren Wörtern der Bezeichnung oder Kennung eingrenzen" : `${fmt(list.length, 0)} Treffer`}` : "Keine Treffer";
      show(50);
    }).catch(() => { if (my === seq) note.textContent = "Suche gerade nicht möglich"; });
  };
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 350); });
  sh.body.append(h("details", { class: "more" }, h("summary", { text: "Im DBnomics-Bestand suchen" }), q, note, h("div", { style: "overflow-x:auto" }, tbl), more));
}
document.addEventListener("DOMContentLoaded", boot);
