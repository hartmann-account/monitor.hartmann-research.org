#!/usr/bin/env python3
"""Big-Cycle-Monitor: Datenpipeline.

Lädt offene Zeitreihen, harmonisiert sie und schreibt public/data/bigcycle.json.
Die Pipeline verwendet keine Daten von Ray Dalio oder Bridgewater, sondern
frei zugängliche Proxy-Reihen für die Messgrößen seines Rahmenwerks.

Aufruf:
    python3 -I pipeline/build_data.py --cache .cache --out public/data/bigcycle.json
    python3 -I pipeline/build_data.py --cache .cache --out public/data/bigcycle.json --refresh

--refresh lädt alle Quellen neu; ohne den Schalter werden vorhandene
Cache-Dateien wiederverwendet. Kuratierte Angaben (Ereignisse, Stichtagswerte
ohne API) liegen in pipeline/curated.json und werden unverändert übernommen.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.request
import zipfile

import numpy as np
import pandas as pd

UA = "bigcycle-monitor/0.1 (+https://github.com/)"
Y0, Y1 = 1820, 2026          # Zeitraum des Machtindex
YEARS = np.arange(Y0, Y1 + 1)
NY = len(YEARS)

# Acht Länder: die drei Reservewährungsimperien seit 1600 (NLD, GBR, USA), der Herausforderer (CHN)
# und die übrigen Großmächte des Untersuchungszeitraums. Farbe im Frontend folgt dieser Reihenfolge.
CTRY = ["USA", "CHN", "GBR", "NLD", "DEU", "JPN", "RUS", "IND"]
CTRY_DE = {
    "USA": "USA", "CHN": "China", "GBR": "Vereinigtes Königreich", "NLD": "Niederlande",
    "DEU": "Deutschland", "FRA": "Frankreich", "JPN": "Japan", "RUS": "Russland/UdSSR",
    "IND": "Indien", "ESP": "Spanien",
}
OWID_NAME = {
    "USA": "United States", "CHN": "China", "GBR": "United Kingdom", "NLD": "Netherlands",
    "DEU": "Germany", "FRA": "France", "JPN": "Japan", "RUS": "Russia", "IND": "India",
    "ESP": "Spain",
}

# ----------------------------------------------------------------------------
# Quellenregister (Download-Ziele). Zitate für OWID-Reihen werden aus den
# Metadaten der jeweiligen Datei übernommen, nicht von Hand formuliert.
# ----------------------------------------------------------------------------
OWID_SLUGS = [
    "gdp-maddison-project-database", "global-gdp-over-the-long-run", "population",
    "military-spending-gmsd", "military-spending-sipri", "military-personnel",
    "nuclear-warhead-stockpiles", "merchandise-exports-gdp-cepii",
    "national-gdp-fouquin-current-gbp", "mean-years-of-schooling-long-run",
    "share-of-the-population-with-completed-tertiary-education", "research-spending-gdp",
    "annual-patent-applications", "political-polarization-score", "liberal-democracy-index",
    "income-share-top-1-before-tax-wid-extrapolations", "wealth-share-richest",
    "public-trust-in-government", "global-deaths-in-violent-political-conflicts-over-the-long-run",
    "deaths-in-armed-conflicts", "deaths-in-state-based-conflicts-by-type",
    "uk-government-debt-as-a-percentage-of-gdp-17272016", "temperature-anomaly",
    "natural-disasters-by-type",
]
OWID_EXTRA_QUERY = {"wealth-share-richest": "&quantile=richest_1pct"}

FRED_IDS = [
    "GFDEGDQ188S", "FYGFGDQ188S", "FYGFDPUN", "A091RC1Q027SBEA", "FGRECPT", "FYOINT", "FYFR",
    "FYFSD", "FYFSGDA188S", "FYOIGDA188S", "GDP", "GDPA", "FYGDP", "FEDFUNDS", "GS10", "TB3MS",
    "CPIAUCNS", "UNRATE", "WALCL", "BOGMBASE", "M2SL", "QUSPAM770A", "QUSGAM770A",
    "B235RC1A027NBEA", "B235RC1Q027SBEA", "A255RC1A027NBEA", "A255RC1Q027SBEA",
    "WFRBST01134", "GFDGDPA188S", "FDHBFIN", "DGS10", "DFF", "DFEDTARU", "DFEDTARL",
]
WB_IDS = ["NE.EXP.GNFS.CD", "CM.MKT.LCAP.CD", "NY.GDP.MKTP.PP.CD", "NY.GDP.MKTP.CD",
          "NE.TRD.GNFS.ZS"]
IMF_DM_IDS = ["d", "ie", "DEBT1", "PPPSH", "GGXWDG_NGDP", "BCA_NGDPD"]

URLS = {
    "shiller": ("shiller/ie_data.xls", "http://www.econ.yale.edu/~shiller/data/ie_data.xls"),
    "gpr": ("gpr/data_gpr_export.xls", "https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls"),
    "jst": ("jst/JSTdatasetR6.dta", "https://www.macrohistory.net/app/download/9834512469/JSTdatasetR6.dta?t=1720600177"),
    "cow": ("cow/NMCv7.zip", "https://correlatesofwar.org/wp-content/uploads/NMCv7.zip"),
    "gold": ("gold/monthly.csv", "https://raw.githubusercontent.com/datasets/gold-prices/main/data/monthly.csv"),
    "voteview": ("voteview/HSall_parties.csv", "https://voteview.com/static/data/out/parties/HSall_parties.csv"),
    "nobel": ("nobel/laureates.json", "https://api.nobelprize.org/2.1/laureates?limit=1500"),
    "boe": ("boe/millennium.xlsx", "https://www.bankofengland.co.uk/-/media/boe/files/statistics/research-datasets/a-millennium-of-macroeconomic-data-for-the-uk.xlsx"),
    "treasury_debt": ("treasury/debt_to_penny.json", "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=400"),
    "treasury_rates": ("treasury/avg_rates.json", "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=5000"),
    "treasury_mts1": ("treasury/mts1.json", "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_1?sort=-record_date&page[size]=400"),
    "treasury_mts9": ("treasury/mts9.json", "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_9?sort=-record_date&page[size]=1000"),
    "cofer": ("imf_cofer/cofer.csv", "https://api.imf.org/external/sdmx/2.1/data/IMF.STA,COFER/?startPeriod=1990"),
}


# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------
def download(url: str, path: str, refresh: bool, headers: dict | None = None, tries: int = 3) -> None:
    if os.path.exists(path) and os.path.getsize(path) > 0 and not refresh:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    hdr = {"User-Agent": UA}
    hdr.update(headers or {})
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=hdr)
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            if len(data) < 50:
                raise RuntimeError(f"Antwort zu kurz ({len(data)} Bytes)")
            tmp = path + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            return
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"Download fehlgeschlagen: {url}: {last}")


def fetch_all(cache: str, refresh: bool) -> list[str]:
    errors = []

    def safe(url, path, headers=None):
        try:
            download(url, path, refresh, headers)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))
            print("WARN", e, file=sys.stderr)

    for s in OWID_SLUGS:
        q = OWID_EXTRA_QUERY.get(s, "")
        base = f"https://ourworldindata.org/grapher/{s}"
        safe(f"{base}.csv?v=1&csvType=full&useColumnShortNames=true{q}", os.path.join(cache, "owid", f"{s}.csv"))
        safe(f"{base}.metadata.json?v=1&csvType=full&useColumnShortNames=true{q}", os.path.join(cache, "owid", f"{s}.meta.json"))
    for sid in FRED_IDS:
        safe(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", os.path.join(cache, "fred", f"{sid}.csv"))
    for ind in WB_IDS:
        safe(f"https://api.worldbank.org/v2/country/all/indicator/{ind}?format=json&per_page=20000&date=1960:{Y1}",
             os.path.join(cache, "wb", f"{ind}.json"))
    for ind in IMF_DM_IDS:
        safe(f"https://www.imf.org/external/datamapper/api/v1/{ind}", os.path.join(cache, "imf_dm", f"{ind}.json"))
    for key, (rel, url) in URLS.items():
        hdr = {"Accept": "application/vnd.sdmx.data+csv;version=1.0.0"} if key == "cofer" else None
        safe(url, os.path.join(cache, rel), hdr)
    cow_zip = os.path.join(cache, "cow", "NMCv7.zip")
    if os.path.exists(cow_zip):
        with zipfile.ZipFile(cow_zip) as z:
            inner = [n for n in z.namelist() if n.endswith("NMC-v7-abridged.zip")]
            if inner:
                with z.open(inner[0]) as f, zipfile.ZipFile(f) as z2:
                    for n in z2.namelist():
                        if n.endswith(".csv"):
                            os.makedirs(os.path.join(cache, "cow", "nmc"), exist_ok=True)
                            with z2.open(n) as src, open(os.path.join(cache, "cow", "nmc", os.path.basename(n)), "wb") as dst:
                                dst.write(src.read())
    return errors


# ----------------------------------------------------------------------------
# Hilfsfunktionen
# ----------------------------------------------------------------------------
def r4(x, nd=4):
    """Rundet auf nd signifikante Stellen; NaN -> None."""
    if x is None:
        return None
    try:
        xf = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(xf):
        return None
    if xf == 0:
        return 0
    return float(f"{xf:.{nd}g}")


def arr(values, nd=4):
    return [r4(v, nd) for v in values]


def interp_annual(points: dict, years=YEARS, log=False, extrapolate=False, max_gap=None):
    """Interpoliert Stützstellen {jahr: wert} auf jährliche Werte.
    Liefert (werte, flags) mit flag 0 = beobachtet, 1 = interpoliert,
    2 = fortgeschrieben (nur wenn extrapolate=True)."""
    out = np.full(len(years), np.nan)
    flags = np.full(len(years), -1, dtype=int)
    pts = sorted((int(k), float(v)) for k, v in points.items() if v is not None and np.isfinite(v) and (not log or v > 0))
    if not pts:
        return out, flags
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    yv = np.log(ys) if log else ys
    for i, y in enumerate(years):
        if y in points and np.isfinite(points.get(y, np.nan)) and (not log or points[y] > 0):
            out[i] = points[y]
            flags[i] = 0
        elif xs[0] <= y <= xs[-1]:
            j = np.searchsorted(xs, y)
            gap = xs[j] - xs[j - 1]
            if max_gap is not None and gap > max_gap:
                continue
            v = np.interp(y, xs, yv)
            out[i] = math.exp(v) if log else v
            flags[i] = 1
        elif extrapolate and y > xs[-1]:
            out[i] = ys[-1]
            flags[i] = 2
    return out, flags


def series_points(df: pd.DataFrame, entity: str, col: str) -> dict:
    d = df[(df.entity == entity)][["year", col]].dropna()
    return {int(y): float(v) for y, v in zip(d.year, d[col])}


def owid_df(cache: str, slug: str) -> pd.DataFrame:
    return pd.read_csv(os.path.join(cache, "owid", f"{slug}.csv"), low_memory=False)


def owid_meta(cache: str, slug: str) -> dict:
    p = os.path.join(cache, "owid", f"{slug}.meta.json")
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        m = json.load(f)
    cols = m.get("columns", {})
    first = next((v for k, v in cols.items() if k != "owid_region"), {})
    return {
        "title": first.get("titleShort") or first.get("title") or m.get("chart", {}).get("title"),
        "citation": first.get("citationFull") or first.get("citationShort"),
        "citationShort": first.get("citationShort"),
        "unit": first.get("unit"),
        "lastUpdated": first.get("lastUpdated"),
        "nextUpdate": first.get("nextUpdate"),
    }


def is_aggregate(code, entity) -> bool:
    if isinstance(code, str):
        return code in {"OWID_WRL", "OWID_AFR", "OWID_ASI", "OWID_EUR", "OWID_NAM", "OWID_SAM", "OWID_OCE",
                        "OWID_EU27", "OWID_HIC", "OWID_LIC", "OWID_LMC", "OWID_UMC"}
    # Einträge ohne Code: Aggregate und Regionen, historische Gebilde behalten
    keep = {"British India", "Zollverein", "German Democratic Republic", "Hawaii", "Hesse-Darmstadt (Ducal)",
            "Hesse-Kassel (Electoral)", "Mecklenburg-Schwerin", "Papal States"}
    return entity not in keep


def world_sum(df: pd.DataFrame, col: str, drop_dupes=True) -> dict:
    d = df[[not is_aggregate(c, e) for c, e in zip(df.code, df.entity)]][["entity", "year", col]].dropna()
    if drop_dupes:
        # Doppelzählungen vermeiden: West-/Gesamtdeutschland, UdSSR/Russland
        g = set(zip(d.entity, d.year))
        mask = []
        for e, y in zip(d.entity, d.year):
            if e == "West Germany" and ("Germany", y) in g:
                mask.append(False)
            elif e == "USSR" and ("Russia", y) in g:
                mask.append(False)
            else:
                mask.append(True)
        d = d[mask]
    return d.groupby("year")[col].sum().to_dict()


def share_from(points_c: dict, points_w: dict) -> dict:
    return {y: 100.0 * v / points_w[y] for y, v in points_c.items() if y in points_w and points_w[y]}


def fred(cache: str, sid: str) -> pd.Series:
    d = pd.read_csv(os.path.join(cache, "fred", f"{sid}.csv"))
    d.columns = ["date", "value"]
    d["date"] = pd.to_datetime(d["date"])
    d["value"] = pd.to_numeric(d["value"], errors="coerce")
    return d.dropna().set_index("date")["value"]


def annual_mean(s: pd.Series) -> dict:
    g = s.groupby(s.index.year).mean()
    return {int(k): float(v) for k, v in g.items()}


def wb(cache: str, ind: str) -> pd.DataFrame:
    with open(os.path.join(cache, "wb", f"{ind}.json"), encoding="utf-8") as f:
        meta, rows = json.load(f)
    d = pd.DataFrame([{"iso": r["countryiso3code"], "year": int(r["date"]), "value": r["value"]} for r in rows if r["value"] is not None])
    return d


def imf_dm(cache: str, ind: str) -> dict:
    with open(os.path.join(cache, "imf_dm", f"{ind}.json"), encoding="utf-8") as f:
        v = json.load(f)["values"][ind]
    return {iso: {int(y): float(x) for y, x in s.items() if x is not None} for iso, s in v.items()}


def to_annual_series(points: dict, y0: int, y1: int, nd=4):
    vals = [points.get(y) for y in range(y0, y1 + 1)]
    return {"start": y0, "values": arr(vals, nd)}


def trim(points: dict) -> tuple[int, int]:
    ks = [k for k, v in points.items() if v is not None and np.isfinite(v)]
    return (min(ks), max(ks)) if ks else (None, None)


def ann(points: dict, nd=4) -> dict:
    a, b = trim(points)
    if a is None:
        return {"start": None, "values": []}
    return to_annual_series(points, a, b, nd)


# ----------------------------------------------------------------------------
# Machtmessgrößen (Anteile in Prozent)
# ----------------------------------------------------------------------------
def m_output(cache):
    """Anteil am Welt-BIP (Kaufkraftparitäten). Maddison 1820-2022, IMF PPPSH ab 2023."""
    df = owid_df(cache, "gdp-maddison-project-database")
    col = "gdp"
    pts = {c: series_points(df, OWID_NAME[c], col) for c in CTRY}
    ussr = series_points(df, "USSR", col)
    # Russland: UdSSR bis 1990, danach Russland
    pts["RUS"] = {y: v for y, v in ussr.items() if y <= 1990} | {y: v for y, v in pts["RUS"].items() if y >= 1991}
    world = series_points(df, "World", col)
    yrs = np.arange(1820, 2023)
    core = {c: interp_annual(pts[c], yrs, log=True)[0] for c in CTRY if c != "RUS"}
    core["USSR"] = interp_annual(ussr, yrs, log=True)[0]
    bench = sorted(world)
    world_est = np.full(len(yrs), np.nan)
    for regime, ylo, yhi, members in [("a", 1820, 1870, [c for c in core if c != "USSR"]),
                                      ("b", 1870, 2022, list(core))]:
        rows = {}
        for b in bench:
            if ylo <= b <= yhi:
                i = b - 1820
                s = sum(core[m][i] for m in members)
                if np.isfinite(s) and world[b] > s:
                    rows[b] = world[b] - s
        row, _ = interp_annual(rows, yrs, log=True)
        for i, y in enumerate(yrs):
            if ylo <= y <= yhi and (regime == "b" or y < 1870):
                s = sum(core[m][i] for m in members)
                if np.isfinite(s) and np.isfinite(row[i]):
                    world_est[i] = s + row[i]
    share = {}
    flags = {}
    for c in CTRY:
        v, f = interp_annual(pts[c], yrs, log=True)
        sh = 100 * v / world_est
        share[c] = {int(y): float(s) for y, s in zip(yrs, sh) if np.isfinite(s)}
        flags[c] = {int(y): int(fl) for y, fl in zip(yrs, f) if fl >= 0}
    # Fortschreibung 2023-2026 mit IMF-WEO-Anteilen (Verhältnisverkettung)
    ppp = imf_dm(cache, "PPPSH")
    for c in CTRY:
        p = ppp.get(c, {})
        if 2022 in share[c] and 2022 in p and p[2022]:
            for y in range(2023, Y1 + 1):
                if y in p:
                    share[c][y] = share[c][2022] * p[y] / p[2022]
                    flags[c][y] = 3  # Prognose/Schätzung IMF
    # Vor-1820-Stützpunkte (Weltwert aus der Langfristreihe, auf Preisbasis 2011 umgerechnet)
    lr = owid_df(cache, "global-gdp-over-the-long-run")
    lrw = series_points(lr, "World", "gdp")
    ratio = lrw[1820] / world[1820]
    bench_pre = {}
    for y in [1500, 1600, 1700, 1820]:
        wv = lrw[y] / ratio
        bench_pre[y] = {c: r4(100 * pts[c][y] / wv) for c in CTRY if y in pts[c]}
    return share, flags, bench_pre


def m_trade(cache):
    """Anteil an den Weltexporten. CEPII TRADHIST 1827-1969 (Waren), Weltbank 1970+ (Waren und Dienste)."""
    ex = owid_df(cache, "merchandise-exports-gdp-cepii")
    gd = owid_df(cache, "national-gdp-fouquin-current-gbp")
    ecol = [c for c in ex.columns if c.startswith("value_of_global")][0]
    gcol = [c for c in gd.columns if c.startswith("gdp__")][0]
    m = ex.merge(gd[["entity", "year", gcol]], on=["entity", "year"], how="left")
    # Fallback für Deutschland 1950-1990: BIP der Bundesrepublik
    gfr = gd[gd.entity == "West Germany"].set_index("year")[gcol].to_dict()
    mask = (m.entity == "Germany") & m[gcol].isna()
    m.loc[mask, gcol] = m.loc[mask, "year"].map(gfr)
    m["exp"] = m[ecol] / 100 * m[gcol]
    m = m[[not is_aggregate(c, e) for c, e in zip(m.code, m.entity)]]
    wsum = m.groupby("year")["exp"].sum().to_dict()
    cep = {}
    for c in CTRY:
        names = [OWID_NAME[c]] + (["British India"] if c == "IND" else [])
        d = m[m.entity.isin(names)].groupby("year")["exp"].sum(min_count=1).dropna().to_dict()
        if c == "DEU":
            zv = m[(m.entity == "Zollverein") & (m.year < 1871)].set_index("year")["exp"].dropna().to_dict()
            d = zv | d
        cep[c] = share_from(d, wsum)
    w = wb(cache, "NE.EXP.GNFS.CD")
    wld = w[w.iso == "WLD"].set_index("year")["value"].to_dict()
    share, flags = {}, {}
    for c in CTRY:
        wc = w[w.iso == c].set_index("year")["value"].to_dict()
        wbs = share_from(wc, wld)
        ov = [wbs[y] / cep[c][y] for y in range(1970, 2015) if y in wbs and y in cep[c] and cep[c][y] > 0][:10]
        ratio = float(np.clip(np.mean(ov), 0.6, 1.6)) if ov else 1.0
        s = {y: v * ratio for y, v in cep[c].items() if y >= 1870}
        f = {y: 0 for y in s}
        for y, v in wbs.items():
            if y >= 1970:
                s[y] = v
                f[y] = 0
        last = max(s)
        for y in range(last + 1, Y1 + 1):
            s[y] = s[last]
            f[y] = 2
        share[c], flags[c] = s, f
    return share, flags


def m_military(cache):
    """Militärausgaben (GMSD, SIPRI-verkettet), Streitkräfte (COW), Atomsprengköpfe (FAS)."""
    g = owid_df(cache, "military-spending-gmsd")
    gw = world_sum(g, "milex_estimate")
    sp = owid_df(cache, "military-spending-sipri")
    spw = series_points(sp, "World", "constant_usd")
    per = owid_df(cache, "military-personnel")
    pw = world_sum(per, "milper")
    nu = owid_df(cache, "nuclear-warhead-stockpiles")
    nw = series_points(nu, "World", "number_of_warheads")
    comps = {"spend": {}, "personnel": {}, "nuclear": {}}
    for c in CTRY:
        s = share_from(series_points(g, OWID_NAME[c], "milex_estimate"), gw)
        ss = share_from(series_points(sp, OWID_NAME[c], "constant_usd"), spw)
        base = max([y for y in s if y in ss and ss[y] > 0] or [0])
        if base:
            for y in range(base + 1, Y1 + 1):
                if y in ss:
                    s[y] = s[base] * ss[y] / ss[base]
        comps["spend"][c] = s
        pc = series_points(per, OWID_NAME[c], "milper")
        if c == "DEU":
            pc = series_points(per, "West Germany", "milper") | pc
        comps["personnel"][c] = share_from(pc, pw)
        nc = series_points(nu, OWID_NAME[c], "number_of_warheads")
        comps["nuclear"][c] = {y: 100 * nc.get(y, 0.0) / nw[y] for y in nw if nw[y] > 0}
    return comps


def m_education(cache):
    """Bestand an Schuljahren und an Hochschulabsolventen (Lee & Lee) gewichtet mit der Bevölkerung."""
    my = owid_df(cache, "mean-years-of-schooling-long-run")
    mcol = [c for c in my.columns if c.startswith("mf_")][0]
    te = owid_df(cache, "share-of-the-population-with-completed-tertiary-education")
    tcol = [c for c in te.columns if c.startswith("mf_")][0]
    pop = owid_df(cache, "population")
    pcol = "population_historical"

    def pop_at(entity, years):
        v, _ = interp_annual(series_points(pop, entity, pcol), np.array(years), log=True)
        return dict(zip(years, v))

    comps = {"schooling": {}, "tertiary": {}, "schooling_pc": {}}
    w_my = series_points(my, "World", mcol)
    w_te = series_points(te, "World", tcol)
    ylist = sorted(w_my)
    wpop = pop_at("World", ylist)
    for c in CTRY:
        name = OWID_NAME[c]
        cp = pop_at(name, ylist)
        cm = series_points(my, name, mcol)
        ct = series_points(te, name, tcol)
        comps["schooling"][c] = {y: 100 * cm[y] * cp[y] / (w_my[y] * wpop[y]) for y in ylist if y in cm and np.isfinite(cp[y])}
        comps["tertiary"][c] = {y: 100 * ct[y] * cp[y] / (w_te[y] * wpop[y]) for y in ylist if y >= 1950 and y in ct and y in w_te and w_te[y] > 0 and np.isfinite(cp[y])}
        comps["schooling_pc"][c] = dict(cm)
    return comps


NOBEL_SCI = {"Physics", "Chemistry", "Physiology or Medicine"}
NOBEL_MAP = {
    "USA": "USA", "United States": "USA", "China": "CHN", "United Kingdom": "GBR", "Scotland": "GBR",
    "England": "GBR", "Northern Ireland": "GBR", "the Netherlands": "NLD", "Netherlands": "NLD",
    "Germany": "DEU", "West Germany (Germany)": "DEU", "Federal Republic of Germany": "DEU",
    "Prussia (Germany)": "DEU", "Prussia": "DEU", "France": "FRA", "Japan": "JPN", "Russia": "RUS",
    "USSR (now Russia)": "RUS", "USSR": "RUS", "Russian Federation": "RUS", "India": "IND",
    "British India (now India)": "IND", "Spain": "ESP",
}


def m_innovation(cache):
    """Nobelpreise (Naturwissenschaften, gleitende 20 Jahre), F&E-Ausgaben (KKP), Patentanmeldungen."""
    with open(os.path.join(cache, "nobel", "laureates.json"), encoding="utf-8") as f:
        L = json.load(f)["laureates"]
    per_year = {}
    for lau in L:
        for p in lau.get("nobelPrizes", []):
            cat = p.get("category", {}).get("en")
            if cat not in NOBEL_SCI:
                continue
            y = int(p["awardYear"])
            try:
                num, den = p.get("portion", "1").split("/") if "/" in p.get("portion", "1") else (1, 1)
                portion = float(num) / float(den)
            except ValueError:
                portion = 1.0
            affs = p.get("affiliations") or []
            ctry = []
            for a in affs:
                n = (a.get("country") or {}).get("en") or (a.get("countryNow") or {}).get("en")
                nn = (a.get("countryNow") or {}).get("en")
                iso = NOBEL_MAP.get(n) or NOBEL_MAP.get(nn) or "OTHER"
                ctry.append(iso)
            if not ctry:
                bp = ((lau.get("birth") or {}).get("place") or {})
                nn = (bp.get("countryNow") or {}).get("en")
                ctry = [NOBEL_MAP.get(nn, "OTHER")]
            dct = per_year.setdefault(y, {})
            for iso in ctry:
                dct[iso] = dct.get(iso, 0.0) + portion / len(ctry)
    years = sorted(per_year)
    nobel = {c: {} for c in CTRY}
    for y in range(1910, max(years) + 1):
        win = [yy for yy in range(y - 19, y + 1) if yy in per_year]
        tot = sum(sum(per_year[yy].values()) for yy in win)
        if tot <= 0:
            continue
        for c in CTRY:
            nobel[c][y] = 100 * sum(per_year[yy].get(c, 0.0) for yy in win) / tot
    rd = owid_df(cache, "research-spending-gdp")
    gdpppp = wb(cache, "NY.GDP.MKTP.PP.CD")
    wppp = gdpppp[gdpppp.iso == "WLD"].set_index("year")["value"].to_dict()
    wrd = series_points(rd, "World", "gb_xpd_rsdv_gd_zs")
    rdshare = {}
    for c in CTRY:
        cr = series_points(rd, OWID_NAME[c], "gb_xpd_rsdv_gd_zs")
        cp = gdpppp[gdpppp.iso == c].set_index("year")["value"].to_dict()
        rdshare[c] = {y: 100 * cr[y] * cp[y] / (wrd[y] * wppp[y]) for y in cr if y in cp and y in wrd and y in wppp}
    pa = owid_df(cache, "annual-patent-applications")
    pw = series_points(pa, "World", "ip_pat_resd")
    pat = {c: share_from(series_points(pa, OWID_NAME[c], "ip_pat_resd"), pw) for c in CTRY}
    nob_counts = {y: {k: r4(v, 3) for k, v in d.items() if k in CTRY or k == "OTHER"} for y, d in per_year.items()}
    return {"nobel": nobel, "rd": rdshare, "patents": pat}, nob_counts


COW_MAP = {"USA": ["USA"], "CHN": ["CHN"], "GBR": ["UKG"], "NLD": ["NTH"], "DEU": ["GMY", "GFR"],
           "FRA": ["FRN"], "JPN": ["JPN"], "RUS": ["RUS"], "IND": ["IND"], "ESP": ["SPN"]}


def m_industry(cache):
    """Industriebasis (COW NMC v7): Anteil an Eisen-/Stahlproduktion und Primärenergieverbrauch."""
    d = pd.read_csv(os.path.join(cache, "cow", "nmc", "NMC-70-abridged.csv"))
    d = d.replace(-9, np.nan)
    comps = {"steel": {}, "energy": {}}
    for var, key in [("irst", "steel"), ("pec", "energy")]:
        w = d.groupby("year")[var].sum(min_count=1).to_dict()
        for c in CTRY:
            sub = d[d.stateabb.isin(COW_MAP[c])].groupby("year")[var].sum(min_count=1).dropna().to_dict()
            comps[key][c] = share_from(sub, w)
    return comps


def m_current_account(cache):
    """Leistungsbilanzsaldo in % des BIP, logistisch auf 0-100 skaliert (Score = 100/(1+exp(-ca/2.5)))."""
    j = pd.read_stata(os.path.join(cache, "jst", "JSTdatasetR6.dta"))
    j["ca_pct"] = 100 * j["ca"] / j["gdp"]
    weo = {}
    with open(os.path.join(cache, "imf_dm", "BCA_NGDPD.json"), encoding="utf-8") as f:
        v = json.load(f)["values"]["BCA_NGDPD"]
    weo = {iso: {int(y): float(x) for y, x in d.items() if x is not None} for iso, d in v.items()}
    raw, score = {}, {}
    for c in CTRY:
        pts = j[j.iso == c].set_index("year")["ca_pct"].dropna().to_dict()
        pts = {int(y): float(x) for y, x in pts.items() if int(y) < 1980} | weo.get(c, {})
        pts = {y: x for y, x in pts.items() if Y0 <= y <= Y1}
        raw[c] = pts
        # 5-Jahres-Mittel (mind. 3 Beobachtungen), um Kriegs- und Sondereffekte zu glätten
        sm = {}
        for y in pts:
            win = [pts[k] for k in range(y - 4, y + 1) if k in pts]
            if len(win) >= 3:
                sm[y] = sum(win) / len(win)
        score[c] = {y: 100.0 / (1.0 + math.exp(-x / 2.5)) for y, x in sm.items()}
    return {"ca": score}, raw


def m_finance(cache):
    """Anteil an der Weltbörsenkapitalisierung (Weltbank, 1975+)."""
    w = wb(cache, "CM.MKT.LCAP.CD")
    wld = w[w.iso == "WLD"].set_index("year")["value"].to_dict()
    return {"mcap": {c: share_from(w[w.iso == c].set_index("year")["value"].to_dict(), wld) for c in CTRY}}


EMU = [c for c in ["DEU", "FRA", "NLD", "ESP"] if c in CTRY]


def m_reserve(cache):
    """Anteil an den Weltdevisenreserven (IMF COFER). Euro anteilig nach BIP-Gewicht im Euroraum."""
    c = pd.read_csv(os.path.join(cache, "imf_cofer", "cofer.csv"),
                    usecols=["COUNTRY", "INDICATOR", "FXR_CURRENCY", "TYPE_OF_TRANSFORMATION", "FREQUENCY", "TIME_PERIOD", "OBS_VALUE"])
    c = c[(c.COUNTRY == "G001") & (c.INDICATOR == "AFXRA") & (c.TYPE_OF_TRANSFORMATION == "SHRO_PT")]
    c["year"] = c.TIME_PERIOD.astype(str).str[:4].astype(int)
    ann_ = c[c.FREQUENCY == "A"].groupby(["FXR_CURRENCY", "year"]).OBS_VALUE.mean()
    q = c[c.FREQUENCY == "Q"].groupby(["FXR_CURRENCY", "year"]).OBS_VALUE.mean()
    sh = pd.concat([ann_[ann_.index.get_level_values(1) < 1999], q]).to_dict()
    latest_q = c[(c.FREQUENCY == "Q")].sort_values("TIME_PERIOD").TIME_PERIOD.iloc[-1]
    cur = {"USA": "CI_USD", "GBR": "CI_GBP", "JPN": "CI_JPY", "CHN": "CI_CNY", "DEU": "CI_DEM", "FRA": "CI_FRF", "NLD": "CI_NLG"}
    g = wb(cache, "NY.GDP.MKTP.CD")
    emu = g[g.iso == "EMU"].set_index("year")["value"].to_dict()
    out = {k: {} for k in CTRY}
    for (cc, y), v in sh.items():
        for iso, code in cur.items():
            if cc == code and iso in out:
                out[iso][y] = v
        if cc == "CI_EUR":
            for iso in EMU:
                gi = g[(g.iso == iso) & (g.year == min(y, 2025))]["value"]
                ge = emu.get(min(y, 2025))
                if len(gi) and ge:
                    out[iso][y] = out[iso].get(y, 0.0) + v * float(gi.iloc[0]) / ge
    last_y = max(y for (_, y) in sh)
    for iso in CTRY:
        for y in range(1995, last_y + 1):
            out[iso].setdefault(y, 0.0)
    cofer_latest = {k[0]: r4(v) for k, v in c[c.TIME_PERIOD == latest_q].set_index(["FXR_CURRENCY", "TIME_PERIOD"]).OBS_VALUE.items()}
    return {"cofer": out}, latest_q, cofer_latest


MEASURES = [
    # id, Label, Komponenten (id, Gewicht), Fortschreibung bis Y1
    ("education", "Bildung", [("schooling", 1 / 3), ("tertiary", 1 / 3), ("schooling_pc", 1 / 3)]),
    ("innovation", "Innovation & Technologie", [("nobel", 0.4), ("rd", 0.4), ("patents", 0.2)]),
    ("competitiveness", "Wettbewerbsfähigkeit", [("steel", 1 / 3), ("energy", 1 / 3), ("ca", 1 / 3)]),
    ("output", "Wirtschaftsleistung", [("gdp", 1.0)]),
    ("trade", "Welthandel", [("exports", 1.0)]),
    ("military", "Militärische Stärke", [("spend", 0.6), ("personnel", 0.25), ("nuclear", 0.15)]),
    ("finance", "Finanzzentrum", [("mcap", 1.0)]),
    ("reserve", "Reservewährung", [("cofer", 1.0)]),
]
COMP_META = {
    "schooling": ("Bestand an Schuljahren (Anteil an der Welt)", "%", ["owid_leelee", "owid_pop"]),
    "tertiary": ("Bestand an Hochschulabsolventen (Anteil an der Welt)", "%", ["owid_tertiary", "owid_pop"]),
    "schooling_pc": ("Durchschnittliche Schuljahre der 15- bis 64-Jährigen", "Jahre", ["owid_leelee"]),
    "nobel": ("Naturwissenschaftliche Nobelpreise, Anteil (20 Jahre gleitend)", "%", ["nobel"]),
    "rd": ("F&E-Ausgaben zu Kaufkraftparitäten (Anteil an der Welt)", "%", ["owid_rd", "wb"]),
    "patents": ("Patentanmeldungen von Inländern (Anteil an der Welt)", "%", ["owid_patents"]),
    "steel": ("Eisen- und Stahlproduktion (Anteil an der Welt)", "%", ["cow"]),
    "energy": ("Primärenergieverbrauch (Anteil an der Welt)", "%", ["cow"]),
    "ca": ("Leistungsbilanzsaldo, 5-Jahres-Mittel, logistisch skaliert (50 = ausgeglichen)", "Score 0–100", ["jst", "imf_weo"]),
    "gdp": ("BIP zu Kaufkraftparitäten (Anteil an der Welt)", "%", ["maddison", "imf_weo"]),
    "exports": ("Exporte (Anteil an den erfassten Weltexporten)", "%", ["owid_cepii", "owid_cepii_gdp", "wb"]),
    "spend": ("Militärausgaben (Anteil an der Welt)", "%", ["owid_gmsd", "owid_sipri"]),
    "personnel": ("Streitkräfte (Anteil an der Welt)", "%", ["owid_milper"]),
    "nuclear": ("Atomsprengköpfe (Anteil an der Welt)", "%", ["owid_fas"]),
    "mcap": ("Börsenkapitalisierung (Anteil an der Welt)", "%", ["wb"]),
    "cofer": ("Anteil an den Weltdevisenreserven", "%", ["imf_cofer", "wb"]),
}
# Komponenten, die nach dem letzten Beobachtungsjahr flach fortgeschrieben werden (max. Jahre)
CARRY = {"schooling": 6, "tertiary": 6, "schooling_pc": 6, "ca": 0, "nobel": 0, "rd": 6, "patents": 5, "steel": 4, "energy": 4,
         "spend": 1, "personnel": 4, "nuclear": 0, "mcap": 4, "cofer": 0, "gdp": 0, "exports": 2}
LINEAR = {"schooling", "tertiary", "schooling_pc"}  # Stützstellen alle 5 Jahre -> linear interpolieren


def build_power(cache):
    out_share, flags_out = {}, {}
    gdp_share, gdp_flags, bench_pre = m_output(cache)
    trade_share, trade_flags = m_trade(cache)
    comps = {}
    comps.update({"gdp": gdp_share, "exports": trade_share})
    comps.update(m_military(cache))
    comps.update(m_education(cache))
    inn, nob_counts = m_innovation(cache)
    comps.update(inn)
    comps.update(m_industry(cache))
    ca_score, ca_raw = m_current_account(cache)
    comps.update(ca_score)
    comps.update(m_finance(cache))
    res, cofer_q, cofer_latest = m_reserve(cache)
    comps.update(res)

    comp_arr, comp_flag = {}, {}
    for comp, per in comps.items():
        comp_arr[comp], comp_flag[comp] = {}, {}
        for c in CTRY:
            pts = {y: v for y, v in per.get(c, {}).items() if Y0 <= y <= Y1}
            v, f = interp_annual(pts, YEARS, log=False, extrapolate=False,
                                 max_gap=6 if comp in LINEAR else 3)
            if pts:
                last = max(pts)
                for i, y in enumerate(YEARS):
                    if last < y <= last + CARRY.get(comp, 0):
                        v[i] = pts[last]
                        f[i] = 2
            if comp == "gdp":
                for i, y in enumerate(YEARS):
                    fl = gdp_flags[c].get(int(y))
                    if fl is not None and np.isfinite(v[i]):
                        f[i] = fl
            comp_arr[comp][c] = v
            comp_flag[comp][c] = f
    # Glättung (zentriertes 5-Jahres-Mittel, mind. 3 Werte) und Normierung je Komponente auf das
    # historische Maximum der acht Länder. Kriegsjahre (1914-1919, 1939-1946) zählen nicht zum Maximum,
    # weil die Länderabdeckung der Weltsummen dort lückenhaft ist; Werte darüber werden auf 1 begrenzt.
    war = np.array([(1914 <= y <= 1919) or (1939 <= y <= 1946) for y in YEARS])
    comp_norm = {}
    comp_max = {}
    comp_smooth = {}
    for comp, per in comp_arr.items():
        sm = {c: pd.Series(per[c]).rolling(5, center=True, min_periods=3).mean().to_numpy(copy=True) for c in CTRY}
        for c in CTRY:
            sm[c][~np.isfinite(per[c])] = np.nan
        comp_smooth[comp] = sm
        stack = np.vstack([sm[c][~war] for c in CTRY])
        mx = np.nanmax(stack)
        comp_max[comp] = mx
        comp_norm[comp] = {c: np.clip(sm[c] / mx, 0, 1) for c in CTRY}
    measures = {}
    for mid, label, parts in MEASURES:
        mat = {}
        for c in CTRY:
            num = np.zeros(NY)
            den = np.zeros(NY)
            for comp, w in parts:
                v = comp_norm[comp][c]
                ok = np.isfinite(v)
                num[ok] += w * v[ok]
                den[ok] += w
            with np.errstate(invalid="ignore", divide="ignore"):
                mat[c] = np.where(den > 0, num / den, np.nan)
        mx = np.nanmax(np.vstack([mat[c][~war] for c in CTRY]))
        measures[mid] = {c: np.clip(mat[c] / mx, 0, 1) for c in CTRY}
    power = {
        "years": [int(y) for y in YEARS],
        "countries": [{"id": c, "name": CTRY_DE[c]} for c in CTRY],
        "measures": [{"id": m, "label": l, "components": [{"id": k, "w": w} for k, w in p]} for m, l, p in MEASURES],
        "score": {m: {c: arr(measures[m][c], 4) for c in CTRY} for m in measures},
        "components": {comp: {
            "label": COMP_META.get(comp, (comp, "", []))[0],
            "unit": COMP_META.get(comp, (comp, "", []))[1],
            "src": COMP_META.get(comp, (comp, "", []))[2],
            "max": r4(comp_max[comp]),
            "share": {c: arr(comp_arr[comp][c], 4) for c in CTRY},
            "flag": {c: [int(x) if x >= 0 else None for x in comp_flag[comp][c]] for c in CTRY},
        } for comp in comp_arr},
        "outputBenchmarks": bench_pre,
        "caRaw": {c: {str(y): r4(v, 3) for y, v in sorted(ca_raw[c].items())} for c in CTRY},
        "nobelCounts": {str(k): v for k, v in sorted(nob_counts.items())},
        "coferLatestQuarter": cofer_q,
        "coferLatest": cofer_latest,
    }
    return power


# ----------------------------------------------------------------------------
# Schuldenzyklus, innere und äußere Ordnung: Zeitreihen
# ----------------------------------------------------------------------------
def yoy_annual_cpi(s: pd.Series) -> dict:
    a = annual_mean(s)
    return {y: 100 * (a[y] / a[y - 1] - 1) for y in a if y - 1 in a}


def build_series(cache):
    S = {}

    def put(key, label, unit, src, points=None, monthly=None, nd=4, note=None):
        e = {"label": label, "unit": unit, "src": src}
        if points is not None:
            e.update(ann(points, nd))
            e["freq"] = "A"
        if monthly is not None:
            e["freq"] = "M"
            e["start"] = monthly.index[0].strftime("%Y-%m")
            e["values"] = arr(monthly.values, nd)
        if note:
            e["note"] = note
        S[key] = e

    # --- USA: Staatsverschuldung
    hpdd = imf_dm(cache, "DEBT1").get("USA", {})
    fpp = imf_dm(cache, "d").get("USA", {})
    weo = imf_dm(cache, "GGXWDG_NGDP").get("USA", {})
    us_debt = {y: v for y, v in hpdd.items() if y < 1929} | dict(fpp)
    put("us_debt_gdp", "Staatsschulden USA (brutto)", "% des BIP", ["imf_hpdd", "imf_fpp"], us_debt)
    put("us_debt_gdp_weo", "Staatsschulden USA, IWF-Projektion", "% des BIP", ["imf_weo"],
        {y: v for y, v in weo.items() if y >= max(fpp) - 1})
    fq = fred(cache, "FYGFGDQ188S")
    put("us_debt_public_gdp", "Bundesschuld in Händen der Öffentlichkeit", "% des BIP", ["fred:FYGFGDQ188S"],
        {int(k): float(v) for k, v in fq.groupby(fq.index.year).last().items()})
    put("us_interest_gdp", "Zinsausgaben des Staates USA", "% des BIP", ["imf_fpp_ie", "fred:FYOIGDA188S"],
        imf_dm(cache, "ie").get("USA", {}) | annual_from_fred_fy(cache, "FYOIGDA188S", only_after=max(imf_dm(cache, "ie").get("USA", {1929: 0}))))
    fyoint = fred(cache, "FYOINT")
    fyfr = fred(cache, "FYFR")
    ir = {int(d.year): 100 * v / fyfr.get(d) for d, v in fyoint.items() if d in fyfr.index and fyfr.get(d)}
    put("us_interest_revenue", "Zinsausgaben des Bundes in % der Einnahmen", "% der Einnahmen",
        ["fred:FYOINT", "fred:FYFR"], ir)
    ip = fred(cache, "A091RC1Q027SBEA")
    rc = fred(cache, "FGRECPT")
    q = (100 * ip / rc).dropna()
    put("us_interest_receipts_q", "Zinszahlungen in % der laufenden Einnahmen (NIPA, quartalsweise)", "%",
        ["fred:A091RC1Q027SBEA", "fred:FGRECPT"], None)
    S["us_interest_receipts_q"].update({"freq": "Q", "start": f"{q.index[0].year}-Q{(q.index[0].month-1)//3+1}", "values": arr(q.values)})
    put("us_deficit_gdp", "Haushaltssaldo des Bundes", "% des BIP", ["fred:FYFSGDA188S"], annual_from_fred_fy(cache, "FYFSGDA188S"))
    pr = fred(cache, "QUSPAM770A")
    gv = fred(cache, "QUSGAM770A")
    put("us_private_credit_gdp", "Kredite an private Nichtfinanzsektoren", "% des BIP", ["fred:QUSPAM770A"],
        {int(k): float(v) for k, v in pr.groupby(pr.index.year).last().items()})
    put("us_gov_credit_gdp", "Kredite an den Gesamtstaat (Marktwerte)", "% des BIP", ["fred:QUSGAM770A"],
        {int(k): float(v) for k, v in gv.groupby(gv.index.year).last().items()})

    # --- USA: Zinsen, Inflation, Gold, Geldmenge
    sh = pd.read_excel(os.path.join(cache, "shiller", "ie_data.xls"), sheet_name="Data", header=7)
    sh = sh[pd.to_numeric(sh["Date"], errors="coerce").notna()].copy()
    sh["year"] = sh["Date"].astype(float).astype(int)
    sh_gs10 = pd.to_numeric(sh["Rate GS10"], errors="coerce").groupby(sh["year"]).mean().dropna().to_dict()
    sh_cpi = pd.to_numeric(sh["CPI"], errors="coerce").groupby(sh["year"]).mean().dropna().to_dict()
    gs10 = annual_mean(fred(cache, "GS10"))
    put("us_10y", "Rendite 10-jähriger US-Staatsanleihen", "%", ["shiller", "fred:GS10"],
        {y: v for y, v in sh_gs10.items() if y < 1953} | gs10)
    put("us_10y_m", "Rendite 10-jähriger US-Staatsanleihen (Monatsmittel)", "%", ["fred:GS10"], monthly=fred(cache, "GS10")[lambda x: x.index >= "1990-01-01"])
    put("us_fedfunds_m", "Federal Funds Rate (Monatsmittel)", "%", ["fred:FEDFUNDS"], monthly=fred(cache, "FEDFUNDS")[lambda x: x.index >= "1990-01-01"])
    tb = annual_mean(fred(cache, "TB3MS"))
    put("us_3m", "Rendite 3-monatiger US-Schatzwechsel", "%", ["fred:TB3MS"], tb)
    ff = annual_mean(fred(cache, "FEDFUNDS"))
    put("us_fedfunds", "Federal Funds Rate", "%", ["fred:FEDFUNDS"], ff)
    cpi = fred(cache, "CPIAUCNS")
    infl = yoy_annual_cpi(cpi)
    sh_infl = {y: 100 * (sh_cpi[y] / sh_cpi[y - 1] - 1) for y in sh_cpi if y - 1 in sh_cpi and y < 1914}
    us_infl = sh_infl | infl
    put("us_cpi_infl", "Inflation USA (Verbraucherpreise)", "% ggü. Vorjahr", ["shiller", "fred:CPIAUCNS"], us_infl)
    ten = {y: v for y, v in sh_gs10.items() if y < 1953} | gs10
    real = {y: ten[y] - us_infl[y] for y in ten if y in us_infl}
    put("us_real_10y", "Realrendite 10 Jahre (ex post)", "%", ["shiller", "fred:GS10", "fred:CPIAUCNS"], real)
    gold = pd.read_csv(os.path.join(cache, "gold", "monthly.csv"))
    gold["date"] = pd.to_datetime(gold["Date"])
    gser = gold.set_index("date")["Price"]
    put("gold_usd", "Goldpreis", "USD je Feinunze (Jahresmittel)", ["gold"], annual_mean(gser))
    gm = gser[gser.index >= "1960-01-01"]
    put("gold_usd_m", "Goldpreis (Monatsmittel)", "USD je Feinunze", ["gold"], monthly=gm)
    # Realer Goldpreis in Preisen des letzten Jahres
    cpi_a = annual_mean(cpi) | {y: v for y, v in sh_cpi.items() if y < 1913}
    ga = annual_mean(gser)
    ly = max(y for y in ga if y in cpi_a)
    put("gold_real", "Goldpreis real (in Preisen von %d)" % ly, "USD je Feinunze", ["gold", "shiller", "fred:CPIAUCNS"],
        {y: ga[y] * cpi_a[ly] / cpi_a[y] for y in ga if y in cpi_a})
    gdp_q = fred(cache, "GDP")
    gdp_a = annual_mean(gdp_q)
    walcl = fred(cache, "WALCL")
    wa = annual_mean(walcl)
    put("us_fed_assets_gdp", "Bilanzsumme der Federal Reserve", "% des BIP", ["fred:WALCL", "fred:GDP"],
        {y: 100 * (wa[y] / 1000) / gdp_a[y] for y in wa if y in gdp_a})
    mb = annual_mean(fred(cache, "BOGMBASE"))
    put("us_base_gdp", "Geldbasis", "% des BIP", ["fred:BOGMBASE", "fred:GDP"],
        {y: 100 * mb[y] / gdp_a[y] for y in mb if y in gdp_a})
    # Effektiver Zollsatz: Zolleinnahmen / Warenimporte (NIPA)
    cd = annual_mean(fred(cache, "B235RC1A027NBEA"))
    im = annual_mean(fred(cache, "A255RC1A027NBEA"))
    tar = {y: 100 * cd[y] / im[y] for y in cd if y in im and im[y]}
    cdq = fred(cache, "B235RC1Q027SBEA")
    imq = fred(cache, "A255RC1Q027SBEA")
    yq = cdq[cdq.index.year > max(tar)]
    if len(yq):
        y = int(yq.index[-1].year)
        tar[y] = 100 * float(cdq[cdq.index.year == y].mean()) / float(imq[imq.index.year == y].mean())
    put("us_tariff_eff", "Effektiver US-Zollsatz (Zolleinnahmen/Warenimporte)", "%", ["fred:B235RC1A027NBEA", "fred:A255RC1A027NBEA"], tar)

    # --- Vereinigtes Königreich (britischer Zyklus)
    ukd = owid_df(cache, "uk-government-debt-as-a-percentage-of-gdp-17272016")
    uk_debt = series_points(ukd, "United Kingdom", "uk_government_debt__pct_of_nominal_gdp")
    fppg = imf_dm(cache, "d").get("GBR", {})
    uk_debt |= {y: v for y, v in fppg.items() if y > max(uk_debt)}
    put("uk_debt_gdp", "Staatsschulden Vereinigtes Königreich", "% des BIP", ["owid_boe", "imf_fpp"], uk_debt)
    put("uk_interest_gdp", "Zinsausgaben Vereinigtes Königreich", "% des BIP", ["imf_fpp_ie"], imf_dm(cache, "ie").get("GBR", {}))
    boe = load_boe(cache)
    for k, (lab, unit) in {"uk_consol": ("Rendite langfristiger britischer Staatsanleihen (Consols)", "%"),
                           "uk_infl": ("Inflation Vereinigtes Königreich", "% ggü. Vorjahr"),
                           "uk_bankrate": ("Bank Rate (Bank of England)", "%")}.items():
        if boe.get(k):
            put(k, lab, unit, ["boe"], boe[k])
    nl = imf_dm(cache, "d").get("NLD", {})
    put("nl_debt_gdp", "Staatsschulden Niederlande", "% des BIP", ["imf_fpp"], nl)
    for iso, key in [("CHN", "cn_debt_gdp"), ("JPN", "jp_debt_gdp"), ("DEU", "de_debt_gdp"), ("FRA", "fr_debt_gdp")]:
        put(key, f"Staatsschulden {CTRY_DE[iso]}", "% des BIP", ["imf_fpp"], imf_dm(cache, "d").get(iso, {}))

    # --- Innere Ordnung
    pol = owid_df(cache, "political-polarization-score")
    lib = owid_df(cache, "liberal-democracy-index")
    for iso in ["USA", "CHN", "GBR", "DEU", "FRA"]:
        put(f"polar_{iso.lower()}", f"Polarisierung der Gesellschaft ({CTRY_DE[iso]})", "V-Dem-Score",
            ["vdem"], series_points(pol, OWID_NAME[iso], "v2cacamps__estimate_best"))
        put(f"libdem_{iso.lower()}", f"Liberaler Demokratieindex ({CTRY_DE[iso]})", "0–1",
            ["vdem"], series_points(lib, OWID_NAME[iso], "libdem_vdem__estimate_best"))
    inc = owid_df(cache, "income-share-top-1-before-tax-wid-extrapolations")
    icol = "share_top_1__welfare_type_before_tax__extrapolated_no"
    put("us_top1_income", "Einkommensanteil oberstes 1 % (vor Steuern) USA", "%", ["wid"], series_points(inc, "United States", icol))
    wea = owid_df(cache, "wealth-share-richest")
    wcol = [c for c in wea.columns if c.startswith("share_top_1")][0]
    for iso in ["USA", "GBR", "FRA", "CHN"]:
        put(f"top1_wealth_{iso.lower()}", f"Vermögensanteil oberstes 1 % ({CTRY_DE[iso]})", "%", ["wid"],
            series_points(wea, OWID_NAME[iso], wcol))
    dfa = fred(cache, "WFRBST01134")
    put("us_top1_wealth_dfa", "Vermögensanteil oberstes 1 % USA (Fed DFA)", "%", ["fred:WFRBST01134"],
        {int(k): float(v) for k, v in dfa.groupby(dfa.index.year).last().items()})
    tr = owid_df(cache, "public-trust-in-government")
    put("us_trust_gov", "Vertrauen in die Bundesregierung (USA)", "% der Befragten", ["pew"],
        series_points(tr, "United States", "trust_us_government_smoothed"))
    vv = pd.read_csv(os.path.join(cache, "voteview", "HSall_parties.csv"))
    for ch, key in [("House", "us_congress_polar_house"), ("Senate", "us_congress_polar_senate")]:
        sub = vv[(vv.chamber == ch) & (vv.party_code.isin([100, 200]))].pivot_table(index="congress", columns="party_code", values="nominate_dim1_median")
        sub = sub.dropna()
        pts = {int(1789 + 2 * (cg - 1)): float(r[200] - r[100]) for cg, r in sub.iterrows()}
        put(key, f"Abstand der Parteimediane ({'Repräsentantenhaus' if ch == 'House' else 'Senat'})",
            "DW-NOMINATE, 1. Dimension", ["voteview"], pts)
    un = annual_mean(fred(cache, "UNRATE"))
    put("us_misery", "Misery-Index (Arbeitslosenquote + Inflation)", "%", ["fred:UNRATE", "fred:CPIAUCNS"],
        {y: un[y] + infl[y] for y in un if y in infl})

    # --- Äußere Ordnung
    g = pd.read_excel(os.path.join(cache, "gpr", "data_gpr_export.xls"))
    g["month"] = pd.to_datetime(g["month"])
    g = g.set_index("month")
    put("gpr_hist_m", "Geopolitischer Risikoindex (historisch, ab 1900)", "Index", ["gpr"], monthly=g["GPRH"].dropna())
    put("gpr_hist", "Geopolitischer Risikoindex (historisch)", "Index, Jahresmittel", ["gpr"], annual_mean(g["GPRH"].dropna()))
    for iso in ["USA", "CHN"]:
        col = f"GPRHC_{iso}"
        if col in g.columns:
            put(f"gpr_hist_{iso.lower()}", f"Geopolitisches Risiko mit Bezug auf {CTRY_DE[iso]}", "Index, Jahresmittel",
                ["gpr"], annual_mean(g[col].dropna()))
    lr = owid_df(cache, "global-deaths-in-violent-political-conflicts-over-the-long-run")
    put("conflict_deaths_longrun", "Todesopfer in Konflikten weltweit (Conflict Catalog)", "Todesopfer pro Jahr",
        ["owid_conflict_catalog"], series_points(lr, "World", "number_deaths_ongoing_conflicts__conflict_type_all"), nd=3)
    ac = owid_df(cache, "deaths-in-state-based-conflicts-by-type")
    acols = [c for c in ac.columns if c.startswith("number_deaths")]
    w = ac[ac.entity == "World"].set_index("year")[acols].sum(axis=1, min_count=1).dropna().to_dict()
    put("conflict_deaths_ucdp", "Todesopfer in staatlichen Konflikten weltweit (UCDP/PRIO)", "Todesopfer pro Jahr",
        ["owid_ucdp"], {int(k): float(v) for k, v in w.items()}, nd=3)
    inter_col = [c for c in acols if c.endswith("interstate")]
    if inter_col:
        wi = ac[ac.entity == "World"].set_index("year")[inter_col[0]].dropna().to_dict()
        put("conflict_deaths_interstate", "Todesopfer in zwischenstaatlichen Konflikten (UCDP/PRIO)", "Todesopfer pro Jahr",
            ["owid_ucdp"], {int(k): float(v) for k, v in wi.items()}, nd=3)
    ex = owid_df(cache, "merchandise-exports-gdp-cepii")
    ecol = [c for c in ex.columns if c.startswith("value_of_global")][0]
    put("world_exports_gdp", "Weltwarenexporte in % des Welt-BIP (CEPII)", "%", ["owid_cepii"], series_points(ex, "World", ecol))
    t = wb(cache, "NE.TRD.GNFS.ZS")
    put("world_trade_gdp", "Welthandel (Exporte + Importe) in % des Welt-BIP", "%", ["wb"],
        t[t.iso == "WLD"].set_index("year")["value"].to_dict())
    sp = owid_df(cache, "military-spending-sipri")
    for iso in ["USA", "CHN", "RUS"]:
        put(f"milex_{iso.lower()}", f"Militärausgaben {CTRY_DE[iso]} (SIPRI, konstante US-$)", "Mrd. US-$",
            ["owid_sipri"], {y: v / 1e9 for y, v in series_points(sp, OWID_NAME[iso], "constant_usd").items()})
    nu = owid_df(cache, "nuclear-warhead-stockpiles")
    for iso in ["USA", "RUS", "CHN"]:
        put(f"nukes_{iso.lower()}", f"Atomsprengköpfe {CTRY_DE[iso]}", "Anzahl", ["owid_fas"],
            series_points(nu, OWID_NAME[iso], "number_of_warheads"))

    # --- Natur
    ta = owid_df(cache, "temperature-anomaly")
    put("temp_anomaly", "Globale Temperaturabweichung (ggü. 1861–1890)", "°C", ["owid_temp"],
        series_points(ta, "World", "near_surface_temperature_anomaly"))
    nd_ = owid_df(cache, "natural-disasters-by-type")
    if "entity" in nd_.columns:
        nd_w = nd_[nd_.entity.str.contains("All disasters", case=False, na=False)]
        if len(nd_w):
            put("disasters_n", "Erfasste Naturkatastrophen (EM-DAT)", "Ereignisse pro Jahr", ["owid_emdat"],
                {int(y): float(v) for y, v in zip(nd_w.year, nd_w.n_events)})
    return S


def annual_from_fred_fy(cache, sid, only_after=None):
    s = fred(cache, sid)
    d = {int(k.year): float(v) for k, v in s.items()}
    if only_after is not None:
        d = {y: v for y, v in d.items() if y > only_after}
    return d


def load_boe(cache):
    import openpyxl
    p = os.path.join(cache, "boe", "millennium.xlsx")
    if not os.path.exists(p):
        return {}
    wb_ = openpyxl.load_workbook(p, read_only=True, data_only=True)
    ws = wb_["A1. Headline series"]
    rows = list(ws.iter_rows(min_row=1, max_row=1100, values_only=True))
    desc = rows[3]
    want = {"uk_consol": "Consols / long-term", "uk_infl": "Consumer price inflation", "uk_bankrate": "Bank Rate"}
    idx = {}
    for k, pref in want.items():
        for i, d in enumerate(desc):
            if isinstance(d, str) and d.strip().startswith(pref):
                idx[k] = i
                break
    out = {k: {} for k in idx}
    for r in rows[7:]:
        y = r[0]
        try:
            y = int(y)
        except (TypeError, ValueError):
            continue
        for k, i in idx.items():
            v = r[i]
            if isinstance(v, (int, float)) and np.isfinite(v):
                out[k][y] = float(v)
    return out


# ----------------------------------------------------------------------------
# Analogien: Land-Jahr-Merkmale (JST-Länder, 1870-2020; USA bis heute)
# ----------------------------------------------------------------------------
def build_analogs(cache, power):
    j = pd.read_stata(os.path.join(cache, "jst", "JSTdatasetR6.dta"))
    j = j.sort_values(["iso", "year"])
    j["infl"] = j.groupby("iso")["cpi"].pct_change(fill_method=None) * 100
    j["infl3"] = j.groupby("iso")["infl"].transform(lambda s: s.rolling(3, min_periods=2).mean())
    j["real_lt"] = j["ltrate"] - j["infl3"]
    # reale Anleihe- und Aktienrenditen, Folgejahre
    j["bond_real"] = ((1 + j["bond_tr"]) / (1 + j["infl"] / 100) - 1) * 100
    j["eq_real"] = ((1 + j["eq_tr"]) / (1 + j["infl"] / 100) - 1) * 100
    d_ = imf_dm(cache, "d")
    hp = imf_dm(cache, "DEBT1")
    ie = imf_dm(cache, "ie")
    pol = owid_df(cache, "political-polarization-score")
    lib = owid_df(cache, "liberal-democracy-index")
    wea = owid_df(cache, "wealth-share-richest")
    wcol = [c for c in wea.columns if c.startswith("share_top_1")][0]
    g = pd.read_excel(os.path.join(cache, "gpr", "data_gpr_export.xls"))
    g["year"] = pd.to_datetime(g["month"]).dt.year
    gpr = g.groupby("year")["GPRH"].mean().to_dict()
    mad = owid_df(cache, "gdp-maddison-project-database")
    # relative Wirtschaftsgröße: BIP / BIP der größten Volkswirtschaft im selben Jahr
    big = mad[[not is_aggregate(c, e) for c, e in zip(mad.code, mad.entity)]].groupby("year")["gdp"].max().to_dict()
    name_of = mad.drop_duplicates("code").set_index("code")["entity"].to_dict()
    rows = []
    isos = sorted(j.iso.unique())
    for iso in isos:
        sub = j[j.iso == iso].set_index("year")
        name = name_of.get(iso)
        wv, _ = interp_annual(series_points(wea, name, wcol), np.arange(1870, 2027), max_gap=25)
        wd = dict(zip(range(1870, 2027), wv))
        pv = series_points(pol, name, "v2cacamps__estimate_best")
        lv = series_points(lib, name, "libdem_vdem__estimate_best")
        mg = series_points(mad, name, "gdp")
        for y in range(1870, 2021):
            r = sub.loc[y] if y in sub.index else None
            debt = d_.get(iso, {}).get(y, hp.get(iso, {}).get(y))
            if debt is None and r is not None and pd.notna(r["debtgdp"]):
                debt = float(r["debtgdp"]) * 100
            rel = mg[y] / big[y] if (y in mg and y in big and big[y]) else None
            nxt = sub.loc[y + 1:y + 10] if r is not None else None
            out = None
            if nxt is not None and len(nxt) >= 8:
                d10 = d_.get(iso, {}).get(y + 10, hp.get(iso, {}).get(y + 10))
                out = {
                    "dDebt": r4(d10 - debt, 3) if (d10 is not None and debt is not None) else None,
                    "infl": r4(nxt["infl"].mean(), 3),
                    "bond": r4(nxt["bond_real"].mean(), 3) if nxt["bond_real"].notna().sum() >= 6 else None,
                    "eq": r4(nxt["eq_real"].mean(), 3) if nxt["eq_real"].notna().sum() >= 6 else None,
                    "crisis": int(nxt["crisisJST"].fillna(0).max()) if nxt["crisisJST"].notna().any() else None,
                    "gpr": r4(max(gpr[yy] for yy in range(y + 1, y + 11)), 3) if all(yy in gpr for yy in range(y + 1, y + 11)) else None,
                }
            rows.append({
                "iso": iso, "y": y,
                "f": [r4(debt, 3), r4(ie.get(iso, {}).get(y), 3),
                      r4(r["ltrate"], 3) if r is not None else None,
                      r4(r["infl3"], 3) if r is not None else None,
                      r4(r["real_lt"], 3) if r is not None else None,
                      r4(wd.get(y), 3), r4(pv.get(y), 3), r4(lv.get(y), 3),
                      r4(gpr.get(y), 3), r4(rel, 3)],
                "o": out,
            })
    feats = [
        {"id": "debt", "label": "Staatsschulden (% BIP)"},
        {"id": "interest", "label": "Zinsausgaben (% BIP)"},
        {"id": "ltrate", "label": "Langfristzins (%)"},
        {"id": "infl3", "label": "Inflation, 3-Jahres-Mittel (%)"},
        {"id": "real", "label": "Realer Langfristzins (%)"},
        {"id": "wealth", "label": "Vermögensanteil Top 1 % (%)"},
        {"id": "polar", "label": "Polarisierung (V-Dem)"},
        {"id": "libdem", "label": "Liberale Demokratie (V-Dem)"},
        {"id": "gpr", "label": "Geopolitisches Risiko (GPR, global)"},
        {"id": "relsize", "label": "BIP relativ zur größten Volkswirtschaft"},
    ]
    names = {iso: name_of.get(iso, iso) for iso in isos}
    # Abfragevektor USA (jüngste verfügbare Werte, gleiche Definitionen wie in den Zeilen)
    weo = imf_dm(cache, "GGXWDG_NGDP").get("USA", {})
    ppp = imf_dm(cache, "PPPSH")
    gs10 = annual_mean(fred(cache, "GS10"))
    cpi = fred(cache, "CPIAUCNS")
    infl_a = yoy_annual_cpi(cpi)
    yq = max(gs10)
    infl3 = float(np.mean([infl_a[y] for y in range(yq - 2, yq + 1) if y in infl_a]))
    ie_us = ie.get("USA", {})
    wv = series_points(wea, "United States", wcol)
    pv = series_points(pol, "United States", "v2cacamps__estimate_best")
    lv = series_points(lib, "United States", "libdem_vdem__estimate_best")
    rel = ppp["USA"][yq] / max(ppp[k].get(yq, 0) for k in CTRY if k in ppp)
    q = [weo.get(yq), ie_us.get(max(ie_us)), gs10[yq], infl3, gs10[yq] - infl3, wv.get(max(wv)), pv.get(max(pv)),
         lv.get(max(lv)), gpr.get(yq), rel]
    query = {"iso": "USA", "y": yq, "label": f"USA {yq}", "f": [r4(x, 3) for x in q],
             "notes": {
                 "debt": f"IWF WEO, Bruttoschulden Gesamtstaat {yq} (Schätzung/Projektion)",
                 "interest": f"IWF FPP, Zinsausgaben {max(ie_us)} (jüngster verfügbarer Wert)",
                 "ltrate": f"FRED GS10, Mittel {yq} bis zum letzten verfügbaren Monat",
                 "infl3": f"FRED CPIAUCNS, Mittel {yq-2}–{yq}",
                 "wealth": f"WID, {max(wv)}", "polar": f"V-Dem, {max(pv)}", "libdem": f"V-Dem, {max(lv)}",
                 "gpr": f"Caldara/Iacoviello, Mittel {yq} bis zum letzten verfügbaren Monat",
                 "relsize": f"IWF WEO PPPSH {yq}: US-Anteil / größter Anteil (China)",
             }}
    return {"features": feats, "rows": rows, "names": names, "query": query}


# ----------------------------------------------------------------------------
# Aktuelle Werte (Stichtag) aus API-Quellen
# ----------------------------------------------------------------------------
def build_latest(cache):
    L = {}

    def last(s: pd.Series, key, label, unit, src, nd=4, scale=1.0):
        s = s.dropna()
        L[key] = {"label": label, "value": r4(float(s.iloc[-1]) * scale, nd), "date": s.index[-1].strftime("%Y-%m-%d"),
                  "unit": unit, "src": src}

    last(fred(cache, "FEDFUNDS"), "fedfunds", "Federal Funds Rate (Monatsmittel)", "%", ["fred:FEDFUNDS"])
    last(fred(cache, "GS10"), "us10y", "Rendite 10-jähriger Treasuries (Monatsmittel)", "%", ["fred:GS10"])
    last(fred(cache, "TB3MS"), "us3m", "Rendite 3-monatiger Schatzwechsel (Monatsmittel)", "%", ["fred:TB3MS"])
    try:
        d10 = fred(cache, "DGS10")
        last(d10, "us10y_d", "Rendite 10-jähriger Treasuries (Tageswert)", "%", ["fred:DGS10"])
        yr = d10[d10.index.year == d10.index[-1].year]
        mx_date, mx = yr.idxmax(), float(yr.max())
        before = d10[(d10.index < mx_date) & (d10 >= mx)]
        L["us10y_d"].update({"max_year": r4(mx), "max_date": mx_date.strftime("%Y-%m-%d"),
                             "max_higher_last": before.index[-1].strftime("%Y-%m-%d") if len(before) else None})
        dff = fred(cache, "DFF")
        last(dff, "dff", "Federal Funds Effective Rate (Tageswert)", "%", ["fred:DFF"])
        lo, hi = fred(cache, "DFEDTARL"), fred(cache, "DFEDTARU")
        L["fed_target"] = {"label": "Zielband der Federal Funds Rate", "lo": r4(float(lo.iloc[-1])), "hi": r4(float(hi.iloc[-1])),
                           "date": hi.index[-1].strftime("%Y-%m-%d"), "src": ["fred:DFEDTARL", "fred:DFEDTARU"]}
        chg = hi[hi.diff() != 0]
        if len(chg) > 1:
            L["fed_target"]["last_change"] = chg.index[-1].strftime("%Y-%m-%d")
            L["fed_target"]["last_change_bp"] = r4(100 * float(hi.diff().loc[chg.index[-1]]))
    except FileNotFoundError:
        pass
    cpi = fred(cache, "CPIAUCNS")
    # Vorjahresmonat über das Datum zuordnen (fehlende Monate, etwa Oktober 2025, verschieben sonst die Reihe)
    prev = cpi.copy()
    prev.index = prev.index + pd.DateOffset(years=1)
    yoy = (cpi / prev.reindex(cpi.index) - 1) * 100
    last(yoy, "cpi_yoy", "Inflation (VPI, ggü. Vorjahresmonat)", "%", ["fred:CPIAUCNS"])
    last(fred(cache, "UNRATE"), "unrate", "Arbeitslosenquote", "%", ["fred:UNRATE"])
    last(fred(cache, "GFDEGDQ188S"), "debt_total_gdp_q", "Bundesschuld gesamt", "% des BIP", ["fred:GFDEGDQ188S"])
    last(fred(cache, "FYGFGDQ188S"), "debt_public_gdp_q", "Bundesschuld in Händen der Öffentlichkeit", "% des BIP", ["fred:FYGFGDQ188S"])
    last(fred(cache, "WFRBST01134"), "top1_wealth", "Vermögensanteil oberstes 1 % (Fed DFA)", "%", ["fred:WFRBST01134"])
    walcl = fred(cache, "WALCL")
    last(walcl, "fed_assets", "Bilanzsumme der Fed", "Bio. US-$", ["fred:WALCL"], scale=1e-6)
    prev_w = walcl[walcl.index <= walcl.index[-1] - pd.DateOffset(years=1)]
    if len(prev_w):
        L["fed_assets"]["change12m"] = r4(100 * (walcl.iloc[-1] / prev_w.iloc[-1] - 1))
    try:
        fh = fred(cache, "FDHBFIN")
        pub = fred(cache, "FYGFDPUN")
        sh_ = (100 * 1000 * fh / pub.reindex(fh.index)).dropna()  # FDHBFIN in Mrd., FYGFDPUN in Mio.
        L["foreign_share"] = {"label": "Anteil ausländischer Halter an der Schuld in Händen der Öffentlichkeit", "value": r4(float(sh_.iloc[-1])),
                              "date": sh_.index[-1].strftime("%Y-%m-%d"), "unit": "%", "src": ["fred:FDHBFIN", "fred:FYGFDPUN"],
                              "history": {d.strftime("%Y-%m-%d"): r4(float(v)) for d, v in sh_[sh_.index >= "2000-01-01"].items()}}
    except FileNotFoundError:
        pass
    ip = fred(cache, "A091RC1Q027SBEA")
    rc = fred(cache, "FGRECPT")
    last((100 * ip / rc).dropna(), "interest_receipts_q", "Zinszahlungen in % der laufenden Einnahmen (NIPA)", "%",
         ["fred:A091RC1Q027SBEA", "fred:FGRECPT"])
    cdq = fred(cache, "B235RC1Q027SBEA")
    imq = fred(cache, "A255RC1Q027SBEA")
    last((100 * cdq / imq).dropna(), "tariff_eff_q", "Effektiver Zollsatz (Quartal, annualisiert)", "%",
         ["fred:B235RC1Q027SBEA", "fred:A255RC1Q027SBEA"])
    gold = pd.read_csv(os.path.join(cache, "gold", "monthly.csv"))
    gold["date"] = pd.to_datetime(gold["Date"])
    last(gold.set_index("date")["Price"], "gold_m", "Goldpreis (Monatsmittel, Weltbank)", "USD/oz", ["gold"])
    gdpq = fred(cache, "GDP")
    with open(os.path.join(cache, "treasury", "debt_to_penny.json"), encoding="utf-8") as f:
        dp = json.load(f)["data"]
    d0 = dp[0]
    L["debt_penny_total"] = {"label": "Gesamtverschuldung des Bundes", "value": r4(float(d0["tot_pub_debt_out_amt"]) / 1e12),
                             "date": d0["record_date"], "unit": "Bio. US-$", "src": ["treasury_debt"]}
    L["debt_penny_public"] = {"label": "Schulden in Händen der Öffentlichkeit", "value": r4(float(d0["debt_held_public_amt"]) / 1e12),
                              "date": d0["record_date"], "unit": "Bio. US-$", "src": ["treasury_debt"]}
    L["debt_public_gdp_now"] = {"label": "Schulden der Öffentlichkeit / nominales BIP (letztes Quartal, annualisiert)",
                                "value": r4(100 * float(d0["debt_held_public_amt"]) / 1e9 / float(gdpq.iloc[-1])),
                                "date": d0["record_date"], "unit": "% des BIP", "src": ["treasury_debt", "fred:GDP"],
                                "gdpQuarter": gdpq.index[-1].strftime("%Y-%m-%d")}
    fy_end = pd.Timestamp(L["debt_penny_total"]["date"][:4] + "-09-30")
    if pd.Timestamp(L["debt_penny_total"]["date"]) < fy_end:
        fy_end = fy_end - pd.DateOffset(years=1)
    qs = gdpq[(gdpq.index > fy_end - pd.DateOffset(years=1)) & (gdpq.index <= fy_end)]
    L["fy_gdp_est"] = {"label": f"Nominales BIP Fiskaljahr {fy_end.year} (Mittel der vorliegenden Quartale, annualisiert)",
                       "value": r4(float(qs.mean()), 5), "quarters": len(qs), "fy": fy_end.year, "unit": "Mrd. US-$", "src": ["fred:GDP"]}
    with open(os.path.join(cache, "treasury", "avg_rates.json"), encoding="utf-8") as f:
        ar = json.load(f)["data"]
    tm = [r for r in ar if r["security_desc"] == "Total Marketable"]
    if tm:
        L["avg_rate_marketable"] = {"label": "Durchschnittszins der marktgängigen Bundesschuld", "value": r4(float(tm[0]["avg_interest_rate_amt"])),
                                    "date": tm[0]["record_date"], "unit": "%", "src": ["treasury_rates"]}
        hist = {}
        for r in tm:
            y = int(r["record_date"][:4])
            hist.setdefault(y, float(r["avg_interest_rate_amt"]))
        L["avg_rate_marketable"]["history"] = {str(k): r4(v) for k, v in sorted(hist.items())}
    # Haushalt laufendes und vorheriges Fiskaljahr aus dem Monthly Treasury Statement
    with open(os.path.join(cache, "treasury", "mts1.json"), encoding="utf-8") as f:
        mts = json.load(f)["data"]
    ytd = [r for r in mts if r["classification_desc"] == "Year-to-Date" and r["record_date"] == mts[0]["record_date"]]
    fy_rows = []
    for r in ytd:
        try:
            fy_rows.append({"rcpt": float(r["current_month_gross_rcpt_amt"]), "outl": float(r["current_month_gross_outly_amt"]),
                            "def": float(r["current_month_dfct_sur_amt"]), "fy": r["record_fiscal_year"],
                            "line": int(r.get("src_line_nbr") or 0)})
        except (TypeError, ValueError):
            pass
    if fy_rows:
        fy_rows.sort(key=lambda r: r["line"])
        cur_, prev_ = fy_rows[-1], fy_rows[0]
        L["mts_ytd"] = {"label": "Monthly Treasury Statement, Year-to-Date", "date": mts[0]["record_date"],
                        "current": {k: r4(cur_[k] / 1e9, 5) for k in ("rcpt", "outl", "def")},
                        "prior": {k: r4(prev_[k] / 1e9, 5) for k in ("rcpt", "outl", "def")},
                        "unit": "Mrd. US-$", "src": ["treasury_mts"]}
    try:
        with open(os.path.join(cache, "treasury", "mts9.json"), encoding="utf-8") as f:
            m9 = json.load(f)["data"]
        ni = [r for r in m9 if r["classification_desc"].strip().lower() == "net interest" and r["record_date"] == m9[0]["record_date"]]
        if ni:
            r = ni[0]
            L["mts_net_interest"] = {"label": "Nettozinsausgaben laut MTS (Fiskaljahr bis Stichtag)", "date": m9[0]["record_date"],
                                     "current": r4(float(r["current_fytd_rcpt_outly_amt"]) / 1e9, 5),
                                     "prior": r4(float(r["prior_fytd_rcpt_outly_amt"]) / 1e9, 5),
                                     "unit": "Mrd. US-$", "src": ["treasury_mts"]}
    except FileNotFoundError:
        pass
    return L


# ----------------------------------------------------------------------------
# Quellenregister für das Frontend
# ----------------------------------------------------------------------------
def build_sources(cache):
    src = {
        "maddison": {"name": "Maddison Project Database 2023", "via": "Our World in Data", "url": "https://www.rug.nl/ggdc/historicaldevelopment/maddison/releases/maddison-project-database-2023", "owid": "gdp-maddison-project-database"},
        "owid_longrun_gdp": {"name": "Welt-BIP der letzten zwei Jahrtausende", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/global-gdp-over-the-long-run", "owid": "global-gdp-over-the-long-run"},
        "owid_cepii": {"name": "CEPII TRADHIST (Fouquin & Hugot 2016)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/merchandise-exports-gdp-cepii", "owid": "merchandise-exports-gdp-cepii"},
        "owid_cepii_gdp": {"name": "CEPII TRADHIST, nominales BIP", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/national-gdp-fouquin-current-gbp", "owid": "national-gdp-fouquin-current-gbp"},
        "owid_gmsd": {"name": "Global Military Spending Dataset", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/military-spending-gmsd", "owid": "military-spending-gmsd"},
        "owid_sipri": {"name": "SIPRI Military Expenditure Database", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/military-spending-sipri", "owid": "military-spending-sipri"},
        "owid_milper": {"name": "Militärpersonal", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/military-personnel", "owid": "military-personnel"},
        "owid_fas": {"name": "Atomwaffenbestände (FAS)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/nuclear-warhead-stockpiles", "owid": "nuclear-warhead-stockpiles"},
        "owid_leelee": {"name": "Durchschnittliche Schuljahre (Lee & Lee)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/mean-years-of-schooling-long-run", "owid": "mean-years-of-schooling-long-run"},
        "owid_tertiary": {"name": "Anteil mit Hochschulabschluss (Lee & Lee)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/share-of-the-population-with-completed-tertiary-education", "owid": "share-of-the-population-with-completed-tertiary-education"},
        "owid_pop": {"name": "Bevölkerung (historisch)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/population", "owid": "population"},
        "owid_rd": {"name": "F&E-Ausgaben in % des BIP (UNESCO/Weltbank)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/research-spending-gdp", "owid": "research-spending-gdp"},
        "owid_patents": {"name": "Patentanmeldungen von Inländern (WIPO/Weltbank)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/annual-patent-applications", "owid": "annual-patent-applications"},
        "vdem": {"name": "V-Dem: Polarisierung und liberale Demokratie", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/political-polarization-score", "owid": "political-polarization-score"},
        "wid": {"name": "World Inequality Database", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/wealth-share-richest", "owid": "wealth-share-richest"},
        "pew": {"name": "Pew Research Center: Vertrauen in die Regierung", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/public-trust-in-government", "owid": "public-trust-in-government"},
        "owid_conflict_catalog": {"name": "Conflict Catalog (Brecke)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/global-deaths-in-violent-political-conflicts-over-the-long-run", "owid": "global-deaths-in-violent-political-conflicts-over-the-long-run"},
        "owid_ucdp": {"name": "UCDP/PRIO Armed Conflict", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/deaths-in-state-based-conflicts-by-type", "owid": "deaths-in-state-based-conflicts-by-type"},
        "owid_boe": {"name": "Staatsschulden UK 1727–2020 (Bank of England)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/uk-government-debt-as-a-percentage-of-gdp-17272016", "owid": "uk-government-debt-as-a-percentage-of-gdp-17272016"},
        "owid_temp": {"name": "Globale Temperaturabweichung (HadCRUT)", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/temperature-anomaly", "owid": "temperature-anomaly"},
        "owid_emdat": {"name": "EM-DAT Naturkatastrophen", "via": "Our World in Data", "url": "https://ourworldindata.org/grapher/natural-disasters-by-type", "owid": "natural-disasters-by-type"},
        "imf_hpdd": {"name": "IMF Historical Public Debt Database", "citation": "Abbas, S. M. A., Belhocine, N., ElGanainy, A., Horton, M. (2010): A Historical Public Debt Database. IMF Working Paper 10/245.", "url": "https://www.imf.org/external/datamapper/DEBT1@DEBT/OEMDC/ADVEC/WEOWORLD"},
        "imf_fpp": {"name": "IMF Public Finances in Modern History", "citation": "Mauro, P., Romeu, R., Binder, A., Zaman, A. (2015): A Modern History of Fiscal Prudence and Profligacy. Journal of Monetary Economics 76, 55–70.", "url": "https://www.imf.org/external/datamapper/d@FPP/USA/FRA/JPN/GBR/SWE/ESP/ITA/ZAF/IND"},
        "imf_fpp_ie": {"name": "IMF Public Finances in Modern History: Zinsausgaben", "citation": "Mauro, P., Romeu, R., Binder, A., Zaman, A. (2015): A Modern History of Fiscal Prudence and Profligacy. Journal of Monetary Economics 76, 55–70.", "url": "https://www.imf.org/external/datamapper/ie@FPP"},
        "imf_weo": {"name": "IMF World Economic Outlook (DataMapper)", "url": "https://www.imf.org/external/datamapper/GGXWDG_NGDP@WEO"},
        "imf_cofer": {"name": "IMF COFER: Währungszusammensetzung der Devisenreserven", "citation": "International Monetary Fund. Currency Composition of Official Foreign Exchange Reserves (COFER).", "url": "https://data.imf.org/en/datasets/IMF.STA:COFER"},
        "wb": {"name": "Weltbank, World Development Indicators (API)", "url": "https://data.worldbank.org/"},
        "fred": {"name": "FRED, Federal Reserve Bank of St. Louis", "url": "https://fred.stlouisfed.org/"},
        "shiller": {"name": "Robert J. Shiller, Online Data (ie_data.xls)", "url": "http://www.econ.yale.edu/~shiller/data.htm"},
        "gpr": {"name": "Geopolitical Risk Index", "citation": "Caldara, D., Iacoviello, M. (2022): Measuring Geopolitical Risk. American Economic Review 112(4), 1194–1225.", "url": "https://www.matteoiacoviello.com/gpr.htm"},
        "jst": {"name": "Jordà-Schularick-Taylor Macrohistory Database, Release 6", "citation": "Jordà, Ò., Schularick, M., Taylor, A. M. (2017): Macrofinancial History and the New Business Cycle Facts. NBER Macroeconomics Annual 2016, Vol. 31.", "url": "https://www.macrohistory.net/database/"},
        "cow": {"name": "Correlates of War, National Material Capabilities v7", "citation": "Singer, J. D., Bremer, S., Stuckey, J. (1972): Capability Distribution, Uncertainty, and Major Power War, 1820–1965. In: Russett, B. (Hg.): Peace, War, and Numbers. Beverly Hills: Sage, 19–48.", "url": "https://correlatesofwar.org/data-sets/national-material-capabilities/"},
        "gold": {"name": "Goldpreis monatlich (Timothy Green bis 1959; Weltbank Pink Sheet ab 1960)", "via": "datasets/gold-prices (DataHub)", "url": "https://github.com/datasets/gold-prices"},
        "voteview": {"name": "Voteview: Congressional Roll-Call Votes Database (DW-NOMINATE)", "url": "https://voteview.com/data"},
        "nobel": {"name": "Nobel Prize API v2.1 (Nobel Prize Outreach)", "url": "https://www.nobelprize.org/about/developer-zone-2/"},
        "boe": {"name": "Bank of England: A Millennium of Macroeconomic Data", "citation": "Thomas, R., Dimsdale, N. (2017): A Millennium of UK Data. Bank of England OBRA dataset.", "url": "https://www.bankofengland.co.uk/statistics/research-datasets"},
        "treasury_debt": {"name": "U.S. Treasury Fiscal Data: Debt to the Penny", "url": "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/"},
        "treasury_rates": {"name": "U.S. Treasury Fiscal Data: Average Interest Rates on U.S. Treasury Securities", "url": "https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/"},
        "treasury_mts": {"name": "U.S. Treasury Fiscal Data: Monthly Treasury Statement", "url": "https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/"},
    }
    for k, v in src.items():
        if v.get("owid"):
            m = owid_meta(cache, v["owid"])
            v["citation"] = m.get("citation")
            v["lastUpdated"] = m.get("lastUpdated")
    return src


FRED_LABELS = {
    "GFDEGDQ188S": "Federal Debt: Total Public Debt as Percent of GDP",
    "FYGFGDQ188S": "Federal Debt Held by the Public as Percent of GDP",
    "A091RC1Q027SBEA": "Federal government current expenditures: Interest payments",
    "FGRECPT": "Federal government current receipts",
    "FYOINT": "Federal Outlays: Interest",
    "FYFR": "Federal Receipts",
    "FYFSGDA188S": "Federal Surplus or Deficit as Percent of GDP",
    "FYOIGDA188S": "Federal Outlays: Interest as Percent of GDP",
    "GDP": "Gross Domestic Product",
    "FEDFUNDS": "Federal Funds Effective Rate",
    "GS10": "Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity",
    "TB3MS": "3-Month Treasury Bill Secondary Market Rate",
    "CPIAUCNS": "Consumer Price Index for All Urban Consumers (NSA)",
    "UNRATE": "Unemployment Rate",
    "WALCL": "Assets: Total Assets (Federal Reserve)",
    "BOGMBASE": "Monetary Base; Total",
    "QUSPAM770A": "Total Credit to Private Non-Financial Sector (BIS)",
    "QUSGAM770A": "Total Credit to General Government, Market Value (BIS)",
    "B235RC1A027NBEA": "Federal government: Customs duties",
    "B235RC1Q027SBEA": "Federal government: Customs duties (quarterly)",
    "A255RC1A027NBEA": "Imports of goods",
    "A255RC1Q027SBEA": "Imports of goods (quarterly)",
    "WFRBST01134": "Share of Net Worth Held by the Top 1% (Distributional Financial Accounts)",
    "FDHBFIN": "Federal Debt Held by Foreign and International Investors",
    "DGS10": "Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity (daily)",
    "DFF": "Federal Funds Effective Rate (daily)",
    "DFEDTARU": "Federal Funds Target Range - Upper Limit",
    "DFEDTARL": "Federal Funds Target Range - Lower Limit",
    "FYGFDPUN": "Federal Debt Held by the Public",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=".cache")
    ap.add_argument("--out", default="public/data/bigcycle.json")
    ap.add_argument("--curated", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "curated.json"))
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-fetch", action="store_true")
    a = ap.parse_args()
    errors = [] if a.no_fetch else fetch_all(a.cache, a.refresh)
    power = build_power(a.cache)
    series = build_series(a.cache)
    analogs = build_analogs(a.cache, power)
    latest = build_latest(a.cache)
    sources = build_sources(a.cache)
    curated = {}
    if os.path.exists(a.curated):
        with open(a.curated, encoding="utf-8") as f:
            curated = json.load(f)
    out = {
        "meta": {
            "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "schema": 1,
            "fetchErrors": errors,
            "fredLabels": FRED_LABELS,
        },
        "sources": sources,
        "power": power,
        "series": series,
        "analogs": analogs,
        "latest": latest,
        "curated": curated,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"geschrieben: {a.out} ({os.path.getsize(a.out)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
