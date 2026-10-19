/* Gemeinsame Hilfen der Abrufjobs */
import { dailySeries, monthlySeries, quarterlySeries, annualSeries, toPoints, mergePoints, lastObs, thinOld } from "./series.js";

export const meta = (l, u, src, extra = {}) => ({ l, u, src, ...extra });

/* Startdatum für den Abruf: beim ersten Lauf "first", danach letzter gespeicherter Wert minus Überlappung.
   Beim ersten Lauf mit Datenarchiv (ctx.full = frühestes Datum) die ganze Historie der Quelle; der Runner kürzt die
   Ausgabe für den Snapshot danach wieder auf "first". */
export function since(ctx, sid, first, overlapDays = 21) {
  if (ctx.full) return start(ctx, first);
  const s = ctx.prev && ctx.prev.series && ctx.prev.series[sid];
  const lo = s ? lastObs(s) : null;
  if (!lo) return first;
  if (/^\d{4}-\d{2}-\d{2}$/.test(lo)) {
    const d = new Date(lo + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - overlapDays);
    const iso = d.toISOString().slice(0, 10);
    return iso > first ? iso : first;
  }
  if (/^\d{4}-\d{2}$/.test(lo)) {
    const d = new Date(Date.UTC(+lo.slice(0, 4), +lo.slice(5, 7) - 1 - 3, 1)).toISOString().slice(0, 7);
    return d > first.slice(0, 7) ? (first.length > 7 ? d + "-01" : d) : first;
  }
  return first;
}

/* Festes Startdatum eines Abrufs; beim ersten Archivlauf das frühere Datum ctx.full (im Format von "first") */
export function start(ctx, first) {
  if (!ctx.full) return first;
  (ctx.firsts || (ctx.firsts = [])).push(first);
  const deep = /^\d{4}-\d{2}$/.test(first) ? ctx.full.slice(0, 7) : /^\d{6}$/.test(first) ? ctx.full.slice(0, 7).replace("-", "")
    : /^\d{4}-Q\d$/.test(first) ? ctx.full.slice(0, 4) + "-Q1" : ctx.full;
  return deep < first ? deep : first;
}

/* gespeicherte und neue Punkte zusammenführen */
export function withPrev(ctx, sid, pts, keepFrom = null) {
  const s = ctx.prev && ctx.prev.series && ctx.prev.series[sid];
  return s ? mergePoints(toPoints(s), pts, keepFrom) : pts;
}
// neue Punkte ungekürzt für das Datenarchiv merken (ctx.raw nur bei gebundener D1-Datenbank)
const keepRaw = (ctx, sid, pts) => { if (ctx.raw) ctx.raw[sid] = pts; };
// Tagesreihen: gespeicherte Historie fortschreiben, Werte älter als gut zwei Jahre auf Wochenwerte ausdünnen
export const D = (ctx, sid, pts, m, keepFrom) => { keepRaw(ctx, sid, pts); return dailySeries(thinOld(withPrev(ctx, sid, pts, keepFrom)), m); };
export const M = (ctx, sid, pts, m, keepFrom) => { keepRaw(ctx, sid, pts); return monthlySeries(withPrev(ctx, sid, pts, keepFrom), m); };
export const Q = (ctx, sid, pts, m) => { keepRaw(ctx, sid, pts); return quarterlySeries(withPrev(ctx, sid, pts), m); };
// Wochenreihen (etwa CFTC-Positionierung): ohne Ausdünnung, Frequenz W (Veröffentlichung einige Tage nach dem Stichtag)
export const W = (ctx, sid, pts, m, keepFrom) => { keepRaw(ctx, sid, pts); return dailySeries(withPrev(ctx, sid, pts, keepFrom), m, "W"); };
export const Y = (pts, m) => annualSeries(pts, m);
export const ratio = (a, b, f = 1) => { const mb = new Map(b); return a.map(([d, v]) => [d, mb.has(d) && mb.get(d) ? f * v / mb.get(d) : null]).filter(p => p[1] != null); };
export const toMonth = pts => pts.map(([d, v]) => [String(d).slice(0, 7), v]);
// "2026-Q2" bleibt, "2026-04" wird zu "2026-Q2"
export const toQuarter = pts => pts.map(([d, v]) => [/Q\d$/.test(d) ? d : `${String(d).slice(0, 4)}-Q${Math.floor((+String(d).slice(5, 7) - 1) / 3) + 1}`, v]);
