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
          ├─► D1  bt_panel,     Backtest seit 1970: Einstufung und spätere Rendite je Anlage und Monatsende,
          │       bt_stats      Kennzahlen je Horizont (Jobs backtest_m1, backtest_y1, backtest_lt, wöchentlich)
          ├─► R2  quellen/      Rohausgabe jedes Abrufjobs, je Tag der letzte Stand (Bucket monitor)
          └─► DBnomics-Import (Hintergrundjob dbnomics, nach allen anderen Jobs, bis 4 Min. je Lauf)
                 ├─► D1 monitor-dbnomics  series, obs, datasets: relevante Datensätze von IWF, OECD, Eurostat, …
                 └─► R2 dbnomics/         jede Antwort der Schnittstelle unverändert, je Datensatz und Stand

Browser ─► GET /api/snapshot ─► Edge-Cache (5 Min.) ─► KV snapshot:v2
                                   Rückfall: statischer Startbestand public/data/live.json
Browser ─► GET /data/bigcycle.json   lange Historien (wöchentlich über GitHub Actions)
```

- **Ein Worker** liefert die statische Seite (`public/`), die API (`/api/*`) und führt die Abrufe aus. Der Browser ruft nie eine fremde Quelle direkt auf.
- **Jobs** (`worker/jobs*.js`) haben einen Takt (`every`) und ein Subrequest-Budget (`cost`). Ein Lauf nimmt die fälligen Jobs in der Reihenfolge ihrer Überfälligkeit, höchstens acht. Nach einem vollen Umlauf (rund eine Stunde) sind alle Jobs geladen; rechenintensive Jobs (Backtests, `solo`) laufen allein in einem Cron-Lauf, Hintergrundjobs (`background`, DBnomics) nach allen anderen fälligen Jobs. Jobs mit `version` (Signalmodell, Länderlisten der IWF-, Weltbank- und BIZ-Abrufe) laufen nach einer Änderung sofort neu; Jobs mit `after` (Backtests) warten, bis ihre Quellen die ganze Historie in der aktuellen Version archiviert haben.
- **Letzter guter Stand:** Schlägt ein Abruf fehl, bleibt die alte Ausgabe stehen. Der Job wartet dann 1, 2, 4, 8, 12 bzw. 24 Stunden bis zum nächsten Versuch (wie bei World Monitor).
- **Historien wachsen mit:** Viele Jobs laden nur die letzten Wochen nach und hängen sie an die gespeicherte Reihe an (`keep: true`). Tageswerte, die älter als 800 Tage sind, werden auf Wochenwerte ausgedünnt.
- **GDELT:** Alle 30 Minuten verarbeitet der Worker die neuesten 15-Minuten-Dateien der GDELT-Ereignisdatenbank und führt Tagessummen je Länderpaar für 150 Tage (Startbestand: `public/data/gdelt-state.json`).
- **Datenarchiv (D1):** Jede Ausgabe eines Abrufjobs schreibt der Runner zusätzlich in die D1-Datenbank `monitor-signals` (Tabelle `obs`: Reihe, Datum, Wert; Tabelle `series`: Bezeichnung, Einheit, Quelle, Zeitraum, Anzahl). Neue Tage werden ergänzt, bekannte nur bei geändertem Wert überschrieben (Revisionen). Beim ersten Archivlauf eines Jobs lädt der Worker die ganze Historie der Quelle (Feld `deep` am Job: FRED seit den 1950er-Jahren, EZB seit 1999, Bundesbank seit 1972, BIZ, OECD seit 1990 usw.) und archiviert sie vollständig; der Snapshot für die Seite behält den bisherigen Zeitraum. Jobs, deren Daten noch nicht archiviert sind, zieht der Runner vor (höchstens vier je Lauf), sodass das Archiv nach dem ersten Deploy innerhalb von rund zwei Stunden vollständig ist. So gehört die Historie dem Monitor, auch wenn eine Quelle ältere Werte nicht mehr anbietet (etwa die ICE-BofA-Risikoprämien auf FRED nach drei Jahren). Der Job `archive_hist` übernimmt wöchentlich die Langfristreihen aus `bigcycle.json` (Präfix `h_`, teils seit dem 13. Jahrhundert), Prognosemärkte werden als Tagesreihen `pm_…` gespeichert, GDACS-Meldungen in `events`.
- **Rohdatenarchiv (R2):** Zusätzlich legt der Runner die ungekürzte Ausgabe jedes Abrufs im R2-Bucket `monitor` ab, je Job und Tag der letzte Stand (`quellen/<quelle>/<job>/<jahr>/<datum>.json.gz`). Anders als D1, wo Revisionen den Wert überschreiben, bleiben so die damaligen Datenstände erhalten. Aufbau des Buckets:

  | Pfad | Inhalt |
  |---|---|
  | `uebersicht.json` | Aufbau des Buckets und Stand des DBnomics-Imports je Anbieter |
  | `quellen/<quelle>/<job>/<jahr>/<datum>.json.gz` | Rohausgabe jedes eigenen Abrufjobs (fred, ecb, snb, oecd, bis, imf, wb, …), je Tag der letzte Stand |
  | `dbnomics/<anbieter>/<datensatz>/datensatz.json` | Metadaten eines DBnomics-Datensatzes: Dimensionen mit Bezeichnungen, Filter, Umfang, alle importierten Stände |
  | `dbnomics/<anbieter>/<datensatz>/<stand>/<reihe>.json.gz` | jede Antwort der DBnomics-Schnittstelle unverändert, `<stand>` = Indexierungsdatum bei DBnomics, `<reihe>` = Nummer der ersten Reihe der Seite; ältere Stände bleiben liegen |
  | `echtzeit/<quelle>/…` | vorgesehen für Echtzeit-Datenstände (OECD-Frühindikatoren, ALFRED) |
  | `eingang/<quelle>/<datei>` | hochgeladene Dateien, die keine Schnittstelle liefert, etwa die Excel-Dateien des World Gold Council unter `eingang/wgc/` (im Dashboard: R2 → monitor → Hochladen). Privat: `/api/rohdaten` liefert sie nicht aus. Der Job `eingang` legt stündlich zu jeder neuen oder geänderten Datei eine Vorschau unter `eingang/_vorschau/<quelle>/<datei>.json` an (Blätter, Größe, die ersten 30 Zeilen und 24 Spalten); Excel (.xlsx), CSV und Text werden gelesen |

  Alle Dateien sind gzip-komprimiertes JSON; Sonderzeichen in Kennungen werden zu `_` (etwa `WEO_2025-04`).
- **DBnomics-Bestand (eigene D1-Datenbank und R2):** Der Job `dbnomics` (`worker/dbnomics.js`) übernimmt die relevanten Datensätze großer Statistikanbieter aus [DBnomics](https://db.nomics.world/) in die eigene D1-Datenbank `monitor-dbnomics` (Bindung `DBN`, getrennt vom Datenarchiv, damit der große Import die Seite nicht bremst) und legt jede Antwort der Schnittstelle zusätzlich in R2 ab. Umfang (`PACKAGES`):

  | Anbieter | Datensätze |
  |---|---|
  | IWF | alle Ausgaben des World Economic Outlook seit 2008 (Prognosen im damaligen Stand, 25 Länder des Monitors) und die Aggregate (Welt, Industrie- und Schwellenländer, G7, Euroraum, Asien), Rohstoffpreise (PCPS), Devisenreserven (COFER), Fiscal Monitor, Asien-Ausblick, International Financial Statistics und Financial Soundness Indicators (Länder des Monitors, Euroraum, Welt), Außenhandel nach Partnerländern (jährlich) |
  | OECD | Key Economic Indicators, Frühindikatoren, Unternehmens- und Verbraucherumfragen, Finanzmarktdaten, Wohnimmobilienpreise, Quartals-BIP der G20, Economic Outlook |
  | Eurostat | Euro-Indikatoren (Stimmung, Verbraucherpreise, Arbeitslosigkeit, Einzelhandel, Häuserpreise, Zinsen, effektive Wechselkurse, Zahlungsbilanz), Zinskurven, Staatsschulden je Quartal, Echtzeit-Datenstände von BIP, Industrieproduktion (seit 2001) und Arbeitslosigkeit |
  | EZB | Stressindizes CISS und CLIFS, €STR, Finanzmarktdaten, gesamtwirtschaftliche Projektionen, Echtzeit-Datenbank, Verbrauchererwartungen, Immobilien, Umfragen, TARGET-Salden, Wechselkurse (monatlich), Kreditumfrage und Kreditzinsen (Euroraum und große Länder), Survey of Professional Forecasters (Mittelwerte) |
  | BIZ | Gesamtkredit, Schuldendienstquoten, Kreditlücken, Wohn- und Gewerbeimmobilienpreise, lange Preisreihen, Leitzinsen, Zentralbankbilanzen, globale Liquidität, effektive und Dollar-Wechselkurse (monatlich) |
  | Weltbank | Global Economic Prospects, Rohstoffpreise (Pink Sheet seit 1960), Global Economic Monitor, World Development Indicators und Governance-Indikatoren (Länder des Monitors und Aggregate) |
  | Fed | H.15, H.10, H.4.1, H.8, H.3, Geldmengen, Industrieproduktion und Kapazitätsauslastung, Leitzinsen, Nominal- und TIPS-Zinskurven, Schuldendienstquoten, Kreditausfälle; die Finanzierungsrechnung Z.1 (42.000 Reihen) nur in R2 |
  | weitere | ISM, Konjunkturumfragen der EU-Kommission, Statistikamt China (Einkaufsmanager, Preise, Industrie, Einzelhandel, Investitionen, Geldmenge, Außenhandel, Immobilien, BIP), Zentralbanken bzw. Statistikämter von Brasilien, Türkei, Südafrika, Indonesien, Indien, Mexiko und China (SAFE) |

  Zusammen rund 1.200 Datensätze mit etwa 330.000 Reihen und 40 Mio. Werten (geschätzt 3–4 GB in D1, rund 2 GB JSON vor der Komprimierung in R2). Große Datensätze sind auf die rund 25 Länder des Monitors begrenzt. Ablauf: Der Job läuft alle zehn Minuten nach allen anderen fälligen Jobs, lädt bis zu vier Minuten lang Seiten mit bis zu 1.000 Reihen (die Schnittstelle braucht dafür 15–35 Sekunden; die Seitengröße richtet sich nach der vorigen Seite, Antworten über 8 MB werden mit weniger Reihen wiederholt) und merkt sich den Fortschritt im KV (`state:dbnomics`). Der erste Durchgang dauert so rund einen halben bis ganzen Tag. Danach prüft er wöchentlich den Indexierungsstand jedes Datensatzes bei DBnomics und lädt nur neu indexierte Datensätze, jeweils in einen neuen Stand-Ordner in R2. Kennung im Monitor: `dbn.<anbieter>.<datensatz>.<reihe>` (andere Zeichen als Buchstaben, Ziffern und `_ . : -` werden zu `_`, dann mit Prüfsumme). Der Backtest nutzt den Bestand noch nicht; die WEO-Ausgaben sind als Ersatz für die heutigen IWF-Projektionen vorgesehen.
- **Weitere DBnomics-Anbieter (vorbereitet):** Der Job `dbnomics_mirror` lädt mit derselben Technik ganze Anbieter nur nach R2 (ohne D1). Er läuft erst, wenn die Variable `DBNOMICS_MIRROR` gesetzt ist, etwa auf `Eurostat,OECD` oder `*` für alle rund 90 Anbieter; Datensätze, die der Job `dbnomics` schon lädt, überspringt er. Für einzelne Anbieter mittlerer Größe ist das der einfache Weg. Der gesamte Bestand von DBnomics (über eine Milliarde Reihen, allein Eurostat 783 Mio.) ist über die Schnittstelle nicht in vertretbarer Zeit zu laden; dafür wäre ein Massenabzug der DBnomics-Rohdaten (git.nomics.world) auf einem eigenen Rechner nötig, der die Dateien mit eigenen R2-Zugangsschlüsseln hochlädt.
- **Signalverlauf (D1):** Alle sechs Stunden rechnet der Worker das Anlagebarometer mit demselben Modell wie die Seite (`src/signals.js`) für alle drei Horizonte und speichert den Stand des Tages samt Säulenwerten in der Tabelle `signal_hist`. Für Anlagen ohne Vorgeschichte rechnet er 24 Monatsenden zurück, und zwar nur mit Daten, die damals veröffentlicht gewesen wären. Gespeicherte Tageswerte ändern sich danach nicht mehr, so entsteht eine echte Historie der Signale. Ändert sich das Modell (`SIG.cfg.version`), wird nur die Rückrechnung neu erstellt.
- **Backtest (D1):** Einmal pro Woche und nach jeder Modelländerung rechnen drei Jobs (je Horizont einer, jeweils allein in einem Cron-Lauf, rund 12–18 s Rechenzeit) das Barometer zu jedem Monatsende seit 1970 mit der Historie aus dem Archiv durch, vergleichen mit der tatsächlichen Kursentwicklung und speichern Einzelwerte (`bt_panel`) und Kennzahlen (`bt_stats`), samt Zufallstest. Die OECD-Frühindikatoren nimmt er ab 2001 in dem Stand, den die OECD damals veröffentlicht hat (`public/data/cli_vintages.json`). Die Zusammenfassung landet im Snapshot; die Seite zeigt daraus die Treffsicherheit und die Wahrscheinlichkeit steigender Kurse je Anlage. Rechnung in `worker/backtest.js`, lokal mit `node scripts/backtest.mjs --local`; die Prüfungen gegen Rückschaufehler (vor 1970, Echtzeit gegen revidiert, JST) mit `node scripts/robustness.mjs`.
- **Wöchentliche Pipeline** (`pipeline/build_data.py`, GitHub Actions montags 05:17 UTC): baut die langen Historien (Machtindex seit 1500, US-Schulden seit 1790, Shiller-Daten, geopolitischer Risikoindex usw.), ergänzt die Echtzeit-Datenstände der Frühindikatoren (`pipeline/fetch_cli_vintages.py`) und prüft die Langfrist-Bausteine an der JST-Datenbank (`pipeline/jst_check.py`). Danach übernimmt sie den aktuellen Worker-Snapshot und die Backtest-Kennzahlen als neuen Startbestand.

```
worker/            Worker: index.js (Routen, Cron), runner.js (Batch-Runner), jobs*.js (Abrufjobs),
                   jobs-extra.js (Quellen mit langer Historie), backtest.js und jobs-backtest.js (Backtest),
                   archive.js (Datenarchiv), providers/ (Quellenadapter), lib/ (HTTP, CSV, ZIP, Reihenformat)
src/               Seite: body.html, style.css, charts.js, signals.js (Signalmodell), app-*.js
public/            ausgelieferte Dateien; index.html, app.css, app.js entstehen beim Build
public/data/       bigcycle.json (Historien), live.json (Startbestand), backtest.json (Kennzahlen, Rückfall), gdelt-state.json,
                   cli_vintages.json (Frühindikatoren im damals veröffentlichten Stand), robustness.json und jst_check.json (Prüfungen)
pipeline/          wöchentliche Python-Pipeline für die langen Historien, Echtzeit-Datenstände und JST-Prüfung
scripts/           build.mjs, fetch_live.mjs, refresh_seed.mjs, gdelt_backfill.mjs, backtest.mjs, robustness.mjs
test/              Tests des Signalmodells (node --test)
```

## Einrichtung

### 1. Cloudflare-Plan (erledigt)

**Workers Paid** ist gebucht (5 USD im Monat). Er ist nötig: Die Abrufjobs parsen CSV- und JSON-Antworten und brauchen dafür je Job 20 bis 120 ms Rechenzeit. Der Free-Plan erlaubt pro Cron-Lauf nur 10 ms CPU und 1.000 KV-Schreibvorgänge am Tag. Paid erlaubt 30 Sekunden CPU je Lauf, und KV-Schreibvorgänge sind nicht begrenzt.

### 2. Repository mit Cloudflare verbunden (erledigt)

Das Repository ist über Workers Builds mit dem Worker **`monitor`** verbunden (wie der `name` in `wrangler.jsonc`) und läuft unter **https://monitor.hartmann-it.workers.dev**. Jeder Push auf `main` wird automatisch veröffentlicht; `wrangler deploy` baut die Seite vorher selbst (`node scripts/build.mjs`, eingetragen unter `build.command`).

Für eine Neueinrichtung: Cloudflare-Dashboard → **Workers & Pages** → **Erstellen** → **Repository importieren**, `hartmann-account/monitor.hartmann-research.org` wählen, Projektname `monitor`, Build-Befehl leer, Deploy-Befehl `npx wrangler deploy`, Produktionszweig `main`. Alternativ lokal: `npx wrangler login` und `npm run deploy`.

### 3. Speicher und Cron

Hier ist nichts zu tun. Den KV-Namespace für das Binding `DATA`, die D1-Datenbanken `monitor-signals` (Binding `DB`) und `monitor-dbnomics` (Binding `DBN`) sowie den R2-Bucket `monitor` (Binding `ARCHIVE`, im EU-Rechtsraum angelegt, deshalb mit `"jurisdiction": "eu"` in `wrangler.jsonc`) bindet Wrangler beim Deploy; was noch fehlt, legt es automatisch an (ab Wrangler 4.45). Automatisch angelegte D1-Datenbanken liegen im allgemeinen Bereich; eine D1-Datenbank im EU-Rechtsraum muss im Dashboard angelegt und mit `database_id` eingetragen werden. Die Tabellen erzeugt der Worker selbst; die Tabelle `signals` der ersten Version übernimmt er einmalig in `signal_hist`. Der Cron-Trigger `*/10 * * * *` steht in `wrangler.jsonc`, ebenso eine CPU-Grenze von 60 Sekunden je Lauf als Reserve für den ersten Archivlauf.

Umfang: Der erste Archivlauf schreibt rund 600.000 Beobachtungen (einige Megabyte), danach kommen täglich einige Tausend hinzu. Der DBnomics-Import schreibt einmalig rund 40 Mio. Werte (geschätzt 3–4 GB in `monitor-dbnomics`), danach nur geänderte Werte. Das liegt innerhalb der Grenzen von Workers Paid (D1: 10 GB je Datenbank, 5 GB Speicher und 50 Mio. geschriebene Zeilen im Monat inklusive, darüber 0,75 USD je GB und Monat bzw. 1 USD je Mio. Zeilen). R2 kostet 0,015 USD je GB und Monat (10 GB frei), ohne Gebühren für den Abruf.

### 4. Optionale Secrets und Variablen

Im Dashboard unter Worker → **Einstellungen** → **Variablen und Secrets**, oder mit `npx wrangler secret put <NAME>`:

| Name | Art | Zweck |
|---|---|---|
| `ADMIN_TOKEN` | Secret | Schaltet `POST /api/run` frei (Abruf sofort anstoßen) |
| `ALFRED_API` | Secret | Schlüssel der FRED/ALFRED-Schnittstelle (St. Louis Fed). Schaltet den Job `alfred_vintages` frei: alle Datenstände einer Reihe in einem Abruf. Ohne ihn rechnet der Backtest Baugenehmigungen und Z.1 im heutigen Stand; lokal ersetzt `pipeline/alfred_snapshots.py` ihn durch Monatsend-Stände |
| `FRED_API_KEY` | Secret | nicht nötig und derzeit nicht verwendet: die laufenden Abrufe nutzen den schlüssellosen CSV-Export von FRED |
| `GDELT_FILES_PER_RUN` | Variable | GDELT-Dateien je Lauf (Standard 3) |
| `MAX_JOBS_PER_RUN`, `SUBREQUEST_BUDGET` | Variable | Jobs und Subrequests je Cron-Lauf (in `wrangler.jsonc`: 8 und 80); der DBnomics-Import hat ein eigenes Budget von 300 Abrufen je Lauf |
| `DBNOMICS_MIRROR` | Variable | schaltet den Job `dbnomics_mirror` ein: Anbieterkennungen mit Komma (etwa `Eurostat,OECD`) oder `*` für alle; lädt deren Datensätze nur als Rohdaten nach R2 |

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

- Repository-Variable `LIVE_URL`, falls der Snapshot von einer anderen Adresse als `https://monitor.hartmann-it.workers.dev/api/snapshot` kommen soll (etwa nach dem Umzug auf die eigene Domain; nötig ist das nicht, die `workers.dev`-Adresse bleibt erreichbar).
- Secret `FRED_API_KEY`: nicht nötig (siehe Schritt 4).

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

