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
        L.s[id] = { id, f: s.f, l: s.l, u: s.u, src: s.src, note: s.note, lag: s.lag, pts: decodeSeries(s) };
        L.jobOf[id] = job;
      }
      if (out.items) L.items[job] = out.items;
    }
    return L;
  }

  /* ------------------------------------------------------------ Zeitreihen-Hilfen */
  const LAG = { D: 0, W: 3, M: 15, Q: 45, A: 120 };
  // Punkte, die zum Stichtag "cut" (Tag) bereits veröffentlicht gewesen wären; cut = null: alle
  // Ergebnis je Reihe für den letzten Stichtag zwischengespeichert (Rückrechnung und Backtest fragen dieselbe Reihe
  // für viele Zeilen zum selben Stichtag ab); Periodenenden e sind aufsteigend
  function asOf(ser, cut) {
    if (!ser) return [];
    if (cut == null) return ser.pts;
    if (ser._cut === cut) return ser._slice;
    const lag = ser.lag ?? LAG[ser.f] ?? 0;
    const p = ser.pts;
    let lo = 0, hi = p.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p[m].e + lag <= cut) lo = m + 1; else hi = m; }
    const out = lo === p.length ? p : p.slice(0, lo);
    ser._cut = cut;
    ser._slice = out;
    return out;
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
  // z-Wert des jüngsten Werts (oder val) gegenüber den letzten `years` Jahren; je Kalenderwoche zählt ein Wert, damit
  // tägliche und ausgedünnte (wöchentliche) Abschnitte einer Reihe gleich viel Gewicht haben, live wie im Backtest
  function zScore(p, years, val) {
    const a = last(p); if (!a) return null;
    const wk = new Map();
    for (const q of p) if (q.t > a.t - years * 365.25) wk.set(Math.floor((q.t + 3) / 7), q.v);
    const win = [...wk.values()];
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
  // Zwei Reihen Punkt für Punkt verknüpfen; Periodenwerte (Monatsmittel) der zweiten Reihe gelten bis zum Periodenende
  function combine(pa, pb, fn, tol = 7) {
    if (!pa.length || !pb.length) return [];
    const out = [];
    for (const q of pa) {
      const b = valueAt(pb, q.t);
      if (!b || q.t - Math.max(b.t, Math.min(b.e ?? b.t, q.t)) > tol) continue;
      const v = fn(q.v, b.v);
      if (v != null && isFinite(v)) out.push({ t: q.t, e: q.e, x: q.x, v });
    }
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
  /* Gewichte der Säulen je Horizont und Anlageart. Ausgangspunkt waren Literatur und Plausibilität; angepasst nach den
     Rückrechnungen seit 1970 (Rangkorrelation jeder Säule mit der späteren Rendite, in allen Teilperioden geprüft).
     Trendfolge wirkt über Wochen, Bewertung, Konjunktur und Stimmung (antizyklisch) über ein bis fünf Jahre. Säulen ohne
     belegte Prognosekraft für einen Horizont erhalten wenig oder kein Gewicht. Die Treffsicherheit „ohne Vorgriff“ misst
     der Backtest mit jährlich neu geschätzten Gewichten (worker/backtest.js). */
  // Ausblick 1 Monat (auch als cfg.weights erreichbar)
  const W_M1 = {
    equity: { trend: 0.40, cycle: 0.35, value: 0.05, liquidity: 0.10, risk: 0.10 },
    bond: { trend: 0.35, cycle: 0.20, value: 0.30, liquidity: 0.05, risk: 0.10 },
    credit: { trend: 0.15, cycle: 0.40, value: 0.35, liquidity: 0.10, risk: 0 },
    fx: { trend: 0.60, cycle: 0.05, value: 0, liquidity: 0.25, risk: 0.10 },
    gold: { trend: 0.55, cycle: 0.10, value: 0, liquidity: 0.25, risk: 0.10 },
    // Rohstoffe und Regionen-Paare ohne Konjunktursäule: im Backtest seit 1955 insgesamt bzw. in allen vier Zeiträumen negativ
    commodity: { trend: 0.46, cycle: 0, value: 0.08, liquidity: 0.15, risk: 0.31 },
    relative: { trend: 1, cycle: 0, value: 0, liquidity: 0, risk: 0 },
  };
  // 12 Monate: Bewertung, Konjunktur (antizyklisch), Stimmung und Positionierung zählen mehr, das kurzfristige Kursmomentum weniger
  const W_Y1 = {
    equity: { cycle12: 0.25, value: 0.40, liquidity: 0.15, mom12: 0.10, risk12: 0.10 },
    bond: { cycle12: 0.15, value: 0.45, liquidity: 0.10, mom12: 0.10, risk12: 0.20 },
    credit: { cycle12: 0.20, value: 0.45, liquidity: 0.20, mom12: 0, risk12: 0.15 },
    fx: { cycle12: 0, value: 0.30, liquidity: 0.15, mom12: 0.50, risk12: 0.05 },
    gold: { cycle12: 0.10, value: 0.25, liquidity: 0.15, mom12: 0.30, risk12: 0.20 },
    commodity: { cycle12: 0.45, value: 0.05, liquidity: 0.15, mom12: 0.05, risk12: 0.30 },
    relative: { cycle12: 0, value: 0.50, liquidity: 0, mom12: 0.50, risk12: 0 },
  };
  // 5–10 Jahre: Bewertung dominiert. Wachstum, Schulden und Machtposition (großer Zyklus) werden angezeigt, zählen aber nur,
  // wo sie im Backtest Prognosekraft zeigen (Wachstum bei Rohstoffen). Aktien nur nach Bewertung: In den Daten von 18 Ländern
  // seit 1890 (Jordà-Schularick-Taylor) sagten ein starker Langfristtrend und hohes Wachstum eher schwächere Jahre voraus,
  // im eigenen Backtest seit 1970 eher stärkere; ohne beide schlägt das Signal den Zufall gleich deutlich.
  const W_LT = {
    equity: { valueLT: 1, growth: 0, debt: 0, power: 0, trendLT: 0 },
    bond: { valueLT: 0.75, growth: 0, debt: 0, power: 0, trendLT: 0.25 },
    credit: { valueLT: 0.70, growth: 0, debt: 0, power: 0, trendLT: 0.30 },
    fx: { valueLT: 0.65, growth: 0, debt: 0, power: 0, trendLT: 0.35 },
    gold: { valueLT: 0.80, growth: 0, debt: 0, power: 0, trendLT: 0.20 },
    commodity: { valueLT: 0.20, growth: 0.30, debt: 0, power: 0, trendLT: 0.50 },
    relative: { valueLT: 0.75, growth: 0, debt: 0, power: 0, trendLT: 0.25 },
  };
  const cfg = {
    // Stand des Modells; ändert sich die Rechnung, rechnet der Worker die gespeicherte Rückrechnung neu
    version: "2026-10-19f",
    pillars: [
      { id: "trend", label: "Trend", short: "T", desc: "Kursmomentum über 3, 6 und 12 Monate, risikobereinigt, und Abstand zum gleitenden 200-Tage-Durchschnitt (Monatsreihen: 10 Monate)." },
      { id: "cycle", label: "Konjunktur", short: "K", desc: "OECD-Frühindikator der Region: Niveau gegenüber dem langfristigen Mittel (100). Bei Aktien, Unternehmensanleihen und Rohstoffen zählt ein hohes Niveau antizyklisch (Boom = spätes Zyklusstadium). Die Dynamik über drei Monate wird angezeigt, zählt aber nicht: mit den damals veröffentlichten Werten hatte sie keine Prognosekraft. Anleihen profitieren von schwächerem Wachstum und sinkender Inflation." },
      { id: "value", label: "Bewertung", short: "B", desc: "Aktien: Aktienanteil am Anlegervermögen der USA (Fed-Finanzierungsrechnung Z.1, antizyklisch), bei den übrigen Märkten zusammen mit dem Abstand zum log-linearen 10-Jahres-Trend. Anleihen: reale Rendite gegenüber ihrer 10-Jahres-Spanne und Steilheit der Zinskurve (Laufzeitprämie). Unternehmensanleihen: Risikoaufschlag gegenüber seiner Historie (Hochzins bzw. Baa-Anleihen seit 1919). Währungen: realer effektiver Wechselkurs (BIS) gegenüber dem 10-Jahres-Mittel. Gold: realer Goldpreis." },
      { id: "liquidity", label: "Liquidität", short: "L", desc: "Richtung der Geldpolitik (Leitzinsänderung über 12 Monate), Steilheit der Zinskurve, Zentralbankbilanz und Dollartrend." },
      { id: "risk", label: "Risikoappetit", short: "R", desc: "Risikoappetit aus Volatilität (VIX), Hochzins-Risikoprämien und Finanzstress, gewichtet mit dem Risikobeta der Anlage. Sichere Häfen (Franken, Yen, Gold, Staatsanleihen) gewinnen bei Risikoaversion. Geopolitische Spannungen des Spannungsmonitors werden angezeigt, zählen aber nicht: ohne lange Historie lassen sie sich nicht im Backtest prüfen." },
      { id: "cycle12", label: "Konjunktur", short: "K", desc: "OECD-Frühindikator (Niveau antizyklisch: ein Boom kündigt schwächere Folgejahre an), IWF-Wachstumsprognose für die nächsten zwölf Monate und in den USA die Baugenehmigungen als früher Zyklusindikator. Anleihen zusätzlich die erwartete Inflationsentwicklung." },
      { id: "mom12", label: "Momentum 12 M.", short: "M", desc: "Kursentwicklung der letzten zwölf Monate ohne den jüngsten Monat, risikobereinigt (Zeitreihen-Momentum), und Abstand zum Zwölfmonatsmittel." },
      { id: "risk12", label: "Stimmung & Risiko", short: "R", desc: "Antizyklische Stimmungs- und Positionierungsdaten: Verbraucherstimmung (Michigan, EU-Kommission), Kreditlücke (BIS), Positionierung der Spekulanten an den Terminmärkten (CFTC), Anleihe-Risikoprämie (Gilchrist-Zakrajšek) und geopolitisches Risiko (für Gold). Euphorie und hohe Verschuldung warnen, Pessimismus ist eine Chance." },
      { id: "valueLT", label: "Bewertung", short: "B", desc: "Aktien USA und Welt: Aktienanteil am Anlegervermögen (Fed Z.1), Shiller-KGV und Verbraucherstimmung, jeweils antizyklisch; übrige Märkte: Abstand zum langfristigen Trend (bis 20 Jahre), der US-Aktienanteil als globale Bewertung und die Wirtschaftsstimmung. Rohstoffe: realer Preis gegenüber dem langfristigen Trend. Anleihen: erwartete Realrendite (Rendite minus IWF-Inflationsprognose für fünf Jahre). Unternehmensanleihen: Risikoaufschlag und Anleihe-Risikoprämie. Währungen: realer effektiver Wechselkurs gegenüber dem langjährigen Mittel. Gold: realer Goldpreis seit 1971." },
      { id: "growth", label: "Wachstum & Demografie", short: "W", desc: "IWF-Prognose des realen Wachstums für die nächsten fünf Jahre, Entwicklung der Bevölkerung im erwerbsfähigen Alter in den nächsten zehn Jahren (Projektion der Weltbank) und Produktivitätswachstum der letzten zehn Jahre. Zählt nur bei Rohstoffen: Bei Aktien gingen hohes Wachstum und ein starker Langfristtrend in 16 Ländern seit 1890 eher schwächeren Jahren voraus." },
      { id: "debt", label: "Schulden", short: "S", desc: "Langer Schuldenzyklus: Staatsschulden in % des BIP, ihre Entwicklung bis in fünf Jahren laut IWF, Haushaltssaldo und Zins minus nominales Wachstum. Hohe und steigende Schulden belasten Anleihen und Währung und stützen Gold. Für die Renditen der folgenden fünf Jahre zeigte die Säule im Backtest keine Prognosekraft; sie fließt derzeit nicht ein." },
      { id: "power", label: "Machtposition", short: "P", desc: "Großer Zyklus nach Dalio: Veränderung des Anteils an der Weltwirtschaft (Kaufkraftparitäten, IWF) über zehn Jahre, Leistungsbilanz und bei Währungen der Anteil an den Weltdevisenreserven (IWF COFER). Im Backtest ohne Prognosekraft für die Renditen der folgenden fünf Jahre; fließt derzeit nicht ein." },
      { id: "trendLT", label: "Langfristtrend", short: "T", desc: "Steigung des log-linearen Zehnjahrestrends und Kursentwicklung über drei Jahre, jeweils im Verhältnis zur Schwankungsbreite. Bei Unternehmensanleihen und Rohstoffen antizyklisch: lange Haussen enden eher in Rückschlägen. Bei Aktien ohne Gewicht (seit 1970 eher prozyklisch, in 16 Ländern seit 1890 eher antizyklisch)." },
    ],
    horizons: [
      { id: "m1", label: "1 Monat", title: "Ausblick 1 Monat", short: "1 M.", desc: "Taktische Sicht für die nächsten Wochen: Trend, Konjunkturdynamik, Liquidität und Risikoappetit stehen im Vordergrund.", pillars: ["trend", "cycle", "value", "liquidity", "risk"], weights: W_M1 },
      { id: "y1", label: "12 Monate", title: "Ausblick 12 Monate", short: "12 M.", desc: "Zyklische Sicht für das nächste Jahr: Bewertung, Wachstumsprognose und Geldpolitik zählen mehr, kurzfristige Kursbewegungen weniger.", pillars: ["cycle12", "value", "liquidity", "mom12", "risk12"], weights: W_Y1 },
      { id: "lt", label: "5–10 Jahre", title: "Langfristiger Trend (5–10 Jahre)", short: "5–10 J.", desc: "Strukturelle Sicht im Sinne von Dalios großem Zyklus: Bewertung, Wachstum und Demografie, Schuldenlast und Machtposition der Länder.", pillars: ["valueLT", "growth", "debt", "power", "trendLT"], weights: W_LT },
    ],
    weights: W_M1,
    priors: { m1: W_M1, y1: W_Y1, lt: W_LT },
    cats: [
      // Stufen gegenüber dem üblichen Ertrag der Anlage (Durchschnitt ihrer Geschichte im Horizont): Das sagt die
      // Stufe aus (Backtest: Treffer gegen den üblichen Ertrag); die Richtung der Kurse zeigt die Wahrscheinlichkeit
      { n: -2, sym: "−−", label: "klar unter üblich", max: -0.9 },
      { n: -1, sym: "−", label: "unter üblich", max: -0.3 },
      { n: 0, sym: "=", label: "wie üblich", max: 0.3 },
      { n: 1, sym: "+", label: "über üblich", max: 0.9 },
      { n: 2, sym: "++", label: "klar über üblich", max: Infinity },
    ],
    hyst: 0.1,
    // Frühindikator: Gewicht der Veränderung über drei Monate und des Niveaus gegenüber 100 (je Punkt). Die Veränderung
    // zählt nicht: sie wird in den ersten Monaten stark revidiert und hatte mit den damals veröffentlichten Werten
    // (OECD-Revisionsdatenbank, seit 2001) keine Prognosekraft; das Niveau bleibt
    cli: { mom: 0, lvl: 0.3 },
    // Risiko-Beta: wie stark eine Anlage von Risikoappetit (+) oder Risikoscheu (−) profitiert
    beta: { equity: 1, em: 1.2, credit: 1, commodity: 0.7, gold: -0.7, safeFx: -0.9, fx: 0.2, usd: -0.3, safeBond: -0.6, bond: -0.3, crypto: 1.2 },
    // Reihen je Region; imf/wb/cofer: Kürzel der Jahresreihen von IWF (WEO) und Weltbank und der Reservewährung
    regions: {
      US: { cli: "cli_us", cpi: "cpi_us", pr: "pr_us", y10: "y10_us", reer: "reer_us", imf: "usa", wb: "usa", cofer: "usd" },
      EA: { cli: "cli_ea", cpi: "cpi_ea", pr: "pr_ea", y10: "y10_de", reer: "reer_ea", imf: "euro", wb: "euu", cofer: "eur", pppAlt: "deu" },
      DE: { cli: "cli_de", cpi: "cpi_de", pr: "pr_ea", y10: "y10_de", reer: "reer_ea", imf: "deu", wb: "deu" },
      CH: { cli: "cli_ch", cpi: "cpi_ch", pr: "pr_ch", y10: "y10_ch", reer: "reer_ch", imf: "che", wb: "che", cofer: "chf" },
      JP: { cli: "cli_jp", cpi: "cpi_jp", pr: "pr_jp", y10: "y10_jp", reer: "reer_jp", imf: "jpn", wb: "jpn", cofer: "jpy" },
      GB: { cli: "cli_gb", cpi: "cpi_gb", pr: "pr_gb", y10: "y10_gb", reer: "reer_gb", imf: "gbr", wb: "gbr", cofer: "gbp" },
      CN: { cli: "cli_cn", cpi: "cpi_cn", pr: "pr_cn", y10: "y10_cn", reer: "reer_cn", imf: "chn", wb: "chn", cofer: "cny" },
      IN: { cli: "cli_in", cpi: "cpi_in", pr: "pr_in", y10: "y10_in", reer: "reer_in", imf: "ind", wb: "ind" },
      // zusammengesetzte Regionen: Gewichte nach ungefährem Anteil an der Weltwirtschaft (Kaufkraftparitäten)
      WORLD: { cli: ["cli_us", "cli_ea", "cli_cn", "cli_jp", "cli_gb", "cli_in"], cpi: "cpi_us", pr: "pr_us", mix: { US: 0.25, EA: 0.20, CN: 0.31, JP: 0.06, GB: 0.04, IN: 0.14 } },
      KR: { cli: "cli_kr", pr: "pr_kr", reer: "reer_kr", imf: "kor", wb: "kor" },
      BR: { cli: "cli_br", pr: "pr_br", reer: "reer_br", imf: "bra", wb: "bra" },
      MX: { cli: "cli_mx", pr: "pr_mx", reer: "reer_mx", imf: "mex", wb: "mex" },
      ZA: { cli: "cli_za", pr: "pr_za", reer: "reer_za", imf: "zaf", wb: "zaf" },
      ID: { cli: "cli_id", pr: "pr_id", reer: "reer_id", imf: "idn", wb: "idn" },
      TR: { cli: "cli_tr", pr: "pr_tr", reer: "reer_tr", imf: "tur", wb: "tur" },
      TW: { reer: "reer_tw", imf: "twn" },
      // Schwellenländer: Frühindikatoren von acht Ländern (gleich gewichtet), IWF- und Weltbankdaten nach ungefährem
      // Börsenwert gewichtet (wie die großen Schwellenländer-Indizes: China, Taiwan, Indien, Korea, Brasilien …)
      EM: { cli: ["cli_cn", "cli_in", "cli_kr", "cli_br", "cli_mx", "cli_za", "cli_id", "cli_tr"], cpi: "cpi_cn", pr: "pr_us",
        mix: { CN: 0.30, TW: 0.19, IN: 0.19, KR: 0.12, BR: 0.06, ZA: 0.04, MX: 0.03, ID: 0.02, TR: 0.01 } },
    },
    names: { US: "USA", EA: "Eurozone", DE: "Deutschland", CH: "Schweiz", JP: "Japan", GB: "Großbritannien", CN: "China", IN: "Indien", WORLD: "Welt", EM: "Schwellenländer",
      KR: "Korea", BR: "Brasilien", MX: "Mexiko", ZA: "Südafrika", ID: "Indonesien", TR: "Türkei", TW: "Taiwan" },
    // langjährige Mediane der Risikoprämien (ICE BofA, seit 1997) als Maßstab der langfristigen Bewertung
    spreadRef: { hy_oas: 4.5, ig_oas: 1.3, hy_oas_eu: 4.3 },
    // Schuldenlast der Reservewährungsländer für Gold (USA doppelt)
    goldDebtMix: { US: 0.5, EA: 0.15, JP: 0.15, GB: 0.1, CN: 0.1 },
  };

  /* Zeilen des Barometers. price: Reihen-ID oder Rechenvorschrift; kind bestimmt Gewichte und Säulenlogik.
     mix: Gewichte der Regionen für die Strukturdaten (Wachstum, Schulden, Machtposition); horizons: nur diese Horizonte. */
  const ROWS = [
    { id: "eq_world", group: "klassen", label: "Aktien", sub: "Korb nach ungefährer Börsengewichtung: USA, Eurozone, China, Japan, Großbritannien, Schweiz, Indien", kind: "equity", region: "WORLD", beta: "equity", price: { basket: [["eq_us", 0.62], ["eq_ea", 0.1], ["eq_jp", 0.06], ["eq_gb", 0.04], ["eq_ch", 0.03], ["eq_cn", 0.05], ["eq_in", 0.03]] },
      mix: { US: 0.62, EA: 0.1, JP: 0.06, GB: 0.04, CH: 0.03, CN: 0.05, IN: 0.03 } },
    { id: "bd_core", group: "klassen", label: "Staatsanleihen", short: "Staatsanl.", sub: "USA, Deutschland, Schweiz, 10 Jahre", kind: "bond", region: "US", beta: "safeBond", price: { basket: [{ bond: "y10_us" }, { bond: "y10_de" }, { bond: "y10_ch" }] }, yieldId: "y10_us", mix: { US: 0.5, DE: 0.25, CH: 0.25 } },
    { id: "credit_all", group: "klassen", label: "Unternehmensanleihen", short: "Untern.-Anl.", sub: "USA, Hochzins (ICE BofA)", kind: "credit", region: "US", beta: "credit", price: { spread: "hy_oas" }, spreadId: "hy_oas" },
    { id: "gold_usd", group: "klassen", label: "Gold", sub: "US-Dollar je Feinunze", kind: "gold", region: "US", beta: "gold", price: "gold_usd", gold: true },
    { id: "commod", group: "klassen", label: "Rohstoffe", sub: "Brent und Kupfer", kind: "commodity", region: "WORLD", beta: "commodity", price: { basket: ["brent", "copper"] } },

    { id: "eq_us", group: "aktien", label: "USA", sub: "S&P 500", kind: "equity", region: "US", beta: "equity", price: "eq_us" },
    { id: "eq_ea", group: "aktien", label: "Eurozone", sub: "Euro Stoxx 50", kind: "equity", region: "EA", beta: "equity", price: "eq_ea", geo: [["ru_eu", -0.4]] },
    { id: "eq_ch", group: "aktien", label: "Schweiz", sub: "SMI", kind: "equity", region: "CH", beta: "equity", price: "eq_ch" },
    { id: "eq_de", group: "aktien", label: "Deutschland", short: "DE", sub: "DAX", kind: "equity", region: "DE", beta: "equity", price: "eq_de", geo: [["ru_eu", -0.4]] },
    { id: "eq_gb", group: "aktien", label: "Großbritannien", short: "GB", sub: "FTSE 100", kind: "equity", region: "GB", beta: "equity", price: "eq_gb" },
    { id: "eq_jp", group: "aktien", label: "Japan", sub: "Nikkei 225", kind: "equity", region: "JP", beta: "equity", price: "eq_jp", geo: [["cn_jp", -0.3]] },
    { id: "eq_cn", group: "aktien", label: "China", sub: "Shanghai Composite", kind: "equity", region: "CN", beta: "em", price: "eq_cn", geo: [["us_cn", -0.5], ["cn_tw", -0.4]] },
    { id: "eq_in", group: "aktien", label: "Indien", sub: "Nifty 50", kind: "equity", region: "IN", beta: "em", price: "eq_in", geo: [["in_pk", -0.3]] },
    { id: "eq_em", group: "aktien", label: "Schwellenländer", short: "EM", sub: "Nasdaq Emerging Markets Index in US-Dollar (mit Taiwan; Korea zählt Nasdaq seit 2015 zu den Industrieländern); ohne Tagesdaten Korb aus China und Indien", kind: "equity", region: "EM", beta: "em", price: "eq_em", fallback: { basket: [["eq_cn", 0.6], ["eq_in", 0.4]] }, geo: [["us_cn", -0.3]] },

    { id: "bd_us", group: "anleihen", label: "USA", sub: "Treasuries, 10 Jahre", kind: "bond", region: "US", beta: "safeBond", price: { bond: "y10_us" }, yieldId: "y10_us" },
    { id: "bd_de", group: "anleihen", label: "Deutschland", short: "DE", sub: "Bundesanleihen, 10 Jahre", kind: "bond", region: "EA", beta: "safeBond", price: { bond: "y10_de" }, yieldId: "y10_de", mix: { DE: 1 } },
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
    { id: "fx_cny", group: "waehrungen", label: "Renminbi", sub: "CNY in US-Dollar", kind: "fx", region: "CN", beta: "fx", price: "fx_cny", geo: [["us_cn", -0.3]] },
    { id: "fx_inr", group: "waehrungen", label: "Rupie", sub: "INR in US-Dollar", kind: "fx", region: "IN", beta: "fx", price: "fx_inr" },
    { id: "fx_usd", group: "waehrungen", label: "Dollar", sub: "US-Dollar, handelsgewichtet (Fed, breiter Index)", kind: "fx", region: "US", beta: "usd", price: "usd_broad", usd: true },
    { id: "fx_eurchf", group: "waehrungen", label: "Euro in Franken", short: "EUR/CHF", sub: "EUR/CHF", kind: "fx", region: "EA", beta: "fx", price: { ratio: ["fx_eur", "fx_chf"] }, cross: "CH" },

    { id: "brent", group: "rohstoffe", label: "Öl (Brent)", short: "Öl", sub: "US-Dollar je Fass", kind: "commodity", region: "WORLD", beta: "commodity", price: "brent", geo: [["il_ir", 0.5], ["ru_ua", 0.2]] },
    { id: "copper", group: "rohstoffe", label: "Kupfer", sub: "US-Dollar je Tonne", kind: "commodity", region: "CN", beta: "commodity", price: "copper", mix: { CN: 0.5, US: 0.15, EA: 0.15, IN: 0.1, JP: 0.05, GB: 0.05 } },
    { id: "btc", group: "rohstoffe", label: "Bitcoin", sub: "US-Dollar", kind: "commodity", region: "US", beta: "crypto", price: "btc", noValue: true, horizons: ["m1", "y1"] },

    // Gold-Monatsübersicht: Gold in den wichtigsten Währungen, Silber und Gold im Vergleich zu Aktien und Anleihen
    { id: "gold_chf", group: "gold", label: "Gold in Franken", short: "Gold CHF", sub: "CHF je Feinunze", kind: "gold", region: "CH", beta: "gold", price: { ratio: ["gold_usd_long", "fx_chf"] }, gold: true },
    { id: "gold_eur", group: "gold", label: "Gold in Euro", short: "Gold EUR", sub: "EUR je Feinunze", kind: "gold", region: "EA", beta: "gold", price: { ratio: ["gold_usd_long", "fx_eur"] }, gold: true },
    { id: "silver", group: "gold", label: "Silber", sub: "US-Dollar je Feinunze", kind: "gold", region: "US", beta: "commodity", price: "silver_usd", gold: true },
    { id: "rel_gold_eq", group: "gold", label: "Gold vs. Aktien", short: "Gold/Akt.", sub: "Gold gegenüber S&P 500", kind: "relative", regions: [null, "US"], price: { ratio: ["gold_usd_long", "eq_us_long"] }, gold: true },
    { id: "rel_gold_bd", group: "gold", label: "Gold vs. Anleihen", short: "Gold/Anl.", sub: "Gold gegenüber 10-jährigen Treasuries", kind: "relative", regions: [null, "US"], price: { ratio: ["gold_usd_long", { bond: "y10_us" }] }, gold: true },

    { id: "rel_ch_us", group: "relativ", label: "Schweiz vs. USA", short: "CH vs. US", sub: "SMI gegenüber S&P 500, beide in Franken", kind: "relative", regions: ["CH", "US"], price: { ratio: ["eq_ch", { product: ["eq_us_long", { inv: "fx_chf" }] }] } },
    { id: "rel_ea_us", group: "relativ", label: "Eurozone vs. USA", short: "EZ vs. US", sub: "Euro Stoxx 50 gegenüber S&P 500, beide in US-Dollar", kind: "relative", regions: ["EA", "US"], price: { ratio: [{ product: ["eq_ea", "fx_eur"] }, "eq_us_long"] } },
    { id: "rel_em_us", group: "relativ", label: "Schwellenl. vs. USA", short: "EM vs. US", sub: "Nasdaq Emerging Markets gegenüber S&P 500, beide in US-Dollar; ohne Tagesdaten Korb aus China und Indien", kind: "relative", regions: ["EM", "US"], price: { ratio: ["eq_em", "eq_us_long"] },
      fallback: { ratio: [{ basket: [[{ product: ["eq_cn", "fx_cny"] }, 0.6], [{ product: ["eq_in", "fx_inr"] }, 0.4]] }, "eq_us_long"] } },
    { id: "rel_eq_bd", group: "relativ", label: "Aktien vs. Anleihen", short: "Akt./Anl.", sub: "S&P 500 gegenüber 10-jährigen Treasuries", kind: "relative", regions: ["US", null], price: { ratio: ["eq_us_long", { bond: "y10_us" }] } },
  ];
  const GROUPS = [
    { id: "klassen", label: "Anlageklassen" },
    { id: "aktien", label: "Aktien", note: "Lokalwährung" },
    { id: "anleihen", label: "Staatsanleihen", note: "Kurs aus der Rendite" },
    { id: "kredit", label: "Unternehmensanleihen" },
    { id: "waehrungen", label: "Währungen gegenüber dem US-Dollar" },
    { id: "rohstoffe", label: "Rohstoffe" },
    { id: "relativ", label: "Relative Stärke", note: "über = erste Anlage stärker als üblich" },
    { id: "gold", label: "Gold und Silber", note: "eigene Monatsübersicht" },
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
  // abgeleitete Preisreihen je Stichtag zwischenspeichern (die letzten Stichtage; prepareLive leert den Speicher)
  // Risikoprämie für das Modell: die verlängerte Reihe (prepareLive), sonst das Original
  const spreadSer = (L, id) => L.s[id + "_long"] || L.s[id];
  // Ältere Reihe vor eine neuere setzen, skaliert mit dem Median der Verhältnisse im ganzen Überlappungszeitraum
  function spliceScaled(newer, older) {
    if (!newer || !newer.pts.length || !older || !older.pts.length) return null;
    const t0 = newer.pts[0].t, ratios = [];
    for (const q of newer.pts) { const o = valueAt(older.pts, q.t); if (o && q.t - o.t < 10 && o.v) ratios.push(q.v / o.v); }
    if (ratios.length < 20) return null;
    const k = median(ratios);
    return { ...newer, pts: older.pts.filter(q => q.t < t0).map(q => ({ ...q, v: q.v * k })).concat(newer.pts) };
  }
  function priceSeries(L, spec, cut) {
    if (spec == null) return [];
    if (typeof spec === "string") return asOf(L.s[spec], cut);
    const memo = L._pm || (L._pm = new Map());
    let m = memo.get(cut);
    if (!m) { m = new Map(); memo.set(cut, m); if (memo.size > 3) memo.delete(memo.keys().next().value); }
    if (m.has(spec)) return m.get(spec);
    const out = priceSeriesCalc(L, spec, cut);
    m.set(spec, out);
    return out;
  }
  function priceSeriesCalc(L, spec, cut) {
    if (spec.bond) return bondIndex(asOf(L.s[spec.bond], cut));
    if (spec.inv) return priceSeries(L, spec.inv, cut).map(q => ({ ...q, v: 1 / q.v }));
    if (spec.spread) { // Kurs einer Unternehmensanleihe ~ −Duration × Risikoprämie (Hochzins ~4, Investment Grade ~7)
      const p = asOf(spreadSer(L, spec.spread), cut);
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
    // Tages- und Wochenreihen (Backtest: verdichtete Tageskurse) mit dem 200-Tage-Schnitt, Monatsreihen mit 10 Monaten
    const daily = p.length > 60 && (last(p).t - p[p.length - 30].t) < 300;
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

  /* Frühindikator: Niveau gegenüber 100 (die Dynamik über drei Monate mit dem Gewicht cfg.cli.mom, derzeit 0). mode "contra" wertet das Niveau antizyklisch:
     Märkte nehmen die Erholung vorweg, ein hohes Niveau geht im Backtest schwächeren Aktien- und Kreditjahren voraus. */
  function growthScore(L, ids, cut, mode = "mom") {
    const sc = [], parts = [];
    const mw = cfg.cli.mom, lw = mode === "contra" ? -cfg.cli.lvl : cfg.cli.lvl;
    for (const id of ids) {
      const p = asOf(L.s[id], cut);
      if (p.length < 6) continue;
      const a = last(p), b = valueAt(p, a.t - 85);
      if (!b) continue;
      const mom = a.v - b.v, lvl = a.v - 100;
      sc.push(clip2(mw * mom + lw * lvl));
      if (ids.length === 1) {
        parts.push({ k: "Frühindikator (OECD)", v: a.v, u: "Punkte", s: null, d: isoOf(a.t).slice(0, 7) });
        parts.push({ k: mw ? "Veränderung über 3 Monate" : "Veränderung über 3 Monate (nur zur Information)", v: mom, u: "Punkte", s: mw ? clip2(mw * mom) : null });
        parts.push({ k: mode === "contra" ? "Niveau gegenüber 100 (antizyklisch)" : "Niveau gegenüber 100", v: lvl, u: "Punkte", s: clip2(lw * lvl) });
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
      if (row.id === "rel_gold_bd") { // steigende Inflation spricht für Gold und gegen Anleihen
        const inf = inflTrend(L, "US", cut);
        if (!inf) return null;
        const s = clip2(inf.d6 / 0.8);
        return { s, parts: [{ k: "US-Inflation, Veränderung über 6 Monate", v: inf.d6, u: "Pp.", s, d: inf.date }] };
      }
      if (!ga || !gb) return null;
      return { s: clip2(ga.s - gb.s), parts: [{ k: "Wachstumsvorsprung", v: null, s: clip2(ga.s - gb.s) }] };
    }
    const contra = row.kind === "equity" || row.kind === "credit" || row.kind === "commodity";
    const g = growthScore(L, regionIds(row.region, "cli"), cut, contra ? "contra" : "mom");
    if (contra) return g;
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

  /* Shiller-KGV zum Stichtag: mit Monatsreihe (seit 1881) der damals bekannte Wert und sein Perzentil bis dahin,
     sonst nur der jüngste Wert (in der Rückrechnung dann ohne KGV) */
  function capeAt(L, cut) {
    const p = L.capeM;
    if (!p || !p.length) return L.cape || null;
    if (cut == null && L.cape) return L.cape;
    const pts = cut == null ? p : p.filter(q => q.e + 15 <= cut);
    if (pts.length < 120) return null;
    const a = last(pts);
    return { value: a.v, pct: pts.filter(q => q.v <= a.v).length / pts.length, date: isoOf(a.t) };
  }

  /* ------------------------------------------------------------ zusätzliche Bausteine (im Backtest geprüft) */
  const usLike = r => r === "US" || r === "WORLD";
  // z-Wert des jüngsten Werts gegenüber den letzten `years` Jahren
  function zAt(L, id, cut, years = 10, minN = 36) {
    const p = asOf(L.s[id], cut);
    if (p.length < minN) return null;
    const z = zScore(p, years);
    return z == null ? null : { z, v: last(p).v, d: isoOf(last(p).t) };
  }
  // Baugenehmigungen USA über sechs Monate: der Bauzyklus läuft der Konjunktur voraus
  function permitsPart(L, cut) {
    const p = asOf(L.s.permit_us, cut);
    if (p.length < 12) return null;
    const c = change(p, 182, "log");
    return c == null ? null : { k: "Baugenehmigungen USA, Veränderung 6 Monate", v: 100 * c, u: "%", s: clip2(c / 0.15), d: isoOf(last(p).t).slice(0, 7) };
  }
  // Stimmung antizyklisch: Verbraucherstimmung USA (Michigan) bzw. Wirtschaftsstimmung (EU-Kommission)
  function sentimentPart(L, region, cut) {
    const id = usLike(region) ? "umcsent" : region === "DE" ? "esi_de" : region === "EA" ? "esi_ea" : null;
    const z = id ? zAt(L, id, cut, 10, 60) : null;
    if (!z) return null;
    const name = id === "umcsent" ? "Verbraucherstimmung USA" : `Wirtschaftsstimmung ${region === "DE" ? "Deutschland" : "Euroraum"}`;
    return { k: `${name} (antizyklisch)`, v: z.v, u: "Punkte", s: clip2(-z.z / 1.2), d: z.d.slice(0, 7) };
  }
  // Kreditlücke der BIZ (Kredit/BIP-Quote über ihrem Trend), antizyklisch: übermäßiges Kreditwachstum belastet
  const CGAP = { US: "us", EA: "de", DE: "de", CH: "ch", JP: "jp", GB: "gb", CN: "cn", IN: "in", WORLD: "us", EM: ["cn", "in", "kr", "br", "mx", "za", "id", "tr"] };
  function creditGapPart(L, region, cut) {
    const c = CGAP[region];
    if (Array.isArray(c)) { // Schwellenländer: Mittel der verfügbaren Länder
      const vals = c.map(x => last(asOf(L.s["cgap_" + x], cut))).filter(Boolean);
      if (vals.length < 3) return null;
      const v = mean(vals.map(a => a.v));
      return { k: `Kreditlücke Schwellenländer (BIZ, Mittel aus ${vals.length} Ländern, antizyklisch)`, v, u: "Pp.", s: clip2(-v / 8), d: isoOf(Math.max(...vals.map(a => a.t))).slice(0, 7) };
    }
    const p = c ? asOf(L.s["cgap_" + c], cut) : [];
    if (!p.length) return null;
    const a = last(p);
    return { k: `Kreditlücke ${regName(c.toUpperCase() === "DE" ? "DE" : c.toUpperCase())} (BIZ, antizyklisch)`, v: a.v, u: "Pp.", s: clip2(-a.v / 8), d: isoOf(a.t).slice(0, 7) };
  }
  // Positionierung der Spekulanten an den Terminmärkten (CFTC), z über drei Jahre; contra: antizyklisch gewertet
  function cotPart(L, key, cut, contra, label) {
    const z = zAt(L, "cot_" + key, cut, 3, 100);
    if (!z) return null;
    return { k: `Positionierung der Spekulanten ${label}${contra ? " (antizyklisch)" : ""}`, v: z.v, u: "% OI", s: clip2((contra ? -z.z : z.z) / 1.2), d: z.d };
  }
  // Geopolitisches Risiko (Caldara-Iacoviello, Monatswerte) gegenüber zehn Jahren: hoch stützt Gold
  function gprPart(L, cut) {
    const z = zAt(L, "gpr_m", cut, 10, 60);
    return z ? { k: "Geopolitischer Risikoindex (GPR) gegenüber 10 Jahren", v: z.z, u: "σ", s: clip2(z.z / 1.5), d: z.d.slice(0, 7) } : null;
  }
  // Excess Bond Premium (Federal Reserve): Risikoaufschlag über das Ausfallrisiko hinaus; hoch = Anleger verunsichert
  function ebpPart(L, cut) {
    const p = asOf(L.s.ebp, cut);
    if (!p.length) return null;
    const a = last(p);
    return { k: "Excess Bond Premium (Fed)", v: a.v, u: "Pp.", s: clip2(a.v / 0.5), d: isoOf(a.t).slice(0, 7) };
  }
  // Zinskurve: Rendite 10 Jahre minus Leitzins; eine steile Kurve bringt Anleihen eine höhere Laufzeitprämie
  function termPart(L, region, cut) {
    const y = asOf(L.s[regionIds(region, "y10")[0]], cut), r = asOf(L.s[regionIds(region, "pr")[0]], cut);
    if (!y.length || !r.length) return null;
    const sl = last(y).v - last(r).v;
    return { k: "Zinskurve (10 Jahre minus Leitzins)", v: sl, u: "Pp.", s: clip2((sl - 1) / 1.2) };
  }
  // Prämie Moody's Baa gegenüber 10-jährigen Treasuries, z über zehn Jahre (lange Historie seit 1986)
  function baaPart(L, cut) {
    const z = zAt(L, "baa10y", cut, 10, 200);
    return z ? { k: "Prämie Moody's Baa gegenüber dem 10-Jahres-Mittel", v: z.v, u: "Pp.", s: clip2(z.z), d: z.d } : null;
  }
  // Shiller-KGV: Perzentil des Monatswerts unter allen Monaten seit 1881 (hoch = teuer)
  const capePart = (L, cut) => { const c = capeAt(L, cut); return c ? { k: "Shiller-KGV (Perzentil seit 1881)", v: c.value, u: "", s: clip2(4 * (0.5 - c.pct)), d: c.date } : null; };
  const meanParts = parts => { const ok = parts.filter(q => q && q.s != null && isFinite(q.s)); return ok.length ? { s: mean(ok.map(q => q.s)), parts: ok } : null; };
  /* Aktienanteil am Anlegervermögen USA (Fed Z.1): Marktwert aller US-Aktien ÷ (Aktien + Schulden der Realwirtschaft).
     Der jüngste veröffentlichte Quartalswert wird mit dem S&P 500 bis zum Stichtag fortgeschrieben (der Schuldenstand
     ändert sich langsam): x' = k·x ÷ (k·x + 1 − x) mit k = Kursveränderung seit Quartalsende. Gewertet antizyklisch als
     z-Wert gegenüber allen Quartalen seit 1945. */
  function aiaeAt(L, cut) {
    const p = asOf(L.s.aiae_us, cut);
    if (p.length < 40) return null;
    const a = last(p), x = a.v / 100;
    const sp = priceSeries(L, "eq_us", cut);
    const s0 = valueAt(sp, a.e), s1 = last(sp);
    const k = s0 && s1 && s1.t > a.e && s0.v > 0 ? s1.v / s0.v : 1;
    const now = (k * x) / (k * x + 1 - x);
    const hist = p.map(q => q.v / 100), m = mean(hist), sdv = sd(hist), iso = isoOf(a.t);
    return { v: 100 * now, q: a.v, date: `${iso.slice(0, 4)}-Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1}`, m: 100 * m, z: sdv ? (now - m) / sdv : null };
  }
  // mode "us": US-Aktien antizyklisch; "global": dito als globale Bewertung der übrigen Märkte; "gold": Gold gegenüber Aktien
  // (ein hoher Aktienanteil ging stärkeren Goldjahren voraus, im Backtest in allen Teilperioden seit 1972)
  const aiaePart = (L, cut, mode = "us") => {
    const a = aiaeAt(L, cut);
    if (!a || a.z == null) return null;
    const gold = mode === "gold";
    const k = gold ? "Aktienanteil am Anlegervermögen USA (hoch = Gold als Absicherung gefragt)" : `${mode === "global" ? "Globale Bewertung: " : ""}Aktienanteil am Anlegervermögen USA (antizyklisch)`;
    return { k: `${k}, Fed Z.1; Mittel seit 1945 ${fmtN(a.m)} %`, v: a.v, u: "% Anteil", s: clip2(((gold ? 1 : -1) * a.z) / 1.2), d: a.date };
  };
  // Reale Rendite 10-jähriger Treasuries (Rendite minus Inflation der letzten zwölf Monate): Opportunitätskosten von Gold,
  // langjähriges Mittel rund 2 %
  function realYieldGoldPart(L, cut) {
    const y = asOf(L.s.y10_us, cut), c = asOf(L.s.cpi_us, cut);
    if (!y.length || !c.length) return null;
    const v = last(y).v - last(c).v;
    return { k: "Reale US-Rendite 10 Jahre (Rendite minus Inflation; hoch belastet Gold)", v, u: "%", s: clip2(-(v - 2) / 2), d: isoOf(last(y).t) };
  }

  function pillarValue(L, row, cut, price) {
    if (row.noValue) return null;
    if (row.kind === "relative") { // Verhältnis zweier Anlagen: Abstand zum eigenen 10-Jahres-Trend (Rückkehr zur Mitte)
      if (row.gold) return meanParts([aiaePart(L, cut, "gold")]);
      const td = trendDeviation(price, 10);
      if (!td) return null;
      const s = clip2(-td.z / 1.2);
      return { s, parts: [{ k: "Verhältnis gegenüber seinem 10-Jahres-Trend", v: 100 * (Math.exp(td.dev) - 1), u: "%", s }] };
    }
    if (row.kind === "equity" || row.kind === "commodity") {
      const td = trendDeviation(price, 10);
      if (!td) return null;
      const tdp = { k: "Abstand zum 10-Jahres-Trend", v: 100 * (Math.exp(td.dev) - 1), u: "%", s: clip2(-td.z / 1.2) };
      if (row.kind === "equity") {
        // USA und Welt: Aktienanteil am Anlegervermögen (Fed Z.1; im Backtest seit 1970 treffsicherer als KGV und Trendabstand),
        // ohne Z.1-Daten Shiller-KGV und Trendabstand. Übrige Märkte: eigener Trendabstand und der US-Wert als globale Bewertung.
        const us = row.id === "eq_us" || row.id === "eq_world";
        const ai = aiaePart(L, cut, !us);
        return us ? meanParts([ai]) || meanParts([tdp, capePart(L, cut)]) : meanParts([tdp, ai]);
      }
      return { s: tdp.s, parts: [tdp] };
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
      const term = termPart(L, row.mix ? Object.keys(row.mix)[0] === "DE" ? "DE" : row.region : row.region, cut);
      if (term) parts.push(term);
      return meanParts(parts);
    }
    if (row.kind === "credit") {
      const p = asOf(spreadSer(L, row.spreadId || "hy_oas"), cut);
      const parts = [];
      if (p.length >= 100) { const z = zScore(p, 10); parts.push({ k: "Risikoprämie gegenüber dem Mittel der vorliegenden Jahre (bis 10)", v: last(p).v, u: "Pp.", s: clip2(z) }); }
      parts.push(baaPart(L, cut));
      return meanParts(parts);
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
      const ai = aiaePart(L, cut, "gold");
      if (ai) return { s: ai.s, parts: [ai] };
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
    const key = cut ?? "now";
    if (L._ra && L._ra.has(key)) return L._ra.get(key);
    const r = riskAppetiteCalc(L, cut);
    if (L._ra) L._ra.set(key, r);
    return r;
  }
  function riskAppetiteCalc(L, cut) {
    const parts = [];
    const vix = asOf(L.s["vix"], cut);
    if (vix.length > 100) {
      const a = last(vix), med = median(vix.filter(q => q.t > a.t - 365).map(q => q.v));
      parts.push({ k: "VIX gegenüber Jahresmedian", v: a.v - med, u: "Punkte", s: clip2(-(a.v - med) / 5) });
    }
    const hy = asOf(spreadSer(L, "hy_oas"), cut);
    if (hy.length > 100) { const d = change(hy, 91, "diff"); if (d != null) parts.push({ k: "Hochzins-Risikoprämie, 3 Monate", v: d, u: "Pp.", s: clip2(-d / 0.6) }); }
    const fs = asOf(L.s["stlfsi"], cut);
    if (fs.length > 20) parts.push({ k: "Finanzstressindex (St. Louis Fed)", v: last(fs).v, u: "", s: clip2(-last(fs).v / 1.2) });
    // Spannungsmonitor (GDELT): nur zur Information. Ohne lange Historie lässt er sich nicht im Backtest prüfen; der
    // geopolitische Risikoindex (GPR, seit 1985) brachte dort keine bessere Vorhersage
    const T = L.tension;
    const gz = !T ? null : cut == null ? (T.global ? T.global.z : null) : T.zAt ? T.zAt(cut) : (T.globalPrev ? T.globalPrev.z : null);
    if (!parts.length) return null;
    const s = mean(parts.map(q => q.s));
    if (gz != null) parts.push({ k: "Geopolitische Spannung (GDELT, nur zur Information)", v: gz, u: "σ", s: null });
    return { s, parts };
  }

  function pillarRisk(L, row, cut, ra) {
    if (row.kind === "relative") return null;
    const b = cfg.beta[row.beta] ?? 0;
    const parts = [];
    let s = null;
    if (ra) { s = b * ra.s; parts.push({ k: `Risikoappetit × Risikobeta (${b > 0 ? "+" : ""}${b})`, v: ra.s, u: "", s }); }
    // betroffene Konfliktlinien des Spannungsmonitors: angezeigt, aber ohne Gewicht (im Backtest nicht prüfbar)
    for (const [pair] of row.geo || []) {
      const t = L.tension && L.tension.pairs && L.tension.pairs[pair];
      const z = t ? (cut == null ? t.z : t.zAt ? t.zAt(cut) : t.zPrev) : null;
      if (z != null) parts.push({ k: `Spannung ${t.label} (nur zur Information)`, v: z, u: "σ", s: null });
    }
    if (s == null) return null;
    return { s: Math.max(-2, Math.min(2, s)), parts };
  }

  /* ------------------------------------------------------------ Säulen der längeren Horizonte */
  // Wert eines Jahres aus Jahresreihen mit Projektionen (IWF WEO, Bevölkerungsprojektionen der Weltbank). Es gibt nur
  // den jüngsten Datenstand; Vormonat und Rückrechnung nutzen ihn ebenfalls (in den Erklärungen vermerkt). Im Backtest
  // ab April 2008 gilt für die IWF-Reihen der Stand der damals jüngsten WEO-Ausgabe (L.weoAt, worker/backtest.js).
  function yv(L, id, y) {
    const w = L.weoAt && L.weoAt[id];
    if (w && w[y] != null) return w[y];
    if (L.pitYear != null && y > L.pitYear) return yProj(L, id, y);
    const s = L.s[id];
    if (!s || !s.pts.length) return null;
    const p = s.pts, i = y - Math.round(p[0].x);
    if (i >= 0 && i < p.length && Math.round(p[i].x) === y) return p[i].v;
    const q = p.find(q => Math.round(q.x) === y);
    return q ? q.v : null;
  }
  /* Backtest ohne Vorgriff (L.pit): Werte nach dem letzten damals veröffentlichten Jahr (L.pitYear) werden nicht aus
     den heutigen IWF- und Weltbank-Projektionen genommen, sondern naiv fortgeschrieben: Raten (Wachstum, Inflation,
     Salden) mit dem Mittel der letzten fünf Jahre, Bestände (Schulden, Anteile, Bevölkerung) mit dem Trend der letzten
     fünf Jahre. Das gilt für die IWF-Reihen nur vor April 2008 (danach die damaligen WEO-Ausgaben, siehe yv) und für
     die Weltbank-Projektionen. */
  function yProj(L, id, y) {
    const p = L.pitYear, pre = id.slice(0, id.indexOf("_") + 1);
    const real = k => { const s = L.s[id]; if (!s) return null; const q = s.pts.find(q => Math.round(q.x) === k); return q ? q.v : null; };
    if (["growth_", "infl_", "ca_", "bal_"].includes(pre)) {
      const v = []; for (let k = p - 4; k <= p; k++) { const a = real(k); if (a != null) v.push(a); }
      return v.length >= 3 ? mean(v) : null;
    }
    if (["debt_", "ppp_", "pop_", "wa_", "prod_"].includes(pre)) {
      const a = real(p), b = real(p - 5);
      if (a == null || b == null) return null;
      if (pre === "debt_") return a + (y - p) * (a - b) / 5;
      return b > 0 ? a * Math.pow(a / b, (y - p) / 5) : null;
    }
    return null;
  }
  // zuletzt veröffentlichtes Jahr der Jahresstatistiken zum Stichtag (IWF-Frühjahrsprognose im April)
  const pitYearOf = cut => { const d = new Date(cut * DAY); return d.getUTCMonth() >= 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear() - 2; };
  // Mittel über Jahre y0 bis y1, sofern mindestens die Hälfte der Jahre vorliegt
  function ym(L, id, y0, y1) {
    const v = [];
    for (let y = y0; y <= y1; y++) { const a = yv(L, id, y); if (a != null) v.push(a); }
    return v.length * 2 >= y1 - y0 + 1 ? mean(v) : null;
  }
  const regCode = (r, k) => (cfg.regions[r] || {})[k];
  const regName = r => cfg.names[r] || r;
  // Teilwerte mit einem Faktor umrechnen (etwa Schuldenlast → Signal), damit die Erklärung zum Säulenwert passt
  function scaled(res, f, extra) {
    if (!res || res.s == null) return null;
    return { s: Math.max(-2, Math.min(2, f * res.s)), parts: res.parts.map(q => ({ ...q, s: q.s == null ? null : f * q.s })).concat(extra || []) };
  }
  // Region oder Regionsmischung (Welt, Schwellenländer, Korb der Zeile) mit einer Funktion je Einzelregion bewerten
  function regionMix(row, r) { if (row && row.mix) return row.mix; const m = regCode(r, "mix"); return m || null; }
  function mixed(row, r, fn, label = "") {
    const mix = regionMix(row, r);
    if (!mix) return fn(r);
    const ks = Object.keys(mix);
    if (ks.length === 1) return fn(ks[0]);
    let num = 0, den = 0;
    const parts = [];
    for (const [rr, w] of Object.entries(mix)) {
      const x = fn(rr);
      if (!x || x.s == null) continue;
      num += w * x.s; den += w;
      parts.push({ k: `${label ? label + " " : ""}${regName(rr)} (Gewicht ${Math.round(100 * w)} %)`, v: null, s: x.s });
    }
    const tot = Object.values(mix).reduce((a, b) => a + b, 0);
    return den >= 0.5 * tot ? { s: num / den, parts } : null;
  }
  // Vorsprung der Region a vor b (Währungen, relative Stärke); sign = −1: Mehrbelastung wirkt negativ
  function diffOf(fn, a, b, label, sign = 1) {
    const x = fn(a), y = fn(b);
    if (!x || !y || x.s == null || y.s == null) return null;
    const s = sign * clip2(x.s - y.s);
    return { s, parts: [
      { k: `${label}: ${regName(a)}`, v: x.s, u: "", s: null },
      { k: `${label}: ${regName(b)}`, v: y.s, u: "", s: null },
      { k: sign > 0 ? `Vorsprung ${regName(a)} gegenüber ${regName(b)}` : `Mehrbelastung ${regName(a)} gegenüber ${regName(b)} (invers)`, v: null, s },
    ] };
  }
  const yearOf = t => new Date(t * DAY).getUTCFullYear();
  const yearPart = t => { const d = new Date(t * DAY); return (d.getUTCMonth() + d.getUTCDate() / 31) / 12; };

  /* IWF-Prognose für die nächsten zwölf Monate gegenüber den letzten zwölf Monaten (zeitgewichtet aus den
     Jahreswerten): Beschleunigung von Wachstum bzw. Inflation */
  function weoAccel(L, prefix, r, Y, f) {
    const id = prefix + regCode(r, "imf");
    const a = yv(L, id, Y - 1), b = yv(L, id, Y), c = yv(L, id, Y + 1);
    if (a == null || b == null || c == null) return null;
    const fwd = (1 - f) * b + f * c, trail = (1 - f) * a + f * b;
    return { fwd, trail, d: fwd - trail };
  }
  function growthAccel(L, r, Y, f) {
    const g = weoAccel(L, "growth_", r, Y, f);
    if (!g) return null;
    const s = clip2(g.d / 0.7);
    return { s, parts: [{ k: `IWF: Wachstum nächste 12 Monate ${fmtN(g.fwd)} % nach ${fmtN(g.trail)} %`, v: g.d, u: "Pp.", s }] };
  }
  const fmtN = v => (Math.round(v * 10) / 10).toFixed(1).replace(".", ",");

  function pillarCycle12(c) {
    const { L, row, cut, Y, f } = c;
    const base = pillarCycle(L, row, cut);
    const parts = base ? base.parts : [];
    const ga = r => growthAccel(L, r, Y, f);
    let fc = null;
    const k = row.kind;
    if (k === "equity" || k === "credit" || k === "commodity") {
      fc = mixed(row, row.region, ga, "Wachstumsbeschleunigung");
      const pm = k === "equity" && usLike(row.region) ? permitsPart(L, cut) : null;
      if (pm) fc = fc ? { s: mean([fc.s, pm.s]), parts: [...fc.parts, pm] } : { s: pm.s, parts: [pm] };
    } else if (k === "bond") {
      const g = mixed(row, row.region, ga, "Wachstumsbeschleunigung");
      const reg = row.mix ? Object.keys(row.mix)[0] : row.region;
      const inf = weoAccel(L, "infl_", reg, Y, f);
      const xs = [];
      if (g) xs.push({ k: "IWF-Wachstumsprognose (invers)", v: null, s: -0.7 * g.s });
      if (inf) xs.push({ k: `IWF: Inflation nächste 12 Monate ${fmtN(inf.fwd)} % nach ${fmtN(inf.trail)} % (sinkend stützt)`, v: inf.d, u: "Pp.", s: clip2(-inf.d / 0.6) });
      fc = xs.length ? { s: mean(xs.map(q => q.s)), parts: xs } : null;
    } else if (k === "fx") fc = row.usd ? diffOf(r => mixed(null, r, ga), "US", "WORLD", "Wachstumsbeschleunigung") : diffOf(ga, row.region, row.cross || "US", "Wachstumsbeschleunigung");
    else if (k === "gold") fc = scaled(mixed(null, "WORLD", ga, "Wachstumsbeschleunigung"), -0.5);
    else if (k === "relative") {
      const [a, b] = row.regions;
      if (row.id === "rel_eq_bd") fc = ga("US");
      else if (row.id === "rel_gold_eq") fc = scaled(ga("US"), -0.6);
      else if (row.id === "rel_gold_bd") {
        const inf = weoAccel(L, "infl_", "US", Y, f);
        if (inf) { const s = clip2(inf.d / 0.6); fc = { s, parts: [{ k: `IWF: US-Inflation nächste 12 Monate ${fmtN(inf.fwd)} % nach ${fmtN(inf.trail)} %`, v: inf.d, u: "Pp.", s }] }; }
      } else if (a && b) fc = diffOf(r => mixed(null, r, ga), a, b, "Wachstumsbeschleunigung");
    }
    if (!base && !fc) return null;
    const s = mean([base ? base.s : null, fc ? fc.s : null]);
    const out = [];
    if (base) out.push({ k: "Frühindikator (OECD), Teilsäule", v: null, s: base.s }, ...parts.filter(q => q.s != null || q.v != null).map(q => ({ ...q, sub: true })));
    if (fc) out.push({ k: "IWF-Prognose, Teilsäule", v: null, s: fc.s }, ...fc.parts.map(q => ({ ...q, sub: true })));
    return { s, parts: out };
  }

  // Zeitreihen-Momentum: Rendite der letzten zwölf Monate ohne den jüngsten Monat, risikobereinigt
  function pillarMom12(price) {
    if (price.length < 30) return null;
    const a = last(price);
    const vol = Math.max(0.03, annVol(price) || 0.15);
    const b = valueAt(price, a.t - 30), c = valueAt(price, a.t - 365);
    const parts = [];
    if (b && c && c.t >= a.t - 420 && b.v > 0 && c.v > 0) {
      const r = Math.log(b.v / c.v);
      parts.push({ k: "Rendite 12 Monate ohne den letzten Monat", v: 100 * (Math.exp(r) - 1), u: "%", s: clip2(r / vol), w: 0.7 });
    }
    const avg = smaDays(price, 365);
    if (avg) { const d = Math.log(a.v / avg); parts.push({ k: "Abstand zum Zwölfmonatsmittel", v: 100 * d, u: "%", s: clip2(d / (vol * 0.5)), w: 0.3 }); }
    if (!parts.length) return null;
    const den = parts.reduce((x, q) => x + q.w, 0);
    return { s: parts.reduce((x, q) => x + q.w * q.s, 0) / den, parts };
  }

  // Realer Preis (in Preisen des jüngsten US-Verbraucherpreisindex) als Monatsreihe
  function realMonthly(L, p, cut) {
    const cpi = asOf(L.s["cpi_us_index"], cut);
    if (!cpi.length || p.length < 24) return [];
    const m = monthlyMeans(p);
    return combine(m, cpi, (a, b) => a / b, 75);
  }
  function bondRealLT(L, r, cut, Y) {
    const yp = asOf(L.s[regionIds(r, "y10")[0]], cut);
    if (!yp.length) return null;
    const y = last(yp).v;
    let inf = ym(L, "infl_" + regCode(r, "imf"), Y + 1, Y + 5), src = `IWF-Inflationsprognose ${Y + 1}–${Y + 5}`;
    if (inf == null) { const t = inflTrend(L, r, cut); if (!t) return null; inf = t.now; src = "aktuelle Inflationsrate"; }
    const real = y - inf, s = clip2((real - 1) / 1);
    return { s, parts: [{ k: `${regName(r)}: Rendite ${fmtN(y)} % minus ${src} ${fmtN(inf)} %`, v: real, u: "%", s }] };
  }
  function reerDev(L, id, cut) {
    const p = asOf(L.s[id], cut);
    if (p.length < 120) return null;
    const a = last(p), m = mean(p.map(q => q.v));
    return { dev: a.v / m - 1, from: isoOf(p[0].t).slice(0, 4), date: isoOf(a.t).slice(0, 7) };
  }

  function pillarValueLT(c) {
    const { L, row, cut, price, Y } = c;
    const k = row.kind;
    if (row.noValue) return null;
    if (k === "relative") {
      // Gold gegenüber Aktien und Anleihen: Aktienanteil am Anlegervermögen und reale US-Rendite
      if (row.gold) return meanParts([aiaePart(L, cut, "gold"), realYieldGoldPart(L, cut)]);
      // Regionen und Aktien gegenüber Anleihen: Rückkehr zur Mitte über drei bis fünf Jahre
      const td = trendDeviation(c.long, 20), r36 = change(c.long, 1096, "log"), vol = Math.max(0.03, annVol(price) || 0.15);
      return meanParts([
        td && { k: "Verhältnis gegenüber seinem langfristigen Trend (bis 20 Jahre)", v: 100 * (Math.exp(td.dev) - 1), u: "%", s: clip2(-td.z / 1.2) },
        r36 != null && { k: "Entwicklung des Verhältnisses über drei Jahre (antizyklisch)", v: 100 * (Math.exp(r36) - 1), u: "%", s: clip2(-r36 / (vol * Math.sqrt(3))) },
      ]);
    }
    if (k === "equity" || k === "commodity") {
      const base = k === "commodity" ? realMonthly(L, c.long, cut) : c.long;
      const td = trendDeviation(base.length ? base : c.long, 20);
      const parts = [];
      if (td) parts.push({ k: k === "commodity" ? "Realer Preis gegenüber dem langfristigen Trend (bis 20 Jahre)" : "Abstand zum langfristigen Trend (bis 20 Jahre)", v: 100 * (Math.exp(td.dev) - 1), u: "%", s: clip2(-td.z / 1.2) });
      if (k === "equity") {
        // USA und Welt (US-Markt = gut 60 % der Weltbörse): Aktienanteil am Anlegervermögen, Shiller-KGV und Stimmung,
        // ohne den Trendabstand (lange Haussen der USA liefen im Backtest weiter). Übrige Märkte: eigener Trendabstand,
        // der US-Wert als globale Bewertung und die Stimmung im eigenen Wirtschaftsraum (soweit vorhanden).
        const tdp = td ? parts[0] : null;
        return row.id === "eq_us" || row.id === "eq_world"
          ? meanParts([aiaePart(L, cut), capePart(L, cut), sentimentPart(L, "US", cut)]) || meanParts([tdp])
          : meanParts([tdp, aiaePart(L, cut, true), sentimentPart(L, row.region, cut)]);
      }
      const s = td ? parts[0].s : null;
      return s == null ? null : { s, parts };
    }
    if (k === "bond") return mixed(row.mix ? row : null, row.region, r => bondRealLT(L, r, cut, Y));
    if (k === "credit") {
      const p = asOf(spreadSer(L, row.spreadId), cut);
      const ref = cfg.spreadRef[row.spreadId];
      if (!p.length || ref == null) return null;
      const v = last(p).v;
      return meanParts([{ k: `Risikoprämie gegenüber dem langjährigen Median (${fmtN(ref)} Pp.)`, v: v - ref, u: "Pp.", s: clip2((v - ref) / 1.5) }, baaPart(L, cut), ebpPart(L, cut)]);
    }
    if (k === "fx") {
      const one = r => reerDev(L, regionIds(r, "reer")[0], cut);
      const a = row.usd ? one("US") : one(row.region), b = row.usd ? null : one(row.cross || "US");
      if (!a || (!row.usd && !b)) return null;
      const d = a.dev - (b ? b.dev : 0), s = clip2(-d / 0.12);
      const parts = [{ k: `Realer effektiver Wechselkurs ${regName(row.usd ? "US" : row.region)} gegenüber Mittel seit ${a.from}`, v: 100 * a.dev, u: "%", s: b ? null : s, d: a.date }];
      if (b) parts.push({ k: `dito ${regName(row.cross || "US")}`, v: 100 * b.dev, u: "%", s: null, d: b.date }, { k: "Unterschied (invers)", v: 100 * d, u: "%", s });
      return { s, parts };
    }
    if (k === "gold") {
      // realer Preis gegenüber seiner Geschichte seit 1971, dazu Gold gegenüber Aktien (Aktienanteil am Anlegervermögen)
      // und die Opportunitätskosten (reale US-Rendite)
      const isGold = row.price !== "silver_usd";
      const base = isGold ? longSeries(L, { price: "gold_usd" }, cut, priceSeries(L, "gold_usd", cut)) : c.long;
      const real = realMonthly(L, base, cut);
      const hist = real.filter(q => q.x >= 1971.6);
      let own = null;
      if (hist.length >= 120) {
        const a = last(real), pct = hist.filter(q => q.v <= a.v).length / hist.length;
        own = { k: `Realer ${isGold ? "Goldpreis" : "Silberpreis"}: Perzentil seit ${isoOf(hist[0].t).slice(0, 4)}`, v: 100 * pct, u: "Perzentil", s: clip2(3 * (0.5 - pct)) };
      }
      const m = meanParts([own, aiaePart(L, cut, "gold"), realYieldGoldPart(L, cut)]);
      if (!m) return null;
      if (isGold && row.id !== "gold_usd") m.parts.push({ k: "Bewertung über den Dollarpreis (weltweit einheitlicher Goldpreis)", v: null, s: null });
      return m;
    }
    return null;
  }

  // Wachstum und Demografie einer Region: IWF-Wachstumsprognose, Erwerbsbevölkerung, Produktivität
  function regionGrowth(L, r, Y) {
    const imf = regCode(r, "imf"), wb = regCode(r, "wb");
    const parts = [];
    const g5 = imf ? ym(L, "growth_" + imf, Y + 1, Y + 5) : null;
    const n = regName(r) + ": ";
    if (g5 != null) parts.push({ k: `${n}reales Wachstum ${Y + 1}–${Y + 5} (IWF-Prognose)`, v: g5, u: "% p. a.", s: clip2((g5 - 2) / 1.5) });
    if (wb) {
      const wa = y => { const p = yv(L, "pop_" + wb, y), sh = yv(L, "wa_" + wb, y); return p != null && sh != null ? p * sh / 100 : null; };
      const a = wa(Y), b = wa(Y + 10);
      if (a && b) { const g = 100 * (Math.pow(b / a, 0.1) - 1); parts.push({ k: `${n}erwerbsfähige Bevölkerung ${Y}–${Y + 10} (Projektion)`, v: g, u: "% p. a.", s: clip2(g / 0.5) }); }
      const pr = L.s["prod_" + wb];
      if (pr) {
        const pts = pr.pts.filter(q => q.x <= (L.pitYear != null ? L.pitYear : Y - 1));
        const z = last(pts), o = z ? pts.find(q => Math.round(q.x) === Math.round(z.x) - 10) : null;
        if (z && o && o.v > 0) { const g = 100 * (Math.pow(z.v / o.v, 0.1) - 1); parts.push({ k: `${n}Produktivität je Erwerbstätigem ${Math.round(o.x)}–${Math.round(z.x)}`, v: g, u: "% p. a.", s: clip2((g - 1) / 1) }); }
      }
    }
    return parts.length ? { s: mean(parts.map(q => q.s)), parts } : null;
  }
  // Schuldenlast einer Region (positiv = hohe Last)
  function regionDebt(L, r, Y, cut) {
    const imf = regCode(r, "imf");
    if (!imf) return null;
    const parts = [], n = regName(r) + ": ";
    const d0 = yv(L, "debt_" + imf, Y), d5 = yv(L, "debt_" + imf, Y + 5);
    if (d0 != null) parts.push({ k: `${n}Staatsschulden ${Y}`, v: d0, u: "% des BIP", s: clip2((d0 - 60) / 40) });
    if (d0 != null && d5 != null) parts.push({ k: `${n}Veränderung der Schuldenquote bis ${Y + 5} (IWF-Projektion)`, v: d5 - d0, u: "Pp.", s: clip2((d5 - d0) / 10) });
    const bal = ym(L, "bal_" + imf, Y, Y + 4);
    if (bal != null) parts.push({ k: `${n}Haushaltssaldo ${Y}–${Y + 4}`, v: bal, u: "% des BIP", s: clip2(-(bal + 3) / 3) });
    const yp = asOf(L.s[regionIds(r, "y10")[0]], cut);
    const gN = ym(L, "growth_" + imf, Y + 1, Y + 5), iN = ym(L, "infl_" + imf, Y + 1, Y + 5);
    if (yp.length && gN != null && iN != null) { const rg = last(yp).v - (gN + iN); parts.push({ k: `${n}Zins minus nominales Wachstum (r − g)`, v: rg, u: "Pp.", s: clip2(rg / 1.5) }); }
    return parts.length ? { s: mean(parts.map(q => q.s)), parts } : null;
  }
  // Machtposition einer Region: Anteil an der Weltwirtschaft, Leistungsbilanz, Reservewährungsanteil
  function regionPower(L, r, Y, cut, cofer) {
    const imf = regCode(r, "imf");
    if (!imf) return null;
    const parts = [], n = regName(r) + ": ";
    let pid = "ppp_" + imf, note = "";
    if (!L.s[pid] && regCode(r, "pppAlt")) { pid = "ppp_" + regCode(r, "pppAlt"); note = ", Deutschland als Näherung"; }
    const a = yv(L, pid, Y - 5), b = yv(L, pid, Y + 5);
    if (a && b) { const g = 100 * (Math.pow(b / a, 0.1) - 1); parts.push({ k: `${n}Anteil an der Weltwirtschaft ${Y - 5}–${Y + 5} (KKP${note})`, v: g, u: "% p. a.", s: clip2(g / 1) }); }
    const ca = ym(L, "ca_" + imf, Y, Y + 4);
    if (ca != null) parts.push({ k: `${n}Leistungsbilanz ${Y}–${Y + 4}`, v: ca, u: "% des BIP", s: clip2(ca / 3) });
    if (cofer && regCode(r, "cofer")) {
      const p = asOf(L.s["cofer_" + regCode(r, "cofer")], cut);
      const z = last(p), o = z ? valueAt(p, z.t - 1826) : null;
      if (z && o && z.t - o.t > 1500) parts.push({ k: `${n}Anteil an den Weltdevisenreserven, Veränderung 5 Jahre`, v: z.v - o.v, u: "Pp.", s: clip2((z.v - o.v) / 2), d: isoOf(z.t).slice(0, 7) });
    }
    return parts.length ? { s: mean(parts.map(q => q.s)), parts } : null;
  }

  function pillarGrowth(c) {
    const { L, row, Y } = c;
    const g = r => regionGrowth(L, r, Y);
    const k = row.kind;
    if (k === "equity" || k === "credit" || k === "commodity") return mixed(row, row.region, g, "Strukturwachstum");
    if (k === "bond") return scaled(mixed(row.mix ? row : null, row.region, g, "Strukturwachstum"), -0.5);
    if (k === "fx") return row.usd ? diffOf(r => mixed(null, r, g), "US", "WORLD", "Strukturwachstum") : diffOf(r => mixed(null, r, g), row.region, row.cross || "US", "Strukturwachstum");
    if (k === "relative") {
      const [a, b] = row.regions;
      if (row.id === "rel_eq_bd") return g("US");
      if (row.id === "rel_gold_eq") return scaled(g("US"), -0.5);
      if (a && b) return diffOf(r => mixed(null, r, g), a, b, "Strukturwachstum");
    }
    return null;
  }
  function pillarDebt(c) {
    const { L, row, Y, cut } = c;
    const d = r => regionDebt(L, r, Y, cut);
    const k = row.kind;
    if (k === "equity" || k === "credit") return scaled(mixed(row, row.region, d, "Schuldenlast"), -0.6);
    if (k === "bond") return scaled(mixed(row.mix ? row : null, row.region, d, "Schuldenlast"), -1);
    if (k === "fx") return row.usd ? scaled(d("US"), -0.8) : diffOf(d, row.region, row.cross || "US", "Schuldenlast", -1);
    if (k === "gold") return mixed({ mix: cfg.goldDebtMix }, null, d, "Schuldenlast");
    if (k === "relative") {
      const [a, b] = row.regions;
      if (row.id === "rel_eq_bd") return scaled(d("US"), 0.4);
      if (row.id === "rel_gold_eq") return scaled(d("US"), 0.8);
      if (row.id === "rel_gold_bd") return scaled(d("US"), 1);
      if (a && b) return scaled(diffOf(r => mixed(null, r, d), a, b, "Schuldenlast", -1), 0.6);
    }
    return null;
  }
  function pillarPower(c) {
    const { L, row, Y, cut } = c;
    const k = row.kind;
    const p = (r, cof) => regionPower(L, r, Y, cut, cof);
    if (k === "equity") return mixed(row, row.region, r => p(r, false), "Machtposition");
    if (k === "fx") return row.usd ? p("US", true) : diffOf(r => p(r, true), row.region, row.cross || "US", "Machtposition");
    if (k === "gold") return scaled(p("US", true), -0.8);
    if (k === "relative") {
      const [a, b] = row.regions;
      if (row.id === "rel_gold_eq" || row.id === "rel_gold_bd") return scaled(p("US", true), -0.8);
      if (a && b) return diffOf(r => mixed(null, r, x => p(x, false)), a, b, "Machtposition");
    }
    return null;
  }
  function pillarTrendLT(c) {
    const p = c.long;
    if (p.length < 60) return null;
    const vol = Math.max(0.03, annVol(c.price) || 0.15);
    // Unternehmensanleihen, Rohstoffe und relative Stärke von Regionen kehren über fünf Jahre zur Mitte zurück: dort zählt
    // der Langfristtrend umgekehrt (Goldpaare folgen dagegen ihrem Trend)
    const k = c.row.kind, f = k === "credit" || k === "commodity" || (k === "relative" && !c.row.gold) ? -1 : 1, tag = f < 0 ? " (antizyklisch)" : "";
    const parts = [];
    const td = trendDeviation(p, 10);
    if (td) parts.push({ k: "Steigung des Zehnjahrestrends" + tag, v: 100 * (Math.exp(td.slope) - 1), u: "% p. a.", s: clip2(f * td.slope / (vol * 0.5)) });
    const r36 = change(p, 1096, "log");
    if (r36 != null) parts.push({ k: "Rendite 3 Jahre" + tag, v: 100 * (Math.exp(r36) - 1), u: "%", s: clip2(f * r36 / (vol * Math.sqrt(3))) });
    return parts.length ? { s: mean(parts.map(q => q.s)), parts } : null;
  }

  /* Stimmung & Risiko (12 Monate): Risikoappetit und Spannungen wie beim Ausblick 1 Monat, dazu je Anlageart die im
     Backtest tragenden Bausteine: Stimmung, Kreditlücke und Positionierung antizyklisch (Aktien), Excess Bond Premium
     (Staats- und Unternehmensanleihen), geopolitisches Risiko und Positionierung (Gold) */
  function pillarRisk12(c) {
    const { L, row, cut, ra } = c;
    const k = row.kind, reg = row.region;
    const parts = [];
    const add = p => { if (p && p.s != null && isFinite(p.s)) parts.push(p); };
    const base = k === "gold" || k === "relative" ? null : pillarRisk(L, row, cut, ra);
    if (base) add({ k: "Risikoappetit und Spannungen (wie 1 Monat)", v: null, s: base.s });
    if (k === "equity") {
      add(sentimentPart(L, reg, cut));
      add(creditGapPart(L, reg, cut));
      if (usLike(reg)) add(cotPart(L, "spx", cut, true, "S&P 500"));
    } else if (k === "bond" || k === "credit") {
      add(ebpPart(L, cut));
      if (k === "bond" && reg === "US") add(cotPart(L, "tnote", cut, true, "10-jährige Treasuries"));
    } else if (k === "gold") {
      add(gprPart(L, cut));
      const silver = row.price === "silver_usd";
      add(cotPart(L, silver ? "silver" : "gold", cut, false, silver ? "Silber" : "Gold"));
    }
    return meanParts(parts);
  }

  /* Säulen je Kennung: c = { L, row, cut, price, long, ra, Y, f } */
  const PILLAR_FN = {
    trend: c => pillarTrend(c.price),
    cycle: c => pillarCycle(c.L, c.row, c.cut),
    value: c => pillarValue(c.L, c.row, c.cut, c.long),
    liquidity: c => pillarLiquidity(c.L, c.row, c.cut),
    risk: c => pillarRisk(c.L, c.row, c.cut, c.ra),
    cycle12: pillarCycle12,
    mom12: c => pillarMom12(c.price),
    valueLT: pillarValueLT,
    growth: pillarGrowth,
    debt: pillarDebt,
    power: pillarPower,
    trendLT: pillarTrendLT,
    risk12: pillarRisk12,
  };
  const horizon = id => cfg.horizons.find(h => h.id === id) || cfg.horizons[0];
  const pillarDef = id => cfg.pillars.find(p => p.id === id);

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
  /* opts.all: alle Säulen des Horizonts rechnen, auch ohne Gewicht (Backtest); opts.weights: Gewichte je Anlageart */
  function evaluate(L, row, cut, ra, hz = "m1", opts = {}) {
    const H = horizon(hz);
    if (row.horizons && !row.horizons.includes(H.id)) return null;
    const price = rowPrice(L, row, cut);
    if (price.length < 30) return null;
    const w = (opts.weights && opts.weights[row.kind]) || H.weights[row.kind];
    const tEval = cut ?? last(price).t;
    L.pitYear = L.pit && cut != null ? pitYearOf(cut) : null;
    let longP = null;
    const c = { L, row, cut, price, ra, Y: yearOf(tEval), f: yearPart(tEval), get long() { return longP || (longP = longSeries(L, row, cut, price)); } };
    const P = {};
    let num = 0, den = 0;
    for (const pid of H.pillars) {
      const p = w[pid] || opts.all ? PILLAR_FN[pid](c) : null;
      P[pid] = p && p.s != null && isFinite(p.s) ? p : null;
      if (P[pid] && w[pid]) { num += w[pid] * P[pid].s; den += w[pid]; }
    }
    if (den < 0.3) return opts.all ? { score: null, cat: null, pillars: P, price, coverage: den, date: last(price).t, hz: H.id } : null;
    const score = num / den;
    return { score, cat: category(score), pillars: P, price, coverage: den, date: last(price).t, hz: H.id };
  }

  // Stichtag: jüngster Tageswert der Leitreihen
  function leadDay(L) {
    const lead = ["eq_us", "y10_us", "fx_chf", "gold_usd"].map(id => last((L.s[id] || { pts: [] }).pts)).filter(Boolean).map(p => p.t);
    return lead.length ? Math.max(...lead) : null;
  }

  /* Hauptfunktion: Barometer für alle Zeilen eines Horizonts (m1, y1, lt), jetzt und einen Monat zuvor */
  function barometer(L, hz = "m1") {
    const H = horizon(hz);
    const raNow = riskAppetite(L, null);
    const tNow = leadDay(L);
    const tPrev = tNow != null ? tNow - 30 : null;
    const raPrev = tPrev != null ? riskAppetite(L, tPrev) : null;
    const rows = [];
    for (const row of ROWS) {
      const now = evaluate(L, row, null, raNow, H.id);
      if (!now) { rows.push({ row, now: null, prev: null }); continue; }
      // Vormonat: 30 Tage vor dem jüngsten Kurs der Zeile (Monatsreihen und verzögert veröffentlichte Reihen)
      const cutRow = tPrev != null ? Math.min(tPrev, now.date - 30) : null;
      const prev = cutRow != null ? evaluate(L, row, cutRow, riskAppetite(L, cutRow), H.id) : null;
      if (prev && prev.cat) { now.raw = now.cat; now.cat = category(now.score, prev.cat); }
      const p = now.price;
      const perf = {
        m1: change(p, 30, "pct"), m3: change(p, 91, "pct"), y1: change(p, 365, "pct"),
        ytd: (() => { const a = last(p); const y = new Date(a.t * DAY).getUTCFullYear(); const b = valueAt(p, Date.UTC(y, 0, 1) / DAY - 1); return b && b.v ? a.v / b.v - 1 : null; })(),
      };
      rows.push({ row, now, prev, perf, spark: p.filter(q => q.t > last(p).t - 190).map(q => [q.x, q.v]) });
    }
    return { hz: H.id, horizon: H, pillars: H.pillars.map(pillarDef), weights: H.weights, rows, groups: GROUPS, risk: raNow, riskPrev: raPrev, tNow, tPrev };
  }

  /* Signalverlauf: Einstufung aller Zeilen zu früheren Monatsenden, mit dem Datenstand, der damals
     veröffentlicht gewesen wäre (Veröffentlichungsfristen wie beim Vormonat). Das Shiller-KGV geht mit dem damals
     bekannten Monatswert ein (ohne Monatsreihe bleibt es außen vor); IWF-Prognosen und Bevölkerungsprojektionen gibt
     es nur im jüngsten Stand. Stufen mit Toleranzband zur Vorperiode. */
  function backfill(L, months = 24, tNow = null, hz = "m1") {
    const t0 = tNow ?? leadDay(L);
    const d0 = new Date(t0 * DAY);
    const cuts = [];
    for (let m = months; m >= 1; m--) cuts.push(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - m + 1, 0) / DAY);
    const cape = L.cape;
    L.cape = null;
    const out = [];
    const prevCat = {};
    try {
      for (const cut of cuts) {
        const ra = riskAppetite(L, cut);
        for (const row of ROWS) {
          const e = evaluate(L, row, cut, ra, hz);
          if (!e) continue;
          const cat = category(e.score, prevCat[row.id]);
          prevCat[row.id] = cat;
          out.push({ d: isoOf(cut), id: row.id, h: hz, score: e.score, cat: cat.n, p: Object.fromEntries(Object.entries(e.pillars).map(([k, v]) => [k, v ? v.s : null])) });
        }
      }
    } finally { L.cape = cape; }
    return out;
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
        label: (s.l || pair).replace(/^Konfliktintensität:\s*/, ""), pct, z, zPrev, zAt, wow, now7: cur.v,
        share: c14 != null && k14 != null && c14 + k14 > 0 ? c14 / (c14 + k14) : null, events7,
        spark: m7.map(q => [yearFrac(q.t), q.v]), last: isoOf(a.t),
      };
      if (!out.last || isoOf(a.t) > out.last) out.last = isoOf(a.t);
      if (z != null) zs.push(z);
      if (zPrev != null) zsPrev.push(zPrev);
    }
    if (zs.length) out.global = { z: mean(zs), n: zs.length };
    if (zsPrev.length) out.globalPrev = { z: mean(zsPrev), n: zsPrev.length };
    // Abweichung über alle Konfliktlinien zu einem beliebigen Stichtag (für Vormonat und Rückrechnung)
    out.zAt = t => { const v = Object.values(out.pairs).map(p => p.zAt(t)).filter(z => z != null); return v.length ? mean(v) : null; };
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
    // Gold mit langer Monatshistorie vor den Tageswerten (für Gold in Franken und Euro und die Verhältnisse)
    if (S.gold_usd) {
      const d = S.gold_usd.pts, t0 = d.length ? d[0].t : Infinity;
      const m = S.gold_usd_m ? S.gold_usd_m.pts.filter(q => q.e < t0) : [];
      S.gold_usd_long = { id: "gold_usd_long", f: "D", l: "Goldpreis (Monatsmittel, danach Tageswerte)", src: S.gold_usd.src, pts: m.concat(d) };
    }
    // S&P 500 seit 1950 (Monatsmittel nach Shiller) als lange Historie für Bewertung und Langfristtrend
    if (hist.sp500_m && !S.eq_us_m) S.eq_us_m = { id: "eq_us_m", f: "M", src: "shiller", pts: decodeSeries(hist.sp500_m) };
    // Verhältnisse gegenüber dem S&P 500 (Regionen, Gold, Aktien gegenüber Anleihen): vor den Tageswerten (FRED: zehn Jahre)
    // die Monatsmittel, damit Trends über 20 Jahre live wie im Backtest rechnen
    if (S.eq_us) {
      const d = S.eq_us.pts, t0 = d.length ? d[0].t : Infinity;
      const m = S.eq_us_m ? S.eq_us_m.pts.filter(q => q.e < t0) : [];
      S.eq_us_long = { ...S.eq_us, id: "eq_us_long", l: "S&P 500 (Monatsmittel, danach Tageswerte)", pts: m.concat(d) };
    }
    if (!S.copper && S.copper_fred) S.copper = S.copper_fred;
    // Risikoprämien der Unternehmensanleihen: die ICE-BofA-Reihen gibt FRED nur für drei Jahre frei. Das Modell nutzt wie
    // der Backtest davor die Prämie Moody's Baa gegenüber Treasuries, skaliert mit dem mittleren Verhältnis im
    // Überlappungszeitraum; die Originalreihen bleiben für die Anzeige unverändert
    for (const id of ["hy_oas", "ig_oas", "hy_oas_eu"]) {
      const long = spliceScaled(S[id], S.baa10y);
      if (long) S[id + "_long"] = { ...long, id: id + "_long", l: `${S[id].l || id} (vor dem Beginn der Reihe: Baa-Prämie, skaliert)` };
    }
    if (hist.cape) L.cape = hist.cape;
    if (hist.cape_m) L.capeM = decodeSeries(hist.cape_m);
    // Index des geopolitischen Risikos (Caldara/Iacoviello) als Monatsreihe seit 1985
    if (hist.gpr_m && !S.gpr_m) S.gpr_m = { id: "gpr_m", f: "M", src: "gpr", pts: decodeSeries(hist.gpr_m) };
    L.tension = tensionFromGdelt(L);
    L._ra = new Map();
    L._pm = null;
    return L;
  }

  return {
    cfg, ROWS, GROUPS, decodeSeries, decodeSnapshot, asOf, last, valueAt, change, annVol, trendDeviation, zScore, yoy,
    combine, bondIndex, priceSeries, pillarTrend, growthScore, riskAppetite, evaluate, barometer, category, cyclePhase,
    tensionFromGdelt, prepareLive, basketSeries, isoOf, dayOf, yearFrac, mean, median, sd, clip2, backfill,
    horizon, pillarDef, leadDay, yv, ym, realMonthly, monthlyMeans, regionGrowth, regionDebt, regionPower, capeAt,
    rowPrice, pitYearOf, aiaeAt, yv,
  };
})();

if (typeof module !== "undefined") module.exports = { SIG };
