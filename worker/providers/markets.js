/* Zentralbanken und amtliche Marktdaten ohne Schlüssel.
   Alle Funktionen liefern Punktlisten [[datum, wert], ...] (Datum ISO, Monat "YYYY-MM", Quartal "YYYY-Qn"). */
import { parseCsv, num } from "../lib/csv.js";

/* Antwort auf HTML-Fehlerseiten prüfen (BoE leitet bei Überlast auf eine Fehlerseite um, die EZB-Firewall liefert HTML) */
function assertData(txt, what) {
  const head = txt.slice(0, 300).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) throw new Error(`${what}: HTML statt Daten erhalten`);
  return txt;
}

/* ---------------------------------------------------------------- EZB: mehrere Reihen eines Datensatzes */
export async function ecbData(F, flow, key, start) {
  const url = `https://data-api.ecb.europa.eu/service/data/${flow}/${key}?format=csvdata&detail=dataonly${start ? `&startPeriod=${start}` : ""}`;
  const { header, rows } = parseCsv(assertData(await F.text(url, { headers: { accept: "text/csv" }, timeout: 40000 }), "EZB"));
  const iK = header.indexOf("KEY"), iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
  if (iT < 0 || iV < 0) throw new Error("EZB: unerwartetes CSV-Format");
  const out = {};
  for (const r of rows) {
    const k = iK >= 0 ? r[iK] : `${flow}.${key}`;
    (out[k] = out[k] || []).push([isoWeekToDate(r[iT]), num(r[iV])]);
  }
  return out;
}
// "2026-W41" → Freitag dieser ISO-Woche (Stichtag der EZB-Wochenausweise)
function isoWeekToDate(p) {
  const m = /^(\d{4})-W(\d{2})$/.exec(p);
  if (!m) return p;
  const y = +m[1], w = +m[2];
  const jan4 = Date.UTC(y, 0, 4), dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const monday = jan4 - dow * 86400000 + (w - 1) * 7 * 86400000;
  return new Date(monday + 4 * 86400000).toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- SNB-Datenportal (CSV mit Semikolon und Vorspann) */
export async function snbCube(F, cube, dimSel, start) {
  const url = `https://data.snb.ch/api/cube/${cube}/data/csv/en?${dimSel ? `dimSel=${encodeURIComponent(dimSel)}&` : ""}fromDate=${start}`;
  const txt = assertData(await F.text(url, { timeout: 40000 }), "SNB");
  const lines = txt.replace(/^﻿/, "").split(/\r?\n/);
  const hi = lines.findIndex(l => /^"?Date"?;/.test(l));
  if (hi < 0) throw new Error("SNB: Kopfzeile fehlt");
  const { header, rows } = parseCsv(lines.slice(hi).join("\n"), ";");
  const iD = header.indexOf("Date"), iV = header.indexOf("Value");
  const dims = header.map((h, i) => [h, i]).filter(([h]) => h.startsWith("D") && h !== "Date").map(([, i]) => i);
  const out = {};
  for (const r of rows) {
    const k = dims.map(i => r[i]).join(".") || cube;
    (out[k] = out[k] || []).push([r[iD], num(r[iV])]);
  }
  return out;
}

/* SNB-RSS (RSS-CB): tagesaktuelle Zinssätze, etwa R10 = Rendite 10-jähriger Eidgenossen */
export async function snbRssRates(F) {
  const xml = await F.text("https://www.snb.ch/public/rss/en/interestRates", { timeout: 20000 });
  const out = {};
  const items = xml.split(/<item[\s>]/).slice(1);
  for (const it of items) {
    const name = (/<cb:rateName>([^<]+)<\/cb:rateName>/.exec(it) || [])[1];
    const val = (/<cb:value[^>]*>([^<]+)<\/cb:value>/.exec(it) || [])[1];
    const date = (/<dc:date>([^<]+)<\/dc:date>/.exec(it) || /<cb:observationPeriod>[\s\S]*?<cb:period>([^<]+)<\/cb:period>/.exec(it) || [])[1];
    if (!name || val == null || !date) continue;
    (out[name.trim()] = out[name.trim()] || []).push([date.slice(0, 10), num(val)]);
  }
  return out;
}

/* ---------------------------------------------------------------- Deutsche Bundesbank (BBSIS: Zinsstrukturkurve) */
export async function bundesbank(F, key, start) {
  const url = `https://api.statistiken.bundesbank.de/rest/data/${key}?startPeriod=${start}&format=csv&lang=en`;
  const txt = assertData(await F.text(url, { timeout: 40000 }), "Bundesbank");
  const out = [];
  for (const l of txt.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}),([^,]*)/.exec(l);
    if (m) { const v = num(m[2]); if (v != null) out.push([m[1], v]); }
  }
  if (!out.length) throw new Error("Bundesbank: keine Werte");
  return out;
}

