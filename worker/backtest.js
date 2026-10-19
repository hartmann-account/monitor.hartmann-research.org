/* Backtest des Anlagebarometers auf der Historie im Datenarchiv (D1).
   1. Datensatz: lange Reihen aus dem Archiv, für jede Modellreihe aus mehreren Quellen verkettet (etwa S&P 500 seit 1871
      aus den Shiller-Daten vor den FRED-Tageswerten, Franken seit 1971 aus der Fed-Statistik vor den EZB-Kursen).
      Tageswerte werden auf Wochenschlusskurse verdichtet.
   2. Zu jedem Monatsende rechnet das unveränderte Modell (src/signals.js) alle Säulen, nur mit Daten, die damals
      veröffentlicht waren (Veröffentlichungsfristen wie im Live-Betrieb; IWF- und Weltbank-Projektionen werden durch
      naive Fortschreibungen ersetzt, das Shiller-KGV mit dem damaligen Monatswert).
   3. Verglichen wird mit der tatsächlichen Kursentwicklung danach: 1 Monat, 12 Monate, 5 Jahre.
   4. Kennzahlen: Trefferquote der Richtung (ohne neutrale Stufen) mit 95-%-Intervall auf der effektiven Stichprobe
      (überlappende Zeiträume zählen anteilig), Vergleich mit der Mehrheitsregel („steigt immer“), Rangkorrelation
      zwischen Gesamtwert und späterer Rendite, Anteil steigender Fälle je Stufe, drei Teilperioden.
   5. Ohne Vorgriff: Gewichte der Säulen werden Jahr für Jahr nur mit der bis dahin bekannten Historie geschätzt
      (walk-forward, ausgehend von gleichen Gewichten); Wahrscheinlichkeiten steigender Kurse aus einer logistischen
      Regression auf den Gesamtwert, ebenfalls Jahr für Jahr nur mit damals bekannten Ergebnissen geschätzt und mit dem
      Brier-Score gegen die bloße Grundhäufigkeit geprüft. */
import sigmod from "../src/signals.js";

const { SIG } = sigmod;
const DAY = 86400000;
export const FWD = { m1: 1, y1: 12, lt: 60 };

/* Modellreihe ← Archivreihen, neueste Quelle zuerst. level: Kursniveaus, ältere Quellen über das mittlere Verhältnis im
   Überlappungszeitraum angeschlossen; rate: Zinssätze und Prämien, direkt angeschlossen; scale: ältere Quelle mit dem
   Verhältnis im Überlappungszeitraum skaliert (Näherung, etwa Hochzinsprämie aus der Baa-Prämie). */