Für `POST /api/run` lokal eine Datei `.dev.vars` mit `ADMIN_TOKEN=…` anlegen; sie wird nicht eingecheckt. Hinter einem Proxy braucht Node `NODE_USE_ENV_PROXY=1`. Die lokale D1 lässt sich mit `npx wrangler d1 execute monitor-signals --local --command "SELECT COUNT(*) FROM obs"` abfragen, der DBnomics-Bestand mit `npx wrangler d1 execute monitor-dbnomics --local --command "SELECT p, d, series, obs FROM datasets"`; den Import stößt `POST /api/run?jobs=dbnomics` an (ein Lauf dauert bis zu vier Minuten).

## API

| Endpunkt | Inhalt |
|---|---|
| `GET /api/snapshot` | alle Live-Reihen, Listen (Prognosemärkte, Naturgefahren) und der Status aller Jobs; 5 Minuten im Edge-Cache |
| `GET /api/status` | nur der Status der Jobs (Zeitpunkt, Fehler, jüngster Wert, Größe, Dauer) |
| `GET /api/signals` | Signalverlauf aus D1: Stichtage, Art (rückgerechnet oder gespeichert), Gesamtwert und Stufe je Anlage. `?h=m1` (1 Monat, Standard), `?h=y1` (12 Monate), `?h=lt` (5–10 Jahre); `?daily=365` alle Tageswerte der letzten 365 Tage statt nur der Monatsenden; `?pillars=1` mit Säulenwerten; `?format=csv` als CSV |
| `GET /api/archive` | Verzeichnis des Datenarchivs: alle Reihen mit Bezeichnung, Einheit, Frequenz, Quelle, erstem und letztem Datum und Anzahl der Werte, dazu Summen; unter `dbnomics` die Summen des DBnomics-Bestands je Anbieter und der Stand des Imports |
| `GET /api/series?id=y10_us,gold_usd` | Beobachtungen aus dem Archiv (höchstens 20 Reihen), `?from=1990&to=2000-12-31`, `?thin=w` nur der letzte Wert je Kalenderwoche, `?format=csv` als CSV; Kennungen `dbn.…` kommen aus dem DBnomics-Bestand, etwa `dbn.IMF.WEO:2025-04.USA.NGDP_RPCH.pcent_change` |
| `GET /api/rohdaten?prefix=dbnomics/IMF/` | Rohdatenarchiv (R2): Unterordner und Dateien einer Ebene (`folders`, `files` mit Größe und Zeitpunkt; bei mehr als 1.000 Einträgen `?cursor=`), `?key=uebersicht.json` bzw. `?key=dbnomics/IMF/WEO_2025-04/datensatz.json` lädt eine Datei, `.json.gz` unverändert als Download. Dateien im Eingang (`eingang/…`) sind gesperrt (403), ihre Vorschauen unter `eingang/_vorschau/` abrufbar |
| `GET /api/dbnomics?q=unemployment` | Suche im DBnomics-Bestand (Bezeichnung und Kennung, höchstens 200 Reihen, `?offset=`), `?p=IMF&d=IFS` auf Anbieter bzw. Datensatz eingrenzen; `?datasets=1` alle Datensätze mit Umfang, Filter und Stand |
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
| `bis_credit` | Kreditlücke und Schuldendienstquote des Privatsektors (Frühwarnindikatoren), 14 Wirtschaftsräume, darunter acht Schwellenländer | BIZ | 1 Woche |
| `em_markets` | Aktien der Schwellenländer in US-Dollar, täglich: Nasdaq Emerging Markets (mit Taiwan, seit 2015 ohne Korea) und Länderindizes für China, Indien, Taiwan, Korea und Brasilien; Dollar gegenüber den Währungen der Schwellenländer | Nasdaq über FRED, Federal Reserve | 6 Std. |
| `em_history` | Schwellenländer seit 1960 (nur Archiv): Aktienindizes und Wechselkurse von 15 Ländern aus der OECD-Monatsstatistik, in US-Dollar umgerechnet und mit dem BIP des Vorjahres gewichtet (Weltbank); Dollarindex gegenüber Schwellenländern seit 1973 | OECD über FRED, Weltbank, Federal Reserve | 1 Woche |
| `oecd_cli_em` | Frühindikatoren Brasilien, Mexiko, Korea, Südafrika, Indonesien, Türkei | OECD | 1 Tag |
| `bis_em` | Leitzinsen und reale effektive Wechselkurse von Brasilien, Mexiko, Korea, Südafrika, Indonesien und der Türkei (Wechselkurs auch Taiwan) | BIZ | 12 Std. |
| `eurostat_esi` | Wirtschaftsstimmung Euroraum und Deutschland | Eurostat | 1 Tag |
| `alfred_vintages` | Echtzeit-Datenstände der Baugenehmigungen und der Z.1-Reihen (Aktienanteil am Anlegervermögen): jeder Wert mit dem Zeitraum, in dem er galt (Tabelle `vint`, für den Backtest; braucht das Secret `ALFRED_API`) | ALFRED (St. Louis Fed) | 1 Woche |
| `signal_history` | Signalverlauf des Anlagebarometers, drei Horizonte (eigene Berechnung, D1) | – | 6 Std. |
| `backtest_m1`, `backtest_y1`, `backtest_lt` | Backtest des Barometers seit 1970 je Horizont (eigene Berechnung auf dem Archiv, D1) | – | 1 Woche |
| `archive_hist` | Langfristreihen des wöchentlichen Datensatzes ins Archiv (D1) | – | 1 Woche |
| `dbnomics` | Relevante Datensätze von IWF (alle WEO-Ausgaben), OECD, Eurostat, EZB, BIZ, Weltbank, Fed und Schwellenländern in die eigene D1-Datenbank `monitor-dbnomics` und als Rohdaten nach R2 (siehe Architektur) | DBnomics | 10 Min., bis der Durchgang fertig ist; danach wöchentliche Prüfung |
| `dbnomics_mirror` | Weitere DBnomics-Anbieter als Rohdaten nach R2 (nur mit der Variable `DBNOMICS_MIRROR`) | DBnomics | 10 Min. |
| `eingang` | Vorschau neu hochgeladener Dateien im privaten Eingang des R2-Buckets (`eingang/…`) | eigene Uploads | 1 Std. |
| `wgc` | Gold-ETFs (Bestand und Zuflüsse in Tonnen, monatlich seit 2003, weltweit und je Region), Goldkäufe der Zentralbanken laut IWF-Meldungen (monatlich seit 2002, weltweit, China, Russland, Indien, Türkei, Polen), Angebot und Nachfrage je Quartal seit 2010 (Gold Demand Trends, mit geschätzten nicht gemeldeten Zentralbankkäufen), Preisaufschläge in China (seit 2003) und Indien (seit 2012); aus den hochgeladenen Goldhub-Dateien in `eingang/wgc/` (jeweils die neueste Datei je Art), Reihen `wgc_…` | World Gold Council | 1 Tag |

