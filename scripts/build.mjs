#!/usr/bin/env node
/* Baut die Seite aus src/ zusammen:
     public/index.html   HTML-Dokument
     public/app.css      Stile (mit selbst gehosteten Schriften, keine Anfragen an Google)
     public/app.js       alle Skripte in fester Reihenfolge (ohne Bundler, ohne Bibliotheken)
   Aufruf: node scripts/build.mjs  (läuft auch automatisch vor jedem "wrangler deploy") */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = f => readFileSync(join(root, "src", f), "utf8");
const JS = ["charts.js", "info.js", "model.js", "markers.js", "signals.js", "app-core.js", "app-sections.js", "app-live.js", "app-geo.js", "app-demo.js", "app-boot.js"];

const fonts = `@font-face { font-family: "Archivo"; font-style: normal; font-display: swap; font-weight: 100 900; font-stretch: 62% 125%;
  src: url(fonts/archivo-latin-wdth-normal.woff2) format("woff2-variations"), url(fonts/archivo-latin-wdth-normal.woff2) format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Archivo"; font-style: normal; font-display: swap; font-weight: 100 900; font-stretch: 62% 125%;
  src: url(fonts/archivo-latin-ext-wdth-normal.woff2) format("woff2-variations"), url(fonts/archivo-latin-ext-wdth-normal.woff2) format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-display: swap; font-weight: 400; src: url(fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-display: swap; font-weight: 500; src: url(fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2"); }
`;

const css = fonts + src("style.css");
const js = JS.map(f => `/* ---- ${f} ---- */\n` + src(f)).join("\n");
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 10);
const body = src("body.html");

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Big-Cycle-Monitor</title>
<meta name="description" content="Weltwirtschaft im Zyklus: Anlagebarometer, Konjunktur, Schulden- und Machtzyklus, Geopolitik, Demografie und Technologie der großen Volkswirtschaften. Offene Daten, täglich aktualisiert.">
<meta name="theme-color" content="#eff2ee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0c110f" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="Big-Cycle-Monitor">
<meta property="og:description" content="Weltwirtschaft im Zyklus: Anlagebarometer, Konjunktur, Geopolitik, Demografie und Technologie mit offenen Daten.">
<meta property="og:type" content="website">
<meta name="live-api" content="/api/snapshot">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="preload" href="fonts/archivo-latin-wdth-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="app.css?v=${hash(css)}">
</head>
<body>
${body}
<script src="app.js?v=${hash(js)}"></script>
</body>
</html>
`;

mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "app.css"), css);
writeFileSync(join(root, "public", "app.js"), js);
writeFileSync(join(root, "public", "index.html"), html);
console.log(`gebaut: public/index.html, app.css (${(css.length / 1024).toFixed(0)} KB), app.js (${(js.length / 1024).toFixed(0)} KB)`);
