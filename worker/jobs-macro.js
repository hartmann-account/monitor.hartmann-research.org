/* Abrufjobs für Konjunktur, Schulden, Demografie und Technologie (OECD, IWF, Weltbank, FRED) */
import { monthlySeries, quarterlySeries, annualSeries } from "./lib/series.js";
import { meta, Q, toMonth, toQuarter } from "./lib/jobutil.js";
import { oecd, worldbank, imfDatamapper, gistemp, fredMulti } from "./providers/official.js";
import { imfSdmx } from "./providers/markets.js";
import { parseCsv, num } from "./lib/csv.js";
import { sleep } from "./lib/http.js";

/* Die OECD-Schnittstelle antwortet auf schnelle Folgeabfragen mit HTTP 500: Abfragen nacheinander und mit Pause */
async function oecdSeq(F, reqs) {
  const out = [];
  for (let i = 0; i < reqs.length; i++) {
    if (i) await sleep(1500);
    out.push(await oecd(F, ...reqs[i]));
  }
  return out;
}

const ISO2 = { USA: "us", CHN: "cn", DEU: "de", JPN: "jp", GBR: "gb", IND: "in", CHE: "ch", RUS: "ru", EA: "ea", EA20: "ea", G7: "g7", G20: "g20", G4E: "g4e", A5M: "a5m", OECD: "oecd" };
const CNAME = { USA: "USA", CHN: "China", DEU: "Deutschland", JPN: "Japan", GBR: "Großbritannien", IND: "Indien", CHE: "Schweiz", RUS: "Russland", EA: "Euroraum", EA20: "Euroraum", G7: "G7", G20: "G20", G4E: "Europa (vier große Länder)", A5M: "Asien (fünf große Länder)", OECD: "OECD", EUU: "Europäische Union", EURO: "Euroraum" };
const sortPts = pts => pts.filter(p => p[1] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));

/* IWF SDMX 3.0 (COFER, CPI): CSV mit Accept-Header */
async function imf3(F, path) {
  const txt = await F.text(`https://api.imf.org/external/sdmx/3.0/data/dataflow/${path}`, { headers: { accept: "application/vnd.sdmx.data+csv;version=2.0.0" }, timeout: 40000 });
  const { header, rows } = parseCsv(txt);
  const iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
  if (iT < 0 || iV < 0) throw new Error("IWF SDMX 3.0: unerwartetes Format");
  return { header, rows, iT, iV };
}

const WEO = [
  ["GGXWDG_NGDP", "debt_", "Bruttoschulden des Gesamtstaats", "% des BIP"],
  ["NGDP_RPCH", "growth_", "Reales BIP-Wachstum", "%"],
  ["PCPIPCH", "infl_", "Inflation (Jahresdurchschnitt)", "%"],
  ["BCA_NGDPD", "ca_", "Leistungsbilanzsaldo", "% des BIP"],
  ["PPPSH", "ppp_", "Anteil am Welt-BIP (Kaufkraftparitäten)", "%"],
  ["GGXCNL_NGDP", "bal_", "Finanzierungssaldo des Gesamtstaats", "% des BIP"],
];
const WEO_C = ["USA", "CHN", "DEU", "JPN", "GBR", "IND", "RUS", "CHE", "EURO", "TWN", "IRN", "ISR", "UKR"];
function weoJob(n, inds) {
  return {
    id: "imf_weo_" + n, label: "IWF World Economic Outlook: " + inds.map(i => i[2]).join(", "), source: "imf", every: 24 * 3, cost: inds.length,
    async run(F) {
      const s = {};
      for (const [code, pre, label, unit] of inds) {
        const r = await imfDatamapper(F, code, WEO_C);
        for (const c of WEO_C) {
          const pts = (r[c] || []).filter(p => p[0] >= 1990);
          if (pts.length) s[pre + c.toLowerCase()] = annualSeries(pts, meta(`${label} ${CNAME[c] || c}`, unit, "imf", { weo: true }));
        }
      }
      return { series: s };
    },
  };
}

const WB_C = ["USA", "CHN", "EUU", "DEU", "JPN", "GBR", "IND", "RUS", "CHE"];
function wbJob(id, label, inds, every = 24 * 7) {
  return {
    id, label, source: "wb", every, cost: inds.length,
    async run(F) {
      const s = {};
      for (const [ind, pre, l, u, opts] of inds) {
        const r = await worldbank(F, WB_C, ind, opts);
        for (const c of WB_C) if (r[c] && r[c].length) s[pre + c.toLowerCase()] = annualSeries(r[c], meta(`${l} (${CNAME[c] || c})`, u, "wb", { wb: ind }));
      }
      return { series: s };
    },
  };
}

