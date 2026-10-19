# Big-Cycle-Monitor

Interaktive Übersicht der Weltwirtschaft entlang der großen Zyklen nach Ray Dalio: Schuldenzyklus, innere Ordnung, äußere Ordnung (Machtverschiebung), Natur sowie Technologie und Demografie. Im Blick sind nur die großen Akteure: USA, China, Eurozone mit Deutschland, Japan, Großbritannien, Indien, Russland und die Schweiz. So werden Dynamiken und Spannungen zwischen ihnen sichtbar.

Ziel-Adresse: **https://monitor.hartmann-research.org**. Bis die Domain eingerichtet ist (siehe [Einrichtung, Schritt 6](#6-domain-monitorhartmann-researchorg)), läuft die Seite unter **https://monitor.hartmann-it.workers.dev**.

Jede berechnete Größe trägt ein ⓘ. Ein Klick öffnet ein kleines Fenster mit dem Rechenweg und, wo möglich, der aktuellen Rechnung mit Zahlen. Auf dem Telefon erscheint es als Blatt vom unteren Rand.

## Was die Seite zeigt

| Kapitel | Inhalt | Aktualisierung |
|---|---|---|
| Lagebild | Kennzahlen, „Was steigt, was fällt?“, Kurzurteil | täglich |
| Anlagebarometer | Signale für 43 Anlagen (Anlageklassen, Aktienregionen, Staatsanleihen, Unternehmensanleihen, Währungen, Rohstoffe, relative Stärke) im Stil der Monatsübersicht von Pictet Asset Management, für drei wählbare Horizonte (1 Monat, 12 Monate, 5–10 Jahre) mit jeweils eigenen Säulen; dazu Indikatoren für die Risikoausrichtung, ein Kurzüberblick und der Signalverlauf über 24 Monate | täglich |
| Gold | Eigene Monatsübersicht: Gold in US-Dollar, Franken und Euro, Silber, Gold gegenüber Aktien und Anleihen, Kennzahlen (Abstand zum Höchststand, realer Preis seit 1971, Gold-Silber-Verhältnis) und die Treiber des Goldsignals je Horizont | täglich |
| Treffsicherheit | Backtest des Barometers seit 1970 je Horizont: Trefferquote der Richtung mit 95-%-Intervall, Vergleich mit „steigt immer“, Rangkorrelation, Teilperioden, Prüfung ohne Vorgriff, Güte der Wahrscheinlichkeiten, Echtzeit-Bilanz; je Anlage die Wahrscheinlichkeit steigender Kurse | wöchentlich |
| Konjunktur und Märkte | Konjunkturuhr (OECD-Frühindikatoren), Inflation, Arbeitslosigkeit, Wachstum, Märkte, Risikokacheln | täglich bis monatlich |
| Schuldenzyklus | Staatsschulden mit IWF-Projektionen, reale Leitzinsen, Währungen in Gold, Reservewährungsanteile, Zentralbankbilanzen; lange Historien der USA | täglich bzw. wöchentlich |
| Machtindex | Acht Machtfaktoren nach Dalio seit 1500 | wöchentlich |
| Geopolitik | Spannungsmonitor der großen Mächte (GDELT), Prognosemärkte, wirtschafts- und handelspolitische Unsicherheit, geopolitischer Risikoindex | alle 30 Minuten bis monatlich |
| Innere Ordnung | Ungleichheit, Polarisierung, Vertrauen | wöchentlich |
| Demografie und Technologie | Kernaussagen des Berichts „Demographics and Technology“ des Pictet Research Institute (Oktober 2025) mit aktuellen Daten: Erwerbsbevölkerung, Altersquotient, Wachstumsbilanz, F&E, Produktivität, Produktivitäts-J-Kurve | wöchentlich |
| Natur | Globale Temperatur, aktuelle Naturgefahren | täglich |
| Datenstatus | Stand und Fehler jedes Abrufjobs, Umfang des Datenarchivs (D1) mit CSV-Download jeder Reihe | live |

## Architektur

```
Cloudflare-Cron (alle 10 Min.)
   └─► Worker scheduled() ─► Batch-Runner: fällige Jobs, höchstens 8 je Lauf, Budget 80 Subrequests
          │                     offizielle Quellen: FRED, EZB, SNB, BIZ, IWF, OECD, Weltbank, …
          ├─► KV  job:<id>      letzte gute Ausgabe je Job
          ├─► KV  state:<k>     Arbeitszustand (GDELT-Tageswerte)
          ├─► KV  meta:v2       Status, Fehler, Backoff je Job
          ├─► KV  snapshot:v2   alle Ausgaben, als Zeichenkette zusammengesetzt
          ├─► D1  obs, series   Datenarchiv: jede abgerufene Beobachtung (Reihe, Datum, Wert), wächst mit jedem Abruf
          ├─► D1  events        archivierte GDACS-Meldungen
          ├─► D1  signal_hist   Einstufung jeder Anlage je Tag und Horizont (Signalverlauf, Job signal_history)
          └─► D1  bt_panel,     Backtest seit 1970: Einstufung und spätere Rendite je Anlage und Monatsende,
                  bt_stats      Kennzahlen je Horizont (Jobs backtest_m1, backtest_y1, backtest_lt, wöchentlich)

Browser ─► GET /api/snapshot ─► Edge-Cache (5 Min.) ─► KV snapshot:v2
                                   Rückfall: statischer Startbestand public/data/live.json
Browser ─► GET /data/bigcycle.json   lange Historien (wöchentlich über GitHub Actions)
```

