/* Abrufjobs: was geladen wird, wie oft und von wo.
   every  Mindestabstand zwischen zwei erfolgreichen Abrufen in Stunden
   cost   höchstens benötigte externe Subrequests
   keep   true: die Ausgabe des letzten Laufs wird als ctx.prev übergeben; neue Werte werden an die gespeicherte
          Historie angehängt (wichtig für Quellen mit kurzem Fenster, etwa SNB-RSS oder ICE-BofA-Reihen auf FRED)
   Jede Reihe trägt l (Bezeichnung), u (Einheit) und src (Quellenkennung für die Seite). */
import { dailySeries, monthlySeries } from "./lib/series.js";
import { meta, since, D, M, ratio } from "./lib/jobutil.js";
import { fredMulti } from "./providers/official.js";
import { ecbData, snbCube, snbRssRates, sixDaily, bundesbank, boe, mofJgb, bis, imfSdmx, nbpGoldUsd, bojApi } from "./providers/markets.js";
import { MACRO_JOBS } from "./jobs-macro.js";
import { GEO_JOBS } from "./jobs-geo.js";

/* ------------------------------------------------------------------ Märkte */
const MARKET_JOBS = [
  {
    id: "fred_markets", label: "US-Aktien, Nikkei, Öl, Bitcoin, Dollarindex, Volatilität", source: "fred", every: 6, cost: 1, keep: true,
    async run(F, ctx) {
      const ids = ["SP500", "NASDAQCOM", "NIKKEI225", "DCOILBRENTEU", "DCOILWTICO", "DHHNGSP", "CBBTCUSD", "DTWEXBGS", "VIXCLS", "VXEEMCLS"];
      const r = await fredMulti(F, ids, since(ctx, "eq_us", "2014-01-01"));
      const s = {};
      const put = (sid, fid, l, u) => { if (r[fid]) s[sid] = D(ctx, sid, r[fid], meta(l, u, "fred", { fred: fid })); };
      put("eq_us", "SP500", "S&P 500", "Punkte");
      put("eq_us_nasdaq", "NASDAQCOM", "Nasdaq Composite", "Punkte");
      put("eq_jp", "NIKKEI225", "Nikkei 225", "Punkte");
      put("brent", "DCOILBRENTEU", "Rohöl Brent", "US-$ je Fass");
      put("wti", "DCOILWTICO", "Rohöl WTI", "US-$ je Fass");
      put("natgas_us", "DHHNGSP", "Erdgas Henry Hub", "US-$ je MMBtu");
      put("btc", "CBBTCUSD", "Bitcoin", "US-$");
      put("usd_broad", "DTWEXBGS", "US-Dollar, handelsgewichteter Index (breit)", "Index");
      put("vix", "VIXCLS", "Volatilitätsindex VIX", "Punkte");
      put("vix_em", "VXEEMCLS", "Volatilitätsindex Schwellenländer", "Punkte");
      return { series: s };
    },
  },
  {
    id: "fred_rates", label: "US-Renditen, Realzinsen, Inflationserwartung, Fed-Leitzins", source: "fred", every: 6, cost: 1, keep: true,
    async run(F, ctx) {
      const ids = ["DGS10", "DGS2", "DGS3MO", "DFII10", "T10YIE", "T10Y2Y", "DFF", "DFEDTARU", "DFEDTARL"];
      const r = await fredMulti(F, ids, since(ctx, "y10_us", "2014-01-01"));
      const s = {};
      const put = (sid, fid, l, u) => { if (r[fid]) s[sid] = D(ctx, sid, r[fid], meta(l, u, "fred", { fred: fid })); };
      put("y10_us", "DGS10", "Rendite 10-jähriger US-Staatsanleihen", "%");
      put("y2_us", "DGS2", "Rendite 2-jähriger US-Staatsanleihen", "%");
      put("y3m_us", "DGS3MO", "Rendite 3-monatiger US-Schatzwechsel", "%");
      put("real10_us", "DFII10", "Reale Rendite 10 Jahre (TIPS)", "%");
      put("be10_us", "T10YIE", "Inflationserwartung 10 Jahre (Breakeven)", "%");
      put("curve_us", "T10Y2Y", "Zinskurve USA (10 Jahre minus 2 Jahre)", "Pp.");
      put("dff", "DFF", "Federal Funds Effective Rate", "%");
      put("fed_hi", "DFEDTARU", "Fed-Zielband, Obergrenze", "%");
      put("fed_lo", "DFEDTARL", "Fed-Zielband, Untergrenze", "%");
      return { series: s };
    },
  },
  {
    id: "fred_risk", label: "Kreditrisikoprämien, Finanzstress, Fed-Bilanz, Geldmenge, US-Preisindex", source: "fred", every: 12, cost: 1, keep: true,
    async run(F, ctx) {
      const ids = ["BAMLH0A0HYM2", "BAMLC0A0CM", "BAMLHE00EHYIOAS", "BAMLEMCBPIOAS", "STLFSI4", "NFCI", "WALCL", "M2SL", "CPIAUCSL", "JPNASSETS", "USEPUINDXD"];
      const r = await fredMulti(F, ids, since(ctx, "hy_oas", "2014-01-01", 40));
      const s = {};
      const putD = (sid, fid, l, u) => { if (r[fid]) s[sid] = D(ctx, sid, r[fid], meta(l, u, "fred", { fred: fid })); };
      const putM = (sid, fid, l, u) => { if (r[fid]) s[sid] = M(ctx, sid, r[fid].map(([d, v]) => [d.slice(0, 7), v]), meta(l, u, "fred", { fred: fid })); };
      putD("hy_oas", "BAMLH0A0HYM2", "Risikoprämie US-Hochzinsanleihen (ICE BofA)", "Pp.");
      putD("ig_oas", "BAMLC0A0CM", "Risikoprämie US-Unternehmensanleihen IG (ICE BofA)", "Pp.");
      putD("hy_oas_eu", "BAMLHE00EHYIOAS", "Risikoprämie Euro-Hochzinsanleihen (ICE BofA)", "Pp.");
      putD("em_oas", "BAMLEMCBPIOAS", "Risikoprämie Unternehmensanleihen Schwellenländer (ICE BofA)", "Pp.");
      putD("stlfsi", "STLFSI4", "Finanzstressindex der St. Louis Fed", "Index");
      putD("nfci", "NFCI", "Finanzierungsbedingungen (Chicago Fed NFCI)", "Index");
      putD("fed_assets", "WALCL", "Bilanzsumme der Federal Reserve", "Mio. US-$");
      putM("m2_us", "M2SL", "Geldmenge M2 USA", "Mrd. US-$");
      putM("cpi_us_index", "CPIAUCSL", "Verbraucherpreisindex USA (saisonbereinigt)", "Index");
      putM("boj_assets_fred", "JPNASSETS", "Bilanzsumme der Bank of Japan", "100 Mio. Yen");
      putD("epu_us", "USEPUINDXD", "Wirtschaftspolitische Unsicherheit USA (täglich)", "Index");
      return { series: s };
    },
  },
  {
    id: "fred_longrates", label: "Langfristzinsen Schweiz, Indien, Japan, Großbritannien (Monatswerte)", source: "fred", every: 24, cost: 1,
    async run(F) {
      const ids = ["IRLTLT01CHM156N", "INDIRLTLT01STM", "IRLTLT01JPM156N", "IRLTLT01GBM156N", "IRLTLT01DEM156N", "IRLTLT01USM156N"];
      const r = await fredMulti(F, ids, "2005-01-01");
      const s = {};
      const put = (sid, fid, l) => { if (r[fid]) s[sid] = monthlySeries(r[fid].map(([d, v]) => [d.slice(0, 7), v]), meta(l, "%", "fred", { fred: fid })); };
      put("y10m_ch", "IRLTLT01CHM156N", "Langfristzins Schweiz (Monatsmittel)");
      put("y10m_in", "INDIRLTLT01STM", "Langfristzins Indien (Monatsmittel)");
      put("y10m_jp", "IRLTLT01JPM156N", "Langfristzins Japan (Monatsmittel)");
      put("y10m_gb", "IRLTLT01GBM156N", "Langfristzins Großbritannien (Monatsmittel)");
      put("y10m_de", "IRLTLT01DEM156N", "Langfristzins Deutschland (Monatsmittel)");
      put("y10m_us", "IRLTLT01USM156N", "Langfristzins USA (Monatsmittel)");
      return { series: s };
    },
  },
  {
    id: "ecb_fx", label: "Wechselkurse (EZB-Referenzkurse) und Zinskurve Euroraum", source: "ecb", every: 6, cost: 2, keep: true,
    async run(F, ctx) {
      const start = since(ctx, "fx_eur", "2019-01-01");
      const [fx, yc] = await Promise.all([
        ecbData(F, "EXR", "D.CHF+USD+JPY+CNY+GBP+INR.EUR.SP00.A", start),
        ecbData(F, "YC", "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y+SR_2Y", since(ctx, "y10_ea", "2014-01-01")),
      ]);
      const g = c => fx[`EXR.D.${c}.EUR.SP00.A`] || [];
      const usd = g("USD");
      if (!usd.length) throw new Error("EZB: kein USD-Kurs");
      const s = {};
      const m = (l, u) => meta(l, u, "ecb");
      s.fx_eur = D(ctx, "fx_eur", usd, m("Euro in US-Dollar", "US-$ je EUR"));
      s.fx_chf = D(ctx, "fx_chf", ratio(usd, g("CHF")), m("Franken in US-Dollar", "US-$ je CHF"));
      s.fx_jpy = D(ctx, "fx_jpy", ratio(usd, g("JPY"), 100), m("Yen in US-Dollar", "US-$ je 100 JPY"));
      s.fx_gbp = D(ctx, "fx_gbp", ratio(usd, g("GBP")), m("Pfund in US-Dollar", "US-$ je GBP"));
      s.fx_cny = D(ctx, "fx_cny", ratio(usd, g("CNY"), 100), m("Renminbi in US-Dollar", "US-$ je 100 CNY"));
      s.fx_inr = D(ctx, "fx_inr", ratio(usd, g("INR"), 100), m("Rupie in US-Dollar", "US-$ je 100 INR"));
      s.eurchf = D(ctx, "eurchf", g("CHF"), m("Euro in Franken", "CHF je EUR"));
      const y10 = yc["YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y"], y2 = yc["YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y"];
      if (y10) s.y10_ea = D(ctx, "y10_ea", y10, m("Rendite 10 Jahre, Euroraum (AAA-Kurve)", "%"));
      if (y2) s.y2_ea = D(ctx, "y2_ea", y2, m("Rendite 2 Jahre, Euroraum (AAA-Kurve)", "%"));
      return { series: s };
    },
  },
  {
    id: "ecb_misc", label: "EZB-Einlagesatz, Eurosystem-Bilanz, Stressindex CISS, Euro Stoxx 50, Geldmenge M3", source: "ecb", every: 12, cost: 5, keep: true,
    async run(F, ctx) {
      const [dfr, ilm, ciss, stoxx, m3] = await Promise.all([
        ecbData(F, "FM", "D.U2.EUR.4F.KR.DFR.LEV", since(ctx, "pr_ea_dfr", "2014-01-01")),
        ecbData(F, "ILM", "W.U2.C.T000000.Z5.Z01", since(ctx, "ecb_assets", "2014-01-01", 60)),
        ecbData(F, "CISS", "D.U2+US+CN.Z0Z.4F.EC.SS_CIN.IDX", since(ctx, "ciss_ea", "2014-01-01")),
        ecbData(F, "FM", "M.U2.EUR.DS.EI.DJES50I.HSTA", "2004-01"),
        ecbData(F, "BSI", "M.U2.Y.V.M30.X.I.U2.2300.Z01.A", "2004-01"),
      ]);
      const s = {};
      const one = o => Object.values(o)[0] || [];
      s.pr_ea_dfr = D(ctx, "pr_ea_dfr", one(dfr), meta("EZB-Einlagesatz", "%", "ecb"));
      s.ecb_assets = D(ctx, "ecb_assets", one(ilm), meta("Bilanzsumme des Eurosystems", "Mio. EUR", "ecb"));
      const c = k => ciss[`CISS.D.${k}.Z0Z.4F.EC.SS_CIN.IDX`] || [];
      s.ciss_ea = D(ctx, "ciss_ea", c("U2"), meta("Systemischer Stress Euroraum (CISS)", "0–1", "ecb"));
      s.ciss_us = D(ctx, "ciss_us", c("US"), meta("Systemischer Stress USA (CISS der EZB)", "0–1", "ecb"));
      s.ciss_cn = D(ctx, "ciss_cn", c("CN"), meta("Systemischer Stress China (CISS der EZB)", "0–1", "ecb"));
      s.eq_ea = monthlySeries(one(stoxx), meta("Euro Stoxx 50 (Monatsmittel)", "Punkte", "ecb"));
      s.m3_ea = monthlySeries(one(m3), meta("Geldmenge M3 Euroraum, Wachstum gegenüber Vorjahr", "%", "ecb"));
      return { series: s };
    },
  },
  {
    id: "bbk_bund", label: "Bundesanleihen 10 und 2 Jahre (tagesaktuell)", source: "bundesbank", every: 8, cost: 2, keep: true,
    async run(F, ctx) {
      const st = since(ctx, "y10_de", "2014-01-01");
      const [y10, y2] = await Promise.all([
        bundesbank(F, "BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A", st),
        bundesbank(F, "BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R02XX.R.A.A._Z._Z.A", st),
      ]);
      return { series: {
        y10_de: D(ctx, "y10_de", y10, meta("Rendite 10-jähriger Bundesanleihen (Svensson, Nullkupon)", "%", "bundesbank")),
        y2_de: D(ctx, "y2_de", y2, meta("Rendite 2-jähriger Bundesanleihen (Svensson, Nullkupon)", "%", "bundesbank")),
      } };
    },
  },
  {
    id: "snb_daily", label: "Eidgenossen 10 Jahre, SARON und SNB-Leitzins (RSS, tagesaktuell)", source: "snb", every: 6, cost: 2, keep: true,
    async run(F, ctx) {
      const [rss, cube] = await Promise.all([snbRssRates(F), snbCube(F, "snbgwdzid", "D0(LZ,SARON)", since(ctx, "saron", "2014-01-01"))]);
      // Basis der 10-jährigen Rendite: Monatswerte (FRED/OECD) werden im Frontend ergänzt; hier die Tageswerte sammeln
      const s = {};
      if (rss.R10) s.y10_ch_d = D(ctx, "y10_ch_d", rss.R10, meta("Rendite 10-jähriger Eidgenossen (SNB, Tageswerte)", "%", "snb"));
      if (cube.LZ) s.pr_ch_snb = D(ctx, "pr_ch_snb", cube.LZ, meta("SNB-Leitzins", "%", "snb"));
      if (cube.SARON) s.saron = D(ctx, "saron", cube.SARON, meta("SARON", "%", "snb"));
      return { series: s };
    },
  },
  {
    id: "snb_monthly", label: "Schweizer Aktien (SMI, SPI) und SNB-Bilanz", source: "snb", every: 24, cost: 2, keep: true,
    async run(F, ctx) {
      const [st, bal] = await Promise.all([
        snbCube(F, "capchstocki", "D0(SMISMIDR,GDR)", since(ctx, "eq_ch", "2014-01-01", 45)),
        snbCube(F, "snbbipo", "D0(T0)", "2010-01"),
      ]);
      const s = {};
      if (st.SMISMIDR) s.eq_ch = D(ctx, "eq_ch", st.SMISMIDR, meta("Swiss Market Index (SMI)", "Punkte", "snb", { note: "monatlich veröffentlicht" }));
      if (st.GDR) s.eq_ch_spi = D(ctx, "eq_ch_spi", st.GDR, meta("Swiss Performance Index (SPI)", "Punkte", "snb", { note: "monatlich veröffentlicht" }));
      if (bal.T0) s.snb_assets = monthlySeries(bal.T0, meta("Bilanzsumme der SNB", "Mio. CHF", "snb"));
      return { series: s };
    },
  },
  {
    // tagesaktuell; die SNB-Reihen (monatlich veröffentlicht) bleiben Rückfall und liefern die ältere Historie
    id: "six_ch", label: "Schweizer Aktien tagesaktuell (SMI, SPI)", source: "six", every: 6, cost: 1, keep: true,
    async run(F, ctx) {
      const r = await sixDaily(F, ["CH0009980894CHF9", "CH0009987501CHF9"], since(ctx, "eq_ch_six", "2014-01-01"));
      const s = {};
      if (r.CH0009980894CHF9) s.eq_ch_six = D(ctx, "eq_ch_six", r.CH0009980894CHF9, meta("Swiss Market Index (SMI)", "Punkte", "six"));
      if (r.CH0009987501CHF9) s.eq_ch_spi_six = D(ctx, "eq_ch_spi_six", r.CH0009987501CHF9, meta("Swiss Performance Index (SPI)", "Punkte", "six"));
      return { series: s };
    },
  },
  {
    id: "boe", label: "Gilts 10 Jahre und Bank Rate", source: "boe", every: 12, cost: 2, keep: true,
    async run(F, ctx) {
      const r = await boe(F, ["IUDMNPY", "IUDBEDR"], since(ctx, "y10_gb", "2014-01-01"));
      const s = {};
      if (r.IUDMNPY && r.IUDMNPY.length) s.y10_gb = D(ctx, "y10_gb", r.IUDMNPY, meta("Rendite 10-jähriger britischer Staatsanleihen", "%", "boe"));
      if (r.IUDBEDR && r.IUDBEDR.length) s.pr_gb_boe = D(ctx, "pr_gb_boe", r.IUDBEDR, meta("Bank Rate", "%", "boe"));
      if (!Object.keys(s).length) throw new Error("Bank of England: keine Werte");
      return { series: s };
    },
  },
  {
    id: "mof_jgb", label: "Japanische Staatsanleihen 10 Jahre (laufender Monat)", source: "mof", every: 12, cost: 1, keep: true,
    async run(F, ctx) {
      const cur = await mofJgb(F, "current", "10Y");
      return { series: { y10_jp: D(ctx, "y10_jp", cur, meta("Rendite 10-jähriger japanischer Staatsanleihen", "%", "mof"), "2014-01-01") } };
    },
  },
  {
    id: "mof_jgb_hist", label: "Japanische Staatsanleihen 10 Jahre (Historie)", source: "mof", every: 24 * 7, cost: 1,
    async run(F) {
      const all = await mofJgb(F, "historical", "10Y");
      return { series: { y10_jp_hist: dailySeries(all.filter(p => p[0] >= "2014-01-01"), meta("Rendite 10-jähriger japanischer Staatsanleihen (Historie)", "%", "mof")) } };
    },
  },
  {
    id: "bis_policy", label: "Leitzinsen von acht Zentralbanken", source: "bis", every: 12, cost: 1, keep: true,
    async run(F, ctx) {
      const r = await bis(F, "WS_CBPOL", "D.US+XM+CH+JP+GB+CN+IN+RU", since(ctx, "pr_us", "2014-01-01", 120));
      const s = {};
      const names = { US: "USA (Fed)", XM: "Euroraum (EZB)", CH: "Schweiz (SNB)", JP: "Japan (BoJ)", GB: "Großbritannien (BoE)", CN: "China (PBoC)", IN: "Indien (RBI)", RU: "Russland (Bank of Russia)" };
      for (const [c, l] of Object.entries(names)) {
        const pts = r["D." + c];
        const sid = "pr_" + (c === "XM" ? "ea" : c.toLowerCase());
        if (pts && pts.length) s[sid] = D(ctx, sid, pts, meta(`Leitzins ${l}`, "%", "bis"));
        else if (ctx.prev && ctx.prev.series && ctx.prev.series[sid]) s[sid] = ctx.prev.series[sid];
      }
      return { series: s };
    },
  },
  {
    id: "bis_reer", label: "Reale effektive Wechselkurse (Bewertung der Währungen)", source: "bis", every: 24, cost: 1,
    async run(F) {
      const r = await bis(F, "WS_EER", "M.R.B.US+XM+CH+JP+GB+CN+IN", "2000-01");
      const s = {};
      const names = { US: "US-Dollar", XM: "Euro", CH: "Schweizer Franken", JP: "Yen", GB: "Pfund", CN: "Renminbi", IN: "Rupie" };
      for (const [c, l] of Object.entries(names)) {
        const pts = r["M.R.B." + c];
        if (pts && pts.length) s["reer_" + (c === "XM" ? "ea" : c.toLowerCase())] = monthlySeries(pts, meta(`Realer effektiver Wechselkurs: ${l}`, "Index 2020 = 100", "bis"));
      }
      return { series: s };
    },
  },
  {
    id: "imf_commodities", label: "Gold, Silber, Kupfer, Brent, Rohstoffindex (Monatsmittel)", source: "imf", every: 24, cost: 1,
    async run(F) {
      const r = await imfSdmx(F, "IMF.RES,PCPS,9.0.0", "G001.PGOLD+PSILVER+PCOPP+POILBRE+PALLFNF.USD+INDEX.M", "2005-01");
      const g = k => r[k] || Object.entries(r).find(([kk]) => kk.includes(k.split(".")[1]) && kk.includes(k.split(".")[2]))?.[1] || [];
      const s = {};
      const put = (sid, key, l, u) => { const p = g(key); if (p.length) s[sid] = monthlySeries(p, meta(l, u, "imf")); };
      put("gold_usd_imf", "G001.PGOLD.USD.M", "Gold (Monatsmittel, IWF)", "US-$ je Feinunze");
      put("silver_usd", "G001.PSILVER.USD.M", "Silber (Monatsmittel, IWF)", "US-$ je Feinunze");
      put("copper", "G001.PCOPP.USD.M", "Kupfer (Monatsmittel, IWF)", "US-$ je Tonne");
      put("brent_m", "G001.POILBRE.USD.M", "Rohöl Brent (Monatsmittel, IWF)", "US-$ je Fass");
      put("commod_index", "G001.PALLFNF.INDEX.M", "Rohstoffpreisindex des IWF (alle Rohstoffe)", "Index 2016 = 100");
      if (!Object.keys(s).length) throw new Error("IWF: keine Rohstoffreihen gefunden");
      return { series: s };
    },
  },
  {
    id: "nbp_gold", label: "Goldpreis täglich (Narodowy Bank Polski, in US-Dollar umgerechnet)", source: "nbp", every: 6, cost: 6, keep: true,
    async run(F, ctx) {
      const end = new Date(ctx.now).toISOString().slice(0, 10);
      let start = since(ctx, "gold_usd", "2023-01-02", 10);
      const pts = [];
      // höchstens 367 Tage je Abfrage; beim ersten Lauf in Jahresblöcken
      while (start <= end && pts.length < 2000) {
        const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 360);
        const stop = d.toISOString().slice(0, 10) < end ? d.toISOString().slice(0, 10) : end;
        pts.push(...await nbpGoldUsd(F, start, stop));
        const n = new Date(stop + "T00:00:00Z"); n.setUTCDate(n.getUTCDate() + 1); start = n.toISOString().slice(0, 10);
        if (F.used >= F.budget - 2) break;
      }
      return { series: { gold_usd: D(ctx, "gold_usd", pts, meta("Goldpreis", "US-$ je Feinunze", "nbp", { note: "NBP-Goldpreis (PLN je Gramm) mit NBP-Dollarkurs umgerechnet" })) } };
    },
  },
  {
    id: "boj", label: "Bank of Japan: Tagesgeldsatz und Bilanzsumme", source: "boj", every: 24, cost: 2, keep: true,
    async run(F, ctx) {
      const st = since(ctx, "boj_call", "2014-01-01").slice(0, 7).replace("-", "");
      const [call, bs] = await Promise.all([bojApi(F, "FM01", "STRDCLUCON", st), bojApi(F, "BS01", "MABJMTA", "201401")]);
      const s = {};
      if (call.length) s.boj_call = D(ctx, "boj_call", call, meta("Unbesicherter Tagesgeldsatz Japan", "%", "boj"));
      if (bs.length) s.boj_assets = monthlySeries(bs, meta("Bilanzsumme der Bank of Japan", "100 Mio. Yen", "boj"));
      return { series: s };
    },
  },
];

export const JOBS = [...MARKET_JOBS, ...MACRO_JOBS, ...GEO_JOBS];