export const BT_MAP = {
  eq_us: { level: ["eq_us", "h_sp500_m"] },
  eq_jp: { level: ["eq_jp", "eqh_jp"] },
  eq_ch: { level: ["eq_ch_six", "eq_ch", "eqh_ch"] },
  eq_ea: { level: ["eq_ea", "eqh_ea"] },
  eq_de: { level: ["eq_de", "eqh_de"] },
  eq_gb: { level: ["eq_gb", "eqh_gb"] },
  eq_cn: { level: ["eq_cn", "eqh_cn"] },
  eq_in: { level: ["eq_in", "eqh_in"] },
  // Schwellenländer: Nasdaq-EM-Index seit 2001, davor der nach BIP gewichtete Korb aus OECD-Länderindizes in US-Dollar
  eq_em: { level: ["eq_em", "eqh_em"] },
  eq_kr_usd: { level: ["eq_kr_usd", "eqh_kr_usd"] },
  eq_br_usd: { level: ["eq_br_usd", "eqh_br_usd"] },
  usd_em: { level: ["usd_em", "usd_em_old"] },
  y10_us: { rate: ["y10_us", "gs10_m", "y10h_us"] },
  y10_de: { rate: ["y10_de", "y10m_de", "y10h_de"] },
  y10_gb: { rate: ["y10_gb", "y10m_gb"] },
  fx_chf: { level: ["fx_chf", "fxh_chf"] },
  fx_jpy: { level: ["fx_jpy", "fxh_jpy"] },
  fx_gbp: { level: ["fx_gbp", "fxh_gbp"] },
  fx_cny: { level: ["fx_cny", "fxh_cny"] },
  fx_inr: { level: ["fx_inr", "fxh_inr"] },
  fx_eur: { level: ["fx_eur", "fxh_eur", "fxh_eur_syn", "fxh_eur_dem"] },
  usd_broad: { level: ["usd_broad", "usd_broad_old"] },
  gold_usd: { level: ["gold_usd", "gold_usd_imf", "h_gold_usd_m"] },
  brent: { level: ["brent", "brent_m"] },
  fed_assets: { level: ["fed_assets", "mbase_us"] },
  real10_us: { rate: ["real10_us", "real10_proxy"] },
  hy_oas: { scale: ["hy_oas", "baa10y", "baa_spread_m"] },
  ig_oas: { scale: ["ig_oas", "baa10y", "baa_spread_m"] },
  hy_oas_eu: { scale: ["hy_oas_eu", "baa10y", "baa_spread_m"] },
};
// direkt übernommene Reihen (Präfixe und Einzelreihen)
export const BT_PREFIX = ["cli_", "cpi_", "pr_", "reer_", "growth_", "infl_", "debt_", "ca_", "ppp_", "bal_", "pop_", "wa_", "prod_", "cofer_", "y10m_", "cot_", "cgap_", "esi_"];
export const BT_DIRECT = ["y10_ch_d", "y10_jp_hist", "y10_jp", "y2_us", "silver_usd", "copper", "btc", "vix", "vix3m", "stlfsi", "nfci", "cpi_us_index", "dff", "eq_us_nasdaq", "permit_us",
  "baa10y", "curve3m_us", "ebp", "ofr_fsi", "cfnai", "claims_us", "sahm_us", "umcsent", "permit_us", "expinf10_us", "be10_us", "curve_us", "skew", "usrec", "tb3m_m",
  "h_sp500_m", "h_cape_m", "h_gold_usd_m", "h_gpr_hist_m", "r3m_us", "r3m_de", "r3m_gb", "r3m_ch", "r3m_jp", "r3m_ea", "eqh_us",
  "aiae_us", "hh_equity_us", "eq_tw_usd"];
// Veröffentlichungsfristen in Tagen nach Periodenende, die das Archiv nicht speichert (sonst gelten die üblichen Fristen je Frequenz)
const ARCHIVE_LAG = [[/^(cgap_|credit_gdp_|dsr_)/, 100], [/^(aiae_us|hh_equity_us|z1_)/, 80]];

/* Archivreihen, die der Backtest lädt (aus dem Reihenverzeichnis des Archivs) */
export function btSeriesIds(catalog) {
  const want = new Set(BT_DIRECT);
  for (const m of Object.values(BT_MAP)) for (const id of [...(m.level || []), ...(m.rate || []), ...(m.scale || [])]) want.add(id);
  for (const id of catalog) if (BT_PREFIX.some(p => id.startsWith(p))) want.add(id);
  ["baa_m", "gs10_m", "expinf10_us", "brent_m", "gold_usd_imf", "mbase_us"].forEach(id => want.add(id));
  return [...want].filter(id => catalog.includes(id));
}

/* ------------------------------------------------------------ Punkte aus dem Archiv */
const dayOf = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
function point(iso, f, v) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1, t = dayOf(iso);
  if (f === "M") return { t, e: Date.UTC(y, m + 1, 1) / DAY - 1, x: y + m / 12, v };
  if (f === "Q") return { t, e: Date.UTC(y, m + 3, 1) / DAY - 1, x: y + Math.floor(m / 3) / 4 + 0.125, v };
  if (f === "A") return { t, e: Date.UTC(y, 11, 31) / DAY, x: y, v };
  return { t, e: t, x: SIG.yearFrac(t), v };
}
// Tageswerte verdichten: letzter Wert je Woche (Montag bis Sonntag) und je Monat (Monatsschluss für die Stichtage)
const monthOf = t => { const d = new Date(t * DAY); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
function weekly(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], n = pts[i + 1];
    if (!n || Math.floor((n.t + 3) / 7) !== Math.floor((p.t + 3) / 7) || monthOf(n.t) !== monthOf(p.t)) out.push(p);
  }
  return out;
}
function series(id, f, pts, extra = {}) { return { id, f, pts, ...extra }; }

