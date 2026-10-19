/* XLSX-Leser und Vorschau des Eingangs an einer selbst gebauten Arbeitsmappe */
import test from "node:test";
import assert from "node:assert/strict";
import { readXlsx, colIndex, excelDate } from "../worker/lib/xlsx.js";
import { previewFile, previewKey } from "../worker/inbox.js";

/* ZIP ohne Kompression (der Leser prüft keine Prüfsummen) */
function zipStored(files) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), d = enc.encode(text);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, d);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    dir.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + d.length;
  }
  const size = dir.reduce((a, x) => a + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true);
  e.setUint32(12, size, true); e.setUint32(16, off, true);
  const all = [...parts, ...dir, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
  let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}

const book = zipStored({
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="ETF &amp; Flows" sheetId="1" r:id="rId1"/><sheet name="Leer" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Datum</t></si><si><r><t>Bestand </t></r><r><t>(t)</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
    <row r="3"><c r="A3"><v>45658</v></c><c r="C3"><v>3215.5</v></c><c r="D3" t="inlineStr"><is><t>a&lt;b</t></is></c></row>
    <row r="4"><c r="A4"><v>45689</v></c><c r="C4" t="str"><f>C3+1</f><v>3216.5</v></c><c r="AB4" t="b"><v>1</v></c></row>
  </sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
});

test("XLSX: Blätter, gemeinsame Zeichenketten, Zellbezüge, Formelwerte", async () => {
  const s = await readXlsx(book);
  assert.deepEqual(s.map(x => x.name), ["ETF & Flows", "Leer"]);
  const r = s[0].rows;
  assert.deepEqual(r[0], ["Datum", null, "Bestand (t)"]);
  assert.deepEqual(r[1], []);
  assert.deepEqual(r[2], [45658, null, 3215.5, "a<b"]);
  assert.equal(r[3][2], "3216.5");
  assert.equal(r[3][27], true);
  assert.equal(excelDate(r[2][0]), "2025-01-01");
  assert.equal(colIndex("A"), 0);
  assert.equal(colIndex("AB"), 27);
  assert.deepEqual(s[1].rows, []);
});

test("Vorschau: Excel je Blatt, CSV zeilenweise, andere Formate nur benannt", async () => {
  const p = await previewFile("eingang/wgc/etf.xlsx", book);
  assert.equal(p.art, "xlsx");
  assert.equal(p.blaetter[0].zeilen, 4);
  assert.equal(p.blaetter[0].spalten, 28);
  assert.equal(p.blaetter[0].anfang[2][2], 3215.5);
  const c = await previewFile("eingang/x/a.csv", new TextEncoder().encode("a,b\n1,2\n"));
  assert.deepEqual(c.anfang.slice(0, 2), ["a,b", "1,2"]);
  assert.equal((await previewFile("eingang/x/a.pdf", new Uint8Array(3))).art, "unbekannt");
  assert.equal(previewKey("eingang/wgc/GDT_Tables_Q2'26_EN.xlsx"), "eingang/_vorschau/wgc/GDT_Tables_Q2_26_EN.xlsx.json");
});
