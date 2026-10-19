#!/usr/bin/env python3
"""Prüfung der Langfrist-Bausteine an der Jordà-Schularick-Taylor-Datenbank.

18 Industrieländer, Jahreswerte 1870-2020: Wie gut sagen die Bausteine des
Barometers (Horizont 5-10 Jahre) die realen 5-Jahres-Renditen voraus? Die
Länder und die Jahre vor 1970 wurden bei der Entwicklung des Modells nicht
verwendet; die Prüfung ergänzt den Backtest um rund 350 unabhängige
5-Jahres-Zeiträume.

Aufruf:
    python3 -I pipeline/jst_check.py --cache .cache --out public/data/jst_check.json

Benötigt die von build_data.py geladene Datei <cache>/jst/JSTdatasetR6.dta.
Rangkorrelation (Spearman) über alle Länder und Jahre je Zeitraum; Aktien mit
Dividenden, real; Anleihen real.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os

import numpy as np
import pandas as pd

PERIODS = [(1890, 1913), (1914, 1945), (1946, 1969), (1970, 1989), (1990, 2015)]


def clip2(x):
    return 2 * np.tanh(x / 2)


def real_index(ret: pd.Series, infl: pd.Series) -> pd.Series:
    """Realer Index aus Jahresrenditen; nach einer Lücke beginnt er neu."""
    out, v = [], 1.0
    for x in (1 + ret) / (1 + infl):
        v = v * x if pd.notna(x) else np.nan
        out.append(v)
        if pd.isna(v):
            v = 1.0
    return pd.Series(out, index=ret.index)


def panel(j: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for country, g in j.sort_values(["country", "year"]).groupby("country"):
        g = g.set_index("year").reindex(range(1870, 2021))
        infl = g.cpi / g.cpi.shift(1) - 1
        ri, rp, rb = real_index(g.eq_tr, infl), real_index(g.eq_capgain, infl), real_index(g.bond_tr, infl)
        lrp = np.log(rp)
        logret = np.log(ri / ri.shift(1))
        for t in range(1890, 2016):
            if pd.isna(ri.get(t)) or pd.isna(ri.get(t + 5)):
                continue
            rec = {"country": country, "year": t, "fwd": np.log(ri[t + 5] / ri[t])}
            if pd.notna(rb.get(t)) and pd.notna(rb.get(t + 5)):
                rec["fwd_bond"] = np.log(rb[t + 5] / rb[t])
            rets = logret.loc[t - 19:t].dropna()
            vol = rets.std() if len(rets) >= 10 else np.nan
            dp = g.eq_dp.loc[:t].dropna()
            if len(dp) >= 15 and dp.std() > 0:
                rec["dp_z"] = (dp.iloc[-1] - dp.mean()) / dp.std()
            y = lrp.loc[t - 19:t].dropna()
            if len(y) >= 15 and pd.notna(lrp.get(t)):
                x = np.array(y.index, float)
                b, a = np.polyfit(x, y.values, 1)
                res = y.values - (a + b * x)
                if res.std() > 0:
                    rec["tdev_z"] = (lrp[t] - (a + b * t)) / res.std()
                y10 = lrp.loc[t - 9:t].dropna()
                if pd.notna(vol) and vol > 0 and len(y10) >= 8:
                    b10 = np.polyfit(np.array(y10.index, float), y10.values, 1)[0]
                    r3 = lrp[t] - lrp.get(t - 3, np.nan)
                    rec["trend"] = np.nanmean([b10 / (vol * 0.5), r3 / (vol * np.sqrt(3)) if pd.notna(r3) else np.nan])
            if pd.notna(g.debtgdp.get(t)) and pd.notna(g.debtgdp.get(t - 5)):
                rec["debt_d5"] = 100 * (g.debtgdp[t] - g.debtgdp[t - 5])
            cg = g.tloans / g.gdp
            if pd.notna(cg.get(t)) and pd.notna(cg.get(t - 5)):
                rec["credit_d5"] = 100 * (cg[t] - cg[t - 5])
            if pd.notna(g.rgdpmad.get(t)) and pd.notna(g.rgdpmad.get(t - 10)):
                rec["growth10"] = 100 * np.log(g.rgdpmad[t] / g.rgdpmad[t - 10]) / 10
            i3 = infl.loc[t - 2:t].mean()
            if pd.notna(g.ltrate.get(t)) and pd.notna(i3):
                rec["real_y"] = g.ltrate[t] - 100 * i3
            rows.append(rec)
    d = pd.DataFrame(rows)
    # relativ: Abstand zum Mittel aller Länder im selben Jahr
    for col in ["dp_z", "tdev_z", "trend", "fwd"]:
        d[col + "_x"] = d[col] - d.groupby("year")[col].transform("mean")
    return d


def ic(d: pd.DataFrame, sig: str, ret: str, sign: float) -> tuple[float | None, int]:
    x = d[[sig, ret]].dropna()
    if len(x) < 30:
        return None, len(x)
    return float((sign * x[sig]).rank().corr(x[ret].rank())), len(x)


SIGNALS = [
    ("dp", "dp_z", "fwd", 1, "Aktien: Dividendenrendite gegenüber der eigenen Historie (hoch = günstig)"),
    ("tdev", "tdev_z", "fwd", -1, "Aktien: Abstand zum 20-Jahres-Trend, antizyklisch (Bewertung im Modell außerhalb der USA)"),
    ("trend", "trend", "fwd", 1, "Aktien: Langfristtrend prozyklisch (bis Oktober 2026 im Modell)"),
    ("growth", "growth10", "fwd", 1, "Aktien: Wirtschaftswachstum der letzten 10 Jahre (hoch = positiv)"),
    ("debt", "debt_d5", "fwd", -1, "Aktien: Staatsschulden steigend (negativ)"),
    ("credit", "credit_d5", "fwd", -1, "Aktien: Kreditboom (negativ)"),
    ("bond", "real_y", "fwd_bond", 1, "Staatsanleihen: Realrendite (hoch = günstig)"),
    ("rel_dp", "dp_z_x", "fwd_x", 1, "Länder untereinander: Dividendenrendite"),
    ("rel_tdev", "tdev_z_x", "fwd_x", -1, "Länder untereinander: Trendabstand, antizyklisch"),
    ("rel_trend", "trend_x", "fwd_x", -1, "Länder untereinander: Langfristtrend, antizyklisch"),
]


def combos(d: pd.DataFrame) -> dict:
    """Langfrist-Gesamtwert für Aktien mit den bisherigen und den neuen Gewichten (Näherung mit JST-Größen)."""
    v = {"val": clip2(-d.tdev_z / 1.2), "gro": clip2((d.growth10 - 2.0) / 1.5), "debt": clip2(-d.debt_d5 / 15), "trend": clip2(d.trend)}
    variants = {
        "bisher": {"val": .55, "gro": .20, "debt": .05, "trend": .15},
        "neu": {"val": 1.0},
    }
    out = {}
    for name, w in variants.items():
        num = sum(v[k].fillna(0) * x for k, x in w.items())
        den = sum(v[k].notna() * abs(x) for k, x in w.items())
        score = (num / den.replace(0, np.nan)).where(den >= 0.3)
        dd = pd.DataFrame({"score": score, "fwd": d.fwd, "year": d.year})
        out[name] = {}
        for a, b in PERIODS + [(1890, 2015)]:
            x = dd[(dd.year >= a) & (dd.year <= b)].dropna()
            out[name][f"{a}-{b}"] = round(float(x.score.rank().corr(x.fwd.rank())), 3)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=".cache")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    j = pd.read_stata(os.path.join(args.cache, "jst", "JSTdatasetR6.dta"))
    d = panel(j)
    res = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "Jordà-Schularick-Taylor Macrohistory Database, Release 6",
           "countries": sorted(d.country.unique().tolist()), "periods": [f"{a}-{b}" for a, b in PERIODS] + ["1890-2015"],
           "signals": [], "model": combos(d)}
    for key, sig, ret, sign, label in SIGNALS:
        row = {"key": key, "label": label, "ic": {}, "n": {}}
        for a, b in PERIODS + [(1890, 2015)]:
            r, n = ic(d[(d.year >= a) & (d.year <= b)], sig, ret, sign)
            row["ic"][f"{a}-{b}"] = None if r is None else round(r, 3)
            row["n"][f"{a}-{b}"] = n
        res["signals"].append(row)
        print(f"{label[:70]:70s} " + "  ".join(f"{p}: {('%+.3f' % v) if v is not None else '  –  '}" for p, v in row["ic"].items()))
    print("Gesamtwert Aktien (Näherung):", json.dumps(res["model"]))
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