export const MACRO_JOBS = [
  {
    id: "oecd_cli", label: "OECD-Frühindikatoren und Geschäftsklima (Schweiz, Euroraum)", source: "oecd", every: 24, cost: 2, onePerRun: true,
    async run(F) {
      const [cli, conf] = await oecdSeq(F, [
        ["OECD.SDD.STES,DSD_STES@DF_CLI,4.1", "USA+CHN+DEU+JPN+GBR+IND+G7+G20+G4E+A5M.M.LI.IX._Z.AA.IX._Z.H", { start: "2010-01" }],
        // Für die Schweiz und den Euroraum gibt es keinen Frühindikator; das standardisierte Geschäftsklima hat dieselbe Skala
        ["OECD.SDD.STES,DSD_STES@DF_CLI,4.1", "CHE+EA20.M.BCICP.IX._Z.AA.IX._Z.H", { start: "2010-01" }],
      ]);
      const s = {};
      for (const [c, pts] of Object.entries(cli)) s["cli_" + ISO2[c]] = monthlySeries(sortPts(pts), meta(`Frühindikator ${CNAME[c] || c} (OECD, amplitudenbereinigt)`, "Index, Mittel = 100", "oecd"));
      for (const [c, pts] of Object.entries(conf)) s["cli_" + ISO2[c]] = monthlySeries(sortPts(pts), meta(`Geschäftsklima ${CNAME[c] || c} (OECD, amplitudenbereinigt; Ersatz für den Frühindikator)`, "Index, Mittel = 100", "oecd"));
      return { series: s };
    },
  },
  {
    id: "oecd_prices", label: "Inflation (OECD, Verbraucherpreise)", source: "oecd", every: 24, cost: 2, onePerRun: true,
    async run(F) {
      const [g20, ch] = await oecdSeq(F, [
        ["OECD.SDD.TPS,DSD_G20_PRICES@DF_G20_PRICES,1.0", "USA+CHN+DEU+JPN+GBR+IND+EA+G20.M..CPI.PA._T.N.GY", { start: "2010-01" }],
        ["OECD.SDD.TPS,DSD_PRICES_COICOP2018@DF_PRICES_C2018_ALL,1.0", "CHE.M.N.CPI.PA._T.N.GY", { start: "2010-01" }],
      ]);
      const s = {};
      for (const [c, pts] of Object.entries({ ...g20, ...ch })) s["cpi_" + ISO2[c]] = monthlySeries(sortPts(pts), meta(`Inflation ${CNAME[c] || c} (Verbraucherpreise, ggü. Vorjahr)`, "%", "oecd"));
      return { series: s };
    },
  },
  {
    id: "oecd_labour", label: "Arbeitslosenquoten (OECD)", source: "oecd", every: 24 * 2, cost: 2, onePerRun: true,
    async run(F) {
      const [m, ch] = await oecdSeq(F, [
        ["OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M,1.0", "USA+DEU+JPN+GBR+EA+G7.UNE_LF_M.PT_LF_SUB._Z.Y._T.Y_GE15._Z.M", { start: "2010-01" }],
        ["OECD.SDD.TPS,DSD_LFS@DF_IALFS_INDIC,1.0", "CHE.UNE_LF.PT_LF_SUB._Z.Y._T.Y_GE15._Z.Q", { start: "2010-Q1" }],
      ]);
      const s = {};
      for (const [c, pts] of Object.entries(m)) s["unemp_" + ISO2[c]] = monthlySeries(sortPts(pts), meta(`Arbeitslosenquote ${CNAME[c] || c}`, "%", "oecd"));
      if (ch.CHE) s.unemp_ch = quarterlySeries(sortPts(toQuarter(ch.CHE)), meta("Arbeitslosenquote Schweiz (ILO-Definition, Quartal)", "%", "oecd"));
      return { series: s };
    },
  },
  {
    id: "oecd_gdp", label: "Reales BIP-Wachstum (OECD, Quartale)", source: "oecd", every: 24 * 2, cost: 2, onePerRun: true,
    async run(F) {
      const [g, ch] = await oecdSeq(F, [
        ["OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_G20,1.1", "Q.Y.USA+CHN+DEU+JPN+GBR+IND+EA+G20+G7.S1.S1.B1GQ._Z._Z._Z.PC.L.GY.T0102", { start: "2010-Q1" }],
        ["OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD,1.1", "Q.Y.CHE.S1.S1.B1GQ._Z._Z._Z.PC.L.GY.T0102", { start: "2010-Q1" }],
      ]);
      const s = {};
      for (const [c, pts] of Object.entries({ ...g, ...ch })) s["gdp_" + ISO2[c]] = quarterlySeries(sortPts(toQuarter(pts)), meta(`Reales BIP ${CNAME[c] || c}, Veränderung ggü. Vorjahresquartal`, "%", "oecd"));
      return { series: s };
    },
  },
  {
    id: "oecd_finmark", label: "Aktienindizes und Langfristzinsen (OECD, Monatswerte)", source: "oecd", every: 24, cost: 1, onePerRun: true,
    async run(F) {
      const txt = await F.text("https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_FINMARK,4.0/USA+JPN+DEU+CHE+GBR+CHN+IND+EA20.M.SHARE+IRLT.......?startPeriod=2004-01&dimensionAtObservation=AllDimensions",
        { headers: { accept: "application/vnd.sdmx.data+csv; charset=utf-8" }, timeout: 40000 });
      const { header, rows } = parseCsv(txt);
      const iA = header.indexOf("REF_AREA"), iM = header.indexOf("MEASURE"), iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
      if (iA < 0 || iM < 0) throw new Error("OECD FINMARK: unerwartetes Format");
      const by = {};
      for (const r of rows) { const k = r[iM] + "|" + r[iA]; (by[k] = by[k] || []).push([r[iT], num(r[iV])]); }
      const s = {};
      const names = { USA: "USA", JPN: "Japan", DEU: "Deutschland", CHE: "Schweiz", GBR: "Großbritannien", CHN: "China", IND: "Indien", EA20: "Euroraum" };
      for (const [k, pts] of Object.entries(by)) {
        const [m, c] = k.split("|");
        const iso = ISO2[c];
        if (m === "SHARE") s[(["de", "gb", "cn", "in"].includes(iso) ? "eq_" : "eqm_") + iso] = monthlySeries(sortPts(pts), meta(`Aktienkurse ${names[c]} (OECD, Index 2015 = 100, Monatsmittel)`, "Index", "oecd"));
        if (m === "IRLT") s["y10m_" + iso] = monthlySeries(sortPts(pts), meta(`Langfristzins ${names[c]} (OECD, Monatsmittel)`, "%", "oecd"));
      }
      if (s.y10m_cn) s.y10_cn = s.y10m_cn;
      return { series: s };
    },
  },
  weoJob(1, WEO.slice(0, 2)),
  weoJob(2, WEO.slice(2, 4)),
  weoJob(3, WEO.slice(4, 6)),
  {
    id: "imf_cofer", label: "Anteile an den Weltdevisenreserven (IWF COFER)", source: "imf_cofer", every: 24 * 3, cost: 1,
    async run(F) {
      const { header, rows, iT, iV } = await imf3(F, "IMF.STA/COFER/+/G001.AFXRA.CI_USD+CI_EUR+CI_CNY+CI_JPY+CI_GBP+CI_CHF.SHRO_PT.Q?c%5BTIME_PERIOD%5D=ge:2000-Q1&attributes=none&measures=all");
      const iC = header.indexOf("FXR_CURRENCY");
      const by = {};
      for (const r of rows) (by[r[iC]] = by[r[iC]] || []).push([r[iT], num(r[iV])]);
      const s = {};
      const n = { CI_USD: ["usd", "US-Dollar"], CI_EUR: ["eur", "Euro"], CI_CNY: ["cny", "Renminbi"], CI_JPY: ["jpy", "Yen"], CI_GBP: ["gbp", "Pfund"], CI_CHF: ["chf", "Franken"] };
      for (const [c, pts] of Object.entries(by)) if (n[c]) s["cofer_" + n[c][0]] = quarterlySeries(sortPts(toQuarter(pts)), meta(`Anteil ${n[c][1]} an den Weltdevisenreserven`, "%", "imf_cofer"));
      return { series: s };
    },
  },
  {
    id: "imf_cpi_ru", label: "Inflation Russland und Iran (IWF)", source: "imf", every: 24 * 3, cost: 1,
    async run(F) {
      const { header, rows, iT, iV } = await imf3(F, "IMF.STA/CPI/+/RUS+IRN.CPI._T.YOY_PCH_PA_PT.M?c%5BTIME_PERIOD%5D=ge:2015-01&attributes=none&measures=all");
      const iC = header.indexOf("COUNTRY");
      const by = {};
      for (const r of rows) (by[r[iC]] = by[r[iC]] || []).push([r[iT].replace(/^(\d{4})-M(\d{2})$/, "$1-$2"), num(r[iV])]);
      const s = {};
      if (by.RUS) s.cpi_ru = monthlySeries(sortPts(by.RUS), meta("Inflation Russland (Verbraucherpreise, ggü. Vorjahr)", "%", "imf"));
      if (by.IRN) s.cpi_ir = monthlySeries(sortPts(by.IRN), meta("Inflation Iran (Verbraucherpreise, ggü. Vorjahr)", "%", "imf"));
      return { series: s };
    },
  },
  {
    id: "fred_uncertainty", label: "Unsicherheitsindizes (EPU, World Uncertainty Index)", source: "fred", every: 24, cost: 2,
    async run(F) {
      const [epu, wui] = await Promise.all([
        fredMulti(F, ["GEPUCURRENT", "EUEPUINDXM", "UKEPUINDXM", "RUSEPUINDXM", "INDEPUINDXM", "USEPUINDXM"], "2005-01-01"),
        fredMulti(F, ["WUIGLOBALWEIGHTAVG", "WUIUSA", "WUICHN", "WUIDEU", "WUIJPN", "WUIGBR", "WUIIND", "WUIRUS", "WUICHE"], "2000-01-01"),
      ]);
      const s = {};
      const em = { GEPUCURRENT: ["epu_global", "Welt"], EUEPUINDXM: ["epu_eu", "Europa"], UKEPUINDXM: ["epu_gb", "Großbritannien"], RUSEPUINDXM: ["epu_ru", "Russland"], INDEPUINDXM: ["epu_in", "Indien"], USEPUINDXM: ["epu_us_m", "USA"] };
      for (const [fid, [sid, n]] of Object.entries(em)) if (epu[fid]) s[sid] = monthlySeries(toMonth(epu[fid]), meta(`Wirtschaftspolitische Unsicherheit ${n} (EPU)`, "Index", "epu", { fred: fid }));
      const wm = { WUIGLOBALWEIGHTAVG: ["wui_world", "Welt"], WUIUSA: ["wui_us", "USA"], WUICHN: ["wui_cn", "China"], WUIDEU: ["wui_de", "Deutschland"], WUIJPN: ["wui_jp", "Japan"], WUIGBR: ["wui_gb", "Großbritannien"], WUIIND: ["wui_in", "Indien"], WUIRUS: ["wui_ru", "Russland"], WUICHE: ["wui_ch", "Schweiz"] };
      for (const [fid, [sid, n]] of Object.entries(wm)) if (wui[fid]) s[sid] = quarterlySeries(toQuarter(wui[fid]), meta(`World Uncertainty Index ${n}`, "Index", "fred", { fred: fid }));
      return { series: s };
    },
  },
  wbJob("wb_population", "Bevölkerung und Erwerbsbevölkerung 1960–2050 (Weltbank, Projektionen)", [
    ["SP.POP.TOTL", "pop_", "Bevölkerung", "Personen", { source: 40, date: "1960:2050" }],
    ["SP.POP.1564.TO.ZS", "wa_", "Anteil 15- bis 64-Jährige", "% der Bevölkerung", { source: 40, date: "1960:2050" }],
  ]),
  wbJob("wb_ageing", "Altersquotient und Fertilität 1960–2050 (Weltbank, Projektionen)", [
    ["SP.POP.DPND.OL", "dep_", "Altersquotient (65+ je 100 Personen von 15 bis 64)", "%", { source: 40, date: "1960:2050" }],
    ["SP.DYN.TFRT.IN", "tfr_", "Geburten je Frau", "Kinder", { source: 40, date: "1960:2050" }],
  ]),
  wbJob("wb_life", "Lebenserwartung und Militärausgaben (Weltbank)", [
    ["SP.DYN.LE00.IN", "le_", "Lebenserwartung bei Geburt", "Jahre", { date: "1990:2025" }],
    ["MS.MIL.XPND.GD.ZS", "milx_", "Militärausgaben (SIPRI)", "% des BIP", { date: "1990:2025" }],
  ]),
  wbJob("wb_tech", "Forschung, Patente, Hightech-Exporte (Weltbank)", [
    ["GB.XPD.RSDV.GD.ZS", "rd_", "F&E-Ausgaben", "% des BIP", { date: "1996:2025" }],
    ["SP.POP.SCIE.RD.P6", "res_", "Forschende", "je Mio. Einwohner", { date: "1996:2025" }],
    ["IP.PAT.RESD", "pat_", "Patentanmeldungen von Inländern", "Anzahl", { date: "1996:2025" }],
  ]),
  wbJob("wb_digital", "Hightech-Exporte, Internetnutzung, Produktivität (Weltbank)", [
    ["TX.VAL.TECH.MF.ZS", "htx_", "Hochtechnologie-Exporte", "% der Industriegüterexporte", { date: "1996:2025" }],
    ["IT.NET.USER.ZS", "net_", "Internetnutzung", "% der Bevölkerung", { date: "1996:2025" }],
    ["SL.GDP.PCAP.EM.KD", "prod_", "BIP je Erwerbstätigem (konstante KKP-Dollar)", "US-$", { date: "1991:2025" }],
  ]),
  {
    id: "nasa_gistemp", label: "Globale Temperaturabweichung (NASA GISTEMP)", source: "nasa", every: 24 * 2, cost: 1,
    async run(F) {
      const pts = await gistemp(F);
      return { series: { temp_gistemp: monthlySeries(pts.filter(p => p[0] >= "1950-01"), meta("Globale Temperaturabweichung gegenüber 1951–1980", "°C", "nasa")) } };
    },
  },
];
