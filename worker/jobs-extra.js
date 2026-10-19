/* Zusätzliche Quellen mit langer Historie: Grundlage der Backtests des Anlagebarometers und neuer Signalbausteine.
   archiveOnly: die Reihen werden nur im Datenarchiv (D1) gespeichert; der Snapshot der Seite erhält eine kurze
   Zusammenfassung (die Backtests lesen die Historie aus D1). Einzelne Reihen mit ao: true ebenso. */
import { monthlySeries, quarterlySeries } from "./lib/series.js";
import { meta, since, start, D, M, W } from "./lib/jobutil.js";
import { fredMulti } from "./providers/official.js";
import { bis } from "./providers/markets.js";
import { parseCsv, num } from "./lib/csv.js";

const isoAgo = (ctx, days) => new Date(ctx.now - days * 864e5).toISOString().slice(0, 10);
const inv = (pts, f = 1) => pts.filter(p => p[1]).map(([d, v]) => [d, f / v]);
const scale = (pts, f) => pts.map(([d, v]) => [d, v * f]);
const ym = pts => pts.map(([d, v]) => [String(d).slice(0, 7), v]);

/* CBOE: Tageswerte der Volatilitätsindizes (CSV der Börse, MM/DD/YYYY) */
async function cboe(F, sym) {
  const { header, rows } = parseCsv(await F.text(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${sym}_History.csv`, { timeout: 30000 }));
  const iC = header.indexOf("CLOSE") >= 0 ? header.indexOf("CLOSE") : header.length - 1;
  return rows.map(r => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r[0]); return m ? [`${m[3]}-${m[1]}-${m[2]}`, num(r[iC])] : null; }).filter(p => p && p[1] != null);
}

/* CFTC Commitments of Traders (Futures, Legacy): Netto-Positionierung der Spekulanten in % des offenen Interesses */
export const COT_MARKETS = {
  gold: ["088691", "Gold"], silver: ["084691", "Silber"], copper: ["085692", "Kupfer"], wti: ["067651", "Rohöl WTI"],
  spx: ["13874A", "S&P 500 (E-mini)"], tnote: ["043602", "US-Staatsanleihen 10 Jahre"], tbond: ["020601", "US-Staatsanleihen 30 Jahre"],
  eur: ["099741", "Euro"], jpy: ["097741", "Yen"], chf: ["092741", "Franken"], gbp: ["096742", "Pfund"], usd: ["098662", "US-Dollar-Index"],
};
async function cotData(F, from) {
  const codes = Object.values(COT_MARKETS).map(m => `'${m[0]}'`).join(",");
  const q = new URLSearchParams({
    $select: "report_date_as_yyyy_mm_dd,cftc_contract_market_code,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all",
    $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${from}T00:00:00'`,
    $order: "report_date_as_yyyy_mm_dd", $limit: "50000",
  });
  const j = await F.json(`https://publicreporting.cftc.gov/resource/6dca-aqww.json?${q}`, { timeout: 40000 });
  if (!Array.isArray(j)) throw new Error("CFTC: unerwartete Antwort");
  return j;
}

