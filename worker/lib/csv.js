/* Schlanker CSV-Parser (Kommas oder Semikolons, Anführungszeichen, keine Zeilenumbrüche in Feldern). */

export function splitLine(line, sep = ",") {
  if (line.indexOf('"') < 0) return line.split(sep);
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* Liefert { header: [...], rows: [[...], ...] }; leere Zeilen entfallen. */
export function parseCsv(text, sep = ",") {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitLine(lines[0], sep).map(h => h.trim());
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) rows[i - 1] = splitLine(lines[i], sep);
  return { header, rows };
}

export function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === "." || t === "NaN" || t === "NA" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