/* Ältere Quelle vor die neuere setzen. mode level: Faktor = Median der Verhältnisse im Überlappungszeitraum;
   scale: ebenso (für Prämien); rate: ohne Anpassung. Periodenenden bleiben aufsteigend. */
function splice(newer, older, mode) {
  if (!older || !older.pts.length) return newer;
  if (!newer || !newer.pts.length) return older;
  const t0 = newer.pts[0].t;
  let k = 1;
  if (mode !== "rate") {
    // Kurse: die ersten 400 gemeinsamen Werte; Prämien: der ganze Überlappungszeitraum wie im Live-Modell (SIG.prepareLive)
    const ratios = [];
    for (const q of mode === "scale" ? newer.pts : newer.pts.slice(0, 400)) { const o = SIG.valueAt(older.pts, q.t); if (o && q.t - o.t < 45 && o.v) ratios.push(q.v / o.v); }
    if (ratios.length) k = SIG.median(ratios);
    else { const o = SIG.last(older.pts.filter(p => p.t <= t0)); if (o && o.v) k = newer.pts[0].v / o.v; }
  }
  const head = older.pts.filter(p => p.e < t0).map(p => ({ ...p, v: p.v * k }));
  const same = newer.f === older.f;
  return { ...newer, f: same ? newer.f : "W", pts: head.concat(newer.pts), lag: same ? newer.lag : 0 };
}

/* Datensatz für den Backtest im Format von SIG.decodeSnapshot. raw: { id: { f, points: [[iso, v], ...] } } */
export function buildBacktestLive(raw) {
  const S = {};
  for (const [id, r] of Object.entries(raw)) {
    if (!r || !r.points || !r.points.length) continue;
    let pts = r.points.filter(p => p[1] != null && isFinite(p[1])).map(([d, v]) => point(d, r.freq, v));
    if (r.freq === "D") pts = weekly(pts);
    // Tageswerte (Märkte) sind sofort bekannt; Kreditdaten der BIZ und die Finanzierungsrechnung der Fed erscheinen Wochen später
    const lag = r.freq === "D" ? 0 : (ARCHIVE_LAG.find(([re]) => re.test(id)) || [])[1];
    S[id] = series(id, r.freq === "D" ? "W" : r.freq, pts, { lag });
  }
  // abgeleitete Hilfsreihen: Baa-Prämie gegenüber Treasuries (Monatsmittel seit 1953), reale Rendite vor den TIPS
  const diff = (a, b, id) => {
    if (!S[a] || !S[b]) return;
    const pts = [];
    for (const q of S[a].pts) { const o = SIG.valueAt(S[b].pts, q.t); if (o && Math.abs(q.t - o.t) < 40) pts.push({ ...q, v: q.v - o.v }); }
    S[id] = series(id, S[a].f, pts);
  };
  diff("baa_m", "gs10_m", "baa_spread_m");
  diff("gs10_m", "expinf10_us", "real10_proxy");
  // Verkettung zu langen Modellreihen
  const out = {};
  for (const [id, r] of Object.entries(S)) out[id] = r;
  for (const [id, m] of Object.entries(BT_MAP)) {
    const mode = m.level ? "level" : m.rate ? "rate" : "scale";
    const ids = m.level || m.rate || m.scale;
    let acc = null;
    for (const src of ids) { const s = S[src]; if (!s) continue; acc = acc ? splice(acc, s, mode) : { ...s, id }; }
    if (acc) out[id] = { ...acc, id };
  }
  const L = { generated: new Date().toISOString(), origin: "backtest", status: {}, s: out, items: {}, jobOf: {}, pit: true };
  // wie im Live-Betrieb: Monatshistorien, Verkettungen, Ersatzreihen; ohne GDELT (keine lange Historie)
  const m = id => (raw[id] ? { f: "M", s: raw[id].points[0][0].slice(0, 7), v: monthlyValues(raw[id].points) } : null);
  SIG.prepareLive(L, { gold_usd_m: m("h_gold_usd_m"), sp500_m: m("h_sp500_m"), cape_m: m("h_cape_m"), gpr_m: m("h_gpr_hist_m"), cape: null });
  return L;
}
// lückenlose Monatswerte ab dem ersten Monat (fehlende Monate = null)
function monthlyValues(points) {
  const idx = d => +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1);
  const i0 = idx(points[0][0]), v = new Array(idx(points[points.length - 1][0]) - i0 + 1).fill(null);
  for (const [d, x] of points) v[idx(d) - i0] = x;
  return v;
}