- **Ein Worker** liefert die statische Seite (`public/`), die API (`/api/*`) und führt die Abrufe aus. Der Browser ruft nie eine fremde Quelle direkt auf.
- **Jobs** (`worker/jobs*.js`) haben einen Takt (`every`) und ein Subrequest-Budget (`cost`). Ein Lauf nimmt die fälligen Jobs in der Reihenfolge ihrer Überfälligkeit, höchstens acht. Nach einem vollen Umlauf (rund eine Stunde) sind alle 54 Jobs geladen; rechenintensive Jobs (Backtests, `solo`) laufen allein in einem Cron-Lauf.
- **Letzter guter Stand:** Schlägt ein Abruf fehl, bleibt die alte Ausgabe stehen. Der Job wartet dann 1, 2, 4, 8, 12 bzw. 24 Stunden bis zum nächsten Versuch (wie bei World Monitor).
- **Historien wachsen mit:** Viele Jobs laden nur die letzten Wochen nach und hängen sie an die gespeicherte Reihe an (`keep: true`). Tageswerte, die älter als 800 Tage sind, werden auf Wochenwerte ausgedünnt.
- **GDELT:** Alle 30 Minuten verarbeitet der Worker die neuesten 15-Minuten-Dateien der GDELT-Ereignisdatenbank und führt Tagessummen je Länderpaar für 150 Tage (Startbestand: `public/data/gdelt-state.json`).
- **Datenarchiv (D1):** Jede Ausgabe eines Abrufjobs schreibt der Runner zusätzlich in die D1-Datenbank `monitor-signals` (Tabelle `obs`: Reihe, Datum, Wert; Tabelle `series`: Bezeichnung, Einheit, Quelle, Zeitraum, Anzahl). Neue Tage werden ergänzt, bekannte nur bei geändertem Wert überschrieben (Revisionen). Beim ersten Archivlauf eines Jobs lädt der Worker die ganze Historie der Quelle (Feld `deep` am Job: FRED seit den 1950er-Jahren, EZB seit 1999, Bundesbank seit 1972, BIZ, OECD seit 1990 usw.) und archiviert sie vollständig; der Snapshot für die Seite behält den bisherigen Zeitraum. Jobs, deren Daten noch nicht archiviert sind, zieht der Runner vor (höchstens vier je Lauf), sodass das Archiv nach dem ersten Deploy innerhalb von rund zwei Stunden vollständig ist. So gehört die Historie dem Monitor, auch wenn eine Quelle ältere Werte nicht mehr anbietet (etwa die ICE-BofA-Risikoprämien auf FRED nach drei Jahren). Der Job `archive_hist` übernimmt wöchentlich die Langfristreihen aus `bigcycle.json` (Präfix `h_`, teils seit dem 13. Jahrhundert), Prognosemärkte werden als Tagesreihen `pm_…` gespeichert, GDACS-Meldungen in `events`.
- **Signalverlauf (D1):** Alle sechs Stunden rechnet der Worker das Anlagebarometer mit demselben Modell wie die Seite (`src/signals.js`) für alle drei Horizonte und speichert den Stand des Tages samt Säulenwerten in der Tabelle `signal_hist`. Für Anlagen ohne Vorgeschichte rechnet er 24 Monatsenden zurück, und zwar nur mit Daten, die damals veröffentlicht gewesen wären. Gespeicherte Tageswerte ändern sich danach nicht mehr, so entsteht eine echte Historie der Signale. Ändert sich das Modell (`SIG.cfg.version`), wird nur die Rückrechnung neu erstellt.
- **Backtest (D1):** Einmal pro Woche und nach jeder Modelländerung rechnen drei Jobs (je Horizont einer, jeweils allein in einem Cron-Lauf, rund 10–15 s Rechenzeit) das Barometer zu jedem Monatsende seit 1970 mit der Historie aus dem Archiv durch, vergleichen mit der tatsächlichen Kursentwicklung und speichern Einzelwerte (`bt_panel`) und Kennzahlen (`bt_stats`). Die Zusammenfassung landet im Snapshot; die Seite zeigt daraus die Treffsicherheit und die Wahrscheinlichkeit steigender Kurse je Anlage. Rechnung in `worker/backtest.js`, lokal mit `node scripts/backtest.mjs --local`.
- **Wöchentliche Pipeline** (`pipeline/build_data.py`, GitHub Actions montags 05:17 UTC): baut die langen Historien (Machtindex seit 1500, US-Schulden seit 1790, Shiller-Daten, geopolitischer Risikoindex usw.). Danach übernimmt sie den aktuellen Worker-Snapshot und die Backtest-Kennzahlen als neuen Startbestand.

```
worker/            Worker: index.js (Routen, Cron), runner.js (Batch-Runner), jobs*.js (Abrufjobs),
                   jobs-extra.js (Quellen mit langer Historie), backtest.js und jobs-backtest.js (Backtest),
                   archive.js (Datenarchiv), providers/ (Quellenadapter), lib/ (HTTP, CSV, ZIP, Reihenformat)
src/               Seite: body.html, style.css, charts.js, signals.js (Signalmodell), app-*.js
public/            ausgelieferte Dateien; index.html, app.css, app.js entstehen beim Build
public/data/       bigcycle.json (Historien), live.json (Startbestand), backtest.json (Kennzahlen, Rückfall), gdelt-state.json
pipeline/          wöchentliche Python-Pipeline für die langen Historien
scripts/           build.mjs, fetch_live.mjs, refresh_seed.mjs, gdelt_backfill.mjs, backtest.mjs
test/              Tests des Signalmodells (node --test)
```

## Einrichtung

### 1. Cloudflare-Plan