**Schwellenländer.** Die MSCI-Indizes sind lizenzpflichtig, und die Börse Taiwan sperrt automatische Abfragen. Tagesaktuell kommen die Schwellenländer deshalb über die Nasdaq-Indizes, die FRED seit 2001 in US-Dollar veröffentlicht (© Nasdaq, Inc.; vor dem Start der Indizes im Dezember 2012 von Nasdaq zurückgerechnet). Nasdaq zählt Korea seit 2015 zu den Industrieländern, MSCI weiterhin zu den Schwellenländern. Für die Zeit davor bildet der Monitor einen Korb aus den Aktienindizes von 15 Schwellenländern der OECD-Statistik, umgerechnet in US-Dollar und mit dem BIP des Vorjahres gewichtet (jedes Land nur in den Jahren als Schwellenland, ungefähr wie bei den großen Indexanbietern: Griechenland ohne 2001–2013, Israel bis 2010, Russland bis Februar 2022; Brasilien erst ab dem Real 1995, davor verzerrt die Hyperinflation die Umrechnung). Seit 2001 folgt der Korb dem Nasdaq-Index mit einer Korrelation der Monatsrenditen von 0,92. Frühindikatoren, Leitzinsen, reale Wechselkurse und Kreditlücken liegen für acht Schwellenländer vor; die Säulen der Zeile „Schwellenländer“ fassen sie zusammen (IWF- und Weltbankdaten nach ungefährem Börsenwert gewichtet wie beim MSCI-Schwellenländerindex, also mit Korea: China, Taiwan, Indien, Korea, Brasilien, Südafrika, Mexiko, Indonesien, Türkei).