/* ------------------------------------------------------------ Monatsenden und Renditen danach */
export function monthEnds(fromYm, toDay) {
  const out = [];
  let y = +fromYm.slice(0, 4), m = +fromYm.slice(5, 7) - 1;
  for (;;) {
    const e = Date.UTC(y, m + 1, 1) / DAY - 1;
    if (e > toDay) break;
    out.push(e);
    if (++m === 12) { m = 0; y++; }
  }
  return out;
}
const monthsLater = (t, n) => { const d = new Date(t * DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 1) / DAY - 1; };
/* Rendite vom Stichtag t bis t + n Monate. Tages- und Wochenkurse: letzter Kurs bis zum jeweiligen Tag. Monatsmittel
   (auch im älteren Teil verketteter Reihen): ab dem Monat nach dem Stichtag, denn das Mittel des laufenden Monats
   enthält Kurse vor dem Stichtag. */
export function forward(p, t, n) {
  if (!p.length) return null;
  const t1 = monthsLater(t, n);
  if (t1 > p[p.length - 1].e) return null;
  const at = x => {
    const a = SIG.valueAt(p, x);
    if (a && a.e - a.t < 5) return x - a.t <= 10 ? a : null;
    let lo = 0, hi = p.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p[m].t <= x) lo = m + 1; else hi = m; }
    const q = p[lo];
    return q && q.t - x <= 40 ? q : null;
  };
  const a = at(t), b = at(t1);
  return a && b && a.v > 0 ? b.v / a.v - 1 : null;
}

/* Panel: zu jedem Monatsende jede Anlage und jeder Horizont mit allen Säulenwerten, Volatilität und Renditen danach */
export function runPanel(L, { from = "1970-01", to = null, horizons = ["m1", "y1", "lt"], onProgress = null } = {}) {
  const lastDay = to ?? SIG.leadDay(L);
  const cuts = monthEnds(from, lastDay);
  const out = [];
  const full = {};
  for (const row of SIG.ROWS) {
    full[row.id] = SIG.rowPrice(L, row, null);
  }
  cuts.forEach((cut, k) => {
    const ra = SIG.riskAppetite(L, cut);
    if (L._ra) L._ra.delete(cut); // je Stichtag nur einmal gebraucht
    for (const hz of horizons) {
      for (const row of SIG.ROWS) {
        const e = SIG.evaluate(L, row, cut, ra, hz, { all: true });
        if (!e) continue;
        const P = {};
        for (const [pid, v] of Object.entries(e.pillars)) P[pid] = v ? Math.round(v.s * 1e4) / 1e4 : null;
        const p = full[row.id];
        const vol = SIG.annVol(e.price) || null;
        out.push({ hz, id: row.id, kind: row.kind, t: cut, P, score: e.score, vol,
          r1: forward(p, cut, 1), r12: forward(p, cut, 12), r60: forward(p, cut, 60) });
      }
    }
    if (onProgress && k % 12 === 11) onProgress(SIG.isoOf(cut), out.length);
  });
  return out;
}

/* ------------------------------------------------------------ Kennzahlen */
// Spearman-Rangkorrelation
export function spearman(a, b) {
  const n = a.length;
  if (n < 8) return null;
  const rank = v => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const ra = rank(a), rb = rank(b), m = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - m) * (rb[i] - m); da += (ra[i] - m) ** 2; db += (rb[i] - m) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
