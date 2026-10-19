/* Abrufjobs für Geopolitik und Naturgefahren: GDELT-Ereignisdaten, Prognosemärkte, GDACS-Warnungen */
import { dailySeries } from "./lib/series.js";
import { meta } from "./lib/jobutil.js";
import { PAIRS, latestStamp, fetchExport, stepStamp, addToState, stateToSeries } from "./providers/gdelt.js";

/* Polymarket: Ereignisse, deren Wahrscheinlichkeiten die Spannungen zwischen den großen Mächten abbilden.
   Die Liste ist zu pflegen: abgelaufene Märkte fallen von selbst heraus. */
export const POLY_SLUGS = [
  "will-china-invade-taiwan-before-2027",
  "china-x-taiwan-military-clash-before-2027",
  "will-china-blockade-taiwan-by-in-2026",
  "russia-x-ukraine-ceasefire-agreement-by",
  "nato-x-russia-military-clash-in-2025",
  "will-the-us-invade-iran-before-2027",
  "us-recession-by-end-of-2026",
  "us-tariff-rate-on-china-on-december-31-2026",
];
const POLY_SEARCH = ["fed decision"];
const GDACS_TYPE = { EQ: "Erdbeben", TC: "Tropischer Wirbelsturm", FL: "Überschwemmung", VO: "Vulkanausbruch", DR: "Dürre", WF: "Waldbrand" };

function pickMarkets(ev, now) {
  const open = (ev.markets || []).filter(m => !m.closed && m.active !== false && m.outcomePrices);
  const parsed = open.map(m => {
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices).map(Number); } catch { /* ignorieren */ }
    let outcomes = [];
    try { outcomes = JSON.parse(m.outcomes || "[]"); } catch { /* ignorieren */ }
    return { q: m.question, p: prices[0], vol: +(m.volume || 0), end: (m.endDate || "").slice(0, 10), d1: m.oneDayPriceChange == null ? null : +m.oneDayPriceChange, label: m.groupItemTitle || outcomes[0] || null };
  }).filter(m => m.p != null && isFinite(m.p) && (!m.end || Date.parse(m.end) > now));
  if (parsed.length <= 2) return parsed;
  // Ereignisse mit Fristen ("bis ..."): nächster Termin mindestens 30 Tage voraus und spätester Termin
  if (parsed.every(m => /by|before|bis/i.test(m.q))) {
    const sorted = parsed.slice().sort((a, b) => (a.end < b.end ? -1 : 1));
    const near = sorted.find(m => Date.parse(m.end) - now > 30 * 864e5) || sorted[0];
    const far = sorted[sorted.length - 1];
    return near === far ? [near] : [near, far];
  }
  // Ereignisse mit mehreren Ausgängen (etwa Zinsentscheid): die zwei wahrscheinlichsten
  return parsed.sort((a, b) => b.p - a.p).slice(0, 2);
}