Die wöchentliche Pipeline nutzt zusätzlich Our World in Data, die Weltbank, den IWF (DataMapper, COFER), FRED, U.S. Treasury Fiscal Data und die Shiller-Daten (shillerdata.com). Hinzu kommen der Geopolitical Risk Index und der Trade Policy Uncertainty Index (Caldara, Iacoviello), die Jordà-Schularick-Taylor Macrohistory Database, Correlates of War, die Millennium-Daten der Bank of England, Voteview und die Nobelpreis-API. Die Quellenangaben stehen an jeder Grafik und in `public/data/bigcycle.json` unter `sources`.

## Anlagebarometer

Jede Anlage wird auf fünf Säulen von −2 bis +2 bewertet. Welche Säulen zählen, hängt vom gewählten Horizont ab:

**1 Monat (taktisch)**

- **Trend:** Momentum über 3, 6 und 12 Monate, risikobereinigt, plus Abstand zum 200-Tage-Schnitt.
- **Konjunktur:** Niveau des OECD-Frühindikators der Region; bei Aktien, Unternehmensanleihen und Rohstoffen zählt ein hohes Niveau antizyklisch (spätes Zyklusstadium). Die Dynamik über drei Monate wird angezeigt, zählt aber nicht: Sie wird in den ersten Monaten stark revidiert und hatte mit den damals veröffentlichten Werten keine Prognosekraft (siehe Backtest).
- **Bewertung:**
  - Aktien: Aktienanteil am Anlegervermögen der USA (Fed Z.1, siehe unten), bei den übrigen Märkten zusammen mit dem Abstand zum 10-Jahres-Trend.
  - Anleihen: Realrendite und Steilheit der Zinskurve.
  - Unternehmensanleihen: Risikoaufschlag gegenüber seiner Historie, dazu die Baa-Prämie.
  - Währungen: realer effektiver Wechselkurs der BIZ.
  - Gold: Gold gegenüber Aktien über den Aktienanteil am Anlegervermögen.