Nötig ist **Workers Paid** (5 USD im Monat; im Konto vorhanden). Die Abrufjobs parsen CSV- und JSON-Antworten und brauchen dafür je Job 20 bis 120 ms Rechenzeit. Der Free-Plan erlaubt pro Cron-Lauf nur 10 ms CPU und 1.000 KV-Schreibvorgänge am Tag. Paid erlaubt 30 Sekunden CPU je Lauf, und KV-Schreibvorgänge sind nicht begrenzt.

### 2. Repository mit Cloudflare verbinden (Workers Builds)

1. Cloudflare-Dashboard → **Workers & Pages** → **Erstellen** → **Repository importieren**.
2. GitHub verbinden und `hartmann-account/monitor.hartmann-research.org` wählen.
3. Projektname: **`monitor`**, wie der `name` in `wrangler.jsonc`.
4. Build-Befehl leer lassen; Deploy-Befehl `npx wrangler deploy`; Produktionszweig `main`.

Danach wird jeder Push auf `main` automatisch veröffentlicht. `wrangler deploy` baut die Seite vorher selbst (`node scripts/build.mjs`, eingetragen unter `build.command`).

Alternativ geht es lokal: `npx wrangler login` und danach `npm run deploy`.

### 3. Speicher und Cron

Hier ist nichts zu tun. Den KV-Namespace für das Binding `DATA` und die D1-Datenbank `monitor-signals` für das Binding `DB` legt Wrangler beim Deploy automatisch an (ab Wrangler 4.45). Die Tabellen erzeugt der Worker selbst; die Tabelle `signals` der ersten Version übernimmt er einmalig in `signal_hist`. Der Cron-Trigger `*/10 * * * *` steht in `wrangler.jsonc`, ebenso eine CPU-Grenze von 60 Sekunden je Lauf als Reserve für den ersten Archivlauf.

Umfang: Der erste Archivlauf schreibt rund 600.000 Beobachtungen (einige Megabyte), danach kommen täglich einige Tausend hinzu. Das liegt weit innerhalb der Kontingente von Workers Paid (D1: 10 GB je Datenbank, 50 Mio. geschriebene Zeilen im Monat inklusive).

### 4. Optionale Secrets und Variablen

Im Dashboard unter Worker → **Einstellungen** → **Variablen und Secrets**, oder mit `npx wrangler secret put <NAME>`:

| Name | Art | Zweck |
|---|---|---|
| `ADMIN_TOKEN` | Secret | Schaltet `POST /api/run` frei (Abruf sofort anstoßen) |
| `FRED_API_KEY` | Secret | FRED über die offizielle API statt über den CSV-Download; nicht nötig |
| `GDELT_FILES_PER_RUN` | Variable | GDELT-Dateien je Lauf (Standard 3) |
| `MAX_JOBS_PER_RUN`, `SUBREQUEST_BUDGET` | Variable | Jobs und Subrequests je Cron-Lauf (in `wrangler.jsonc`: 8 und 80) |

### 5. Erste Befüllung

Direkt nach dem ersten Deploy liefert `/api/snapshot` den Startbestand aus dem Repository (Header `x-snapshot-origin: seed`). Nach einem vollen Umlauf von rund 50 Minuten kommt alles aus dem KV (`x-snapshot-origin: kv`). Wer nicht warten will, stößt einzelne Jobs sofort an:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://monitor.hartmann-it.workers.dev/api/run?jobs=fred_markets,fred_rates,ecb_fx,six_ch"
```

### 6. Domain monitor.hartmann-research.org

Die Subdomain zeigt derzeit per CNAME auf All-Inkl. Ein eigener Worker-Domainname (Custom Domain) setzt voraus, dass die Zone `hartmann-research.org` bei Cloudflare verwaltet wird; dafür reicht der kostenlose Plan:

1. Cloudflare-Dashboard → **Domain hinzufügen** → `hartmann-research.org`. Cloudflare übernimmt die bestehenden DNS-Einträge. **Vor dem Umzug prüfen,** dass alle Einträge da sind, besonders MX, SPF/DKIM-TXT und `www`.
2. Beim Registrar bzw. im All-Inkl-KAS die Nameserver auf die beiden angezeigten Cloudflare-Nameserver umstellen und warten, bis die Zone aktiv ist.
3. Den alten CNAME `monitor` löschen. In `wrangler.jsonc` die Zeile mit `routes` einkommentieren und auf `main` pushen. Alternativ im Dashboard: Worker → **Einstellungen** → **Domains & Routen** → **Benutzerdefinierte Domain** `monitor.hartmann-research.org`. Das TLS-Zertifikat erstellt Cloudflare selbst.

Ohne Umzug der Zone bleibt nur die `workers.dev`-Adresse, gegebenenfalls mit einer Weiterleitung bei All-Inkl.

### 7. GitHub Actions für die wöchentlichen Historien

Der Workflow `Daten aktualisieren` bringt die nötigen Schreibrechte selbst mit (`permissions: contents: write`). Der erste Lauf am 19. Oktober 2026 hat seine Daten erfolgreich committet. Er lässt sich unter **Actions** jederzeit auch von Hand starten. Optional:

- Repository-Variable `LIVE_URL`, falls die Seite unter einer anderen Adresse als `https://monitor.hartmann-research.org/api/snapshot` läuft.
- Secret `FRED_API_KEY`.

Jeder dieser Commits löst über Workers Builds einen neuen Deploy aus.

## Lokal entwickeln

