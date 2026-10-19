/* Einlesen der World-Gold-Council-Dateien an nachgebauten Blättern (gleicher Aufbau wie die Goldhub-Downloads) */
import test from "node:test";
import assert from "node:assert/strict";
import { parseEtf, parseCentralBanks, parseGdt, parsePremiums, wgcSeries, pickFiles } from "../worker/wgc.js";

const etf = [{ name: "Holdings by month", rows: [
  ["ticker", "All units in tonnes", null, null, null, "gld us equity", "x eu", "y asia"],
  ["Region", null, null, null, null, "North America", "Europe", "Asia"],
  ["Date", "Gold, US$/oz", "Ounces", "Tonnes", "Value (USD)", "SPDR", "Xetra", "Hua An"],
  [45688, 2800, 1, 100, 1, 60, 30, ""],
  [45716, 2850, 1, 110, 1, 65, 30, 15],
  [], [null, "Column : fund_total_assets_tonnes"],
] }, { name: "Demand by month", rows: [
  ["Region", null, null, null, null, "North America", "Europe", "Asia"],
  ["Date", "Gold, US$/oz", "Ounces", "Tonnes", "Value (USD)", "SPDR", "Xetra", "Hua An"],
  [45716, 2850, 1, 110, 1, 5, 0, 5],
] }];
const cb = [{ name: "Monthly", rows: [
  [null, null, "Year =>", 2025, 2025],
  ["Country Lookup Column", "Country", "Comments", 45688, 45716],
  ["China", "China, P.R.: Mainland", null, 5, 3],
  ["Poland", "Poland, Rep. of", null, 10, ""],
  ["Turkey", "Turkey*", "zweite Fassung", 99, 99],
  ["Turkey", "Turkey", null, -2, 4],
] }];
const gdt = [{ name: "Gold Balance", rows: [
  [null, null, 2024, 2025, "Year-on-year % change", null, null, "Q1'25", "Q2'25"],
  [null, "Total Supply", 4900, 5000, 1, null, "Total Supply", 1200, 1250],
  [null, "   Central Bank and Other Institutions", 1080, 850, -21, "▼", "   Central Bank and Other Institutions", 240, 180],
] }];
const prem = [{ name: "Chinese premiums-discounts", rows: [["Gold market premium/discount"], [], ["Chinese Premium/Discount (US$/oz)", null], ["2003-04-25", 0.46], ["2003-04-28", -0.28]] },
  { name: "Indian premiums-discounts", rows: [[null], [45658, 5.5]] }];

test("ETF: Bestand und Zufluss weltweit und je Region", () => {
  const e = parseEtf(etf);
  // insgesamt = Summe der Fonds (Spalte D wird nicht verwendet)
  assert.deepEqual(e.t.total, [["2025-01", 90], ["2025-02", 110]]);
  assert.deepEqual(e.t.na, [["2025-01", 60], ["2025-02", 65]]);
  assert.deepEqual(e.t.asia, [["2025-02", 15]]);
  assert.deepEqual(e.flow.total, [["2025-02", 10]]);
});

test("Zentralbanken: Summe aller Länder ohne zweite Fassung, ausgewählte Käufer", () => {
  const c = parseCentralBanks(cb);
  assert.deepEqual(c.world, [["2025-01", 13], ["2025-02", 7]]);
  assert.deepEqual(c.cn, [["2025-01", 5], ["2025-02", 3]]);
  assert.deepEqual(c.pl, [["2025-01", 10]]);
});

test("Gold Demand Trends: Quartale aus dem rechten Tabellenteil", () => {
  const g = parseGdt(gdt);
  assert.deepEqual(g.supply, [["2025-Q1", 1200], ["2025-Q2", 1250]]);
  assert.deepEqual(g.cb, [["2025-Q1", 240], ["2025-Q2", 180]]);
});

test("Preisaufschläge: Datum als Text oder Excel-Zahl", () => {
  const p = parsePremiums(prem);
  assert.deepEqual(p.cn, [["2003-04-25", 0.46], ["2003-04-28", -0.28]]);
  assert.deepEqual(p.in, [["2025-01-01", 5.5]]);
});

test("Reihen und Dateiauswahl (neueste Datei je Art)", () => {
  const s = wgcSeries({ etf, cb, gdt, prem });
  assert.equal(s.wgc_etf_t.f, "M");
  assert.equal(s.wgc_cb_world.src, "wgc");
  assert.equal(s.wgc_q_cb.f, "Q");
  assert.equal(s.wgc_prem_cn.f, "D");
  const f = pickFiles([
    { key: "eingang/wgc/ETF_Flows_2026-09-01.xlsx", uploaded: "2026-09-02" },
    { key: "eingang/wgc/ETF_Flows_2026-10-02_1401.xlsx", uploaded: "2026-10-19" },
    { key: "eingang/wgc/GDT_Tables_Q2'26_EN.xlsx", uploaded: "2026-10-19" },
    { key: "eingang/wgc/Production_costs_methodology.pdf", uploaded: "2026-10-19" },
  ]);
  assert.equal(f.etf.key, "eingang/wgc/ETF_Flows_2026-10-02_1401.xlsx");
  assert.ok(f.gdt && !f.cb && !f.prem);
});