/* Eurostat JSON-stat: eine Reihe je Land */
async function eurostat(F, dataset, params) {
  const j = await F.json(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}?format=JSON&lang=en&${params}`, { timeout: 30000 });
  const dims = j.id || [], size = j.size || [];
  const geoIdx = dims.indexOf("geo"), timeIdx = dims.indexOf("time");
  const geo = Object.entries(j.dimension.geo.category.index).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  const time = Object.entries(j.dimension.time.category.index).sort((a, b) => a[1] - b[1]).map(e => e[0]);
  const stride = dims.map((_, i) => size.slice(i + 1).reduce((a, b) => a * b, 1));
  const out = {};
  for (const [k, v] of Object.entries(j.value || {})) {
    const n = +k;
    const g = geo[Math.floor(n / stride[geoIdx]) % size[geoIdx]], t = time[Math.floor(n / stride[timeIdx]) % size[timeIdx]];
    (out[g] = out[g] || []).push([t.replace(/M/, "-").slice(0, 7), v]);
  }
  return out;
}

export const EXTRA_JOBS = [
  {
    // Wechselkurse seit 1971 (Fed H.10 über FRED) für Backtests vor dem Start des Euro und der EZB-Referenzkurse
    id: "fred_fxhist", label: "Wechselkurse und Dollarindizes seit 1971 (Fed H.10, nur Archiv)", source: "fred", every: 24 * 3, cost: 1, deep: "1971-01-01", archiveOnly: true, requires: ["DB"],
    async run(F, ctx) {
      const ids = ["DEXSZUS", "DEXJPUS", "DEXUSUK", "DEXCHUS", "DEXINUS", "DEXUSEU", "EXGEUS", "CCUSMA02EZM618N", "TWEXBMTH", "TWEXMMTH"];
      const r = await fredMulti(F, ids, start(ctx, isoAgo(ctx, 120)));
      const s = {}, m = (l, u) => meta(l, u, "fred");
      if (r.DEXSZUS) s.fxh_chf = D(ctx, "fxh_chf", inv(r.DEXSZUS), m("Franken in US-Dollar (Fed H.10)", "US-$ je CHF"));
      if (r.DEXJPUS) s.fxh_jpy = D(ctx, "fxh_jpy", inv(r.DEXJPUS, 100), m("Yen in US-Dollar (Fed H.10)", "US-$ je 100 JPY"));
      if (r.DEXUSUK) s.fxh_gbp = D(ctx, "fxh_gbp", r.DEXUSUK, m("Pfund in US-Dollar (Fed H.10)", "US-$ je GBP"));
      if (r.DEXCHUS) s.fxh_cny = D(ctx, "fxh_cny", inv(r.DEXCHUS, 100), m("Renminbi in US-Dollar (Fed H.10)", "US-$ je 100 CNY"));
      if (r.DEXINUS) s.fxh_inr = D(ctx, "fxh_inr", inv(r.DEXINUS, 100), m("Rupie in US-Dollar (Fed H.10)", "US-$ je 100 INR"));
      if (r.DEXUSEU) s.fxh_eur = D(ctx, "fxh_eur", r.DEXUSEU, m("Euro in US-Dollar (Fed H.10)", "US-$ je EUR"));
      // vor 1999: D-Mark, zum festen Umrechnungskurs 1,95583 in Euro ausgedrückt; ab 1979 die synthetische Euro-Reihe der OECD
      if (r.EXGEUS) s.fxh_eur_dem = M(ctx, "fxh_eur_dem", ym(inv(r.EXGEUS, 1.95583)), m("Euro in US-Dollar vor 1999, aus der D-Mark (1,95583 DM je Euro)", "US-$ je EUR"));
      if (r.CCUSMA02EZM618N) s.fxh_eur_syn = M(ctx, "fxh_eur_syn", ym(inv(r.CCUSMA02EZM618N)), m("Euro in US-Dollar, synthetisch vor 1999 (OECD)", "US-$ je EUR"));
      if (r.TWEXBMTH) s.usd_broad_old = M(ctx, "usd_broad_old", ym(r.TWEXBMTH), m("US-Dollar, handelsgewichtet breit (alter Fed-Index, bis 2019)", "Index"));
      if (r.TWEXMMTH) s.usd_major_old = M(ctx, "usd_major_old", ym(r.TWEXMMTH), m("US-Dollar gegenüber Hauptwährungen (alter Fed-Index, bis 2019)", "Index"));
      return { series: s };
    },
  },
  {
    // Aktienindizes, Langfrist- und Geldmarktzinsen der OECD-Monatsstatistik (über FRED), teils seit 1955
    id: "fred_intl", label: "Aktienkurse, Langfrist- und Dreimonatszinsen seit 1955 (OECD über FRED, nur Archiv)", source: "fred", every: 24 * 3, cost: 2, deep: "1950-01-01", archiveOnly: true, requires: ["DB"],
    async run(F, ctx) {
      const cs = { DE: "de", GB: "gb", JP: "jp", CH: "ch", CN: "cn", IN: "in", EZ: "ea", US: "us" };
      const shares = Object.keys(cs).map(c => `SPASTT01${c}M661N`);
      const rates = ["IRLTLT01DEM156N", "IRLTLT01USM156N", "IR3TIB01DEM156N", "IR3TIB01CHM156N", "IR3TIB01JPM156N", "IR3TIB01GBM156N", "IR3TIB01USM156N", "IR3TIB01EZM156N"];
      const from = start(ctx, isoAgo(ctx, 400));
      const [a, b] = await Promise.all([fredMulti(F, shares, from), fredMulti(F, rates, from)]);
      const s = {};
      for (const [c, iso] of Object.entries(cs)) {
        const p = a[`SPASTT01${c}M661N`];
        if (p) s["eqh_" + iso] = M(ctx, "eqh_" + iso, ym(p), meta(`Aktienkurse ${iso.toUpperCase()} (OECD-Monatsstatistik, Index 2015 = 100)`, "Index", "fred", { fred: `SPASTT01${c}M661N` }));
      }
      const r3 = { DE: "de", CH: "ch", JP: "jp", GB: "gb", US: "us", EZ: "ea" };
      for (const [c, iso] of Object.entries(r3)) {
        const p = b[`IR3TIB01${c}M156N`];
        if (p) s["r3m_" + iso] = M(ctx, "r3m_" + iso, ym(p), meta(`Dreimonatszins ${iso.toUpperCase()} (OECD)`, "%", "fred", { fred: `IR3TIB01${c}M156N` }));
      }
      if (b.IRLTLT01DEM156N) s.y10h_de = M(ctx, "y10h_de", ym(b.IRLTLT01DEM156N), meta("Langfristzins Deutschland (OECD, seit 1956)", "%", "fred"));
      if (b.IRLTLT01USM156N) s.y10h_us = M(ctx, "y10h_us", ym(b.IRLTLT01USM156N), meta("Langfristzins USA (OECD)", "%", "fred"));
      return { series: s };
    },
  },
  {
    // Unternehmensanleihen seit 1919, Zinskurve, erwartete Inflation: Kredit- und Zinssignale mit langer Historie
    id: "fred_credit", label: "Risikoprämien Moody's Baa/Aaa, Zinskurve 10 J. – 3 Mon., erwartete Inflation", source: "fred", every: 12, cost: 2, keep: true, deep: "1919-01-01",
    async run(F, ctx) {
      const [d, m] = await Promise.all([
        fredMulti(F, ["BAA10Y", "AAA10Y", "T10Y3M"], since(ctx, "baa10y", "2014-01-01")),
        fredMulti(F, ["BAA", "AAA", "GS10", "TB3MS", "EXPINF10YR"], start(ctx, "2005-01-01")),
      ]);
      const s = {}, md = (l, u) => meta(l, u, "fred");
      if (d.BAA10Y) s.baa10y = D(ctx, "baa10y", d.BAA10Y, md("Risikoprämie Moody's Baa gegenüber 10-jährigen Treasuries", "Pp."));
      if (d.AAA10Y) s.aaa10y = D(ctx, "aaa10y", d.AAA10Y, md("Risikoprämie Moody's Aaa gegenüber 10-jährigen Treasuries", "Pp."));
      if (d.T10Y3M) s.curve3m_us = D(ctx, "curve3m_us", d.T10Y3M, md("Zinskurve USA (10 Jahre minus 3 Monate)", "Pp."));
      const pm = (sid, fid, l, u) => { if (m[fid]) s[sid] = M(ctx, sid, ym(m[fid]), md(l, u)); };
      pm("baa_m", "BAA", "Rendite Moody's Baa (Monatsmittel, seit 1919)", "%");
      pm("aaa_m", "AAA", "Rendite Moody's Aaa (Monatsmittel, seit 1919)", "%");
      pm("gs10_m", "GS10", "Rendite 10-jähriger Treasuries (Monatsmittel, seit 1953)", "%");
      pm("tb3m_m", "TB3MS", "Rendite 3-monatiger Schatzwechsel (Monatsmittel, seit 1934)", "%");
      pm("expinf10_us", "EXPINF10YR", "Erwartete Inflation 10 Jahre (Cleveland Fed)", "%");
      return { series: s };
    },
  },
  {
    // Konjunktur der USA mit langer Historie: Aktivität, Arbeitsmarkt, Bau, Stimmung, Kreditvergabe, Rezessionen
    id: "fred_cycle", label: "US-Konjunktur seit 1919: CFNAI, Erstanträge, Baugenehmigungen, Stimmung, Sahm-Regel, Kreditstandards", source: "fred", every: 24, cost: 2, keep: true, deep: "1919-01-01",
    async run(F, ctx) {
      const [m, w] = await Promise.all([
        fredMulti(F, ["CFNAI", "PERMIT", "UMCSENT", "SAHMREALTIME", "INDPRO", "UNRATE", "BOGMBASE", "USREC", "DRTSCILM"], start(ctx, "2005-01-01")),
        fredMulti(F, ["ICSA"], since(ctx, "claims_us", "2014-01-01")),
      ]);
      const s = {}, md = (l, u) => meta(l, u, "fred");
      const pm = (sid, fid, l, u) => { if (m[fid]) s[sid] = M(ctx, sid, ym(m[fid]), md(l, u)); };
      pm("cfnai", "CFNAI", "Chicago Fed National Activity Index", "Index, 0 = Trendwachstum");
      pm("permit_us", "PERMIT", "Baugenehmigungen USA", "Tsd. Einheiten, Jahresrate");
      pm("umcsent", "UMCSENT", "Verbraucherstimmung (University of Michigan)", "Index 1966 = 100");
      pm("sahm_us", "SAHMREALTIME", "Sahm-Rezessionsindikator (Echtzeit)", "Pp.");
      pm("indpro_us", "INDPRO", "Industrieproduktion USA", "Index 2017 = 100");
      pm("unrate_us", "UNRATE", "Arbeitslosenquote USA", "%");
      pm("mbase_us", "BOGMBASE", "Geldbasis USA", "Mrd. US-$");
      pm("usrec", "USREC", "Rezession USA laut NBER (1 = Rezession)", "0/1");
      if (m.DRTSCILM) s.sloos_us = M(ctx, "sloos_us", ym(m.DRTSCILM), md("Kreditstandards für Unternehmenskredite, Saldo verschärfend (SLOOS, Quartal)", "% der Banken"));
      if (w.ICSA) s.claims_us = W(ctx, "claims_us", w.ICSA, md("Erstanträge auf Arbeitslosenhilfe USA (wöchentlich)", "Personen"));
      return { series: s };
    },
  },
  {
    /* Finanzierungsrechnung der Fed (Z.1), Quartalswerte seit 1945: Aktienanteil am Anlegervermögen = Marktwert aller
       US-Aktien ÷ (Aktien + Schulden von Haushalten, Unternehmen, Bund, Gliedstaaten und Ausland). Wer Aktien hält, muss
       sie jemandem abnehmen: ist der Anteil hoch, fehlen künftige Käufer, und die Renditen der folgenden Jahre waren niedrig.
       Veröffentlichung gut zehn Wochen nach Quartalsende (lag 80 Tage). */
    id: "fred_z1", label: "Aktienanteil am Anlegervermögen USA (Fed-Finanzierungsrechnung Z.1, seit 1945)", source: "fred", every: 24 * 3, cost: 1, keep: true,
    async run(F) {
      const r = await fredMulti(F, ["NCBEILQ027S", "FBCELLQ027S", "CMDEBT", "BCNSDODNS", "FGSDODNS", "SLGSDODNS", "DODFFSWCMI", "BOGZ1FL153064486Q"], "1945-01-01");
      const q = d => `${d.slice(0, 4)}-Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
      const by = id => new Map((r[id] || []).map(([d, v]) => [q(d), v]));
      const fin = by("FBCELLQ027S"), debt = ["CMDEBT", "BCNSDODNS", "FGSDODNS", "SLGSDODNS", "DODFFSWCMI"].map(by);
      const eq = [], dt = [], share = [];
      for (const [k, nonfin] of by("NCBEILQ027S")) {
        const e = nonfin + (fin.get(k) ?? NaN), d = debt.reduce((a, m) => a + (m.get(k) ?? NaN), 0);
        if (!isFinite(e) || !isFinite(d)) continue;
        eq.push([k, e / 1000]);
        dt.push([k, d / 1000]);
        share.push([k, (100 * e) / (e + d)]);
      }
      if (share.length < 100) throw new Error("FRED Z.1: zu wenige vollständige Quartale");
      const md = (l, u, extra) => meta(l, u, "fred", { lag: 80, ...extra });
      const s = {
        aiae_us: quarterlySeries(share, md("Aktienanteil am Anlegervermögen USA (Aktien ÷ Aktien und Schulden der Realwirtschaft, Fed Z.1)", "%")),
        z1_equity_us: quarterlySeries(eq, md("Marktwert aller US-Aktien (Fed Z.1)", "Mrd. US-$", { ao: true })),
        z1_debt_us: quarterlySeries(dt, md("Schulden der Realwirtschaft USA: Haushalte, Unternehmen, Staat, Ausland (Fed Z.1)", "Mrd. US-$", { ao: true })),
      };
      if (r.BOGZ1FL153064486Q) s.hh_equity_us = quarterlySeries(r.BOGZ1FL153064486Q.map(([d, v]) => [q(d), v]), md("Aktien in % des Geldvermögens der Haushalte USA (Fed Z.1)", "%"));
      return { series: s };
    },
  },
  {
    id: "cboe", label: "Volatilitätsstruktur: VIX 3 Monate, SKEW, VVIX (CBOE)", source: "cboe", every: 12, cost: 3, keep: true, deep: "1990-01-01",
    async run(F, ctx) {
      const from = since(ctx, "vix3m", "2014-01-01");
      const [v3, sk, vv] = await Promise.all([cboe(F, "VIX3M"), cboe(F, "SKEW"), cboe(F, "VVIX")]);
      const cut = p => p.filter(q => q[0] >= from);
      const m = (l, u) => meta(l, u, "cboe");
      return { series: {
        vix3m: D(ctx, "vix3m", cut(v3), m("Volatilitätsindex 3 Monate (VIX3M)", "Punkte")),
        skew: D(ctx, "skew", cut(sk), m("CBOE SKEW (Preis für Absicherung gegen Kurseinbrüche)", "Punkte")),
        vvix: D(ctx, "vvix", cut(vv), m("Volatilität des VIX (VVIX)", "Punkte")),
      } };
    },
  },
  {
    id: "cftc_cot", label: "Positionierung der Spekulanten an den Terminmärkten (CFTC Commitments of Traders)", source: "cftc", every: 24, cost: 1, keep: true, deep: "1986-01-01",
    async run(F, ctx) {
      const rows = await cotData(F, since(ctx, "cot_gold", "2019-01-01", 28));
      const by = {};
      for (const r of rows) {
        const oi = +r.open_interest_all, d = String(r.report_date_as_yyyy_mm_dd).slice(0, 10);
        if (!oi) continue;
        (by[r.cftc_contract_market_code] = by[r.cftc_contract_market_code] || []).push([d, 100 * ((+r.noncomm_positions_long_all) - (+r.noncomm_positions_short_all)) / oi, 100 * ((+r.comm_positions_long_all) - (+r.comm_positions_short_all)) / oi]);
      }
      const s = {};
      for (const [k, [code, name]] of Object.entries(COT_MARKETS)) {
        const p = by[code];
        if (!p || !p.length) continue;
        s["cot_" + k] = W(ctx, "cot_" + k, p.map(q => [q[0], q[1]]), meta(`Netto-Position der Spekulanten: ${name}`, "% des offenen Interesses", "cftc", { cftc: code }));
        s["cotc_" + k] = W(ctx, "cotc_" + k, p.map(q => [q[0], q[2]]), meta(`Netto-Position der kommerziellen Händler: ${name}`, "% des offenen Interesses", "cftc", { cftc: code, ao: true }));
      }
      if (!Object.keys(s).length) throw new Error("CFTC: keine Positionsdaten");
      return { series: s };
    },
  },
  {
    id: "fed_ebp", label: "Excess Bond Premium und Rezessionswahrscheinlichkeit (Federal Reserve, Gilchrist-Zakrajšek)", source: "fed", every: 24 * 3, cost: 1,
    async run(F, ctx) {
      const { header, rows } = parseCsv(await F.text("https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv", { timeout: 30000 }));
      const col = n => header.indexOf(n);
      const pick = i => rows.map(r => [String(r[0]).slice(0, 7), num(r[i])]).filter(p => p[1] != null);
      const m = (l, u) => meta(l, u, "fed");
      if (col("ebp") < 0) throw new Error("Fed EBP: unerwartetes Format");
      return { series: {
        ebp: monthlySeries(pick(col("ebp")), m("Excess Bond Premium (Risikoaufschlag über das Ausfallrisiko hinaus)", "Pp.")),
        gz_spread: monthlySeries(pick(col("gz_spread")), m("Gilchrist-Zakrajšek-Kreditspread", "Pp.")),
        rec_prob_ebp: monthlySeries(pick(col("est_prob")).map(([d, v]) => [d, 100 * v]), m("Rezessionswahrscheinlichkeit USA in 12 Monaten (aus dem Kreditspread)", "%")),
      } };
    },
  },
  {
    id: "ofr_fsi", label: "Finanzstressindex des Office of Financial Research (täglich, mit Teilindizes)", source: "ofr", every: 12, cost: 1, keep: true, deep: "2000-01-01",
    async run(F, ctx) {
      const { header, rows } = parseCsv(await F.text("https://www.financialresearch.gov/financial-stress-index/data/fsi.csv", { timeout: 30000 }));
      const from = since(ctx, "ofr_fsi", "2014-01-01");
      const col = n => header.indexOf(n);
      const pick = i => rows.filter(r => r[0] >= from).map(r => [r[0], num(r[i])]).filter(p => p[1] != null);
      const m = (l, ao) => meta(l, "Index, 0 = normal", "ofr", ao ? { ao: true } : {});
      const parts = [["ofr_fsi", "OFR FSI", "Finanzstressindex (OFR)"], ["ofr_credit", "Credit", "Finanzstress: Kredit"], ["ofr_equity", "Equity valuation", "Finanzstress: Aktienbewertung"],
        ["ofr_safe", "Safe assets", "Finanzstress: sichere Häfen"], ["ofr_funding", "Funding", "Finanzstress: Refinanzierung"], ["ofr_vol", "Volatility", "Finanzstress: Volatilität"]];
      const s = {};
      for (const [sid, c, l] of parts) if (col(c) >= 0) s[sid] = D(ctx, sid, pick(col(c)), m(l, sid !== "ofr_fsi"));
      if (!s.ofr_fsi) throw new Error("OFR FSI: unerwartetes Format");
      return { series: s };
    },
  },
  {
    id: "bis_credit", label: "Kreditlücke und Schuldendienstquote des Privatsektors (BIZ, Frühwarnindikatoren)", source: "bis", every: 24 * 7, cost: 2,
    async run(F) {
      const cs = "US+XM+CH+JP+GB+CN+IN+DE";
      const [gap, dsr] = await Promise.all([bis(F, "WS_CREDIT_GAP", `Q.${cs}.P.A.C+A`, "1960"), bis(F, "WS_DSR", `Q.${cs}.P`, "1990")]);
      const iso = c => (c === "XM" ? "ea" : c.toLowerCase());
      const s = {};
      for (const [k, pts] of Object.entries(gap)) {
        const [, c, , , t] = k.split(".");
        const sid = (t === "C" ? "cgap_" : "credit_gdp_") + iso(c);
        s[sid] = quarterlySeries(pts.filter(p => p[1] != null), meta(t === "C" ? `Kreditlücke ${c} (Kredit/BIP-Quote minus Trend, BIZ)` : `Kredite an den Privatsektor ${c} in % des BIP (BIZ)`, t === "C" ? "Pp." : "% des BIP", "bis", { lag: 100 }));
      }
      for (const [k, pts] of Object.entries(dsr)) {
        const [, c] = k.split(".");
        s["dsr_" + iso(c)] = quarterlySeries(pts.filter(p => p[1] != null), meta(`Schuldendienstquote Privatsektor ${c} (BIZ)`, "% des Einkommens", "bis", { lag: 100 }));
      }
      if (!Object.keys(s).length) throw new Error("BIZ: keine Kreditdaten");
      return { series: s };
    },
  },
  {
    id: "eurostat_esi", label: "Wirtschaftsstimmung Euroraum und Deutschland (Eurostat ESI, seit 1985)", source: "eurostat", every: 24, cost: 1,
    async run(F) {
      const r = await eurostat(F, "ei_bssi_m_r2", "indic=BS-ESI-I&s_adj=SA&geo=EA21&geo=EA20&geo=DE&sinceTimePeriod=1985-01");
      const s = {};
      // Euroraum in der jeweils aktuellen Zusammensetzung (seit 2026 mit 21 Ländern), ältere Monate notfalls aus EA20
      const ea = new Map((r.EA20 || []).map(p => [p[0], p[1]]));
      for (const [d, v] of r.EA21 || []) ea.set(d, v);
      if (ea.size) s.esi_ea = monthlySeries([...ea.entries()], meta("Wirtschaftsstimmung Euroraum (ESI, langfristiges Mittel = 100)", "Index", "eurostat"));
      if (r.DE) s.esi_de = monthlySeries(r.DE, meta("Wirtschaftsstimmung Deutschland (ESI)", "Index", "eurostat"));
      if (!Object.keys(s).length) throw new Error("Eurostat: keine ESI-Werte");
      return { series: s };
    },
  },
];
