/* Rohdatenarchiv in R2 (Bucket "monitor", Bindung ARCHIVE). D1 hält die Reihen, die Seite und Backtest abfragen; R2 hält
   die Rohdaten so, wie sie geladen wurden, nach Quellen geordnet:

   uebersicht.json                                         Aufbau des Buckets und letzter Stand je Bereich
   quellen/<quelle>/<job>/<jahr>/<datum>.json.gz           Rohausgabe jedes eigenen Abrufjobs (fred, ecb, snb, oecd, bis,
                                                           imf, wb, …), je Tag der letzte Stand: eigene Datenstände
   dbnomics/<anbieter>/<datensatz>/datensatz.json          Metadaten des Datensatzes (Dimensionen mit Bezeichnungen,
                                                           Filter, Umfang und Stand des letzten Imports, alle Stände)
   dbnomics/<anbieter>/<datensatz>/<stand>/<reihe>.json.gz Antworten der DBnomics-Schnittstelle unverändert, je Seite eine
                                                           Datei (<stand>: Indexierungsdatum bei DBnomics, <reihe>: Nummer
                                                           der ersten Reihe der Seite); frühere Stände bleiben erhalten
   echtzeit/<quelle>/…                                     Echtzeit-Datenstände (OECD-Frühindikatoren, ALFRED)

   Schlüssel nur aus Buchstaben, Ziffern und . _ @ - (andere Zeichen werden zu _), Dateien JSON, gzip-komprimiert. */

export const LAYOUT = {
  "uebersicht.json": "Aufbau des Buckets und letzter Stand je Bereich",
  "quellen/<quelle>/<job>/<jahr>/<datum>.json.gz": "Rohausgabe jedes eigenen Abrufjobs, je Tag der letzte Stand",
  "dbnomics/<anbieter>/<datensatz>/datensatz.json": "Metadaten eines DBnomics-Datensatzes, Umfang und Stände der Importe",
  "dbnomics/<anbieter>/<datensatz>/<stand>/<reihe>.json.gz": "Antworten der DBnomics-Schnittstelle je Seite, Stand = Indexierungsdatum",
  "echtzeit/<quelle>/...": "Echtzeit-Datenstände (OECD-Frühindikatoren, ALFRED)",
};

export const safeKey = s => String(s).replace(/[^A-Za-z0-9._@-]+/g, "_");

/* Text gzip-komprimiert ablegen; Fehler werden zurückgegeben statt geworfen (das Rohdatenarchiv darf keinen Abruf stören) */
export async function putTextGz(bucket, key, text, meta = {}) {
  if (!bucket) return false;
  try {
    const body = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    await bucket.put(key, body, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: meta });
    return true;
  } catch (e) {
    console.error("R2", key, e);
    return false;
  }
}
export const putJsonGz = (bucket, key, obj, meta = {}) => putTextGz(bucket, key, JSON.stringify(obj), meta);
export async function putJson(bucket, key, obj, meta = {}) {
  if (!bucket) return false;
  try {
    await bucket.put(key, JSON.stringify(obj, null, 1), { httpMetadata: { contentType: "application/json" }, customMetadata: meta });
    return true;
  } catch (e) {
    console.error("R2", key, e);
    return false;
  }
}
export async function getJson(bucket, key) {
  if (!bucket) return null;
  const o = await bucket.get(key);
  if (!o) return null;
  const enc = o.httpMetadata && o.httpMetadata.contentEncoding;
  const stream = enc === "gzip" ? o.body.pipeThrough(new DecompressionStream("gzip")) : o.body;
  return new Response(stream).json();
}

/* Rohausgabe eines Abrufjobs: quellen/<quelle>/<job>/<jahr>/<datum>.json.gz */
export function sourceKey(job, nowIso) {
  const day = nowIso.slice(0, 10);
  return `quellen/${safeKey(job.source || "eigen")}/${safeKey(job.id)}/${day.slice(0, 4)}/${day}.json.gz`;
}

/* DBnomics: Metadaten und Seiten eines Datensatzes */
export const dbnPrefix = (p, d) => `dbnomics/${safeKey(p)}/${safeKey(d)}`;
export const dbnMetaKey = (p, d) => `${dbnPrefix(p, d)}/datensatz.json`;
export const dbnPageKey = (p, d, stand, offset) => `${dbnPrefix(p, d)}/${safeKey(stand)}/${String(offset).padStart(7, "0")}.json.gz`;

/* Übersicht im Wurzelverzeichnis: Aufbau und letzter Stand je Bereich (part: z. B. { dbnomics: {...} }) */
export async function updateOverview(bucket, part, nowIso) {
  if (!bucket) return;
  const cur = (await getJson(bucket, "uebersicht.json").catch(() => null)) || {};
  await putJson(bucket, "uebersicht.json", { ...cur, ...part, aufbau: LAYOUT, stand: nowIso });
}
