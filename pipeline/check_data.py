#!/usr/bin/env python3
"""Plausibilitätsprüfung für public/data/bigcycle.json. Bricht mit Exit-Code 1 ab, wenn
Pflichtreihen fehlen oder Werte außerhalb plausibler Bereiche liegen."""
import json
import sys

REQUIRED_SERIES = ["us_debt_gdp", "us_10y", "us_cpi_infl", "gold_usd", "gpr_hist_m", "polar_usa", "us_tariff_eff"]
OPTIONAL_RANGES = {"cape": (5, 80)}
RANGES = {  # Schlüssel in latest: (min, max)
    "debt_public_gdp_now": (40, 250), "us10y": (0, 20), "cpi_yoy": (-5, 30), "fedfunds": (0, 25),
    "gold_m": (200, 20000), "top1_wealth": (10, 60), "tariff_eff_q": (0, 60),
}


def main(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    problems = []
    for k in REQUIRED_SERIES:
        s = d["series"].get(k)
        if not s or not s.get("values") or all(v is None for v in s["values"][-5:]):
            problems.append(f"Reihe fehlt oder endet leer: {k}")
    for k, (lo, hi) in OPTIONAL_RANGES.items():  # fehlen darf der Wert, falsch sein nicht
        v = d["latest"].get(k, {}).get("value")
        if v is not None and not (lo <= v <= hi):
            problems.append(f"Wert außerhalb des Bereichs: {k} = {v}")
    for k, (lo, hi) in RANGES.items():
        v = d["latest"].get(k, {}).get("value")
        if v is None or not (lo <= v <= hi):
            problems.append(f"Wert außerhalb des Bereichs: {k} = {v}")
    for m, per in d["power"]["score"].items():
        for c, arr in per.items():
            last = [v for v in arr[-10:] if v is not None]
            if not last:
                problems.append(f"Machtindex ohne aktuelle Werte: {m}/{c}")
    if d["meta"].get("fetchErrors"):
        print("Hinweis, Downloadfehler:", *d["meta"]["fetchErrors"], sep="\n  ")
    if problems:
        print("Prüfung fehlgeschlagen:", *problems, sep="\n  ")
        sys.exit(1)
    print("Prüfung bestanden.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/data/bigcycle.json")