```bash
npm install
npm run dev                  # wrangler dev auf http://127.0.0.1:8787 (mit lokalem KV und lokaler D1)
curl "http://127.0.0.1:8787/__scheduled?cron=*/10+*+*+*+*"     # einen Cron-Lauf auslösen
npm test                     # Tests des Signalmodells
npm run build                # Seite neu bauen (public/index.html, app.css, app.js)
npm run fetch:live           # alle Jobs in Node ausführen und public/data/live.json schreiben
node scripts/backtest.mjs --local --out public/data/backtest.json   # Backtest auf der lokalen D1 (Bericht + Datei)
python3 -I pipeline/build_data.py --cache .cache --refresh       # lange Historien
```

Für `POST /api/run` lokal eine Datei `.dev.vars` mit `ADMIN_TOKEN=…` anlegen; sie wird nicht eingecheckt. Hinter einem Proxy braucht Node `NODE_USE_ENV_PROXY=1`. Die lokale D1 lässt sich mit `npx wrangler d1 execute monitor-signals --local --command "SELECT COUNT(*) FROM obs"` abfragen.

## API

| Endpunkt | Inhalt |
|---|---|
| `GET /api/snapshot` | alle Live-Reihen, Listen (Prognosemärkte, Naturgefahren) und der Status aller Jobs; 5 Minuten im Edge-Cache |
| `GET /api/status` | nur der Status der Jobs (Zeitpunkt, Fehler, jüngster Wert, Größe, Dauer) |
| `GET /api/signals` | Signalverlauf aus D1: Stichtage, Art (rückgerechnet oder gespeichert), Gesamtwert und Stufe je Anlage. `?h=m1` (1 Monat, Standard), `?h=y1` (12 Monate), `?h=lt` (5–10 Jahre); `?daily=365` alle Tageswerte der letzten 365 Tage statt nur der Monatsenden; `?pillars=1` mit Säulenwerten; `?format=csv` als CSV |
| `GET /api/archive` | Verzeichnis des Datenarchivs: alle Reihen mit Bezeichnung, Einheit, Frequenz, Quelle, erstem und letztem Datum und Anzahl der Werte, dazu Summen |
| `GET /api/series?id=y10_us,gold_usd` | Beobachtungen aus dem Archiv (höchstens 20 Reihen), `?from=1990&to=2000-12-31`, `?thin=w` nur der letzte Wert je Kalenderwoche, `?format=csv` als CSV |
| `GET /api/backtest` | Kennzahlen des Backtests aller Horizonte (Treffer, Intervalle, Rangkorrelation, Teilperioden, ohne Vorgriff, Kalibrierung, je Anlage); `?h=y1&id=eq_us` die Einzelwerte einer Anlage (Monatsende, Gesamtwert, Stufe, Rendite danach), auch `&format=csv` |
| `GET /api/events` | archivierte GDACS-Meldungen, `?from=2026-01-01` |
| `POST /api/run?jobs=a,b` | Jobs sofort ausführen (Header `Authorization: Bearer <ADMIN_TOKEN>`) |

Reihenformat im Snapshot: `{f: "D", s: "2014-01-02", d: [Tagesabstände], v: [Werte], l, u, src}` für Tageswerte. Monats-, Quartals- und Jahresreihen (`f: "M" | "Q" | "A"`) bestehen nur aus Startperiode und Werten.

## Datenquellen der täglichen Abrufe

Alle Quellen sind ohne Schlüssel und dauerhaft abrufbar. Fast alle sind amtliche Statistikschnittstellen von Zentralbanken, Ministerien und internationalen Organisationen. Ausnahmen sind die Kursabfrage der SIX-Website und die öffentliche Polymarket-API: Für beide gibt es keine Zusage, dass sie dauerhaft unverändert bleiben. Fällt die SIX aus, greift die SNB-Reihe.