/* ---------------------------------------------------------------- Bank of England (IADB-CSV) */
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
export async function boe(F, codes, startDate) {
  const d = new Date(startDate + "T00:00:00Z");
  const from = `${String(d.getUTCDate()).padStart(2, "0")}/${Object.keys(MON)[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
  const url = `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${from}&Dateto=now&SeriesCodes=${codes.join(",")}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
  let txt;
  for (let attempt = 0; attempt < 3; attempt++) { // erster Aufruf nach Ruhepause landet oft auf einer Fehlerseite
    if (attempt) await new Promise(r => setTimeout(r, 2500 * attempt));
    txt = await F.text(url, { timeout: 30000 });
    if (!/<html/i.test(txt.slice(0, 500))) break;
    txt = null;
  }
  if (!txt) throw new Error("Bank of England: Fehlerseite statt Daten");
  const { header, rows } = parseCsv(txt);
  const out = {};
  for (let j = 1; j < header.length; j++) out[header[j]] = [];
  for (const r of rows) {
    const m = /^(\d{2}) (\w{3}) (\d{4})$/.exec((r[0] || "").trim());
    if (!m) continue;
    const iso = `${m[3]}-${MON[m[2]]}-${m[1]}`;
    for (let j = 1; j < header.length; j++) { const v = num(r[j]); if (v != null) out[header[j]].push([iso, v]); }
  }
  return out;
}

/* ---------------------------------------------------------------- Japanisches Finanzministerium (JGB-Renditen) */
export async function mofJgb(F, which = "current", tenor = "10Y") {
  const url = which === "current"
    ? "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv"
    : "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv";
  const txt = await F.text(url, { timeout: 40000 });
  const lines = txt.split(/\r?\n/);
  const hi = lines.findIndex(l => l.startsWith("Date,"));
  if (hi < 0) throw new Error("MoF: Kopfzeile fehlt");
  const header = lines[hi].split(",");
  const j = header.indexOf(tenor);
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    const c = l.split(",");
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(c[0]);
    if (!m) continue;
    const v = num(c[j]);
    if (v != null) out.push([`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, v]);
  }
  return out;
}

/* ---------------------------------------------------------------- BIS: Leitzinsen (WS_CBPOL) und andere Datensätze */
export async function bis(F, flow, key, start) {
  const url = `https://stats.bis.org/api/v1/data/${flow}/${key}?startPeriod=${start}&detail=dataonly&format=csv`;
  const { header, rows } = parseCsv(assertData(await F.text(url, { timeout: 40000 }), "BIS"));
  const iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
  const keyCols = header.map((h, i) => [h, i]).filter(([h]) => !["TIME_PERIOD", "OBS_VALUE"].includes(h)).map(([, i]) => i);
  const out = {};
  for (const r of rows) {
    const k = keyCols.map(i => r[i]).join(".");
    (out[k] = out[k] || []).push([r[iT], num(r[iV])]);
  }
  return out;
}

/* ---------------------------------------------------------------- IWF SDMX (z. B. Rohstoffpreise PCPS) */
export async function imfSdmx(F, flowRef, key, start) {
  const url = `https://api.imf.org/external/sdmx/2.1/data/${flowRef}/${key}?startPeriod=${start}&detail=dataonly`;
  const { header, rows } = parseCsv(assertData(await F.text(url, { headers: { accept: "application/vnd.sdmx.data+csv;version=1.0.0" }, timeout: 40000 }), "IWF"));
  const iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
  const dimCols = ["COUNTRY", "INDICATOR", "COMMODITY", "DATA_TRANSFORMATION", "UNIT", "UNIT_MEASURE", "TYPE_OF_TRANSFORMATION", "FXR_CURRENCY", "FREQUENCY", "FREQ"].map(c => header.indexOf(c)).filter(i => i >= 0);
  const out = {};
  for (const r of rows) {
    const k = dimCols.map(i => r[i]).join(".");
    const t = r[iT].replace(/^(\d{4})-M(\d{2})$/, "$1-$2").replace(/^(\d{4})-(Q\d)$/, "$1-$2");
    (out[k] = out[k] || []).push([t, num(r[iV])]);
  }
  return out;
}

/* ---------------------------------------------------------------- Narodowy Bank Polski: Gold (PLN je Gramm) und USD/PLN → USD je Feinunze */
const OZ = 31.1034768;
export async function nbpGoldUsd(F, start, end) {
  const [g, fx] = await Promise.all([
    F.json(`https://api.nbp.pl/api/cenyzlota/${start}/${end}/?format=json`),
    F.json(`https://api.nbp.pl/api/exchangerates/rates/a/usd/${start}/${end}/?format=json`),
  ]);
  const usd = new Map((fx.rates || []).map(r => [r.effectiveDate, r.mid]));
  const out = [];
  for (const r of g) { const m = usd.get(r.data); if (m) out.push([r.data, r.cena * OZ / m]); }
  return out;
}

/* ---------------------------------------------------------------- Bank of Japan, Statistik-API (seit Februar 2026) */
export async function bojApi(F, db, code, startYm) {
  const j = await F.json(`https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=json&lang=en&db=${db}&code=${code}&startDate=${startYm}`, { timeout: 30000 });
  const res = (j.RESULTSET || j.resultset || [])[0] || {};
  const v = res.VALUES || {};
  const dates = v.SURVEY_DATES || [], vals = v.VALUES || [];
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const d = String(dates[i]);
    const iso = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.length === 6 ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : d;
    if (vals[i] != null) out.push([iso, +vals[i]]);
  }
  return out;
}
