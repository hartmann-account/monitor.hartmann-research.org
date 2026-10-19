/* Abrufe bei amtlichen und institutionellen Quellen ohne Schlüssel (FRED optional mit Schlüssel).
   Jede Funktion liefert Punktlisten [[datum, wert], ...] oder Objekte davon. */
import { parseCsv, num } from "../lib/csv.js";
import { unzip } from "../lib/zip.js";

/* ---------------------------------------------------------------- FRED (Federal Reserve Bank of St. Louis)
   Ohne Schlüssel über den offiziellen Grafik-Export (fredgraph.csv), mit FRED_API_KEY über die dokumentierte API.
   freq: "m" Monatsmittel, "q" Quartalsmittel, sonst Originalfrequenz. */
export async function fred(F, id, { start, freq, key } = {}) {
  if (key) {
    const u = new URL("https://api.stlouisfed.org/fred/series/observations");
    u.searchParams.set("series_id", id);
    u.searchParams.set("api_key", key);
    u.searchParams.set("file_type", "json");
    if (start) u.searchParams.set("observation_start", start);
    if (freq) { u.searchParams.set("frequency", freq); u.searchParams.set("aggregation_method", "avg"); }
    const j = await F.json(u.toString());
    return (j.observations || []).map(o => [o.date, num(o.value)]).filter(p => p[1] != null);
  }
  let url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  if (start) url += `&cosd=${start}`;
  if (freq) url += `&fq=${{ m: "Monthly", q: "Quarterly", a: "Annual", w: "Weekly" }[freq]}&fam=avg`;
  const txt = await F.text(url);
  if (txt.startsWith("PK")) throw new Error(`FRED lieferte ein ZIP statt CSV für ${id}`);
  const { header, rows } = parseCsv(txt);
  if (header.length < 2) throw new Error(`FRED: unerwartetes Format für ${id}`);
  return rows.map(r => [r[0], num(r[1])]).filter(p => p[1] != null);
}

/* Mehrere FRED-Reihen in einem Abruf. Gleiche Frequenz: eine CSV-Datei; gemischte Frequenzen: ZIP mit je einer
   CSV-Datei pro Frequenz. Liefert { id: [[datum, wert], ...] }. */
export async function fredMulti(F, ids, start) {
  let url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${ids.map(encodeURIComponent).join(",")}`;
  if (start) url += `&cosd=${ids.map(() => start).join(",")}`;
  const r = await F.request(url, { timeout: 40000 });
  const u8 = new Uint8Array(await r.arrayBuffer());
  const files = u8[0] === 0x50 && u8[1] === 0x4b ? await unzip(u8, { only: n => n.endsWith(".csv") }) : { "data.csv": new TextDecoder().decode(u8) };
  const out = {};
  for (const txt of Object.values(files)) {
    const { header, rows } = parseCsv(txt);
    if (header[0] !== "observation_date") throw new Error("FRED: unerwartetes Format");
    for (let j = 1; j < header.length; j++) {
      const id = header[j];
      out[id] = rows.map(rw => [rw[0], num(rw[j])]).filter(p => p[1] != null);
    }
  }
  const missing = ids.filter(id => !out[id]);
  if (missing.length === ids.length) throw new Error("FRED: keine der Reihen geliefert");
  return out;
}

/* ---------------------------------------------------------------- EZB Data Portal (SDMX 2.1, CSV) */
export async function ecb(F, flow, key, { start } = {}) {
  const url = `https://data-api.ecb.europa.eu/service/data/${flow}/${key}?format=csvdata${start ? `&startPeriod=${start}` : ""}`;
  const { header, rows } = parseCsv(await F.text(url, { headers: { accept: "text/csv" } }));
  const iK = header.indexOf("KEY"), iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE");
  if (iT < 0 || iV < 0) throw new Error("EZB: unerwartetes CSV-Format");
  const out = {};
  for (const r of rows) {
    const k = iK >= 0 ? r[iK] : key;
    (out[k] = out[k] || []).push([r[iT], num(r[iV])]);
  }
  return out;
}

/* ---------------------------------------------------------------- OECD Data Explorer (SDMX, CSV)
   Liefert { REF_AREA: [[periode, wert], ...] }; weitere Dimensionen werden über "pick" gefiltert. */
export async function oecd(F, flowRef, key, { start, pick = {}, by = "REF_AREA" } = {}) {
  const url = `https://sdmx.oecd.org/public/rest/data/${flowRef}/${key}?format=csvfile${start ? `&startPeriod=${start}` : ""}&dimensionAtObservation=AllDimensions`;
  const { header, rows } = parseCsv(await F.text(url, { timeout: 40000 }));
  const iT = header.indexOf("TIME_PERIOD"), iV = header.indexOf("OBS_VALUE"), iB = header.indexOf(by);
  if (iT < 0 || iV < 0 || iB < 0) throw new Error("OECD: unerwartetes CSV-Format");
  const filt = Object.entries(pick).map(([k, v]) => [header.indexOf(k), v]).filter(([i]) => i >= 0);
  const out = {};
  for (const r of rows) {
    if (filt.some(([i, v]) => r[i] !== v)) continue;
    (out[r[iB]] = out[r[iB]] || []).push([r[iT], num(r[iV])]);
  }
  return out;
}

/* ---------------------------------------------------------------- Weltbank (World Development Indicators u. a.) */
export async function worldbank(F, countries, indicator, { source, date = "1960:2050" } = {}) {
  const url = `https://api.worldbank.org/v2/country/${countries.join(";")}/indicator/${indicator}?format=json&per_page=5000&date=${date}${source ? `&source=${source}` : ""}`;
  const j = await F.json(url, { timeout: 40000 });
  if (!Array.isArray(j) || !Array.isArray(j[1])) throw new Error(`Weltbank: keine Daten für ${indicator}`);
  const out = {};
  for (const r of j[1]) {
    if (r.value == null) continue;
    const iso = r.countryiso3code || (r.country && r.country.id);
    (out[iso] = out[iso] || []).push([+r.date, +r.value]);
  }
  return out;
}

/* ---------------------------------------------------------------- IWF DataMapper (WEO inkl. Projektionen) */
export async function imfDatamapper(F, indicator, countries) {
  const j = await F.json(`https://www.imf.org/external/datamapper/api/v1/${indicator}/${countries.join("/")}`, { timeout: 40000 });
  const v = (j.values || {})[indicator] || {};
  const out = {};
  for (const [iso, ser] of Object.entries(v)) out[iso] = Object.entries(ser).map(([y, x]) => [+y, x == null ? null : +x]);
  return out;
}

/* ---------------------------------------------------------------- US-Finanzministerium (Fiscal Data API) */
export async function treasury(F, path, params = "") {
  const j = await F.json(`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/${path}?${params}`, { timeout: 40000 });
  return j.data || [];
}

/* ---------------------------------------------------------------- NASA GISTEMP v4 (globale Temperaturabweichung, Monatswerte) */
export async function gistemp(F) {
  const txt = await F.text("https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv");
  const lines = txt.split(/\r?\n/);
  const hi = lines.findIndex(l => l.startsWith("Year,"));
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    const c = l.split(",");
    const y = +c[0];
    if (!y) continue;
    for (let m = 1; m <= 12; m++) {
      const v = num(c[m]);
      if (v != null && c[m] !== "***") out.push([`${y}-${String(m).padStart(2, "0")}`, v]);
    }
  }
  return out;
}