- **Liquidität:** Leitzinsrichtung, Zinskurve, Zentralbankbilanz, Dollartrend.
- **Risikoappetit:** VIX, Risikoprämien, Finanzstress, gewichtet mit dem Risikobeta der Anlage. Die Spannungen des Spannungsmonitors stehen zur Information dabei, zählen aber nicht (siehe unten).

**12 Monate (zyklisch)**

- **Konjunktur:** Frühindikator-Niveau wie oben und die IWF-Wachstumsprognose der nächsten zwölf Monate gegenüber den letzten zwölf Monaten (bei Anleihen auch die Inflationsprognose); für US- und Weltaktien zusätzlich die Baugenehmigungen.
- **Bewertung und Liquidität** wie oben, Bewertung mit dem höchsten Gewicht.
- **Momentum 12 Monate:** Rendite der letzten zwölf Monate ohne den jüngsten Monat, risikobereinigt (Zeitreihen-Momentum).
- **Stimmung & Risiko:** antizyklische Stimmungs- und Positionierungsdaten – Verbraucherstimmung (Michigan, EU-Kommission), Kreditlücke der BIZ, Positionierung der Spekulanten (CFTC), Excess Bond Premium der Fed; für Gold das geopolitische Risiko und die Positionierung im Goldfuture.

**5–10 Jahre (strukturell, großer Zyklus)**

- **Bewertung:** Aktien USA und Welt: Aktienanteil am Anlegervermögen, Shiller-KGV und Verbraucherstimmung; übrige Märkte: Abstand zum Trend über bis zu 20 Jahre, dazu der US-Wert als globale Bewertung und die Wirtschaftsstimmung. Anleihen: erwartete Realrendite (Rendite minus IWF-Inflationsprognose für fünf Jahre); Unternehmensanleihen: Risikoaufschlag, Baa-Prämie, Excess Bond Premium; Währungen: realer Wechselkurs gegenüber dem langjährigen Mittel; Gold: realer Preis seit 1971, Aktienanteil am Anlegervermögen und reale US-Rendite; Regionen-Paare: Rückkehr zur Mitte.
- **Wachstum und Demografie:** IWF-Wachstumsprognose für fünf Jahre, Erwerbsbevölkerung der nächsten zehn Jahre (Weltbank), Produktivität. Fließt nur bei Rohstoffen ein.
- **Schulden:** Schuldenquote, ihre Entwicklung laut IWF, Haushaltssaldo, Zins minus nominales Wachstum. Fließt derzeit bei keiner Anlage ein.
- **Machtposition:** Anteil an der Weltwirtschaft (Kaufkraftparitäten), Leistungsbilanz, bei Währungen der Anteil an den Weltdevisenreserven (COFER). Fließt derzeit bei keiner Anlage ein.
- **Langfristtrend:** Steigung des Zehnjahrestrends und Rendite über drei Jahre; bei Unternehmensanleihen, Rohstoffen und Regionen-Paaren antizyklisch. Fließt bei Aktien nicht ein.

Aktien werden über 5–10 Jahre nur nach ihrer Bewertung eingestuft. Wachstum, Schulden, Machtposition und Langfristtrend – die Bausteine des großen Zyklus – fließen dort nicht ein; ihre Daten zeigen die Kapitel Schuldenzyklus, Machtindex sowie Demografie und Technologie. In den Daten von 16 Ländern seit 1890 (Jordà-Schularick-Taylor) gingen ein starker Langfristtrend und hohes Wachstum eher schwächeren Aktienjahren voraus, steigende Staatsschulden eher stärkeren; der eigene Backtest seit 1970 zeigte teils das Gegenteil. Ohne diese Bausteine schlägt das Signal den Zufall gleich deutlich, und in den 16 Ländern wird es besser (siehe Backtest).