| Job | Inhalt | Quelle | Takt |
|---|---|---|---|
| `fred_markets` | US-Aktien, Nikkei, Öl, Bitcoin, Dollarindex, Volatilität | FRED (Federal Reserve Bank of St. Louis) | 6 Std. |
| `fred_rates` | US-Renditen, Realzinsen, Inflationserwartung, Fed-Leitzins | FRED | 6 Std. |
| `fred_risk` | Kreditrisikoprämien, Finanzstress, Fed-Bilanz, Geldmenge, US-Preisindex | FRED | 12 Std. |
| `fred_longrates` | Langfristzinsen Schweiz, Indien, Japan, Großbritannien (Monatswerte) | FRED | 1 Tag |
| `ecb_fx` | Wechselkurse (EZB-Referenzkurse) und Zinskurve Euroraum | Europäische Zentralbank | 6 Std. |
| `ecb_misc` | EZB-Einlagesatz, Eurosystem-Bilanz, Stressindex CISS, Euro Stoxx 50, Geldmenge M3 | Europäische Zentralbank | 12 Std. |
| `bbk_bund` | Bundesanleihen 10 und 2 Jahre (tagesaktuell) | Deutsche Bundesbank | 8 Std. |
| `snb_daily` | Eidgenossen 10 Jahre, SARON und SNB-Leitzins (RSS, tagesaktuell) | Schweizerische Nationalbank | 6 Std. |
| `snb_monthly` | Schweizer Aktien (SMI, SPI) und SNB-Bilanz | Schweizerische Nationalbank | 1 Tag |
| `six_ch` | Schweizer Aktien tagesaktuell (SMI, SPI) | SIX Swiss Exchange | 6 Std. |
| `boe` | Gilts 10 Jahre und Bank Rate | Bank of England | 12 Std. |
| `mof_jgb`, `mof_jgb_hist` | Japanische Staatsanleihen 10 Jahre | Japanisches Finanzministerium | 12 Std. / 1 Woche |
| `bis_policy` | Leitzinsen von acht Zentralbanken | BIZ | 12 Std. |
| `bis_reer` | Reale effektive Wechselkurse (Bewertung der Währungen) | BIZ | 1 Tag |
| `imf_commodities` | Gold, Silber, Kupfer, Brent, Rohstoffindex (Monatsmittel) | IWF | 1 Tag |
| `nbp_gold` | Goldpreis täglich (in US-Dollar umgerechnet) | Narodowy Bank Polski | 6 Std. |
| `boj` | Tagesgeldsatz und Bilanzsumme | Bank of Japan | 1 Tag |
| `oecd_cli`, `oecd_prices`, `oecd_labour`, `oecd_gdp`, `oecd_finmark` | Frühindikatoren, Inflation, Arbeitslosigkeit, BIP, Aktienindizes und Langfristzinsen | OECD | 1–2 Tage |
| `imf_weo_1` bis `imf_weo_3` | Schulden, Wachstum, Inflation, Leistungsbilanz, BIP-Anteile, Finanzierungssaldo mit Projektionen | IWF World Economic Outlook (SDMX, Rückfall DataMapper) | 3 Tage |
| `imf_cofer` | Anteile an den Weltdevisenreserven | IWF COFER | 3 Tage |
| `imf_cpi_ru` | Inflation Russland und Iran | IWF | 3 Tage |
| `fred_uncertainty` | Economic Policy Uncertainty, World Uncertainty Index | FRED | 1 Tag |
| `wb_population`, `wb_ageing`, `wb_life`, `wb_tech`, `wb_digital` | Bevölkerung und Projektionen bis 2050, Altersquotient, Fertilität, Lebenserwartung, Militärausgaben, F&E, Patente, Hightech-Exporte, Internet, Produktivität | Weltbank | 1 Woche |
| `nasa_gistemp` | Globale Temperaturabweichung | NASA GISS | 2 Tage |
| `gdelt_tension` | Spannungsmonitor aus der GDELT-Ereignisdatenbank | GDELT Project | 30 Min. |
| `polymarket` | Prognosemärkte zu Konflikten, Rezession und Zinsen | Polymarket | 6 Std. |
| `gdacs` | Naturgefahren mit oranger oder roter Warnstufe | GDACS (EU/UN) | 6 Std. |
| `fred_fxhist` | Wechselkurse seit 1971 (Fed H.10), synthetischer Euro aus der D-Mark, Dollarindizes (nur Archiv) | FRED | 3 Tage |
| `fred_intl` | Aktienkurse, Langfrist- und Dreimonatszinsen von acht Ländern seit 1955 (OECD-Monatsstatistik, nur Archiv) | FRED | 3 Tage |
| `fred_credit` | Risikoprämien Moody's Baa/Aaa (seit 1919), Zinskurve 10 Jahre – 3 Monate, erwartete Inflation | FRED | 12 Std. |
| `fred_cycle` | US-Konjunktur: CFNAI, Erstanträge, Baugenehmigungen, Verbraucherstimmung, Sahm-Regel, Kreditstandards, Rezessionen | FRED | 1 Tag |
| `fred_z1` | Aktienanteil am Anlegervermögen USA: Marktwert der Aktien und Schulden der Realwirtschaft seit 1945, Aktienquote der Haushalte | Fed-Finanzierungsrechnung Z.1 über FRED | 3 Tage |
| `cboe` | VIX 3 Monate, SKEW, VVIX | Cboe | 12 Std. |
| `cftc_cot` | Netto-Positionierung der Spekulanten (und der kommerziellen Händler) in zwölf Terminmärkten seit 1986 | CFTC Commitments of Traders | 1 Tag |
| `fed_ebp` | Excess Bond Premium, Gilchrist-Zakrajšek-Spread, Rezessionswahrscheinlichkeit | Federal Reserve Board | 3 Tage |
| `ofr_fsi` | Finanzstressindex mit Teilindizes | Office of Financial Research | 12 Std. |
| `bis_credit` | Kreditlücke und Schuldendienstquote des Privatsektors (Frühwarnindikatoren) | BIZ | 1 Woche |
| `eurostat_esi` | Wirtschaftsstimmung Euroraum und Deutschland | Eurostat | 1 Tag |
| `signal_history` | Signalverlauf des Anlagebarometers, drei Horizonte (eigene Berechnung, D1) | – | 6 Std. |
| `backtest_m1`, `backtest_y1`, `backtest_lt` | Backtest des Barometers seit 1970 je Horizont (eigene Berechnung auf dem Archiv, D1) | – | 1 Woche |
| `archive_hist` | Langfristreihen des wöchentlichen Datensatzes ins Archiv (D1) | – | 1 Woche |

Die wöchentliche Pipeline nutzt zusätzlich Our World in Data, die Weltbank, den IWF (DataMapper, COFER), FRED, U.S. Treasury Fiscal Data und die Shiller-Daten (shillerdata.com). Hinzu kommen der Geopolitical Risk Index und der Trade Policy Uncertainty Index (Caldara, Iacoviello), die Jordà-Schularick-Taylor Macrohistory Database, Correlates of War, die Millennium-Daten der Bank of England, Voteview und die Nobelpreis-API. Die Quellenangaben stehen an jeder Grafik und in `public/data/bigcycle.json` unter `sources`.

## Anlagebarometer

Jede Anlage wird auf fünf Säulen von −2 bis +2 bewertet. Welche Säulen zählen, hängt vom gewählten Horizont ab:

**1 Monat (taktisch)**