// Wilson-Intervall für einen Anteil bei effektiver Stichprobengröße n
export function wilson(p, n, z = 1.96) {
  if (!n) return [null, null];
  const d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const retKey = hz => ({ m1: "r1", y1: "r12", lt: "r60" }[hz]);

/* Einstufung mit Toleranzband je Anlage in zeitlicher Reihenfolge */
export function categorize(entries, scoreKey = "score") {
  const prev = {};
  for (const e of entries.slice().sort((a, b) => a.t - b.t)) {
    const s = e[scoreKey];
    if (s == null) { e.cat = null; continue; }
    const c = SIG.category(s, prev[e.id] ?? null);
    e.cat = c.n;
    prev[e.id] = c.n;
  }
  return entries;
}

/* Treffsicherheit einer Menge von Signalen (ein Horizont): Richtung = Vorzeichen der Stufe (= gilt als keine Aussage) */
export function accuracy(entries, hz, scoreKey = "score") {
  const rk = retKey(hz), months = FWD[hz];
  const ok = entries.filter(e => e[rk] != null && e[scoreKey] != null && e.cat != null);
  if (!ok.length) return null;
  const dir = ok.filter(e => e.cat !== 0);
  const hits = dir.filter(e => (e.cat > 0) === (e[rk] > 0)).length;
  const up = ok.filter(e => e[rk] > 0).length;
  // effektive Stichprobe: überlappende Zeiträume zählen anteilig (je Anlage ein unabhängiger Wert je Horizontlänge)
  const nEff = Math.max(1, Math.round(dir.length / months));
  const hit = dir.length ? hits / dir.length : null;
  // Mehrheitsregel als Vergleich: immer die häufigere Richtung derselben Fälle tippen
  const upDir = dir.filter(e => e[rk] > 0).length;
  const base = dir.length ? Math.max(upDir, dir.length - upDir) / dir.length : null;
  const byCat = [-2, -1, 0, 1, 2].map(c => {
    const g = ok.filter(e => e.cat === c);
    const u = g.filter(e => e[rk] > 0).length;
    const ne = Math.max(1, Math.round(g.length / months));
    return { c, n: g.length, up: g.length ? u / g.length : null, upCI: g.length ? wilson(u / g.length, ne) : [null, null], mean: g.length ? SIG.mean(g.map(e => e[rk])) : null };
  });
  // Rangkorrelation zwischen Gesamtwert und um die Schwankung bereinigter Rendite (je Stichtag über alle Anlagen gepoolt)
  const ic = spearman(ok.map(e => e[scoreKey]), ok.map(e => e[rk] / Math.max(0.02, e.vol || 0.15)));
  const pos = ok.filter(e => e.cat > 0), neg = ok.filter(e => e.cat < 0);
  const ann = r => (months >= 12 ? Math.pow(1 + r, 12 / months) - 1 : r * 12);
  return {
    n: ok.length, nDir: dir.length, nEff, coverage: dir.length / ok.length,
    hit, hitCI: hit == null ? [null, null] : wilson(hit, nEff), base, upShare: up / ok.length,
    ic, byCat,
    meanPos: pos.length ? ann(SIG.mean(pos.map(e => e[rk]))) : null, meanNeg: neg.length ? ann(SIG.mean(neg.map(e => e[rk]))) : null,
    from: SIG.isoOf(Math.min(...ok.map(e => e.t))), to: SIG.isoOf(Math.max(...ok.map(e => e.t))),
  };
}

/* ------------------------------------------------------------ Gewichte ohne Vorgriff */
/* Gewichte je Anlageart: Rangkorrelation jeder Säule mit der späteren, schwankungsbereinigten Rendite auf den Daten bis
   zum Stichtag fit (nur Fälle, deren Rendite damals schon bekannt war), negative Werte = 0, zur Hälfte mit den
   Ausgangsgewichten gemischt. */
export function fitWeights(entries, hz, kind, fit, prior, { shrink = 0.5, minN = 120 } = {}) {
  const rk = retKey(hz), horizonDays = FWD[hz] * 30.44;
  const train = entries.filter(e => e.kind === kind && e[rk] != null && e.t + horizonDays <= fit);
  const pillars = Object.keys(prior);
  const ic = {};
  for (const pid of pillars) {
    const g = train.filter(e => e.P[pid] != null);
    ic[pid] = g.length >= minN ? spearman(g.map(e => e.P[pid]), g.map(e => e[rk] / Math.max(0.02, e.vol || 0.15))) : null;
  }
  const pos = Object.fromEntries(pillars.map(p => [p, Math.max(0, ic[p] ?? 0)]));
  const sum = Object.values(pos).reduce((a, b) => a + b, 0);
  const priorSum = pillars.reduce((a, p) => a + (prior[p] || 0), 0) || 1;
  const w = {};
  for (const p of pillars) {
    const pr = (prior[p] || 0) / priorSum;
    w[p] = sum > 0 ? shrink * pr + (1 - shrink) * pos[p] / sum : pr;
  }
  return { w, ic, n: train.length };
}
const scoreWith = (e, w) => {
  let num = 0, den = 0;
  for (const [p, x] of Object.entries(w)) if (x && e.P[p] != null) { num += x * e.P[p]; den += x; }
  return den >= 0.3 ? num / den : null;
};

/* Vorhersagen außerhalb der Stichprobe: jedes Jahr ab firstYear Gewichte mit den Daten bis Jahresbeginn schätzen und
   auf die Monatsenden dieses Jahres anwenden */
export function walkForward(entries, hz, { firstYear = 1990, shrink = 0.5, equal = false } = {}) {
  const H = SIG.horizon(hz);
  const eq = Object.fromEntries(H.pillars.map(p => [p, 1 / H.pillars.length]));
  const kinds = [...new Set(entries.map(e => e.kind))];
  const out = [];
  const fits = {};
  const lastYear = new Date(Math.max(...entries.map(e => e.t)) * DAY).getUTCFullYear();
  for (let y = firstYear; y <= lastYear + 1; y++) {
    const fit = Date.UTC(y, 0, 1) / DAY;
    for (const kind of kinds) {
      const prior = equal ? eq : H.weights[kind];
      const f = fitWeights(entries, hz, kind, fit, prior, { shrink });
      (fits[kind] = fits[kind] || []).push({ year: y, ...f });
      if (y > lastYear) continue;
      for (const e of entries) {
        if (e.kind !== kind || new Date(e.t * DAY).getUTCFullYear() !== y) continue;
        out.push({ ...e, score: scoreWith(e, f.w) });
      }
    }
  }
  return { preds: out, fits };
}

/* ------------------------------------------------------------ Daten aus D1 (Worker) */
/* Tageswerte schon in der Datenbank verdichten: letzter Wert je Kalenderwoche und je Monat (die Stichtage des Backtests
   sind Monatsenden, so steht dort der Schlusskurs des Monats und nicht der Wert der Vorwoche) */
export const THIN_SQL = `SELECT d, v FROM obs WHERE s = ?1 AND v IS NOT NULL AND d IN (
  SELECT MAX(d) FROM obs WHERE s = ?1 AND v IS NOT NULL GROUP BY strftime('%Y-%W', d)
  UNION SELECT MAX(d) FROM obs WHERE s = ?1 AND v IS NOT NULL GROUP BY strftime('%Y-%m', d)) ORDER BY d`;
export const FULL_SQL = "SELECT d, v FROM obs WHERE s = ?1 AND v IS NOT NULL ORDER BY d";
/* Reihen des Backtests aus dem Archiv, Tageswerte verdichtet */
export async function loadArchive(db, ids = null) {
  const { results: cat } = await db.prepare("SELECT id, freq FROM series").all();
  const freq = Object.fromEntries(cat.map(r => [r.id, r.freq]));
  const want = (ids || btSeriesIds(cat.map(r => r.id))).filter(id => freq[id]);
  const raw = {};
  for (let i = 0; i < want.length; i += 20) {
    const part = want.slice(i, i + 20);
    const res = await db.batch(part.map(id => db.prepare(freq[id] === "D" ? THIN_SQL : FULL_SQL).bind(id)));
    part.forEach((id, k) => { raw[id] = { freq: freq[id], points: (res[k].results || []).map(r => [r.d, r.v]) }; });
  }
  return raw;
}

/* ------------------------------------------------------------ Wahrscheinlichkeiten */
const sigm = z => 1 / (1 + Math.exp(-z));
const CAL_L2 = 4; // Ridge-Strafe auf die Steigung (bezogen auf die effektive Stichprobe)
/* Logistische Regression P(Rendite > 0) = σ(a + b·x), Newton-Verfahren mit Ridge-Strafe auf b. wt: Gewicht je Fall –
   bei überlappenden Zeiträumen 1 ÷ Horizont in Monaten, damit die Strafe gegen die effektive Stichprobe wirkt und die
   Wahrscheinlichkeiten bei wenigen unabhängigen Zeiträumen (5 Jahre) nicht übertrieben ausfallen */
export function logistic(xs, ys, l2 = 1, wt = 1) {
  let a = 0, b = 0;
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = -l2 * b, haa = 1e-9, hab = 0, hbb = l2;
    for (let i = 0; i < xs.length; i++) {
      const p = sigm(a + b * xs[i]), w = wt * p * (1 - p), r = wt * (ys[i] - p);
      ga += r; gb += r * xs[i]; haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a, b };
}
const yearOf = t => new Date(t * DAY).getUTCFullYear();
const usable = (entries, hz) => { const rk = retKey(hz); return entries.filter(e => e.score != null && e[rk] != null); };
const groups = entries => [["all", entries], ...[...new Set(entries.map(e => e.kind))].map(k => [k, entries.filter(e => e.kind === k)])];

/* Kalibrierung auf der ganzen Historie (für die heutigen Wahrscheinlichkeiten) je Anlageart und insgesamt */
export function calibrate(entries, hz) {
  const rk = retKey(hz), out = {};
  for (const [k, g] of groups(usable(entries, hz))) {
    if (g.length < 60) continue;
    const ys = g.map(e => (e[rk] > 0 ? 1 : 0));
    const { a, b } = logistic(g.map(e => e.score), ys, CAL_L2, 1 / FWD[hz]);
    out[k] = { a: r4(a), b: r4(b), n: g.length, base: r3(SIG.mean(ys)) };
  }
  return out;
}

/* Brier-Score der Wahrscheinlichkeiten ohne Vorgriff: jedes Jahr ab firstYear die Regression nur mit Fällen schätzen,
   deren Ergebnis zu Jahresbeginn bekannt war; Vergleich: Grundhäufigkeit derselben Trainingsdaten. Skill = 1 − BS ÷ BS_ref */
export function brierWalkForward(entries, hz, { firstYear = 1990 } = {}) {
  const rk = retKey(hz), hd = FWD[hz] * 30.44;
  const ok = usable(entries, hz);
  if (!ok.length) return {};
  const lastYear = yearOf(Math.max(...ok.map(e => e.t)));
  const acc = {};
  const add = (k, p, q, o) => { const a = acc[k] || (acc[k] = { bs: 0, ref: 0, n: 0, bins: [0, 0, 0, 0, 0].map(() => [0, 0, 0]) }); a.bs += (p - o) ** 2; a.ref += (q - o) ** 2; a.n++; const bin = a.bins[Math.min(4, Math.floor(p * 5))]; bin[0]++; bin[1] += p; bin[2] += o; };
  const kinds = [...new Set(ok.map(e => e.kind))];
  for (let y = firstYear; y <= lastYear; y++) {
    const fit = Date.UTC(y, 0, 1) / DAY;
    for (const kind of kinds) {
      const train = ok.filter(e => e.kind === kind && e.t + hd <= fit);
      if (train.length < 60) continue;
      const ys = train.map(e => (e[rk] > 0 ? 1 : 0));
      const { a, b } = logistic(train.map(e => e.score), ys, CAL_L2, 1 / FWD[hz]);
      const q = SIG.mean(ys);
      for (const e of ok) {
        if (e.kind !== kind || yearOf(e.t) !== y) continue;
        const p = sigm(a + b * e.score), o = e[rk] > 0 ? 1 : 0;
        add(kind, p, q, o); add("all", p, q, o);
      }
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { n: a.n, bs: r4(a.bs / a.n), ref: r4(a.ref / a.n), skill: r3(1 - a.bs / a.ref),
    // Zuverlässigkeit: je Fünftel der vorhergesagten Wahrscheinlichkeit die mittlere Vorhersage und die beobachtete Häufigkeit
    bins: a.bins.filter(b => b[0]).map(b => [b[0], r3(b[1] / b[0]), r3(b[2] / b[0])]) };
  return out;
}

/* ------------------------------------------------------------ Zusammenfassung für Seite und D1 */
const r3 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
export const PERIODS = [["1970-01-01", "1990-01-01"], ["1990-01-01", "2008-01-01"], ["2008-01-01", "2100-01-01"]];
// 95-%-Intervall der Rangkorrelation (Fisher-z) auf der effektiven Stichprobe
function icCI(ic, nEff) {
  if (ic == null || nEff < 5) return [null, null];
  const z = Math.atanh(Math.max(-0.999, Math.min(0.999, ic))), h = 1.96 / Math.sqrt(nEff - 3);
  return [Math.tanh(z - h), Math.tanh(z + h)];
}
export function compactAccuracy(a) {
  if (!a) return null;
  const [icLo, icHi] = icCI(a.ic, a.nEff);
  return {
    n: a.n, nDir: a.nDir, nEff: a.nEff, hit: r3(a.hit), lo: r3(a.hitCI[0]), hi: r3(a.hitCI[1]), base: r3(a.base), up: r3(a.upShare),
    ic: r3(a.ic), icLo: r3(icLo), icHi: r3(icHi), cov: r3(a.coverage), mPos: r3(a.meanPos), mNeg: r3(a.meanNeg), from: a.from, to: a.to,
    // je Stufe −2 … +2: Anzahl, Anteil steigender Kurse, mittlere Rendite danach
    cats: a.byCat.map(c => [c.c, c.n, r3(c.up), r3(c.mean)]),
  };
}
/* Urteil je Horizont und Anlageart: belegt = Rangkorrelation mit 95 % Sicherheit positiv und in jeder Teilperiode
   positiv; schwach = insgesamt positiv; nicht belegt = sonst */
export function verdict(all, subs) {
  if (!all || all.ic == null || all.ic <= 0) return "fail";
  const okSubs = subs.filter(x => x && x.nEff >= 3);
  return all.icLo > 0 && okSubs.length >= 2 && okSubs.every(x => x.ic > 0) ? "ok" : "weak";
}

/* Alle Kennzahlen eines Horizonts aus dem Panel (nur Einträge dieses Horizonts) */
export function summarizeBacktest(panel, hz, { firstYear = 1990 } = {}) {
  const E = categorize(panel.filter(e => e.hz === hz && e.score != null).map(e => ({ ...e })));
  const stats = {};
  for (const [k, g] of groups(E)) {
    const all = compactAccuracy(accuracy(g, hz));
    if (!all) continue;
    const subs = PERIODS.map(([a, b]) => compactAccuracy(accuracy(g.filter(e => e.t >= SIG.dayOf(a) && e.t < SIG.dayOf(b)), hz)));
    stats[k] = { ...all, sub: subs.map(x => x && { n: x.n, nEff: x.nEff, hit: x.hit, base: x.base, ic: x.ic }), verdict: verdict(all, subs) };
  }
  // ohne Vorgriff: Gewichte jährlich aus gleichen Startgewichten geschätzt
  const wf = walkForward(panel.filter(e => e.hz === hz), hz, { firstYear, shrink: 0.5, equal: true });
  const P = categorize(wf.preds.filter(e => e.score != null));
  const oos = {};
  for (const [k, g] of groups(P)) { const a = compactAccuracy(accuracy(g, hz)); if (a) oos[k] = { n: a.n, nEff: a.nEff, hit: a.hit, lo: a.lo, hi: a.hi, base: a.base, ic: a.ic, icLo: a.icLo, from: a.from }; }
  const latest = Object.fromEntries(Object.entries(wf.fits).map(([k, f]) => [k, Object.fromEntries(Object.entries(f[f.length - 1].w).map(([p, w]) => [p, r3(w)]))]));
  // je Anlage
  const rows = {};
  for (const id of [...new Set(E.map(e => e.id))]) {
    const a = compactAccuracy(accuracy(E.filter(e => e.id === id), hz));
    if (a) rows[id] = { n: a.n, nDir: a.nDir, nEff: a.nEff, hit: a.hit, lo: a.lo, hi: a.hi, base: a.base, up: a.up, ic: a.ic, from: a.from, cats: a.cats.map(c => [c[1], c[2]]) };
  }
  const months = new Set(E.map(e => e.t)).size;
  return { hz, months, from: stats.all && stats.all.from, to: stats.all && stats.all.to, stats, oos, wfWeights: latest,
    calib: calibrate(E, hz), brier: brierWalkForward(E, hz, { firstYear }), rows };
}