**Aktienanteil am Anlegervermögen (Fed Z.1).** Marktwert aller US-Aktien ÷ (Aktien + Schulden von Haushalten, Unternehmen, Staat und Ausland), quartalsweise seit 1945, mit dem S&P 500 bis zum Stichtag fortgeschrieben. Wer Aktien hält, muss sie jemandem abgenommen haben: Ist der Anteil hoch, fehlen künftige Käufer. Im Backtest erklärt der Wert die 5-Jahres-Renditen von US-Aktien deutlich besser als das Shiller-KGV (Rangkorrelation 0,50 statt 0,29 seit 1960) und ging auch stärkeren Goldjahren voraus.

Live-Rechnung und Backtest nutzen dieselben Reihen: Die nur drei Jahre langen ICE-BofA-Risikoprämien werden für das Modell mit der skalierten Baa-Prämie verlängert, der US-Verbraucherpreisindex (reale Gold- und Rohstoffpreise) liegt seit 1947 vor, und Verhältnisse gegenüber dem S&P 500 (Regionen, Gold, Aktien gegenüber Anleihen) reichen über die Shiller-Monatswerte vor die zehn Jahre der FRED-Tagesreihe zurück.

Rohwerte werden durch ihre typische Schwankung geteilt und weich begrenzt (2·tanh(z/2)). Die Gewichte hängen von Anlageart und Horizont ab (Tabellen auf der Seite unter „So entsteht das Signal“). Sie wurden anhand der Rückrechnungen seit 1970 gesetzt und an Daten geprüft, die dabei keine Rolle spielten (vor 1970, 16 weitere Länder seit 1890, damals veröffentlichte Frühindikatoren): Säulen ohne belegte Prognosekraft für einen Horizont erhalten kein Gewicht und stehen nur zur Information dabei. Die Gesamtnote ergibt eine von fünf Stufen (−−, −, =, +, ++; Schwellen ±0,3 und ±0,9). IWF-Prognosen und Bevölkerungsprojektionen gibt es nur im jüngsten Stand; Vormonat und Rückrechnung verwenden ihn ebenfalls. Bitcoin hat keinen fundamentalen Bewertungsanker und bleibt im Horizont 5–10 Jahre ohne Einstufung.

**Gold** hat eine eigene Monatsübersicht: Gold in US-Dollar, Franken und Euro, Silber, Gold gegenüber Aktien (S&P 500) und Anleihen (10-jährige Treasuries), mit Kennzahlen und den Säulen des Goldsignals als Treiber. Gold in Franken und Euro nutzt für Trend und Momentum den Preis in der jeweiligen Währung, für die Bewertung den weltweit einheitlichen Dollarpreis.

Der Vormonat wird mit dem Datenstand von vor 30 Tagen berechnet. Monatsreihen zählen dabei erst nach ihrer üblichen Veröffentlichungsfrist. Ein Toleranzband von 0,1 verhindert, dass Werte nahe einer Schwelle jeden Monat die Stufe wechseln. Zeilen, deren jüngster Wert nicht tagesaktuell ist, tragen einen Hinweis „Stand …“.

Die Darstellung lehnt sich an die Monatsübersicht von Pictet Asset Management an: Balken auf einer Fünf-Stufen-Skala, Pfeil bei einer Änderung zum Vormonat, Indikatoren für die Risikoausrichtung. Der Monitor verwendet keine Daten oder Einschätzungen von Pictet. **Keine Anlageberatung.**

## Backtest und Treffsicherheit

**Vorgehen.** Zu jedem Monatsende seit Januar 1970 rechnet das unveränderte Modell (`src/signals.js`) alle Anlagen und Horizonte, und zwar nur mit Daten, die zum Stichtag veröffentlicht waren (übliche Fristen je Reihe: Monatswerte 15 Tage, OECD-Frühindikatoren 45 Tage, Quartale 45 Tage, Kreditdaten der BIZ 100, Fed Z.1 80 Tage). Die OECD-Frühindikatoren nimmt der Backtest ab 2001 in dem Stand, den die OECD jeden Monat veröffentlicht hat (Revisionsdatenbank der Main Economic Indicators, 16 Regionen), nicht in der heute revidierten Fassung. Ebenso die US-Baugenehmigungen (ab 1999) und den Aktienanteil am Anlegervermögen (aus den Z.1-Reihen, ab 2013), sobald der Job `alfred_vintages` deren Datenstände aus ALFRED geladen hat. Die Historie stammt aus dem D1-Archiv; lange Reihen werden aus mehreren Quellen verkettet (S&P 500 seit 1871 aus den Shiller-Daten, Wechselkurse seit 1971 aus der Fed-Statistik, Euro vor 1999 über die D-Mark, Aktien von acht Ländern seit 1955 aus der OECD-Statistik, Schwellenländer seit 2001 aus dem Nasdaq-Index und davor aus dem BIP-gewichteten Korb von 15 Ländern, Risikoprämien über die Baa-Prämie seit 1953). IWF- und Weltbank-Projektionen liegen nur im heutigen Stand vor und werden durch einfache Fortschreibungen ersetzt. Verglichen wird mit der Rendite der folgenden 1, 12 bzw. 60 Monate.

**Kennzahlen.**
- *Trefferquote der Richtung:* Anteil der Stufen „positiv/klar positiv“ mit steigendem und „negativ/klar negativ“ mit fallendem Kurs (neutral = keine Aussage), 95-%-Intervall nach Wilson auf der effektiven Stichprobe (überlappende Zeiträume zählen anteilig).
- *Mehrheitsregel:* dieselben Fälle, immer die häufigere Richtung getippt („steigt immer“) – der Maßstab, den das Modell schlagen muss.
- *Rangkorrelation (IC):* Spearman zwischen Gesamtwert und späterer, um die Schwankung bereinigter Rendite, mit 95-%-Intervall.
- *Teilperioden:* 1970–89, 1990–2007, ab 2008.
- *Zufallstest:* Alle Einstufungen werden gemeinsam zeitlich gegen die späteren Renditen verschoben (zyklisch, mindestens um einen Horizont). Trends, Gleichlauf der Anlagen und die Häufigkeit der Stufen bleiben so erhalten; nur der zeitliche Zusammenhang geht verloren. p = Anteil der Verschiebungen, die das Modell erreichen. Der Test ist strenger als die Intervalle oben, die den Gleichlauf der Anlagen nicht berücksichtigen.
- *Urteil:* „belegt“, wenn die Rangkorrelation mit 95 % Sicherheit über null, in jeder Teilperiode positiv und im Zufallstest p < 0,05 ist; „nicht belegt“, wenn sie nicht positiv ist oder verschobene Signale mindestens halb so oft ebenso gut abschneiden (p ≥ 0,5); sonst „schwach“.
- *Ohne Vorgriff:* Gewichte der Säulen Jahr für Jahr nur aus der bis dahin bekannten Geschichte geschätzt (ausgehend von gleichen Gewichten), ab 1990.
- *Wahrscheinlichkeiten:* logistische Regression P(Kurs steigt) = 1 ÷ (1 + e^−(a + b·Gesamtwert)) je Anlageart; Fälle mit 1 ÷ Horizont in Monaten gewichtet, damit wenige unabhängige 5-Jahres-Zeiträume keine übertriebenen Wahrscheinlichkeiten erzeugen. Geprüft mit dem Brier-Score ohne Vorgriff gegen die bloße Grundhäufigkeit.
- *Echtzeit-Bilanz:* die seit Oktober 2026 täglich gespeicherten Einstufungen (`signal_hist`), sobald ihr Horizont abgelaufen ist.

