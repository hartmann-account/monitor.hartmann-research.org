/* Minimaler XLSX-Leser (Office Open XML): Blattnamen und Zellwerte. Text aus der Tabelle der gemeinsamen Zeichenketten,
   Zahlen als Zahl (Datumswerte bleiben Excel-Tageszahlen, siehe excelDate), Formeln mit ihrem gespeicherten Ergebnis.
   Läuft im Worker und in Node. */
import { unzip } from "./zip.js";

const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const texts = xml => unesc([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(""));

/* Spaltenbuchstaben → Index ab 0 (A → 0, Z → 25, AA → 26) */
export function colIndex(letters) {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

/* Excel-Tageszahl (1900er System) → ISO-Datum */
export const excelDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 864e5)).toISOString().slice(0, 10);

/* Arbeitsmappe lesen: [{ name, rows: [[wert, …], …], total }]; fehlende Zellen sind null, total = Zeilen des Blatts
   (auch wenn maxRows nur den Anfang liest) */
export async function readXlsx(u8, { maxRows = Infinity } = {}) {
  const files = await unzip(u8, { only: n => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n) });
  const shared = [...(files["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rels = {};
  for (const m of (files["xl/_rels/workbook.xml.rels"] || "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]), t = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && t) rels[id[1]] = t[1].startsWith("/") ? t[1].slice(1) : "xl/" + t[1].replace(/^\.\//, "");
  }
  const sheets = [];
  for (const m of (files["xl/workbook.xml"] || "").matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0]), rid = /\br:id="([^"]+)"/.exec(m[0]);
    const xml = rid && files[rels[rid[1]]];
    if (name && xml != null) sheets.push({ name: unesc(name[1]), rows: parseSheet(xml, shared, maxRows), total: lastRow(xml) });
  }
  return sheets;
}

// Nummer der letzten Zeile (aus dem letzten <row r="…">), ohne das ganze Blatt zu lesen
function lastRow(xml) {
  const i = xml.lastIndexOf("<row ");
  const m = i >= 0 ? /\br="(\d+)"/.exec(xml.slice(i, i + 300)) : null;
  return m ? +m[1] : 0;
}

function parseSheet(xml, shared, maxRows) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rn = /\br="(\d+)"/.exec(rm[1]);
    const r = rn ? +rn[1] - 1 : rows.length;
    if (r >= maxRows) break;
    const row = [];
    for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], body = cm[2] || "";
      const ref = /\br="([A-Z]+)\d+"/.exec(a), t = (/\bt="([^"]+)"/.exec(a) || [])[1], v = /<v>([\s\S]*?)<\/v>/.exec(body);
      let val = null;
      if (t === "s") val = v ? shared[+v[1]] ?? null : null;
      else if (t === "inlineStr") val = texts(body);
      else if (t === "str" || t === "e") val = v ? unesc(v[1]) : null;
      else if (t === "b") val = v ? v[1] === "1" : null;
      else if (v) val = Number(v[1]);
      row[ref ? colIndex(ref[1]) : row.length] = val;
    }
    rows[r] = Array.from(row, x => (x === undefined ? null : x));
  }
  return Array.from(rows, x => x || []);
}
