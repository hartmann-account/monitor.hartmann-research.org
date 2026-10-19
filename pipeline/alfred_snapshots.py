#!/usr/bin/env python3
"""Echtzeit-Datenstände aus ALFRED ohne Schlüssel (für lokale Backtests).

Der Worker lädt die Datenstände mit Schlüssel über die ALFRED-Schnittstelle
(Job alfred_vintages, Tabelle vint in D1). Ohne Schlüssel liefert der freie
CSV-Export je Abruf die Stände zu mehreren Stichtagen; dieses Skript lädt sie zu
jedem Monatsende und bildet daraus dasselbe Format wie der Worker:
{"PERMIT": [[Datum, gültig ab, gültig bis, Wert], ...], ...}

Aufruf:
    python3 -I pipeline/alfred_snapshots.py --out alfred.json
    node scripts/backtest.mjs --local --alfred alfred.json
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import time
import urllib.error
import urllib.request

# Reihe: erster Monat mit Datenständen in ALFRED (Baugenehmigungen ab 1999, Z.1-Aktien ab 2013)
SERIES = {"PERMIT": "1999-09", "NCBEILQ027S": "2013-01", "FBCELLQ027S": "2013-01", "CMDEBT": "2013-01",
          "BCNSDODNS": "2013-01", "FGSDODNS": "2013-01", "SLGSDODNS": "2013-01", "DODFFSWCMI": "2013-01"}
PER_REQUEST = 12


def month_ends(start: str, until: dt.date) -> list[str]:
    y, m = int(start[:4]), int(start[5:7])
    out = []
    while True:
        nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
        last = nxt - dt.timedelta(days=1)
        if last > until:
            return out
        out.append(last.isoformat())
        y, m = nxt.year, nxt.month


def fetch(series: str, dates: list[str]) -> dict[str, dict[str, float]]:
    url = ("https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=" + ",".join([series] * len(dates)) +
           "&vintage_date=" + ",".join(dates))
    req = urllib.request.Request(url, headers={"User-Agent": "BigCycleMonitor/2.0"})
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = r.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:  # mindestens ein Stichtag vor dem ersten Datenstand: einzeln nachfragen
                if len(dates) == 1:
                    return {}
                out = {}
                for d in dates:
                    out.update(fetch(series, [d]))
                    time.sleep(1)
                return out
            print(f"{series}: HTTP {e.code}, neuer Versuch", flush=True)
            time.sleep(10 * attempt)
        except Exception as e:  # Netzwerkfehler, Abbruch der Verbindung, Zeitüberschreitung
            print(f"{series}: {e}, neuer Versuch", flush=True)
            time.sleep(10 * attempt)
    else:
        raise RuntimeError(f"ALFRED {series} nicht abrufbar")
    rows = list(csv.reader(io.StringIO(txt)))
    head = rows[0]
    out: dict[str, dict[str, float]] = {d: {} for d in dates}
    for k, col in enumerate(head[1:], start=1):
        d = col.rsplit("_", 1)[-1]
        vd = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        if vd not in out:
            continue
        for r in rows[1:]:
            try:
                out[vd][r[0]] = float(r[k])
            except (ValueError, IndexError):
                pass
    return out


def intervals(snaps: dict[str, dict[str, float]]) -> list[list]:
    """Monatsend-Stände → [Datum, gültig ab, gültig bis, Wert] (gültig bis: Tag vor dem nächsten abweichenden Stand)."""
    order = sorted(snaps)
    cur: dict[str, list] = {}
    out: list[list] = []
    for i, vd in enumerate(order):
        snap = snaps[vd]
        prev_day = (dt.date.fromisoformat(vd) - dt.timedelta(days=1)).isoformat()
        for d, v in snap.items():
            c = cur.get(d)
            if c is None or abs(c[3] - v) > 1e-9:
                if c is not None:
                    c[2] = prev_day
                    out.append(c)
                cur[d] = [d, vd, "9999-12-31", v]
        for d in [d for d in cur if d not in snap]:  # Datum fiel weg (Revision der Reihe)
            cur[d][2] = prev_day
            out.append(cur.pop(d))
    out.extend(cur.values())
    return sorted(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    today = dt.date.today()
    res = {}
    for s, start in SERIES.items():
        dates = month_ends(start, today)
        snaps: dict[str, dict[str, float]] = {}
        for i in range(0, len(dates), PER_REQUEST):
            part = dates[i:i + PER_REQUEST]
            got = fetch(s, part)
            snaps.update({d: v for d, v in got.items() if v})
            time.sleep(1.5)
        res[s] = intervals(snaps)
        print(f"{s}: {len(snaps)} Stände, {len(res[s])} Werte mit Gültigkeitszeitraum", flush=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(res, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