- **Trend:** Momentum über 3, 6 und 12 Monate, risikobereinigt, plus Abstand zum 200-Tage-Schnitt.
- **Konjunktur:** OECD-Frühindikator der Region, Dynamik über drei Monate und Niveau; bei Aktien, Unternehmensanleihen und Rohstoffen zählt ein hohes Niveau antizyklisch (spätes Zyklusstadium).
- **Bewertung:**
  - Aktien: Aktienanteil am Anlegervermögen der USA (Fed Z.1, siehe unten), bei den übrigen Märkten zusammen mit dem Abstand zum 10-Jahres-Trend.
  - Anleihen: Realrendite und Steilheit der Zinskurve.
  - Unternehmensanleihen: Risikoaufschlag gegenüber seiner Historie, dazu die Baa-Prämie.
  - Währungen: realer effektiver Wechselkurs der BIZ.
  - Gold: Gold gegenüber Aktien über den Aktienanteil am Anlegervermögen.
- **Liquidität:** Leitzinsrichtung, Zinskurve, Zentralbankbilanz, Dollartrend.
- **Risiko und Geopolitik:** VIX, Risikoprämien, Finanzstress, Spannungsmonitor.

**12 Monate (zyklisch)**

- **Konjunktur:** Frühindikator wie oben und die IWF-Wachstumsprognose der nächsten zwölf Monate gegenüber den letzten zwölf Monaten (bei Anleihen auch die Inflationsprognose); für US- und Weltaktien zusätzlich die Baugenehmigungen.
- **Bewertung und Liquidität** wie oben, Bewertung mit dem höchsten Gewicht.
- **Momentum 12 Monate:** Rendite der letzten zwölf Monate ohne den jüngsten Monat, risikobereinigt (Zeitreihen-Momentum).
- **Stimmung & Risiko:** antizyklische Stimmungs- und Positionierungsdaten – Verbraucherstimmung (Michigan, EU-Kommission), Kreditlücke der BIZ, Positionierung der Spekulanten (CFTC), Excess Bond Premium der Fed; für Gold das geopolitische Risiko und die Positionierung im Goldfuture.

**5–10 Jahre (strukturell, großer Zyklus)**

- **Bewertung:** Aktien USA und Welt: Aktienanteil am Anlegervermögen, Shiller-KGV und Verbraucherstimmung; übrige Märkte: Abstand zum Trend über bis zu 20 Jahre, dazu der US-Wert als globale Bewertung und die Wirtschaftsstimmung. Anleihen: erwartete Realrendite (Rendite minus IWF-Inflationsprognose für fünf Jahre); Unternehmensanleihen: Risikoaufschlag, Baa-Prämie, Excess Bond Premium; Währungen: realer Wechselkurs gegenüber dem langjährigen Mittel; Gold: realer Preis seit 1971, Aktienanteil am Anlegervermögen und reale US-Rendite; Regionen-Paare: Rückkehr zur Mitte.
- **Wachstum und Demografie:** IWF-Wachstumsprognose für fünf Jahre, Erwerbsbevölkerung der nächsten zehn Jahre (Weltbank), Produktivität.
- **Schulden:** Schuldenquote, ihre Entwicklung laut IWF, Haushaltssaldo, Zins minus nominales Wachstum. Hohe Schulden belasten Anleihen und Währung und stützen Gold.
- **Machtposition:** Anteil an der Weltwirtschaft (Kaufkraftparitäten), Leistungsbilanz, bei Währungen der Anteil an den Weltdevisenreserven (COFER).
- **Langfristtrend:** Steigung des Zehnjahrestrends und Rendite über drei Jahre; bei Unternehmensanleihen, Rohstoffen und Regionen-Paaren antizyklisch.

**Aktienanteil am Anlegervermögen (Fed Z.1).** Marktwert aller US-Aktien ÷ (Aktien + Schulden von Haushalten, Unternehmen, Staat und Ausland), quartalsweise seit 1945, mit dem S&P 500 bis zum Stichtag fortgeschrieben. Wer Aktien hält, muss sie jemandem abgenommen haben: Ist der Anteil hoch, fehlen künftige Käufer. Im Backtest erklärt der Wert die 5-Jahres-Renditen von US-Aktien deutlich besser als das Shiller-KGV (Rangkorrelation 0,50 statt 0,29 seit 1960) und ging auch stärkeren Goldjahren voraus.

Rohwerte werden durch ihre typische Schwankung geteilt und weich begrenzt (2·tanh(z/2)). Die Gewichte hängen von Anlageart und Horizont ab (Tabellen auf der Seite unter „So entsteht das Signal“). Sie wurden anhand der Rückrechnungen seit 1970 gesetzt: Säulen ohne belegte Prognosekraft für einen Horizont erhalten wenig oder kein Gewicht (etwa die Schuldensäule bei Gold und Anleihen über 5–10 Jahre). Die Gesamtnote ergibt eine von fünf Stufen (−−, −, =, +, ++; Schwellen ±0,3 und ±0,9). IWF-Prognosen und Bevölkerungsprojektionen gibt es nur im jüngsten Stand; Vormonat und Rückrechnung verwenden ihn ebenfalls. Bitcoin hat keinen fundamentalen Bewertungsanker und bleibt im Horizont 5–10 Jahre ohne Einstufung.

**Gold** hat eine eigene Monatsübersicht: Gold in US-Dollar, Franken und Euro, Silber, Gold gegenüber Aktien (S&P 500) und Anleihen (10-jährige Treasuries), mit Kennzahlen und den Säulen des Goldsignals als Treiber. Gold in Franken und Euro nutzt für Trend und Momentum den Preis in der jeweiligen Währung, für die Bewertung den weltweit einheitlichen Dollarpreis.