**Ergebnisse (Stand Oktober 2026, rund 25 000 Einstufungen je Horizont).**

| Horizont | Treffer | bei Zufall (95-%-Schwelle) | „steigt immer“ | Rangkorrelation | bei Zufall | Zufallstest p | ohne Vorgriff | Brier-Skill |
|---|---|---|---|---|---|---|---|---|
| 1 Monat | 56,2 % | 52,0 % (53,4 %) | 54,4 % | 0,11 | 0,02 | 0,016 | 0,08 | +0,3 % |
| 12 Monate | 63,4 % | 51,9 % (57,1 %) | 58,9 % | 0,22 | 0,01 | 0,005 | 0,15 | +1,5 % |
| 5–10 Jahre (5-Jahres-Rendite) | 67,4 % | 53,6 % (60,2 %) | 63,3 % | 0,35 | 0,07 | 0,002 | 0,32 | +0,5 % |

Alle drei Horizonte schlagen den Zufall deutlich: Zeitlich verschobene Einstufungen treffen die Richtung in 52–54 % der Fälle, das Modell in 56, 63 bzw. 67 %. Am stärksten sind die Signale für Unternehmensanleihen (12 Monate: Rangkorrelation 0,39; 5 Jahre: 0,64), Staatsanleihen und Gold; Aktien liegen auf 12 Monate bei 0,19 (Zufallstest p = 0,07) und auf 5 Jahre bei 0,31. Nach „klar positiv“ stiegen die Kurse auf 12 Monate in 75 % der Fälle, nach „klar negativ“ in 34 %. Langfristig sind Währungen nicht besser als Zufall (p = 0,7): Ihre scheinbare Rangkorrelation von 0,24 entsteht allein durch dauerhafte Unterschiede zwischen den Währungen.

**Prüfungen gegen Rückschaufehler.** Die Bausteine wurden mit Kenntnis der Geschichte seit 1970 ausgewählt. Drei Prüfungen nutzen Daten, die dabei keine Rolle spielten (`public/data/robustness.json`, auf der Seite unter „Treffsicherheit“):

| Prüfung | Ergebnis |
|---|---|
| 1955–1969 (bei der Gewichtung nicht verwendet, ohne Gold und Währungen) | 12 Monate: Treffer 61,6 % gegen 55,0 % „steigt immer“, Rangkorrelation 0,20, Zufall −0,03 (p < 0,01); 1 Monat: Rangkorrelation 0,15 (p = 0,045), Treffer auf Höhe der Mehrheitsregel |
| Frühindikatoren ab 2001 im damals veröffentlichten statt im revidierten Stand | Rangkorrelation 1 Monat 0,065 statt 0,072, 12 Monate 0,155 statt 0,164. Mit der früheren Formel (Dynamik über drei Monate) fiel sie auf 1 Monat von 0,080 auf 0,056 und die der Konjunktursäule von 0,06 auf null (−0,005); deshalb zählt heute nur das Niveau |
| 16 Länder seit 1890 (Jordà-Schularick-Taylor), Aktien auf 5 Jahre | Gesamtwert Rangkorrelation 0,06 statt −0,02 mit den früheren Gewichten; Dividendenrendite 0,21, Langfristtrend −0,13 (in allen fünf Zeiträumen negativ), Wachstum −0,09; Staatsanleihen: Realrendite 0,43 |

Daraus folgten vier Änderungen am Modell: Der Frühindikator zählt nur noch mit seinem Niveau; Aktien werden über 5–10 Jahre nur nach Bewertung eingestuft; die Bausteine Wachstum, Schulden und Machtposition zählen langfristig nur dort, wo sie Prognosekraft zeigen (Wachstum bei Rohstoffen); und bei Regionen-Paaren zählt der Wachstumsvorsprung nicht mehr (er war auf 1 und 12 Monate in allen vier Zeiträumen seit 1955 negativ, ohne ihn stieg die Rangkorrelation der relativen Stärke auf 12 Monate von 0,18 auf 0,20), ebenso bei Rohstoffen die Konjunktursäule auf 1 Monat. Der Rohwert der Rangkorrelation sank dadurch auf 5 Jahre von 0,41 auf 0,35, der Abstand zum Zufall stieg aber von 0,27 auf 0,28: Ein Teil des früheren Werts kam daher, dass dieselben Märkte über Jahrzehnte vorn lagen (Zufallsmittel 0,14 statt 0,07). Die Schwellenländer-Daten haben die Zeile „Schwellenländer“ deutlich verbessert (Rangkorrelation 1 Monat 0,17 statt 0,09, 12 Monate 0,30 statt 0,14, 5 Jahre 0,61 statt 0,53; vorher ein Korb aus China und Indien). „Schwellenländer gegenüber USA“ bleibt auf 12 Monate ohne belegte Prognosekraft (−0,05), ebenso China allein (−0,10, Daten erst seit 2001). Die genauen, wöchentlich neu gerechneten Werte je Anlageart und Anlage stehen auf der Seite und unter `/api/backtest`.

**Was das heißt.** Das Modell trifft die Richtung häufiger als der Zufall und über alle Anlagen häufiger als „steigt immer“, aber nahezu sichere Prognosen sind an Märkten nicht möglich. Aktien steigen meistens; „negativ“ heißt bei ihnen „unterdurchschnittliche Aussichten“, deshalb liegt ihre Trefferquote der Richtung auf 12 Monate unter der Mehrheitsregel, obwohl die Rangkorrelation positiv ist. Aussagekräftiger ist die Wahrscheinlichkeit steigender Kurse, die jede Zeile des Barometers zeigt.

**Selbstoptimierung mit Bedacht.** Jährlich aus den Daten neu geschätzte Gewichte schnitten im Backtest schlechter ab als feste, begründete Gewichte (bekannt als Rätsel der Prognosekombination). Das Modell hält deshalb die Gewichte fest und kalibriert stattdessen jede Woche Trefferquoten und Wahrscheinlichkeiten mit der wachsenden Historie in D1 neu.

**Live wie im Backtest.** Seite, Worker und Backtest rechnen mit demselben Modell (`src/signals.js`) und denselben Reihen; Tageskurse liegen im Backtest als Wochen- und Monatsschlusswerte vor, z-Werte zählen je Kalenderwoche einen Wert. Zum jüngsten Stichtag stimmen alle Säulenwerte beider Rechnungen bis auf weniger als 0,25 überein; wo die Live-Historie kürzer ist als im Archiv (etwa 20-Jahres-Trends einzelner Märkte), weichen langfristige Bewertungen an früheren Stichtagen etwas ab. Bausteine, die sich nicht prüfen lassen (Spannungsmonitor) oder keine Prognosekraft zeigen (Dynamik der Frühindikatoren, langfristig Schulden und Machtposition), zählen nicht.

