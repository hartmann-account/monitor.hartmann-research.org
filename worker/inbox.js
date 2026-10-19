/* Eingang im R2-Bucket (eingang/…): Dateien, die nicht über eine Schnittstelle kommen, sondern hochgeladen werden (etwa
   Excel-Dateien des World Gold Council unter eingang/wgc/). Der Eingang ist privat: /api/rohdaten liefert ihn nicht aus.
   Der Job eingang legt zu jeder neuen oder geänderten Datei eine Vorschau an (eingang/_vorschau/…json: Blätter, Größe,
   die ersten Zeilen und Spalten), die /api/rohdaten?vorschau= zeigt; daraus entstehen die Importe der einzelnen Quellen. */
import { readXlsx } from "./lib/xlsx.js";
import { putJson } from "./r2.js";

export const INBOX = "eingang/";
export const PREVIEW = "eingang/_vorschau/";
const HEAD_ROWS = 30, HEAD_COLS = 24;

/* Vorschau einer Datei: Excel je Blatt die ersten Zeilen und Spalten, CSV und Text die ersten Zeilen */
export async function previewFile(key, u8) {
  if (/\.xlsx$/i.test(key)) {
    const sheets = await readXlsx(u8);
    return {
      art: "xlsx",
      blaetter: sheets.map(s => ({ name: s.name, zeilen: s.rows.length, spalten: Math.max(0, ...s.rows.map(r => r.length)),
        anfang: s.rows.slice(0, HEAD_ROWS).map(r => r.slice(0, HEAD_COLS)) })),
    };
  }
  if (/\.(csv|txt|tsv)$/i.test(key)) {
    const lines = new TextDecoder().decode(u8.subarray(0, 200000)).split(/\r?\n/);
    return { art: "text", anfang: lines.slice(0, HEAD_ROWS) };
  }
  return { art: "unbekannt", hinweis: "Format wird nicht ausgewertet (Excel .xlsx, CSV und Text werden gelesen)" };
}

export const INBOX_JOBS = [{
  id: "eingang", label: "Eingang im R2-Bucket (eingang/): Vorschau neu hochgeladener Dateien", source: "r2", every: 1, cost: 0,
  requires: ["ARCHIVE"], noArchive: true, noRaw: true,
  async run(F, ctx) {
    const b = ctx.env.ARCHIVE;
    const seen = (await ctx.state.get("eingang")) || {};
    const files = [];
    let cursor;
    do {
      const r = await b.list({ prefix: INBOX, limit: 1000, cursor });
      files.push(...r.objects.filter(o => !o.key.startsWith(PREVIEW)));
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    const items = [];
    for (const o of files) {
      if (seen[o.key] === o.etag) { items.push({ key: o.key, size: o.size, neu: false }); continue; }
      const obj = await b.get(o.key);
      if (!obj) continue;
      let p;
      try {
        p = await previewFile(o.key, new Uint8Array(await obj.arrayBuffer()));
      } catch (e) {
        p = { art: "fehler", fehler: String((e && e.message) || e).slice(0, 300) };
      }
      await putJson(b, PREVIEW + o.key.slice(INBOX.length) + ".json", { datei: o.key, groesse: o.size, hochgeladen: o.uploaded, ...p });
      seen[o.key] = o.etag;
      items.push({ key: o.key, size: o.size, neu: true, art: p.art });
    }
    // gelöschte Dateien vergessen; Zustand nur bei Änderungen schreiben
    let dirty = items.some(x => x.neu);
    for (const k of Object.keys(seen)) if (!files.some(o => o.key === k)) { delete seen[k]; dirty = true; }
    if (dirty) await ctx.state.put("eingang", seen);
    return { series: {}, items: [{ dateien: files.length, neu: items.filter(x => x.neu).length, liste: items }] };
  },
}];