Der Vormonat wird mit dem Datenstand von vor 30 Tagen berechnet. Monatsreihen zählen dabei erst nach ihrer üblichen Veröffentlichungsfrist. Ein Toleranzband von 0,1 verhindert, dass Werte nahe einer Schwelle jeden Monat die Stufe wechseln. Zeilen, deren jüngster Wert nicht tagesaktuell ist, tragen einen Hinweis „Stand …“.

Die Darstellung lehnt sich an die Monatsübersicht von Pictet Asset Management an: Balken auf einer Fünf-Stufen-Skala, Pfeil bei einer Änderung zum Vormonat, Indikatoren für die Risikoausrichtung. Der Monitor verwendet keine Daten oder Einschätzungen von Pictet. **Keine Anlageberatung.**

## Backtest und Treffsicherheit

**Vorgehen.** Zu jedem Monatsende seit Januar 1970 rechnet das unveränderte Modell (`src/signals.js`) alle Anlagen und Horizonte, und zwar nur mit Daten, die zum Stichtag veröffentlicht waren (übliche Fristen je Reihe: Monatswerte 15 Tage, Quartale 45 Tage, Kreditdaten der BIZ 100, Fed Z.1 80 Tage). Die Historie stammt aus dem D1-Archiv; lange Reihen werden aus mehreren Quellen verkettet (S&P 500 seit 1871 aus den Shiller-Daten, Wechselkurse seit 1971 aus der Fed-Statistik, Euro vor 1999 über die D-Mark, Aktien von acht Ländern seit 1955 aus der OECD-Statistik, Risikoprämien über die Baa-Prämie seit 1953). IWF- und Weltbank-Projektionen liegen nur im heutigen Stand vor und werden durch einfache Fortschreibungen ersetzt. Verglichen wird mit der Rendite der folgenden 1, 12 bzw. 60 Monate.

**Kennzahlen.**
- *Trefferquote der Richtung:* Anteil der Stufen „positiv/klar positiv“ mit steigendem und „negativ/klar negativ“ mit fallendem Kurs (neutral = keine Aussage), 95-%-Intervall nach Wilson auf der effektiven Stichprobe (überlappende Zeiträume zählen anteilig).
- *Mehrheitsregel:* dieselben Fälle, immer die häufigere Richtung getippt („steigt immer“) – der Maßstab, den das Modell schlagen muss.
- *Rangkorrelation (IC):* Spearman zwischen Gesamtwert und späterer, um die Schwankung bereinigter Rendite, mit 95-%-Intervall.
- *Teilperioden:* 1970–89, 1990–2007, ab 2008. Urteil „belegt“, wenn die Rangkorrelation mit 95 % Sicherheit über null und in jeder Teilperiode positiv ist.
- *Ohne Vorgriff:* Gewichte der Säulen Jahr für Jahr nur aus der bis dahin bekannten Geschichte geschätzt (ausgehend von gleichen Gewichten), ab 1990.
- *Wahrscheinlichkeiten:* logistische Regression P(Kurs steigt) = 1 ÷ (1 + e^−(a + b·Gesamtwert)) je Anlageart; Fälle mit 1 ÷ Horizont in Monaten gewichtet, damit wenige unabhängige 5-Jahres-Zeiträume keine übertriebenen Wahrscheinlichkeiten erzeugen. Geprüft mit dem Brier-Score ohne Vorgriff gegen die bloße Grundhäufigkeit.
- *Echtzeit-Bilanz:* die seit Oktober 2026 täglich gespeicherten Einstufungen (`signal_hist`), sobald ihr Horizont abgelaufen ist.

**Ergebnisse (Stand Oktober 2026, rund 25 000 Einstufungen je Horizont).**

| Horizont | Treffer | 95-%-Intervall | „steigt immer“ | Rangkorrelation | ohne Vorgriff | Brier-Skill |
|---|---|---|---|---|---|---|
| 1 Monat | 57,1 % | 56,3–57,9 % | 54,8 % | 0,13 | 0,10 | +0,6 % |
| 12 Monate | 63,4 % | 60,4–66,3 % | 58,7 % | 0,23 | 0,14 | +1,6 % |
| 5–10 Jahre (5-Jahres-Rendite) | 72,8 % | 66,9–78,0 % | 66,6 % | 0,41 | 0,34 | ±0 % |

Am stärksten sind die Signale für Unternehmensanleihen (12 Monate: Rangkorrelation 0,40; 5 Jahre: 0,63), Staatsanleihen und Gold; Aktien liegen auf 12 Monate bei 0,17 und auf 5 Jahre bei 0,38. Nach „klar positiv“ stiegen die Kurse auf 12 Monate in 76 % der Fälle, nach „klar negativ“ in 38 %. Die genauen, wöchentlich neu gerechneten Werte je Anlageart und Anlage stehen auf der Seite und unter `/api/backtest`.

**Was das heißt.** Das Modell trifft die Richtung häufiger als der Zufall und über alle Anlagen häufiger als „steigt immer“, aber nahezu sichere Prognosen sind an Märkten nicht möglich. Aktien steigen meistens; „negativ“ heißt bei ihnen „unterdurchschnittliche Aussichten“, deshalb liegt ihre Trefferquote der Richtung auf 12 Monate unter der Mehrheitsregel, obwohl die Rangkorrelation positiv ist. Aussagekräftiger ist die Wahrscheinlichkeit steigender Kurse, die jede Zeile des Barometers zeigt.

**Selbstoptimierung mit Bedacht.** Jährlich aus den Daten neu geschätzte Gewichte schnitten im Backtest schlechter ab als feste, begründete Gewichte (bekannt als Rätsel der Prognosekombination). Das Modell hält deshalb die Gewichte fest und kalibriert stattdessen jede Woche Trefferquoten und Wahrscheinlichkeiten mit der wachsenden Historie in D1 neu.