**Grenzen des Backtests.** Ganz ausschließen lässt sich Rückschaufehler nicht: Auch die Prüfungen oben wurden in Kenntnis der Ergebnisse seit 1970 gewählt, und jede weitere Feinabstimmung am selben Backtest würde ihn eher vergrößern. Die eigentliche Bewährungsprobe ist die Echtzeit-Bilanz. Konjunkturdaten außer den Frühindikatoren (Baugenehmigungen, Kreditlücken, Fed Z.1) liegen nur im heutigen, revidierten Stand vor; vor 2001 auch die Frühindikatoren, dort mit der realistischen Frist von 45 Tagen. Vor 1990 beruhen manche Reihen auf Monatsmitteln. Beim Horizont 5–10 Jahre gibt es seit 1970 nur wenige unabhängige Zeiträume, die Intervalle sind breit; die JST-Prüfung ergänzt rund 350 Zeiträume, bildet das Modell außerhalb der USA aber nur näherungsweise nach (Bewertung über den Trendabstand). Am meisten Prognosekraft zeigte dort die Dividendenrendite, die für die meisten Märkte nicht frei und tagesaktuell verfügbar ist.

## Spannungsmonitor

Gemessen wird die Konfliktintensität je Länderpaar in der Weltpresse. Die Formel stammt von World Monitor: Σ Erwähnungen × max(0, −Goldstein) über Ereignisse der Klassen 3 und 4 (verbale und materielle Konflikte), je 10.000 Erwähnungen aller Ereignisse. Der Index ist das Perzentil des 7-Tage-Mittels innerhalb von 90 Tagen. Zusätzlich zeigt der Monitor die Abweichung der letzten 14 Tage vom Mittel der 120 Tage davor. Diese Abweichung steht in der Säule Risikoappetit des Barometers zur Information. In den Gesamtwert geht sie nicht ein: Ohne lange Historie lässt sie sich nicht im Backtest prüfen, und der geopolitische Risikoindex (GPR, seit 1985), der sich prüfen lässt, verbesserte die Vorhersagen dort nicht.

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

- **Monatswerte:** Für Aktien der Eurozone, Deutschlands, Großbritanniens, Chinas und Indiens in Landeswährung gibt es keine freie amtliche Tagesquelle. Sie kommen als Monatswerte von EZB und OECD und tragen im Barometer den Hinweis „Stand …“. Die Schwellenländer insgesamt und China, Indien, Taiwan, Korea und Brasilien in US-Dollar liegen über die Nasdaq-Indizes täglich vor.
- **Schwellenländer vor 2001:** Der Backtest rechnet mit dem BIP-gewichteten OECD-Korb. Er ist kein investierbarer Index und enthält in den 1970er-Jahren nur Indien, Südafrika und Mexiko; in den 1980er-Jahren kommen Israel, Korea, Griechenland und die Türkei hinzu, in den 1990er-Jahren Chile, Ungarn, Polen, Tschechien, Brasilien, Indonesien, Russland und China. Taiwan fehlt (nicht in der OECD-Statistik).
- **Rendite der Eidgenossen:** Der SNB-RSS-Kanal liefert nur den jüngsten Wert. Die Tageshistorie wächst daher erst mit dem Betrieb des Workers; bis dahin ergänzen Monatswerte die Reihe.
- **OECD:** drosselt Anfragen. Die OECD-Jobs laufen deshalb einzeln, nacheinander und höchstens einer je Lauf.
- **Bank of England:** blockiert gelegentlich Cloud-Adressen. Dann bleibt der letzte Stand stehen.
- **KV:** ist nur letztendlich konsistent. Neue Werte erscheinen nach bis zu 60 Sekunden, mit dem Edge-Cache nach bis zu 5 Minuten.
- **Archiv:** Die Historie reicht so weit zurück, wie die Quellen sie frei anbieten (der S&P 500 auf FRED etwa nur zehn Jahre; die lange Reihe seit 1950 kommt aus den Shiller-Daten der Pipeline, Präfix `h_`). Revisionen überschreiben den gespeicherten Wert in D1; die damaligen Fassungen bleiben seit Oktober 2026 als tägliche Rohausgabe im R2-Bucket (`quellen/…`) und je DBnomics-Stand (`dbnomics/…`) erhalten. Der gespeicherte Signalverlauf hält fest, was die Seite an jedem Tag angezeigt hat.
- **Prognosen:** Die Säulen der Horizonte 12 Monate und 5–10 Jahre nutzen IWF-Projektionen. Diese nimmt die Seite im jüngsten Stand; der Signalverlauf der letzten 24 Monate enthält daher etwas Wissen von heute, der Backtest ersetzt sie durch einfache Fortschreibungen. Die damaligen WEO-Ausgaben seit 2008 lädt der DBnomics-Import; sie sollen diese Fortschreibungen im Backtest ersetzen.
- **DBnomics:** Der Bestand ist so aktuell wie DBnomics selbst. Manche Datensätze aktualisiert DBnomics nur selten: Die jüngste WEO-Ausgabe dort ist die vom April 2025, die Konjunkturumfragen der EU-Kommission wurden zuletzt im Mai 2023 indexiert, mehrere Zentralbanken der Schwellenländer im April 2022. Die laufenden Werte kommen deshalb weiter aus den eigenen Abrufen bei den Quellen.
- **Goldnachfrage:** Die Daten des World Gold Council stehen in der Monatsübersicht Gold, zählen aber nicht im Signal. In der Prüfung 2003–2026 sagten die ETF-Zuflüsse der letzten drei Monate die Goldrendite des Folgemonats zwar voraus (Rangkorrelation +0,11, Zufallstest p = 0,03), folgen aber dem Kursmomentum (Rangkorrelation 0,46–0,57); ohne dieses bleibt +0,04 (p = 0,29). Die Zentralbanknachfrage wirkte nur ab 2019, davor gegenläufig; Preisaufschläge in China und Indien hatten keinen stabilen Zusammenhang. Die Dateien lädt man auf der Goldhub-Seite (kostenlose Anmeldung) und legt sie in den Eingang `eingang/wgc/`.
- **Treffsicherheit:** Vergangene Treffer sind keine Garantie für künftige (siehe [Backtest und Treffsicherheit](#backtest-und-treffsicherheit)).
- **Bewertung außerhalb der USA:** Für die meisten Aktienmärkte gibt es keine freie, laufend aktualisierte Bewertungshistorie (Dividendenrendite, KGV). Das Barometer nutzt dort den Abstand zum 20-Jahres-Trend, der in den JST-Daten deutlich schwächer war als die Dividendenrendite. Eine lizenzierte Quelle mit Länderbewertungen (etwa Global Financial Data) würde diese Lücke schließen.

## Lizenzen

- Schriften: Archivo und IBM Plex Mono, SIL Open Font License, selbst gehostet unter `public/fonts/`, ohne Anfragen an Google.
- Daten: Es gelten die Bedingungen der jeweiligen Quelle.
