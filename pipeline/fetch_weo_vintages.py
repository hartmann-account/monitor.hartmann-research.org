#!/usr/bin/env python3
"""Echtzeit-Datenstände der IWF-Prognosen (World Economic Outlook) für den Backtest.

Lädt über DBnomics jede Ausgabe des World Economic Outlook seit April 2008 (Frühjahr und
Herbst; die Ausgabe vom September 2011 fehlt dort) mit den sechs Kennzahlen, die das Modell
nutzt, für die 18 Länder des Monitors und den Euroraum: Vergangenheit im damaligen Stand und
Projektionen für die folgenden Jahre, so wie sie damals veröffentlicht wurden. Der Backtest
(worker/backtest.js, prepWeo) nimmt damit zum Stichtag die jüngste erschienene Ausgabe statt
einer naiven Fortschreibung.

Aufruf:
    python3 -I pipeline/fetch_weo_vintages.py --out public/data/weo_vintages.json [--full]

Ohne --full werden nur Ausgaben geladen, die in der Datei noch fehlen.
Format: {"editions": {"2008-04": {"growth_usa": [1990, [Werte ab 1990]], ...}, ...}}
Quelle: IWF, World Economic Outlook (über DBnomics, Datensätze IMF/WEO:JJJJ-MM und IMF/WEOAGG:JJJJ-MM).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

# Kennzahl des IWF → Präfix der Reihen im Monitor (wie worker/jobs-macro.js, WEO)
SUBJECTS = {"NGDP_RPCH": "growth_", "PCPIPCH": "infl_", "BCA_NGDPD": "ca_", "GGXCNL_NGDP": "bal_", "GGXWDG_NGDP": "debt_", "PPPSH": "ppp_"}
COUNTRIES = ["USA", "CHN", "DEU", "JPN", "GBR", "IND", "RUS", "CHE", "TWN", "IRN", "ISR", "UKR", "KOR", "BRA", "MEX", "ZAF", "IDN", "TUR"]
# Euroraum: Ländergruppe 163 im Datensatz der Aggregate
GROUPS = {"163": "euro"}
FIRST_YEAR = 1990
API = "https://api.db.nomics.world/v22"


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "BigCycleMonitor/2.0"})
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
            print(f"HTTP {e.code}, neuer Versuch", flush=True)
        except Exception as e:  # Netzwerkfehler, Zeitüberschreitung
            print(f"{e}, neuer Versuch", flush=True)
        time.sleep(10 * attempt)
    raise RuntimeError(f"DBnomics nicht erreichbar: {url}")


def editions_available() -> list[str]:
    codes, offset = [], 0
    while True:  # höchstens 500 Datensätze je Seite
        docs = get(f"{API}/datasets/IMF?limit=500&offset={offset}").get("datasets", {}).get("docs", [])
        codes += [d.get("code", "") for d in docs]
        if len(docs) < 500:
            break
        offset += 500
    return sorted({c.split(":")[1] for c in codes if c.startswith("WEO:")})


def series(dataset: str, dim: str, codes: list[str]) -> list[dict]:
    q = {"dimensions": json.dumps({dim: codes, "weo-subject": list(SUBJECTS)}), "observations": "1", "limit": "1000"}
    j = get(f"{API}/series/IMF/{dataset}?{urllib.parse.urlencode(q)}")
    return j.get("series", {}).get("docs", []) if j else []


def edition(ed: str) -> dict:
    out: dict = {}
    for dataset, dim, codes, names in ((f"WEO:{ed}", "weo-country", COUNTRIES, None), (f"WEOAGG:{ed}", "weo-countries-group", list(GROUPS), GROUPS)):
        for s in series(dataset, dim, codes):
            d = s.get("dimensions", {})
            code, subj = d.get(dim), d.get("weo-subject")
            if subj not in SUBJECTS or code is None:
                continue
            obs = {}
            for p, v in zip(s.get("period", []), s.get("value", [])):
                try:
                    year, x = int(p[:4]), float(v)
                except (TypeError, ValueError):
                    continue
                if year >= FIRST_YEAR:
                    obs[year] = round(x, 3)
            if not obs:
                continue
            y0, y1 = min(obs), max(obs)
            out[SUBJECTS[subj] + (names[code] if names else code.lower())] = [y0, [obs.get(y) for y in range(y0, y1 + 1)]]
        time.sleep(1)
    return dict(sorted(out.items()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--full", action="store_true")
    args = ap.parse_args()
    full = args.full or not os.path.exists(args.out)
    editions: dict = {} if full else json.load(open(args.out, encoding="utf-8"))["editions"]
    todo = [ed for ed in editions_available() if full or ed not in editions]
    for ed in todo:
        e = edition(ed)
        if e:
            editions[ed] = e
        print(f"{ed}: {len(e)} Reihen", flush=True)
    if not editions:
        raise RuntimeError("keine Ausgaben geladen")
    out = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "IWF, World Economic Outlook (Ausgaben April und Oktober), über DBnomics",
           "editions": dict(sorted(editions.items()))}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"gespeichert: {len(editions)} Ausgaben, {sum(len(e) for e in editions.values())} Reihen")


if __name__ == "__main__":
    main()