**Grenzen des Backtests.** Die Bausteine wurden mit Kenntnis dieser Geschichte ausgewählt (Rückschaufehler); die Spalte „ohne Vorgriff“ ist die strengere Prüfung, die Echtzeit-Bilanz die eigentliche. Frühindikatoren und Konjunkturdaten liegen nur im heutigen, revidierten Stand vor. Vor 1990 beruhen manche Reihen auf Monatsmitteln. Beim Horizont 5–10 Jahre gibt es seit 1970 nur wenige unabhängige Zeiträume, die Intervalle sind breit.

## Spannungsmonitor

Gemessen wird die Konfliktintensität je Länderpaar in der Weltpresse. Die Formel stammt von World Monitor: Σ Erwähnungen × max(0, −Goldstein) über Ereignisse der Klassen 3 und 4 (verbale und materielle Konflikte), je 10.000 Erwähnungen aller Ereignisse. Der Index ist das Perzentil des 7-Tage-Mittels innerhalb von 90 Tagen. Zusätzlich zeigt der Monitor die Abweichung der letzten 14 Tage vom Mittel der 120 Tage davor. Diese Abweichung fließt in die Risikosäule des Barometers ein.

Beobachtete Paare: USA–China, China–Taiwan, Russland–Ukraine, Russland–Europa, USA–Russland, Israel–Iran, USA–Iran, China–Japan, Indien–Pakistan, Indien–China, Nordkorea, USA–Europa und USA–Schweiz. Liegen in sieben Tagen weniger als 30 Ereignisse vor, ist das Paar als „wenig Daten“ markiert. GDELT misst Aufmerksamkeit und Ton der Berichterstattung, nicht das tatsächliche Geschehen.

## Vorbilder: World Monitor und Conflictly

**World Monitor** (`koala73/worldmonitor`) ruft keine Quelle aus dem Browser auf. Seed-Skripte laufen als Cron-Jobs auf Railway und schreiben jeden Datensatz mit einem Frische-Zeitstempel nach Redis. Ein Cloudflare-Worker liefert vorbereitete Snapshots aus Workers KV aus. Schlägt ein Abruf fehl, bleibt der letzte gute Wert stehen.

Übernommen wurden:

- das Muster Seed, Snapshot, letzter guter Wert;
- die Fälligkeitsprüfung je Quelle;
- der Datenstatus;
- die GDELT-Massendateien statt der überlasteten DOC-API;
- die Konfliktformel für Länderpaare.

**Conflictly** ist eine React-Seite auf Supabase. Die Daten kommen über serverseitige Edge-Funktionen: GDELT, RSS, Yahoo-Kurse, Flug- und Schiffsdaten, X-Beiträge über Nitter mit KI-Zusammenfassung. Der Browser fragt sie im Abstand von 30 Sekunden bis 30 Minuten ab. Den Global Tension Index gewichtet Conflictly serverseitig und glättet ihn mit EMA und Regler; die Formel ist nicht öffentlich.

Für den Big-Cycle-Monitor wurden bewusst nur nachvollziehbare, formelbasierte Kennzahlen aus offiziellen Quellen verwendet, keine KI-Signale und keine Kursquellen ohne Lizenz (Yahoo, MSCI).

## Grenzen

- **Monatswerte:** Für Aktien der Eurozone, Deutschlands, Großbritanniens, Chinas und Indiens gibt es keine freie amtliche Tagesquelle. Sie kommen als Monatswerte von EZB und OECD und tragen im Barometer den Hinweis „Stand …“.
- **Rendite der Eidgenossen:** Der SNB-RSS-Kanal liefert nur den jüngsten Wert. Die Tageshistorie wächst daher erst mit dem Betrieb des Workers; bis dahin ergänzen Monatswerte die Reihe.
- **OECD:** drosselt Anfragen. Die OECD-Jobs laufen deshalb einzeln, nacheinander und höchstens einer je Lauf.
- **Bank of England:** blockiert gelegentlich Cloud-Adressen. Dann bleibt der letzte Stand stehen.
- **KV:** ist nur letztendlich konsistent. Neue Werte erscheinen nach bis zu 60 Sekunden, mit dem Edge-Cache nach bis zu 5 Minuten.
- **Archiv:** Die Historie reicht so weit zurück, wie die Quellen sie frei anbieten (der S&P 500 auf FRED etwa nur zehn Jahre; die lange Reihe seit 1950 kommt aus den Shiller-Daten der Pipeline, Präfix `h_`). Revisionen überschreiben den gespeicherten Wert; frühere Fassungen einer Zahl werden nicht aufbewahrt. Der gespeicherte Signalverlauf hält dagegen fest, was die Seite an jedem Tag angezeigt hat.
- **Prognosen:** Die Säulen der Horizonte 12 Monate und 5–10 Jahre nutzen IWF-Projektionen. Diese gibt es nur im jüngsten Stand; der Signalverlauf der letzten 24 Monate enthält daher etwas Wissen von heute, der Backtest ersetzt sie durch einfache Fortschreibungen.
- **Treffsicherheit:** Vergangene Treffer sind keine Garantie für künftige (siehe [Backtest und Treffsicherheit](#backtest-und-treffsicherheit)).

## Lizenzen

- Schriften: Archivo und IBM Plex Mono, SIL Open Font License, selbst gehostet unter `public/fonts/`, ohne Anfragen an Google.
- Daten: Es gelten die Bedingungen der jeweiligen Quelle.