export const GEO_JOBS = [
  {
    id: "gdelt_tension", label: "Spannungsmonitor: GDELT-Ereignisdaten (alle 15 Minuten eine Datei)", source: "gdelt", every: 0.5, cost: 4, frequent: true, onePerRun: true,
    async run(F, ctx) {
      let state = await ctx.state.get("gdelt");
      if (!state || !state.days) state = (await ctx.seed("data/gdelt-state.json")) || { days: {}, last: null };
      delete state.done;
      const latest = await latestStamp(F);
      let next = state.last ? stepStamp(state.last, 1) : stepStamp(latest, -2);
      // nach längerem Ausfall nicht alles nachholen, sondern bei den jüngsten Dateien weitermachen
      if (state.last && next < stepStamp(latest, -96)) next = stepStamp(latest, -2);
      const max = Math.max(1, +(ctx.env.GDELT_FILES_PER_RUN || 3));
      let done = 0;
      while (next <= latest && done < max && F.used < F.budget) {
        try {
          addToState(state, next, await fetchExport(F, next));
        } catch (e) {
          if (!/HTTP 404/.test(e.message)) throw e; // einzelne fehlende Dateien überspringen
          state.last = next;
        }
        next = stepStamp(next, 1);
        done++;
      }
      await ctx.state.put("gdelt", state);
      const ser = stateToSeries(state);
      const s = {};
      for (const p of PAIRS) {
        const r = ser[p.id];
        if (!r || !r.conflict.length) continue;
        s["gdelt_c_" + p.id] = dailySeries(r.conflict, meta(`Konfliktintensität: ${p.label}`, "je 10.000 Erwähnungen", "gdelt"));
        s["gdelt_k_" + p.id] = dailySeries(r.coop, meta(`Kooperationsintensität: ${p.label}`, "je 10.000 Erwähnungen", "gdelt"));
        s["gdelt_n_" + p.id] = dailySeries(r.events, meta(`Ereignisse: ${p.label}`, "Anzahl (Stichprobe)", "gdelt"));
      }
      return { series: s, info: { last: state.last, days: Object.keys(state.days).length } };
    },
  },
  {
    id: "polymarket", label: "Prognosemärkte zu Konflikten, Rezession und Zinsen (Polymarket)", source: "polymarket", every: 6, cost: 4,
    async run(F, ctx) {
      const now = ctx.now;
      const evs = await F.json("https://gamma-api.polymarket.com/events?" + POLY_SLUGS.map(s => "slug=" + encodeURIComponent(s)).join("&"), { timeout: 30000 });
      const found = Array.isArray(evs) ? evs : [];
      for (const q of POLY_SEARCH) {
        try {
          const r = await F.json(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=6&events_status=active`, { timeout: 30000 });
          const next = (r.events || []).filter(e => !e.closed && e.endDate && Date.parse(e.endDate) > now && /^Fed Decision/i.test(e.title || ""))
            .sort((a, b) => (a.endDate < b.endDate ? -1 : 1))[0];
          if (next) {
            const full = await F.json(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(next.slug)}`, { timeout: 30000 });
            if (Array.isArray(full) && full[0]) found.push(full[0]);
          }
        } catch (e) { /* Suche ist optional */ }
      }
      const items = [];
      for (const ev of found) {
        for (const m of pickMarkets(ev, now)) {
          if (m.vol < 50000) continue;
          items.push({ q: m.label && !/^yes$/i.test(m.label) && ev.title && /Fed Decision/i.test(ev.title) ? `${ev.title.replace("?", "")}: ${m.label}` : m.q, p: m.p, vol: m.vol, end: m.end, d1: m.d1, event: ev.title, url: `https://polymarket.com/event/${ev.slug}` });
        }
      }
      items.sort((a, b) => b.vol - a.vol);
      if (!items.length) throw new Error("Polymarket: keine offenen Märkte gefunden");
      return { series: {}, items };
    },
  },
  {
    id: "gdacs", label: "Naturgefahren mit oranger oder roter Warnstufe (GDACS)", source: "gdacs", every: 6, cost: 1,
    async run(F, ctx) {
      const to = new Date(ctx.now).toISOString().slice(0, 10), from = new Date(ctx.now - 30 * 864e5).toISOString().slice(0, 10);
      const j = await F.json(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&fromDate=${from}&toDate=${to}&alertlevel=Orange;Red`, { timeout: 30000 });
      const items = (j.features || []).map(f => {
        const p = f.properties || {};
        return {
          date: (p.fromdate || p.todate || "").slice(0, 10), type: GDACS_TYPE[p.eventtype] || p.eventtype, name: p.name || p.eventname || p.country || "",
          level: p.alertlevel, country: p.country, url: p.url && (p.url.report || p.url.details) || null,
        };
      }).filter(e => e.date).sort((a, b) => (a.date < b.date ? 1 : -1));
      return { series: {}, items };
    },
  },
];
