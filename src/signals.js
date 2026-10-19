"use strict";
/* Anlagebarometer: Signalrechnung auf den Live-Reihen des Workers.
   Aufbau nach dem Muster der Hausmeinung großer Vermögensverwalter (etwa des Pictet-Barometers):
   jede Anlage wird auf mehreren Säulen beurteilt und zu einer Gesamteinschätzung verdichtet.
     Trend          Kursmomentum über 3, 6 und 12 Monate und Abstand zum gleitenden Durchschnitt
     Konjunktur     OECD-Frühindikator (Niveau und Dynamik), bei Anleihen auch die Inflationsdynamik
     Bewertung      Abstand zum langfristigen Trend, reale Renditen, realer Wechselkurs
     Liquidität     Richtung der Geldpolitik, Zinskurve, Zentralbankbilanzen, Dollar
     Risiko         Volatilität, Kreditrisikoprämien, Finanzstress und geopolitische Spannungen
   Jede Säule liefert einen Wert zwischen −2 und +2; die Gesamtnote ist ihr gewichtetes Mittel.
   Alle Schwellen und Gewichte stehen in SIG.cfg und sind Setzungen dieses Modells.
   Reine Funktionen, im Browser und in Node lauffähig. Keine Anlageberatung. */

const SIG = (() => {
  const DAY = 86400000;
  const dayOf = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, iso.length >= 10 ? +iso.slice(8, 10) : 1) / DAY;
  const isoOf = n => new Date(n * DAY).toISOString().slice(0, 10);
  const yearFrac = n => {
    const d = new Date(n * DAY), y = d.getUTCFullYear();
    const a = Date.UTC(y, 0, 1) / DAY, b = Date.UTC(y + 1, 0, 1) / DAY;
    return y + (n - a) / (b - a);
  };
  const clip2 = z => (z == null || !isFinite(z) ? null : 2 * Math.tanh(z / 2));
  const mean = a => { const b = a.filter(v => v != null && isFinite(v)); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
  const median = a => { const b = a.filter(v => v != null && isFinite(v)).sort((p, q) => p - q); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const sd = a => { const b = a.filter(v => v != null && isFinite(v)); if (b.length < 3) return null; const m = b.reduce((s, v) => s + v, 0) / b.length; return Math.sqrt(b.reduce((s, v) => s + (v - m) ** 2, 0) / (b.length - 1)); };

  /* ------------------------------------------------------------ Dekodieren */
  // Punkte: { t: Tag seit 1970, e: Tag des Periodenendes, x: Jahresbruchteil, v: Wert }
  function decodeSeries(s) {
    if (!s || s.s == null || !s.v) return [];
    const out = [];
    if (s.f === "D" || s.f === "W") {
      let n = dayOf(s.s);
      for (let i = 0; i < s.v.length; i++) {
        n += s.d[i];
        if (s.v[i] != null) out.push({ t: n, e: n, x: yearFrac(n), v: s.v[i] });
      }
    } else if (s.f === "M") {
      const y0 = +s.s.slice(0, 4), m0 = +s.s.slice(5, 7) - 1;
      s.v.forEach((v, i) => {
        if (v == null) return;
        const y = y0 + Math.floor((m0 + i) / 12), m = (m0 + i) % 12;
        const t = Date.UTC(y, m, 1) / DAY, e = Date.UTC(y, m + 1, 1) / DAY - 1;
        out.push({ t, e, x: y + m / 12, v });
      });
    } else if (s.f === "Q") {
      const y0 = +s.s.slice(0, 4), q0 = +s.s.slice(-1) - 1;
      s.v.forEach((v, i) => {
        if (v == null) return;
        const y = y0 + Math.floor((q0 + i) / 4), q = (q0 + i) % 4;
        const t = Date.UTC(y, 3 * q, 1) / DAY, e = Date.UTC(y, 3 * q + 3, 1) / DAY - 1;
        out.push({ t, e, x: y + q / 4 + 0.125, v });
      });
    } else if (s.f === "A") {
      s.v.forEach((v, i) => {
        if (v == null) return;
        const y = s.s + i;
        out.push({ t: Date.UTC(y, 0, 1) / DAY, e: Date.UTC(y, 11, 31) / DAY, x: y, v });
      });
    }
    return out;
  }

  /* Snapshot des Workers in eine flache Sammlung umsetzen: L.s[id] = { meta, f, pts } */
  function decodeSnapshot(snap) {
    const L = { generated: snap.generated, origin: snap.origin, status: snap.status || {}, s: {}, items: {}, jobOf: {} };
    for (const [job, out] of Object.entries(snap.data || {})) {
      for (const [id, s] of Object.entries(out.series || {})) {
        L.s[id] = { id, f: s.f, l: s.l, u: s.u, src: s.src, note: s.note, pts: decodeSeries(s) };
        L.jobOf[id] = job;
      }
      if (out.items) L.items[job] = out.items;
    }
    return L;
  }

  /* ------------------------------------------------------------ Zeitreihen-Hilfen */
  const LAG = { D: 0, W: 3, M: 15, Q: 45, A: 120 };
  // Punkte, die zum Stichtag "cut" (Tag) bereits veröffentlicht gewesen wären; cut = null: alle
  function asOf(ser, cut) {
    if (!ser) return [];
    if (cut == null) return ser.pts;
    const lag = LAG[ser.f] ?? 0;
    const p = ser.pts;
    let i = p.length;
    while (i > 0 && p[i - 1].e + lag > cut) i--;
    return i === p.length ? p : p.slice(0, i);
  }
  const last = p => (p.length ? p[p.length - 1] : null);
  function valueAt(p, day) { // letzter Wert mit t <= day
    let lo = 0, hi = p.length - 1, r = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (p[m].t <= day) { r = p[m]; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  function change(p, days, mode = "log") {
    const a = last(p); if (!a) return null;
    const b = valueAt(p, a.t - days); if (!b || b.t < a.t - days * 1.6) return null;
    if (mode === "diff") return a.v - b.v;
    if (b.v <= 0 || a.v <= 0) return null;
    return mode === "pct" ? a.v / b.v - 1 : Math.log(a.v / b.v);
  }
  function annVol(p) { // annualisierte Volatilität der Log-Renditen über das letzte Jahr
    const a = last(p); if (!a || p.length < 8) return null;
    const win = p.filter(q => q.t > a.t - 370);
    if (win.length < 8) return null;
    const r = [];
    for (let i = 1; i < win.length; i++) if (win[i].v > 0 && win[i - 1].v > 0) r.push(Math.log(win[i].v / win[i - 1].v));
    const s = sd(r); if (s == null) return null;
    const perYear = r.length / Math.max(0.25, (win[win.length - 1].t - win[0].t) / 365.25);
    return s * Math.sqrt(perYear);
  }
  function smaDays(p, days) {
    const a = last(p); if (!a) return null;
    const win = p.filter(q => q.t > a.t - days);
    return win.length >= 5 ? mean(win.map(q => q.v)) : null;
  }
  // Abstand zum log-linearen Trend der letzten "years" Jahre (Monatsmittel), in Standardabweichungen der Residuen
  function trendDeviation(p, years = 10) {
    const a = last(p); if (!a) return null;
    const win = p.filter(q => q.t > a.t - years * 365.25 && q.v > 0);
    const byM = new Map();
    for (const q of win) { const k = Math.floor(q.x * 12); const e = byM.get(k) || [0, 0, 0]; e[0] += Math.log(q.v); e[1]++; e[2] = q.x; byM.set(k, e); }
    const pts = [...byM.values()].map(([s, n, x]) => [x, s / n]);
    if (pts.length < Math.min(84, years * 12 * 0.7)) return null;
    const mx = mean(pts.map(q => q[0])), my = mean(pts.map(q => q[1]));
    let num = 0, den = 0;
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    const b = num / den, c = my - b * mx;
    const res = pts.map(([x, y]) => y - (c + b * x));
    const s = sd(res); if (!s) return null;
    return { z: (Math.log(a.v) - (c + b * a.x)) / s, dev: Math.log(a.v) - (c + b * a.x), slope: b };
  }
  function zScore(p, years, val) {
    const a = last(p); if (!a) return null;
    const win = p.filter(q => q.t > a.t - years * 365.25).map(q => q.v);
    const m = mean(win), s = sd(win);
    if (m == null || !s) return null;
    return ((val ?? a.v) - m) / s;
  }
  function yoy(p) { // Veränderung gegenüber Vorjahresperiode in Prozent (für Index-Reihen)
    const out = [];
    for (const q of p) { const b = valueAt(p, q.t - 360); if (b && b.t >= q.t - 380 && b.v) out.push({ ...q, v: 100 * (q.v / b.v - 1) }); }
    return out;
  }
  // Reihen verknüpfen: Quotient/Produkt zweier Reihen auf gemeinsamen Daten
  function combine(pa, pb, fn, tol = 7) {
    if (!pa.length || !pb.length) return [];
    const out = [];
    for (const q of pa) { const b = valueAt(pb, q.t); if (b && q.t - b.t <= tol) { const v = fn(q.v, b.v); if (v != null && isFinite(v)) out.push({ t: q.t, e: q.e, x: q.x, v }); } }
    return out;
  }
  // Total-Return-Index aus einer Rendite (10-jährige Staatsanleihe, Duration ~8,5, Konvexität ~85)
  function bondIndex(py, dur = 8.5, conv = 85) {
    if (py.length < 2) return [];
    let idx = 100;
    const out = [{ ...py[0], v: idx }];
    for (let i = 1; i < py.length; i++) {
      const y0 = py[i - 1].v / 100, y1 = py[i].v / 100, dt = (py[i].t - py[i - 1].t) / 365.25;
      const dy = y1 - y0;
      idx *= 1 + y0 * dt - dur * dy + 0.5 * conv * dy * dy;
      out.push({ ...py[i], v: idx });
    }
    return out;
  }

  /* ------------------------------------------------------------ Konfiguration */
  const cfg = {
    pillars: [
      { id: "trend", label: "Trend", short: "T", desc: "Kursmomentum über 3, 6 und 12 Monate, risikobereinigt, und Abstand zum gleitenden 200-Tage-Durchschnitt (Monatsreihen: 10 Monate)." },
      { id: "cycle", label: "Konjunktur", short: "K", desc: "OECD-Frühindikator der Region: Dynamik über drei Monate und Niveau gegenüber dem langfristigen Mittel (100). Anleihen profitieren von schwächerem Wachstum und sinkender Inflation." },
      { id: "value", label: "Bewertung", short: "B", desc: "Aktien und Rohstoffe: Abstand zum log-linearen 10-Jahres-Trend. Anleihen: reale Rendite gegenüber ihrer 10-Jahres-Spanne. Währungen: realer effektiver Wechselkurs (BIS) gegenüber dem 10-Jahres-Mittel. Gold: realer Goldpreis." },
      { id: "liquidity", label: "Liquidität", short: "L", desc: "Richtung der Geldpolitik (Leitzinsänderung über 12 Monate), Steilheit der Zinskurve, Zentralbankbilanz und Dollartrend." },
      { id: "risk", label: "Risiko & Geopolitik", short: "R", desc: "Risikoappetit aus Volatilität (VIX), Hochzins-Risikoprämien, Finanzstress und geopolitischem Risiko. Sichere Häfen (Franken, Yen, Gold, Staatsanleihen) gewinnen bei Risikoaversion." },
    ],
    weights: {
      equity: { trend: 0.35, cycle: 0.25, value: 0.15, liquidity: 0.15, risk: 0.10 },
      bond: { trend: 0.30, cycle: 0.25, value: 0.20, liquidity: 0.20, risk: 0.05 },
      credit: { trend: 0.30, cycle: 0.25, value: 0.20, liquidity: 0.10, risk: 0.15 },
      fx: { trend: 0.40, cycle: 0.15, value: 0.20, liquidity: 0.15, risk: 0.10 },
      gold: { trend: 0.40, cycle: 0.10, value: 0.15, liquidity: 0.20, risk: 0.15 },
      commodity: { trend: 0.40, cycle: 0.30, value: 0.10, liquidity: 0.10, risk: 0.10 },
      relative: { trend: 0.70, cycle: 0.30, value: 0, liquidity: 0, risk: 0 },
    },
    cats: [
      { n: -2, sym: "−−", label: "klar negativ", max: -0.9 },
      { n: -1, sym: "−", label: "negativ", max: -0.3 },
      { n: 0, sym: "=", label: "neutral", max: 0.3 },
      { n: 1, sym: "+", label: "positiv", max: 0.9 },
      { n: 2, sym: "++", label: "klar positiv", max: Infinity },
    ],
    hyst: 0.1,
    // Risiko-Beta: wie stark eine Anlage von Risikoappetit (+) oder Risikoscheu (−) profitiert
    beta: { equity: 1, em: 1.2, credit: 1, commodity: 0.7, gold: -0.7, safeFx: -0.9, fx: 0.2, usd: -0.3, safeBond: -0.6, bond: -0.3, crypto: 1.2 },
    regions: {
      US: { cli: "cli_us", cpi: "cpi_us", pr: "pr_us", y10: "y10_us", reer: "reer_us" },
      EA: { cli: "cli_ea", cpi: "cpi_ea", pr: "pr_ea", y10: "y10_de", reer: "reer_ea" },
      DE: { cli: "cli_de", cpi: "cpi_de", pr: "pr_ea", y10: "y10_de", reer: "reer_ea" },
      CH: { cli: "cli_ch", cpi: "cpi_ch", pr: "pr_ch", y10: "y10_ch", reer: "reer_ch" },
      JP: { cli: "cli_jp", cpi: "cpi_jp", pr: "pr_jp", y10: "y10_jp", reer: "reer_jp" },
      GB: { cli: "cli_gb", cpi: "cpi_gb", pr: "pr_gb", y10: "y10_gb", reer: "reer_gb" },
      CN: { cli: "cli_cn", cpi: "cpi_cn", pr: "pr_cn", y10: "y10_cn", reer: "reer_cn" },
      IN: { cli: "cli_in", cpi: "cpi_in", pr: "pr_in", y10: "y10_in", reer: "reer_in" },
      WORLD: { cli: ["cli_us", "cli_ea", "cli_cn", "cli_jp", "cli_gb", "cli_in"], cpi: "cpi_us", pr: "pr_us" },
      EM: { cli: ["cli_cn", "cli_in"], cpi: "cpi_cn", pr: "pr_us" },
    },
  };

  /* Zeilen des Barometers. price: Reihen-ID oder Rechenvorschrift; kind bestimmt Gewichte und Säulenlogik. */
  const ROWS = [
    { id: "eq_world", group: "klassen", label: "Aktien", sub: "Korb nach ungefährer Börsengewichtung: USA, Eurozone, China, Japan, Großbritannien, Schweiz, Indien", kind: "equity", region: "WORLD", beta: "equity", price: { basket: [["eq_us", 0.62], ["eq_ea", 0.1], ["eq_jp", 0.06], ["eq_gb", 0.04], ["eq_ch", 0.03], ["eq_cn", 0.05], ["eq_in", 0.03]] } },
    { id: "bd_core", group: "klassen", label: "Staatsanleihen", short: "Staatsanl.", sub: "USA, Deutschland, Schweiz, 10 Jahre", kind: "bond", region: "US", beta: "safeBond", price: { basket: [{ bond: "y10_us" }, { bond: "y10_de" }, { bond: "y10_ch" }] }, yieldId: "y10_us" },
    { id: "credit_all", group: "klassen", label: "Unternehmensanleihen", short: "Untern.-Anl.", sub: "USA, Hochzins (ICE BofA)", kind: "credit", region: "US", beta: "credit", price: { spread: "hy_oas" }, spreadId: "hy_oas" },
    { id: "commod", group: "klassen", label: "Rohstoffe", sub: "Brent und Kupfer", kind: "commodity", region: "WORLD", beta: "commodity", price: { basket: ["brent", "copper"] } },

    { id: "eq_us", group: "aktien", label: "USA", sub: "S&P 500", kind: "equity", region: "US", beta: "equity", price: "eq_us" },
    { id: "eq_ea", group: "aktien", label: "Eurozone", sub: "Euro Stoxx 50", kind: "equity", region: "EA", beta: "equity", price: "eq_ea", geo: [["ru_eu", -0.4]] },
    { id: "eq_ch", group: "aktien", label: "Schweiz", sub: "SMI", kind: "equity", region: "CH", beta: "equity", price: "eq_ch" },
    { id: "eq_de", group: "aktien", label: "Deutschland", short: "DE", sub: "DAX", kind: "equity", region: "DE", beta: "equity", price: "eq_de", geo: [["ru_eu", -0.4]] },
    { id: "eq_gb", group: "aktien", label: "Großbritannien", short: "GB", sub: "FTSE 100", kind: "equity", region: "GB", beta: "equity", price: "eq_gb" },
    { id: "eq_jp", group: "aktien", label: "Japan", sub: "Nikkei 225", kind: "equity", region: "JP", beta: "equity", price: "eq_jp", geo: [["cn_jp", -0.3]] },
    { id: "eq_cn", group: "aktien", label: "China", sub: "Shanghai Composite", kind: "equity", region: "CN", beta: "em", price: "eq_cn", geo: [["us_cn", -0.5], ["cn_tw", -0.4]] },
    { id: "eq_in", group: "aktien", label: "Indien", sub: "Nifty 50", kind: "equity", region: "IN", beta: "em", price: "eq_in", geo: [["in_pk", -0.3]] },
    { id: "eq_em", group: "aktien", label: "Schwellenländer", short: "EM", sub: "MSCI Emerging Markets; ohne MSCI-Daten Korb aus China und Indien", kind: "equity", region: "EM", beta: "em", price: "eq_em", fallback: { basket: [["eq_cn", 0.6], ["eq_in", 0.4]] }, geo: [["us_cn", -0.3]] },

    { id: "bd_us", group: "anleihen", label: "USA", sub: "Treasuries, 10 Jahre", kind: "bond", region: "US", beta: "safeBond", price: { bond: "y10_us" }, yieldId: "y10_us" },
    { id: "bd_de", group: "anleihen", label: "Deutschland", short: "DE", sub: "Bundesanleihen, 10 Jahre", kind: "bond", region: "EA", beta: "safeBond", price: { bond: "y10_de" }, yieldId: "y10_de" },
    { id: "bd_ch", group: "anleihen", label: "Schweiz", sub: "Eidgenossen, 10 Jahre", kind: "bond", region: "CH", beta: "safeBond", price: { bond: "y10_ch" }, yieldId: "y10_ch" },
    { id: "bd_jp", group: "anleihen", label: "Japan", sub: "JGB, 10 Jahre", kind: "bond", region: "JP", beta: "bond", price: { bond: "y10_jp" }, yieldId: "y10_jp" },
    { id: "bd_gb", group: "anleihen", label: "Großbritannien", short: "GB", sub: "Gilts, 10 Jahre", kind: "bond", region: "GB", beta: "bond", price: { bond: "y10_gb" }, yieldId: "y10_gb" },
    { id: "bd_cn", group: "anleihen", label: "China", sub: "Staatsanleihen, 10 Jahre", kind: "bond", region: "CN", beta: "bond", price: { bond: "y10_cn" }, yieldId: "y10_cn" },

    { id: "credit_hy", group: "kredit", label: "Hochzins USA", short: "HY USA", sub: "ICE BofA US High Yield, Kurs geschätzt aus der Risikoprämie", kind: "credit", region: "US", beta: "credit", price: { spread: "hy_oas" }, spreadId: "hy_oas" },
    { id: "credit_ig", group: "kredit", label: "Investment Grade USA", short: "IG USA", sub: "ICE BofA US Corporate, Kurs geschätzt aus der Risikoprämie", kind: "credit", region: "US", beta: "equity", price: { spread: "ig_oas", dur: 7 }, spreadId: "ig_oas" },
    { id: "credit_hy_eu", group: "kredit", label: "Hochzins Euro", short: "HY Euro", sub: "ICE BofA Euro High Yield, Kurs geschätzt aus der Risikoprämie", kind: "credit", region: "EA", beta: "credit", price: { spread: "hy_oas_eu" }, spreadId: "hy_oas_eu" },

    { id: "fx_eur", group: "waehrungen", label: "Euro", sub: "EUR in US-Dollar", kind: "fx", region: "EA", beta: "fx", price: "fx_eur", geo: [["ru_eu", -0.3]] },
    { id: "fx_gbp", group: "waehrungen", label: "Pfund", sub: "GBP in US-Dollar", kind: "fx", region: "GB", beta: "fx", price: "fx_gbp" },
    { id: "fx_chf", group: "waehrungen", label: "Franken", sub: "CHF in US-Dollar", kind: "fx", region: "CH", beta: "safeFx", price: "fx_chf" },
    { id: "fx_jpy", group: "waehrungen", label: "Yen", sub: "JPY in US-Dollar", kind: "fx", region: "JP", beta: "safeFx", price: "fx_jpy" },
    { id: "gold_usd", group: "waehrungen", label: "Gold", sub: "US-Dollar je Feinunze", kind: "gold", region: "US", beta: "gold", price: "gold_usd" },
    { id: "fx_cny", group: "waehrungen", label: "Renminbi", sub: "CNY in US-Dollar", kind: "fx", region: "CN", beta: "fx", price: "fx_cny", geo: [["us_cn", -0.3]] },
    { id: "fx_inr", group: "waehrungen", label: "Rupie", sub: "INR in US-Dollar", kind: "fx", region: "IN", beta: "fx", price: "fx_inr" },
    { id: "fx_usd", group: "waehrungen", label: "Dollar", sub: "US-Dollar, handelsgewichtet (Fed, breiter Index)", kind: "fx", region: "US", beta: "usd", price: "usd_broad", usd: true },
    { id: "fx_eurchf", group: "waehrungen", label: "Euro in Franken", short: "EUR/CHF", sub: "EUR/CHF", kind: "fx", region: "EA", beta: "fx", price: { ratio: ["fx_eur", "fx_chf"] }, cross: "CH" },

    { id: "brent", group: "rohstoffe", label: "Öl (Brent)", short: "Öl", sub: "US-Dollar je Fass", kind: "commodity", region: "WORLD", beta: "commodity", price: "brent", geo: [["il_ir", 0.5], ["ru_ua", 0.2]] },
    { id: "copper", group: "rohstoffe", label: "Kupfer", sub: "US-Dollar je Tonne", kind: "commodity", region: "CN", beta: "commodity", price: "copper" },
    { id: "silver", group: "rohstoffe", label: "Silber", sub: "US-Dollar je Feinunze", kind: "gold", region: "US", beta: "commodity", price: "silver_usd" },
    { id: "gold_chf", group: "rohstoffe", label: "Gold in Franken", short: "Gold CHF", sub: "CHF je Feinunze", kind: "gold", region: "CH", beta: "gold", price: { ratio: ["gold_usd", "fx_chf"] } },
    { id: "btc", group: "rohstoffe", label: "Bitcoin", sub: "US-Dollar", kind: "commodity", region: "US", beta: "crypto", price: "btc", noValue: true },

    { id: "rel_ch_us", group: "relativ", label: "Schweiz vs. USA", short: "CH vs. US", sub: "SMI gegenüber S&P 500, beide in Franken", kind: "relative", regions: ["CH", "US"], price: { ratio: ["eq_ch", { product: ["eq_us", { inv: "fx_chf" }] }] } },
    { id: "rel_ea_us", group: "relativ", label: "Eurozone vs. USA", short: "EZ vs. US", sub: "Euro Stoxx 50 gegenüber S&P 500, beide in US-Dollar", kind: "relative", regions: ["EA", "US"], price: { ratio: [{ product: ["eq_ea", "fx_eur"] }, "eq_us"] } },
    { id: "rel_em_us", group: "relativ", label: "Schwellenl. vs. USA", short: "EM vs. US", sub: "MSCI EM gegenüber S&P 500; ohne MSCI-Daten Korb aus China und Indien in US-Dollar", kind: "relative", regions: ["EM", "US"], price: { ratio: ["eq_em", "eq_us"] },
      fallback: { ratio: [{ basket: [[{ product: ["eq_cn", "fx_cny"] }, 0.6], [{ product: ["eq_in", "fx_inr"] }, 0.4]] }, "eq_us"] } },
    { id: "rel_eq_bd", group: "relativ", label: "Aktien vs. Anleihen", short: "Akt./Anl.", sub: "S&P 500 gegenüber 10-jährigen Treasuries", kind: "relative", regions: ["US", null], price: { ratio: ["eq_us", { bond: "y10_us" }] } },
    { id: "rel_gold_eq", group: "relativ", label: "Gold vs. Aktien", short: "Gold/Akt.", sub: "Gold gegenüber S&P 500", kind: "relative", regions: [null, "US"], price: { ratio: ["gold_usd", "eq_us"] } },
  ];
  const GROUPS = [
    { id: "klassen", label: "Anlageklassen" },
    { id: "aktien", label: "Aktien", note: "Lokalwährung" },
    { id: "anleihen", label: "Staatsanleihen", note: "Kurs aus der Rendite" },
    { id: "kredit", label: "Unternehmensanleihen" },
    { id: "waehrungen", label: "Währungen gegenüber dem US-Dollar" },
    { id: "rohstoffe", label: "Rohstoffe" },
    { id: "relativ", label: "Relative Stärke", note: "positiv = erste Anlage vorn" },
  ];

  /* Korb aus mehreren Preisreihen: Renditen gewichtet verkettet. Sind Monatsreihen dabei, rechnet der Korb
     mit Monatsmitteln, sonst mit Tageswerten. Teile ohne Wert in einer Periode fallen dort heraus. */
  function spacing(p) { if (p.length < 3) return 30; const k = Math.min(p.length - 1, 20); return (p[p.length - 1].t - p[p.length - 1 - k].t) / k; }
  function monthlyMeans(p) {
    const m = new Map();
    for (const q of p) { const k = Math.floor(q.x * 12 + 1e-6); const e = m.get(k) || { s: 0, n: 0, t: q.t, e: q.e }; e.s += q.v; e.n++; e.t = Math.min(e.t, q.t); m.set(k, e); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, e]) => { const y = Math.floor(k / 12), mo = k % 12; return { t: Date.UTC(y, mo, 1) / DAY, e: Date.UTC(y, mo + 1, 1) / DAY - 1, x: y + mo / 12, v: e.s / e.n }; });
  }
  // lineare Interpolation zwischen Periodenmitten (für Monatsreihen in einem Tageskorb)
  function interpolator(p) {
    const xs = p.map(q => (q.t + q.e) / 2), vs = p.map(q => q.v);
    return t => {
      if (t < xs[0] || t > xs[xs.length - 1]) return null;
      let lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= t) lo = m; else hi = m; }
      return xs[hi] === xs[lo] ? vs[lo] : vs[lo] + (vs[hi] - vs[lo]) * (t - xs[lo]) / (xs[hi] - xs[lo]);
    };
  }
  function basketSeries(parts) {
    parts = parts.filter(q => q.p.length > 12);
    if (!parts.length) return [];
    const isMonthly = q => spacing(q.p.filter(x => x.t > last(q.p).t - 400)) > 20;
    const allMonthly = parts.every(isMonthly);
    let base, fns;
    if (allMonthly) {
      parts = parts.map(q => ({ ...q, p: monthlyMeans(q.p) }));
      const m = new Map();
      for (const part of parts) for (const q of part.p) if (!m.has(q.t)) m.set(q.t, q);
      base = [...m.values()].sort((a, b) => a.t - b.t);
      fns = parts.map(part => t => { const a = valueAt(part.p, t); return a && t - a.t <= 40 ? a.v : null; });
    } else {
      // Zeitraster: der Teil mit den meisten Werten im letzten Jahr; Monatsreihen werden interpoliert
      const tMax = Math.max(...parts.map(q => last(q.p).t));
      const recent = part => part.p.filter(q => q.t > tMax - 365).length;
      base = parts.reduce((a, b) => (recent(a) >= recent(b) ? a : b)).p;
      fns = parts.map(part => (isMonthly(part) ? interpolator(part.p) : t => { const a = valueAt(part.p, t); return a && t - a.t <= 10 ? a.v : null; }));
    }
    const out = [];
    let idx = 100, prev = null;
    for (const q of base) {
      if (prev != null) {
        let num = 0, den = 0;
        parts.forEach((part, i) => {
          const a = fns[i](q.t), b = fns[i](prev);
          if (a != null && b != null && b > 0) { num += part.w * (a / b - 1); den += part.w; }
        });
        if (den > 0) idx *= 1 + num / den;
      }
      out.push({ t: q.t, e: q.e, x: q.x, v: idx });
      prev = q.t;
    }
    return out;
  }

  /* ------------------------------------------------------------ Preisreihen bilden */
  function priceSeries(L, spec, cut) {
    if (spec == null) return [];
    if (typeof spec === "string") return asOf(L.s[spec], cut);
    if (spec.bond) return bondIndex(asOf(L.s[spec.bond], cut));
    if (spec.inv) return priceSeries(L, spec.inv, cut).map(q => ({ ...q, v: 1 / q.v }));
    if (spec.spread) { // Kurs einer Unternehmensanleihe ~ −Duration × Risikoprämie (Hochzins ~4, Investment Grade ~7)
      const p = asOf(L.s[spec.spread], cut);
      const dur = spec.dur || 4;
      return p.map(q => ({ ...q, v: 100 * Math.exp(-dur / 100 * q.v) }));
    }
    if (spec.ratio) return combine(priceSeries(L, spec.ratio[0], cut), priceSeries(L, spec.ratio[1], cut), (a, b) => (b ? a / b : null));
    if (spec.product) return combine(priceSeries(L, spec.product[0], cut), priceSeries(L, spec.product[1], cut), (a, b) => a * b);
    if (spec.basket) return basketSeries(spec.basket.map(b => (Array.isArray(b) ? { p: priceSeries(L, b[0], cut), w: b[1] } : { p: priceSeries(L, b, cut), w: 1 })));
    return [];
  }
  const regionIds = (r, key) => { const c = cfg.regions[r]; if (!c) return []; const v = c[key]; return v == null ? [] : Array.isArray(v) ? v : [v]; };

  /* ------------------------------------------------------------ Säulen */
  function pillarTrend(p) {
    if (p.length < 30) return null;
    const vol = Math.max(0.03, annVol(p) || 0.15);
    const parts = [];
    for (const [m, days] of [[3, 91], [6, 182], [12, 365]]) {
      const r = change(p, days, "log");
      if (r == null) continue;
      parts.push({ k: `Rendite ${m} Monate`, v: 100 * (Math.exp(r) - 1), u: "%", s: clip2(r / (vol * Math.sqrt(m / 12))) });
    }
    const daily = p.length > 60 && (last(p).t - p[p.length - 30].t) < 60;
    const ma = smaDays(p, daily ? 290 : 305);
    if (ma) {
      const dist = Math.log(last(p).v / ma);
      parts.push({ k: daily ? "Abstand zum 200-Tage-Schnitt" : "Abstand zum 10-Monats-Schnitt", v: 100 * dist, u: "%", s: clip2(dist / (vol * 0.45)), w: 0.6 });
    }
    if (!parts.length) return null;
    const mom = mean(parts.filter(q => q.k.startsWith("Rendite")).map(q => q.s));
    const dist = parts.find(q => q.k.startsWith("Abstand"));
    const s = mom == null ? dist.s : dist ? 0.6 * mom + 0.4 * dist.s : mom;
    return { s, parts };
  }

  function growthScore(L, ids, cut) {
    const sc = [], parts = [];
    for (const id of ids) {
      const p = asOf(L.s[id], cut);
      if (p.length < 6) continue;
      const a = last(p), b = valueAt(p, a.t - 85);
      if (!b) continue;
      const mom = a.v - b.v, lvl = a.v - 100;
      sc.push(clip2(1.4 * mom + 0.3 * lvl));
      if (ids.length === 1) {
        parts.push({ k: "Frühindikator (OECD)", v: a.v, u: "Punkte", s: null, d: isoOf(a.t).slice(0, 7) });
        parts.push({ k: "Veränderung über 3 Monate", v: mom, u: "Punkte", s: clip2(1.4 * mom) });
      }
    }
    if (!sc.length) return null;
    const s = mean(sc);
    if (ids.length > 1) parts.push({ k: `Frühindikatoren (${sc.length} Regionen)`, v: null, s });
    return { s, parts };
  }
  function inflTrend(L, region, cut) {
    const id = regionIds(region, "cpi")[0];
    const p = asOf(L.s[id], cut);
    if (p.length < 8) return null;
    const a = last(p), b = valueAt(p, a.t - 180);
    if (!b) return null;
    return { now: a.v, d6: a.v - b.v, date: isoOf(a.t).slice(0, 7) };
  }

  function pillarCycle(L, row, cut) {
    if (row.kind === "relative") {
      const [ra, rb] = row.regions;
      const ga = ra ? growthScore(L, regionIds(ra, "cli"), cut) : null, gb = rb ? growthScore(L, regionIds(rb, "cli"), cut) : null;
      if (row.id === "rel_eq_bd" && ga) return { s: ga.s, parts: [{ k: "Wachstumsdynamik USA", v: null, s: ga.s }] };
      if (row.id === "rel_gold_eq" && gb) return { s: -0.6 * gb.s, parts: [{ k: "Wachstumsdynamik USA (invers)", v: null, s: -0.6 * gb.s }] };
      if (!ga || !gb) return null;
      return { s: clip2(ga.s - gb.s), parts: [{ k: "Wachstumsvorsprung", v: null, s: clip2(ga.s - gb.s) }] };
    }
    const g = growthScore(L, regionIds(row.region, "cli"), cut);
    if (row.kind === "equity" || row.kind === "credit") return g;
    if (row.kind === "commodity") return g;
    if (row.kind === "bond") {
      const inf = inflTrend(L, row.region, cut);
      const parts = [];
      let s1 = null, s2 = null;
      if (g) { s1 = -0.7 * g.s; parts.push({ k: "Wachstumsdynamik (invers)", v: null, s: s1 }); }
      if (inf) { s2 = clip2(-inf.d6 / 0.8); parts.push({ k: "Inflation, Veränderung über 6 Monate", v: inf.d6, u: "Pp.", s: s2, d: inf.date }); }
      const s = mean([s1, s2]);
      return s == null ? null : { s, parts };
    }
    if (row.kind === "fx") {
      if (row.usd) { const w = growthScore(L, regionIds("WORLD", "cli"), cut), us = growthScore(L, regionIds("US", "cli"), cut); if (!w || !us) return null; const s = clip2(us.s - w.s); return { s, parts: [{ k: "Wachstumsvorsprung USA gegenüber Welt", v: null, s }] }; }
      const base = row.cross || "US";
      const a = growthScore(L, regionIds(row.region, "cli"), cut), b = growthScore(L, regionIds(base, "cli"), cut);
      if (!a || !b) return null;
      const s = clip2(a.s - b.s);
      return { s, parts: [{ k: `Wachstumsvorsprung gegenüber ${base === "US" ? "den USA" : "der Schweiz"}`, v: null, s }] };
    }
    if (row.kind === "gold") {
      const w = growthScore(L, regionIds("WORLD", "cli"), cut);
      const inf = inflTrend(L, "US", cut);
      const parts = [];
      const s1 = w ? -0.5 * w.s : null, s2 = inf ? clip2(inf.d6 / 0.8) : null;
      if (s1 != null) parts.push({ k: "Weltkonjunktur (invers)", v: null, s: s1 });
      if (s2 != null) parts.push({ k: "US-Inflation, Veränderung über 6 Monate", v: inf.d6, u: "Pp.", s: s2 });
      const s = mean([s1, s2]);
      return s == null ? null : { s, parts };
    }
    return null;
  }

  function pillarValue(L, row, cut, price) {
    if (row.kind === "relative" || row.noValue) return null;
    if (row.kind === "equity" || row.kind === "commodity") {
      const td = trendDeviation(price, 10);
      if (!td) return null;
      const parts = [{ k: "Abstand zum 10-Jahres-Trend", v: 100 * (Math.exp(td.dev) - 1), u: "%", s: clip2(-td.z / 1.2) }];
      let s = parts[0].s;
      if (row.id === "eq_us" && L.cape) {
        const cs = clip2(4 * (0.5 - L.cape.pct));
        parts.push({ k: "Shiller-KGV (Perzentil seit 1881)", v: L.cape.value, u: "", s: cs, d: L.cape.date });
        s = mean([s, cs]);
      }
      return { s, parts };
    }
    if (row.kind === "bond") {
      const yp = asOf(L.s[row.yieldId], cut);
      const inf = inflTrend(L, row.region, cut);
      if (!yp.length || !inf) return null;
      const y = last(yp).v, real = y - inf.now;
      // reale Rendite im Vergleich zum eigenen Mittel der letzten zehn Jahre (Monatsdaten)
      const cpiP = asOf(L.s[regionIds(row.region, "cpi")[0]], cut);
      const realHist = [];
      for (const q of cpiP) { const yy = valueAt(yp, q.e); if (yy && q.e - yy.t < 40) realHist.push({ t: q.t, e: q.e, x: q.x, v: yy.v - q.v }); }
      const z = realHist.length > 24 ? zScore(realHist, 10, real) : null;
      const parts = [{ k: "Realrendite (Rendite minus Inflation)", v: real, u: "%", s: z == null ? clip2(real / 1.2) : clip2(z * 0.9) }];
      return { s: parts[0].s, parts };
    }
    if (row.kind === "credit") {
      const p = asOf(L.s[row.spreadId || "hy_oas"], cut);
      if (p.length < 100) return null;
      const z = zScore(p, 10);
      return { s: clip2(z), parts: [{ k: "Risikoprämie gegenüber 10-Jahres-Mittel", v: last(p).v, u: "Pp.", s: clip2(z) }] };
    }
    if (row.kind === "fx") {
      if (row.cross) return null;
      const rid = row.usd ? "reer_us" : regionIds(row.region, "reer")[0];
      const p = asOf(L.s[rid], cut);
      if (p.length < 60) return null;
      const a = last(p);
      const m = mean(p.filter(q => q.t > a.t - 3653).map(q => q.v));
      const dev = a.v / m - 1;
      let s = clip2(-dev / 0.07);
      if (!row.usd) { // gegenüber dem Dollar zählt die relative Bewertung
        const pu = asOf(L.s["reer_us"], cut);
        if (pu.length > 60) { const au = last(pu); const mu = mean(pu.filter(q => q.t > au.t - 3653).map(q => q.v)); s = clip2(-(dev - (au.v / mu - 1)) / 0.1); }
      }
      return { s, parts: [{ k: "Realer effektiver Wechselkurs gegenüber 10-Jahres-Mittel", v: 100 * dev, u: "%", s, d: isoOf(a.t).slice(0, 7) }] };
    }
    if (row.kind === "gold") {
      const cpi = asOf(L.s["cpi_us_index"], cut);
      if (!cpi.length || price.length < 200) return null;
      const real = combine(price, cpi.map(q => ({ ...q, t: q.e })), (g, c) => g / c, 75);
      const td = trendDeviation(real, 10);
      if (!td) return null;
      return { s: clip2(-td.z / 1.2), parts: [{ k: "Realer Preis gegenüber 10-Jahres-Trend", v: 100 * (Math.exp(td.dev) - 1), u: "%", s: clip2(-td.z / 1.2) }] };
    }
    return null;
  }

  function policyChange(L, region, cut, days) {
    const id = regionIds(region, "pr")[0];
    const p = asOf(L.s[id], cut);
    if (p.length < 3) return null;
    const a = last(p), b = valueAt(p, a.t - days);
    return b ? { d: a.v - b.v, now: a.v, date: isoOf(a.t) } : null;
  }

  function pillarLiquidity(L, row, cut) {
    const parts = [];
    const push = (k, v, u, s, d) => { if (s != null && isFinite(s)) parts.push({ k, v, u, s, d }); };
    if (row.kind === "relative") return null;
    const usd6 = (() => { const p = asOf(L.s["usd_broad"], cut); return p.length > 60 ? change(p, 182, "log") : null; })();
    if (row.kind === "equity" || row.kind === "credit" || row.kind === "commodity") {
      const reg = row.region === "WORLD" || row.region === "EM" ? "US" : row.region;
      const pc = policyChange(L, reg, cut, 365);
      if (pc) push(`Leitzinsänderung 12 Monate (${reg === "US" ? "Fed" : reg})`, pc.d, "Pp.", clip2(-pc.d / 0.6));
      const y = asOf(L.s[regionIds(reg, "y10")[0]], cut);
      if (pc && y.length) { const slope = last(y).v - pc.now; push("Zinskurve (10 Jahre minus Leitzins)", slope, "Pp.", clip2(slope / 1.0)); }
      if (reg === "US") {
        const bs = asOf(L.s["fed_assets"], cut);
        if (bs.length > 30) { const g = change(bs, 182, "pct"); if (g != null) push("Bilanzsumme der Fed, 6 Monate", 100 * g, "%", clip2(g / 0.03)); }
      }
      if ((row.kind === "commodity" || row.beta === "em") && usd6 != null) push("US-Dollar, 6 Monate (invers)", 100 * usd6, "%", clip2(-usd6 / 0.04));
    } else if (row.kind === "bond") {
      const pc = policyChange(L, row.region, cut, 182);
      if (pc) push("Leitzinsänderung 6 Monate", pc.d, "Pp.", clip2(-pc.d / 0.4));
      if (row.region === "US") {
        const y2 = asOf(L.s["y2_us"], cut), pr = asOf(L.s["pr_us"], cut);
        if (y2.length && pr.length) { const exp = last(y2).v - last(pr).v; push("Markterwartung (2-jährige Rendite minus Leitzins)", exp, "Pp.", clip2(-exp / 0.5)); }
      }
    } else if (row.kind === "fx") {
      if (row.usd) {
        const pc = policyChange(L, "US", cut, 182);
        if (pc) push("Fed-Leitzins, Veränderung 6 Monate", pc.d, "Pp.", clip2(pc.d / 0.5));
      } else {
        const base = row.cross || "US";
        const a = policyChange(L, row.region, cut, 182), b = policyChange(L, base, cut, 182);
        if (a && b) {
          push("Zinsdifferenz, Veränderung 6 Monate", a.d - b.d, "Pp.", clip2((a.d - b.d) / 0.5));
          push("Zinsdifferenz, Niveau", a.now - b.now, "Pp.", clip2((a.now - b.now) / 3) * 0.5);
        }
      }
    } else if (row.kind === "gold") {
      const ry = asOf(L.s["real10_us"], cut);
      if (ry.length > 100) { const d = change(ry, 182, "diff"); if (d != null) push("Reale US-Rendite, 6 Monate (invers)", d, "Pp.", clip2(-d / 0.4)); }
      if (usd6 != null) push("US-Dollar, 6 Monate (invers)", 100 * usd6, "%", clip2(-usd6 / 0.04));
    }
    if (!parts.length) return null;
    return { s: mean(parts.map(q => q.s)), parts };
  }

  /* Risikoappetit: positiv = Risikofreude, negativ = Risikoscheu */
  function riskAppetite(L, cut) {
    const parts = [];
    const vix = asOf(L.s["vix"], cut);
    if (vix.length > 100) {
      const a = last(vix), med = median(vix.filter(q => q.t > a.t - 365).map(q => q.v));
      parts.push({ k: "VIX gegenüber Jahresmedian", v: a.v - med, u: "Punkte", s: clip2(-(a.v - med) / 5) });
    }
    const hy = asOf(L.s["hy_oas"], cut);
    if (hy.length > 100) { const d = change(hy, 91, "diff"); if (d != null) parts.push({ k: "Hochzins-Risikoprämie, 3 Monate", v: d, u: "Pp.", s: clip2(-d / 0.6) }); }
    const fs = asOf(L.s["stlfsi"], cut);
    if (fs.length > 20) parts.push({ k: "Finanzstressindex (St. Louis Fed)", v: last(fs).v, u: "", s: clip2(-last(fs).v / 1.2) });
    const gpr = L.tension && L.tension.global;
    if (gpr && gpr.z != null && cut == null) parts.push({ k: "Geopolitisches Risiko (Abweichung vom Jahresmittel)", v: gpr.z, u: "σ", s: clip2(-gpr.z / 1.5) });
    const gprPrev = L.tension && L.tension.globalPrev;
    if (gprPrev && gprPrev.z != null && cut != null) parts.push({ k: "Geopolitisches Risiko (Abweichung vom Jahresmittel)", v: gprPrev.z, u: "σ", s: clip2(-gprPrev.z / 1.5) });
    if (!parts.length) return null;
    return { s: mean(parts.map(q => q.s)), parts };
  }

  function pillarRisk(L, row, cut, ra) {
    if (row.kind === "relative") return null;
    const b = cfg.beta[row.beta] ?? 0;
    const parts = [];
    let s = null;
    if (ra) { s = b * ra.s; parts.push({ k: `Risikoappetit × Risikobeta (${b > 0 ? "+" : ""}${b})`, v: ra.s, u: "", s }); }
    for (const [pair, w] of row.geo || []) {
      const t = L.tension && L.tension.pairs && L.tension.pairs[pair];
      const z = t ? (cut == null ? t.z : t.zPrev) : null;
      if (z == null) continue;
      const g = clip2(w * z);
      parts.push({ k: `Spannung ${t.label}`, v: z, u: "σ", s: g });
      s = s == null ? g : s + g;
    }
    if (s == null) return null;
    return { s: Math.max(-2, Math.min(2, s)), parts };
  }

  /* Einstufung; mit Vorstufe gilt ein Toleranzband: Die Stufe wechselt erst, wenn der Wert die Schwelle um mehr
     als cfg.hyst überschreitet. So springen Werte nahe einer Schwelle nicht jeden Monat hin und her. */
  function category(score, prev) {
    if (score == null) return null;
    const c = cfg.cats.find(c => score <= c.max);
    const pn = prev == null ? null : typeof prev === "object" ? prev.n : prev;
    const P = pn == null ? null : cfg.cats[pn + 2];
    if (!P) return c;
    const lo = pn > -2 ? cfg.cats[pn + 1].max : -Infinity;
    return score > lo - cfg.hyst && score <= P.max + cfg.hyst ? P : c;
  }

  // lange Monatshistorie (Kennung <id>_m) für die Bewertung, sonst die Tagesreihe
  function longSeries(L, row, cut, price) {
    if (typeof row.price === "string" && L.s[row.price + "_m"]) {
      const m = asOf(L.s[row.price + "_m"], cut);
      if (m.length) { const t1 = last(m).t; return m.concat(price.filter(q => q.t > t1 + 31)); }
    }
    return price;
  }

  function rowPrice(L, row, cut) {
    let p = priceSeries(L, row.price, cut);
    if (p.length < 30 && row.fallback) p = priceSeries(L, row.fallback, cut);
    return p;
  }
  function evaluate(L, row, cut, ra) {
    const price = rowPrice(L, row, cut);
    if (price.length < 30) return null;
    const P = {
      trend: pillarTrend(price),
      cycle: pillarCycle(L, row, cut),
      value: pillarValue(L, row, cut, longSeries(L, row, cut, price)),
      liquidity: pillarLiquidity(L, row, cut),
      risk: pillarRisk(L, row, cut, ra),
    };
    const w = cfg.weights[row.kind];
    let num = 0, den = 0;
    for (const [k, p] of Object.entries(P)) if (p && p.s != null && w[k]) { num += w[k] * p.s; den += w[k]; }
    if (den < 0.3) return null;
    const score = num / den;
    return { score, cat: category(score), pillars: P, price, coverage: den, date: last(price).t };
  }

  /* Hauptfunktion: Barometer für alle Zeilen, jetzt und einen Monat zuvor */
  function barometer(L) {
    const raNow = riskAppetite(L, null);
    // Stichtag: jüngster Tageswert der Leitreihen
    const lead = ["eq_us", "y10_us", "fx_chf", "gold_usd"].map(id => last((L.s[id] || { pts: [] }).pts)).filter(Boolean).map(p => p.t);
    const tNow = lead.length ? Math.max(...lead) : null;
    const tPrev = tNow != null ? tNow - 30 : null;
    const raPrev = tPrev != null ? riskAppetite(L, tPrev) : null;
    const rows = [];
    for (const row of ROWS) {
      const now = evaluate(L, row, null, raNow);
      if (!now) { rows.push({ row, now: null, prev: null }); continue; }
      // Vormonat: 30 Tage vor dem jüngsten Kurs der Zeile (Monatsreihen und verzögert veröffentlichte Reihen)
      const cutRow = tPrev != null ? Math.min(tPrev, now.date - 30) : null;
      const prev = cutRow != null ? evaluate(L, row, cutRow, cutRow === tPrev ? raPrev : riskAppetite(L, cutRow)) : null;
      if (prev && prev.cat) { now.raw = now.cat; now.cat = category(now.score, prev.cat); }
      const p = now.price;
      const perf = {
        m1: change(p, 30, "pct"), m3: change(p, 91, "pct"), y1: change(p, 365, "pct"),
        ytd: (() => { const a = last(p); const y = new Date(a.t * DAY).getUTCFullYear(); const b = valueAt(p, Date.UTC(y, 0, 1) / DAY - 1); return b && b.v ? a.v / b.v - 1 : null; })(),
      };
      rows.push({ row, now, prev, perf, spark: p.filter(q => q.t > last(p).t - 190).map(q => [q.x, q.v]) });
    }
    return { rows, groups: GROUPS, risk: raNow, riskPrev: raPrev, tNow, tPrev };
  }

  /* Konjunkturphase aus dem Frühindikator: Niveau über/unter 100, Dynamik positiv/negativ */
  function cyclePhase(p) {
    if (!p || p.length < 6) return null;
    const a = last(p), b = valueAt(p, a.t - 85);
    if (!b) return null;
    const lvl = a.v - 100, mom = a.v - b.v;
    const id = lvl >= 0 ? (mom >= 0 ? "expansion" : "slowdown") : (mom >= 0 ? "recovery" : "contraction");
    const label = { expansion: "Aufschwung", slowdown: "Abschwung", contraction: "Abschwächung unter Trend", recovery: "Erholung" }[id];
    return { id, label, lvl, mom, date: isoOf(a.t).slice(0, 7) };
  }

  /* Spannungsindex je Länderpaar aus den GDELT-Tageswerten (Reihen gdelt_c_<paar>, gdelt_k_<paar>, gdelt_n_<paar>):
     pct   Perzentil des 7-Tage-Mittels innerhalb der letzten 90 Tage (wie bei World Monitor)
     z     Abweichung des 14-Tage-Mittels vom Mittel der 120 Tage davor, in Standardabweichungen
     zPrev dieselbe Größe 30 Tage zuvor (für die Vormonatseinstufung im Barometer) */
  function tensionFromGdelt(L) {
    const out = { pairs: {}, global: null, globalPrev: null, last: null };
    const zs = [], zsPrev = [];
    const mean7 = (p, i) => { const w = p.slice(Math.max(0, i - 6), i + 1).map(q => q.v); return w.length >= 4 ? mean(w) : null; };
    for (const [id, s] of Object.entries(L.s)) {
      if (!id.startsWith("gdelt_c_")) continue;
      const pair = id.slice(8);
      const p = s.pts;
      if (p.length < 30) continue;
      const a = last(p);
      const m7 = p.map((q, i) => ({ t: q.t, v: mean7(p, i) })).filter(q => q.v != null);
      const cur = last(m7);
      const hist = m7.filter(q => q.t > a.t - 90).map(q => q.v);
      const pct = hist.length >= 20 ? 100 * hist.filter(v => v <= cur.v).length / hist.length : null;
      const prevWeek = valueAt(m7, a.t - 7);
      const wow = prevWeek && prevWeek.v > 0 ? cur.v / prevWeek.v - 1 : null;
      const zAt = t1 => {
        const rec = p.filter(q => q.t > t1 - 14 && q.t <= t1).map(q => q.v);
        const base = p.filter(q => q.t > t1 - 134 && q.t <= t1 - 14).map(q => q.v);
        const m = mean(base), sdev = sd(base);
        return rec.length >= 7 && base.length >= 30 && sdev ? (mean(rec) - m) / sdev : null;
      };
      const z = zAt(a.t), zPrev = zAt(a.t - 30);
      const kser = L.s["gdelt_k_" + pair], nser = L.s["gdelt_n_" + pair];
      const c14 = mean(p.filter(q => q.t > a.t - 14).map(q => q.v));
      const k14 = kser ? mean(kser.pts.filter(q => q.t > a.t - 14).map(q => q.v)) : null;
      const events7 = nser ? nser.pts.filter(q => q.t > a.t - 7).reduce((x, q) => x + q.v, 0) : null;
      out.pairs[pair] = {
        label: (s.l || pair).replace(/^Konfliktintensität:\s*/, ""), pct, z, zPrev, wow, now7: cur.v,
        share: c14 != null && k14 != null && c14 + k14 > 0 ? c14 / (c14 + k14) : null, events7,
        spark: m7.map(q => [yearFrac(q.t), q.v]), last: isoOf(a.t),
      };
      if (!out.last || isoOf(a.t) > out.last) out.last = isoOf(a.t);
      if (z != null) zs.push(z);
      if (zPrev != null) zsPrev.push(zPrev);
    }
    if (zs.length) out.global = { z: mean(zs), n: zs.length };
    if (zsPrev.length) out.globalPrev = { z: mean(zsPrev), n: zsPrev.length };
    return out;
  }

  /* Live-Daten aufbereiten: Monats- und Tagesreihen derselben Größe zusammenführen und Ersatzreihen setzen.
     hist: optional { gold_usd_m: kompakte Monatsreihe, cape: {...} } aus dem wöchentlichen Datensatz */
  function prepareLive(L, hist = {}) {
    const S = L.s;
    // Monatswerte (Periodenende) mit nachfolgenden Tageswerten verketten
    const splice = (id, monthlyId, dailyIds, label) => {
      const m = S[monthlyId] ? S[monthlyId].pts.map(q => ({ ...q, t: q.e, x: yearFrac(q.e) })) : [];
      let d = [];
      for (const di of dailyIds) if (S[di]) d = d.concat(S[di].pts);
      d.sort((a, b) => a.t - b.t);
      const dedup = [];
      for (const q of d) { if (dedup.length && dedup[dedup.length - 1].t === q.t) dedup[dedup.length - 1] = q; else dedup.push(q); }
      const firstDaily = dedup.length ? dedup[0].t : Infinity;
      const pts = m.filter(q => q.t < firstDaily).concat(dedup);
      if (pts.length) S[id] = { id, f: dedup.length ? "D" : "M", l: label, src: (S[dailyIds.find(x => S[x])] || S[monthlyId] || {}).src, pts };
    };
    // tagesaktuelle Reihe ab ihrem Beginn, davor die ältere Reihe (etwa SMI: SIX tagesaktuell, davor SNB)
    const prefer = (id, newerId) => {
      const n = S[newerId];
      if (!n || !n.pts.length) return;
      const o = S[id] ? S[id].pts.filter(q => q.t < n.pts[0].t) : [];
      S[id] = { ...n, id, pts: o.concat(n.pts) };
    };
    prefer("eq_ch", "eq_ch_six");
    prefer("eq_ch_spi", "eq_ch_spi_six");
    if (!S.y10_ch || S.y10_ch.derived !== false) splice("y10_ch", "y10m_ch", ["y10_ch_d"], "Rendite 10-jähriger Eidgenossen");
    splice("y10_jp", "y10m_jp", ["y10_jp_hist", "y10_jp"], "Rendite 10-jähriger japanischer Staatsanleihen");
    if (!S.y10_in && S.y10m_in) S.y10_in = { ...S.y10m_in, id: "y10_in" };
    if (!S.y10_cn && S.y10m_cn) S.y10_cn = { ...S.y10m_cn, id: "y10_cn" };
    if (!S.y10_gb && S.y10m_gb) S.y10_gb = { ...S.y10m_gb, id: "y10_gb" };
    if (!S.y10_de && S.y10m_de) S.y10_de = { ...S.y10m_de, id: "y10_de" };
    // Leitzinsen: BIS, sonst Angaben der Zentralbanken
    if (!S.pr_gb && S.pr_gb_boe) S.pr_gb = S.pr_gb_boe;
    if (!S.pr_ch && S.pr_ch_snb) S.pr_ch = S.pr_ch_snb;
    if (!S.pr_ea && S.pr_ea_dfr) S.pr_ea = S.pr_ea_dfr;
    if (!S.pr_us && S.dff) S.pr_us = S.dff;
    // Gold: lange Monatshistorie für die Bewertung, Tageswerte der Notenbank; ohne Tageswerte die IWF-Monatsmittel
    if (hist.gold_usd_m && !S.gold_usd_m) S.gold_usd_m = { id: "gold_usd_m", f: "M", src: "gold", pts: decodeSeries(hist.gold_usd_m) };
    if (S.gold_usd_imf) {
      const m = S.gold_usd_m ? S.gold_usd_m.pts : [];
      const t1 = m.length ? m[m.length - 1].t : -Infinity;
      S.gold_usd_m = { id: "gold_usd_m", f: "M", src: "imf", pts: m.concat(S.gold_usd_imf.pts.filter(q => q.t > t1)) };
    }
    if (!S.gold_usd && S.gold_usd_imf) S.gold_usd = S.gold_usd_imf;
    if (!S.copper && S.copper_fred) S.copper = S.copper_fred;
    if (hist.cape) L.cape = hist.cape;
    L.tension = tensionFromGdelt(L);
    return L;
  }

  return {
    cfg, ROWS, GROUPS, decodeSeries, decodeSnapshot, asOf, last, valueAt, change, annVol, trendDeviation, zScore, yoy,
    combine, bondIndex, priceSeries, pillarTrend, growthScore, riskAppetite, evaluate, barometer, category, cyclePhase,
    tensionFromGdelt, prepareLive, basketSeries, isoOf, dayOf, yearFrac, mean, median, sd, clip2,
  };
})();

if (typeof module !== "undefined") module.exports = { SIG };
