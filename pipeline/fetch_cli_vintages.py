#!/usr/bin/env python3
"""Echtzeit-Datenstände der OECD-Frühindikatoren für den Backtest.

Lädt aus der OECD-Revisionsdatenbank (Main Economic Indicators: Original Release
Data and Revisions Database, Messgröße LI_AA) jede monatliche Ausgabe seit 2001
mit ihren jüngsten acht Monatswerten, so wie sie damals veröffentlicht wurden.
Der Backtest (worker/backtest.js, VINTAGE_IDS) rechnet damit ab 2001 ohne
nachträgliche Revisionen.

Aufruf:
    python3 -I pipeline/fetch_cli_vintages.py --out public/data/cli_vintages.json [--full]

Ohne --full werden nur die Ausgaben der letzten beiden Jahre neu geladen und mit
der vorhandenen Datei zusammengeführt.
Format: {"editions": {"USA": {"200101": ["2000-04", [8 Werte]], ...}, ...}}
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import time
import urllib.error
import urllib.request

AREAS = ["USA", "DEU", "JPN", "GBR", "CHN", "IND", "BRA", "MEX", "KOR", "ZAF", "IDN", "TUR", "G7", "G20", "G4E", "A5M"]
KEEP = 8
FIRST_YEAR = 2001
BASE = "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES_REVISIONS@DF_STES_REVISIONS,4.0/"


def add_months(ym: str, k: int) -> str:
    n = int(ym[:4]) * 12 + int(ym[5:7]) - 1 + k
    return f"{n // 12}-{n % 12 + 1:02d}"


def fetch_year(year: int) -> str:
    eds = "+".join(f"{year}{m:02d}" for m in range(1, 13))
    url = f"{BASE}{'+'.join(AREAS)}.M.LI_AA...{eds}?startPeriod={year - 2}-01&dimensionAtObservation=AllDimensions"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.sdmx.data+csv;version=2.0.0", "User-Agent": "BigCycleMonitor/2.0"})
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 404:  # Jahr ohne Ausgaben (noch nicht erschienen)
                return ""
            print(f"{year}: HTTP {e.code}, neuer Versuch", flush=True)
        except Exception as e:  # Netzwerkfehler, Zeitüberschreitung
            print(f"{year}: {e}, neuer Versuch", flush=True)
        time.sleep(15 * attempt)
    raise RuntimeError(f"OECD-Revisionsdatenbank: Ausgaben {year} nicht abrufbar")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--full", action="store_true")
    args = ap.parse_args()
    full = args.full or not os.path.exists(args.out)
    editions: dict = {} if full else json.load(open(args.out, encoding="utf-8"))["editions"]
    now = dt.datetime.now(dt.timezone.utc)
    years = list(range(FIRST_YEAR if full else now.year - 1, now.year + 1))
    added = 0
    for i, year in enumerate(years):
        by: dict = {}
        for r in csv.DictReader(io.StringIO(fetch_year(year))):
            try:
                v = float(r["OBS_VALUE"])
            except (TypeError, ValueError):
                continue
            by.setdefault(r["REF_AREA"], {}).setdefault(r["EDITION"], {})[r["TIME_PERIOD"]] = v
        for area, eds in by.items():
            for ed, obs in eds.items():
                start = add_months(max(obs), -(KEEP - 1))
                editions.setdefault(area, {})[ed] = [start, [obs.get(add_months(start, k)) for k in range(KEEP)]]
                added += 1
        print(f"{year}: {sum(len(e) for e in by.values())} Ausgaben", flush=True)
        if i < len(years) - 1:
            time.sleep(6)
    if not added and full:
        raise RuntimeError("keine Ausgaben geladen")
    editions = {a: dict(sorted(e.items())) for a, e in sorted(editions.items())}
    out = {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "OECD, Main Economic Indicators: Original Release Data and Revisions Database (LI_AA)",
           "keep": KEEP, "editions": editions}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print("gespeichert: " + ", ".join(f"{a} {len(e)}" for a, e in editions.items()))


if __name__ == "__main__":
    main()
