/* Monatsmail des Anlagebarometers: am Ersten jedes Monats ab 7 Uhr (Europe/Berlin) die Einstufung aller Anlagen in den
   drei Horizonten (1 Monat, 12 Monate, 5–10 Jahre) mit Stufenwechsel gegenüber dem Vormonat und dem Ertrag über
   12 Monate. Rechnung mit demselben Modell wie die Seite (src/signals.js) aus dem Snapshot im KV; Versand über
   Cloudflare Email Service (lib/mail.js) an die Adressen der Variablen MAIL_EMPFANG. Vorschau unter /barometer-mail.

   HTML für E-Mail-Programme: Tabellen statt Flexbox, alle Stile inline, keine Bilder, keine Skripte, keine externen
   Schriften, höchstens 640 Pixel breit; Stufen immer mit Zeichen und Wort, nie nur als Farbe. */
import sigmod from "../src/signals.js";
import { liveFromSnapshot } from "./jobs-signals.js";
import { SNAP_KEY } from "./keys.js";
import { mailBereit, mailSenden } from "./lib/mail.js";

const { SIG } = sigmod;
export const ERSTER_MONAT = "2026-11";
export const VERSAND_STUNDE = 7;
const SITE = "https://monitor.hartmann-it.workers.dev";
export const site = env => String((env && env.SITE_URL) || SITE).replace(/\/+$/, "");
const HZ = ["m1", "y1", "lt"];
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const monatName = m => `${MONATE[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

/* Datum und Stunde in Berlin */
export function berlin(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { tag: `${p.year}-${p.month}-${p.day}`, monat: `${p.year}-${p.month}`, stunde: +p.hour };
}
/* fälliger Monat: am Ersten ab 7 Uhr (und an den Tagen danach, bis versandt) der laufende Monat, frühestens ERSTER_MONAT */
export function faellig(now, erster = ERSTER_MONAT) {
  const b = berlin(now);
  if (b.tag.endsWith("-01") && b.stunde < VERSAND_STUNDE) return null;
  return b.monat >= erster ? b.monat : null;
}

const fZahl = (x, s = 1) => (x == null || !Number.isFinite(x) ? "–" : x.toLocaleString("de-DE", { minimumFractionDigits: s, maximumFractionDigits: s }));
const fProz = x => (x == null || !Number.isFinite(x) ? "–" : `${x > 0.0005 ? "+" : x < -0.0005 ? "−" : "±"}${fZahl(Math.abs(100 * x), 1)} %`);
const fDatum = iso => `${+iso.slice(8, 10)}.${+iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const KURZ = { "-2": "klar unter", "-1": "unter", 0: "üblich", 1: "über", 2: "klar über" };
const LANG = { "-2": "klar unter üblich", "-1": "unter üblich", 0: "wie üblich", 1: "über üblich", 2: "klar über üblich" };
const HZ_NAME = { m1: "1 Monat", y1: "12 Monate", lt: "5–10 Jahre" };

/* Barometer der drei Horizonte → Inhalt der Mail. bs: { m1, y1, lt } (SIG.barometer), bt: { m1: stats.all, … } */
export function baueUebersicht({ monat, bs, bt = {}, site: url = SITE, vorschau = false }) {
  const b0 = bs.m1;
  const stand = b0 && b0.tNow != null ? SIG.isoOf(b0.tNow) : null;
  const zeilen = new Map();
  for (const h of HZ) {
    const B = bs[h];
    if (!B) continue;
    for (const r of B.rows) {
      const z = zeilen.get(r.row.id) || zeilen.set(r.row.id, { id: r.row.id, label: r.row.label, sub: r.row.sub || "", group: r.row.group, h: {}, y1: null }).get(r.row.id);
      if (!r.now) continue;
      z.h[h] = { n: r.now.cat.n, sym: r.now.cat.sym, score: r.now.score, prev: r.prev && r.prev.cat ? r.prev.cat.n : null };
      if (h === "m1" && r.perf) z.y1 = r.perf.y1 ?? null;
    }
  }
  const gruppen = (b0 ? b0.groups : []).map(g => ({ id: g.id, label: g.label, note: g.note === "eigene Monatsübersicht" ? "" : g.note || "",
    zeilen: [...zeilen.values()].filter(z => z.group === g.id && Object.keys(z.h).length) })).filter(g => g.zeilen.length);

  // Kurzfassung: Anlageklassen im Ausblick 1 Monat, Stufenwechsel, Extreme
  const kurz = [];
  const klassen = gruppen.find(g => g.id === "klassen");
  if (klassen) {
    const auf = s => klassen.zeilen.filter(z => z.h.m1 && s(z.h.m1.n)).map(z => z.label);
    const ueber = auf(n => n > 0), unter = auf(n => n < 0), ueblich = auf(n => n === 0);
    kurz.push(`Ausblick 1 Monat für die Anlageklassen: ${[ueber.length && `über üblich ${ueber.join(", ")}`, ueblich.length && `wie üblich ${ueblich.join(", ")}`,
      unter.length && `unter üblich ${unter.join(", ")}`].filter(Boolean).join("; ")}.`);
  }
  const wechsel = [];
  for (const g of gruppen) for (const z of g.zeilen) for (const h of HZ) {
    const x = z.h[h];
    if (x && x.prev != null && x.prev !== x.n) wechsel.push({ label: z.label, h, von: x.prev, nach: x.n });
  }
  kurz.push(wechsel.length
    ? `Stufenwechsel gegenüber dem Vormonat (${wechsel.length}): ${wechsel.slice(0, 8).map(w => `${w.label} ${HZ_NAME[w.h]} ${LANG[w.von]} → ${LANG[w.nach]}`).join("; ")}${wechsel.length > 8 ? " …" : ""}.`
    : "Keine Stufe hat sich gegenüber dem Vormonat geändert.");
  const klar = [...zeilen.values()].filter(z => z.h.m1 && Math.abs(z.h.m1.n) === 2);
  if (klar.length) kurz.push(`Ausblick 1 Monat klar über oder unter üblich: ${klar.map(z => `${z.label} (${LANG[z.h.m1.n]})`).join(", ")}.`);
  const treffer = HZ.filter(h => bt[h] && bt[h].rel != null).map(h => `${HZ_NAME[h]} ${fZahl(100 * bt[h].rel, 0)} % (Mehrheitsregel ${fZahl(100 * bt[h].relBase, 0)} %)`);

  return { monat, titel: `Anlagebarometer ${monatName(monat)}`, stand, vorschau, site: url, kurz, gruppen, wechsel: wechsel.length, treffer };
}

export const betreffVon = u => `Big-Cycle-Monitor · ${u.titel}${u.vorschau ? " (Vorschau)" : ""}`;

/* ---------- E-Mail als HTML ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safe = u => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const F = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const C = { ink: "#111a15", ink2: "#46514b", ink3: "#78837d", line: "#dfe4e0", bg: "#eff2ee", card: "#ffffff", accent: "#184f95", up: "#1c5cab", down: "#a32f2f" };
// Stufenfarben der Seite (src/style.css, helles Thema): von klar unter (hell) bis klar über (dunkel)
const FARBE = { "-2": ["#86b6ef", "#111a15"], "-1": ["#5598e7", "#111a15"], 0: ["#256abf", "#ffffff"], 1: ["#184f95", "#ffffff"], 2: ["#0d366b", "#ffffff"] };
function chip(x) {
  if (!x) return `<span style="color:${C.ink3}">–</span>`;
  const [bg, fg] = FARBE[x.n];
  const pfeil = x.prev != null && x.prev !== x.n ? `<span style="color:${x.n > x.prev ? C.up : C.down};font-size:11px;padding-left:3px" title="Vormonat: ${esc(LANG[x.prev])}">${x.n > x.prev ? "▲" : "▼"}</span>` : "";
  return `<span style="display:inline-block;min-width:58px;padding:3px 6px;border-radius:3px;background:${bg};color:${fg};font-size:12px;font-weight:600;text-align:center;white-space:nowrap">${esc(x.sym)} ${esc(KURZ[x.n])}</span>${pfeil}`;
}
const h2 = t => `<tr><td style="${F}padding:22px 24px 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700">${esc(t)}</td></tr>`;
const absatz = (t, extra = "") => `<tr><td style="${F}padding:4px 24px;font-size:14px;line-height:1.5;color:${C.ink}${extra}">${t}</td></tr>`;

export function mailHtml(u) {
  const th = (t, a = "left") => `<th align="${a}" style="${F}font-size:11px;font-weight:600;color:${C.ink3};text-transform:uppercase;letter-spacing:.04em;padding:6px 6px;border-bottom:1px solid ${C.line};white-space:nowrap">${esc(t)}</th>`;
  const td = (t, a = "left", extra = "") => `<td align="${a}" style="${F}font-size:13px;color:${C.ink};padding:6px 6px;border-bottom:1px solid ${C.line};vertical-align:middle${extra}">${t}</td>`;
  const tabellen = u.gruppen.map(g => {
    const kopf = `<tr>${th("Anlage")}${th("1 Monat", "center")}${th("12 Monate", "center")}${th("5–10 J.", "center")}${th("12 Mt.", "right")}</tr>`;
    const rows = g.zeilen.map(z => `<tr>${td(`<b>${esc(z.label)}</b>${z.sub ? `<br><span style="font-size:11px;color:${C.ink3}">${esc(z.sub.length > 60 ? z.sub.slice(0, 57) + "…" : z.sub)}</span>` : ""}`)}${HZ.map(h => td(chip(z.h[h]), "center", ";white-space:nowrap")).join("")}${td(`<span style="color:${z.y1 > 0.0005 ? C.up : z.y1 < -0.0005 ? C.down : C.ink2}">${fProz(z.y1)}</span>`, "right", ";white-space:nowrap")}</tr>`).join("");
    return h2(g.label) + (g.note ? absatz(`<span style="font-size:12px;color:${C.ink3}">${esc(g.note)}</span>`) : "")
      + `<tr><td style="padding:2px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${kopf}${rows}</table></td></tr>`;
  }).join("");
  const kopf = `<tr><td style="${F}background:#0c110f;padding:22px 24px 18px;color:#e9eee9"><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9ec5f4;font-weight:700">Big-Cycle-Monitor</div>
    <div style="font-size:22px;font-weight:700;margin-top:6px;color:#ffffff">${esc(u.titel)}${u.vorschau ? " (Vorschau)" : ""}</div><div style="font-size:13px;color:#aab6ae;margin-top:4px">${u.stand ? `Einstufung zum ${fDatum(u.stand)} · ` : ""}gegenüber dem üblichen Ertrag der Anlage</div></td></tr>`;
  const legende = `Stufen: ${[2, 1, 0, -1, -2].map(n => `${chip({ n, sym: SIG.cfg.cats.find(c => c.n === n).sym, prev: null })} ${esc(LANG[n])}`).join(" &nbsp;")}. ▲▼ Stufe gegenüber dem Vormonat gestiegen bzw. gesunken. 12 Mt.: Kursveränderung der letzten zwölf Monate.`;
  const fuss = `Signale nach festen, offengelegten Regeln, seit 1970 rückgerechnet und an der tatsächlichen Kursentwicklung geprüft${u.treffer.length ? ` (Stufe richtig gegenüber dem üblichen Ertrag: ${esc(u.treffer.join(", "))})` : ""}; keine Anlageempfehlung.<br>
    <a href="${safe(u.site)}/#barometer" style="color:${C.accent}">Barometer öffnen</a> · <a href="${safe(u.site)}/barometer-mail" style="color:${C.accent}">Diese Mail im Browser</a>`;
  const rows = [
    kopf,
    h2("Auf einen Blick"),
    `<tr><td style="padding:0 24px"><ul style="${F}margin:4px 0 0;padding-left:18px;font-size:14px;line-height:1.55;color:${C.ink}">${u.kurz.map(s => `<li style="margin:0 0 6px">${esc(s)}</li>`).join("")}</ul></td></tr>`,
    tabellen,
    absatz(`<span style="font-size:12px;color:${C.ink3};line-height:1.9">${legende}</span>`, ";padding-top:14px"),
    `<tr><td style="${F}padding:18px 24px 22px;font-size:12px;line-height:1.6;color:${C.ink3};border-top:1px solid ${C.line}">${fuss}</td></tr>`,
  ];
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(betreffVon(u))}</title></head>
<body style="margin:0;padding:0;background:${C.bg}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.card};border:1px solid ${C.line};border-radius:6px;border-collapse:separate">${rows.join("\n")}</table>
</td></tr></table></body></html>`;
}

/* ---------- E-Mail als Text ---------- */
export function mailText(u) {
  const z = [`BIG-CYCLE-MONITOR · ${u.titel}${u.vorschau ? " (Vorschau)" : ""}`, `${u.stand ? `Einstufung zum ${fDatum(u.stand)}, ` : ""}gegenüber dem üblichen Ertrag der Anlage`];
  const linie = t => z.push("", t.toUpperCase(), "-".repeat(t.length));
  linie("Auf einen Blick");
  for (const s of u.kurz) z.push(`• ${s}`);
  for (const g of u.gruppen) {
    linie(g.label);
    for (const r of g.zeilen) {
      const st = HZ.map(h => { const x = r.h[h]; return `${HZ_NAME[h]} ${x ? `${LANG[x.n]}${x.prev != null && x.prev !== x.n ? (x.n > x.prev ? " ▲" : " ▼") : ""}` : "–"}`; }).join(", ");
      z.push(`• ${r.label}: ${st}; 12 Mt. ${fProz(r.y1)}`);
    }
  }
  z.push("", "▲▼ Stufe gegenüber dem Vormonat gestiegen bzw. gesunken. Keine Anlageempfehlung.", `Barometer: ${u.site}/#barometer`, `Im Browser: ${u.site}/barometer-mail`);
  return z.join("\n");
}

/* aus dem Snapshot im KV: Barometer der drei Horizonte, Treffer im Backtest, Mail */
export async function erstelleMail(env, { now = Date.now(), seed, vorschau = false, monat = null } = {}) {
  const txt = await env.DATA.get(SNAP_KEY);
  if (!txt) throw new Error("Noch kein Snapshot im KV");
  const snap = JSON.parse(txt);
  const L = liveFromSnapshot(snap, seed ? await seed("data/bigcycle.json") : null);
  const bs = Object.fromEntries(HZ.map(h => [h, SIG.barometer(L, h)]));
  const bt = Object.fromEntries(HZ.map(h => { const it = snap.data && snap.data["backtest_" + h]; const a = it && it.items && it.items[0] && it.items[0].stats && it.items[0].stats.all; return [h, a || null]; }));
  const u = baueUebersicht({ monat: monat || berlin(now).monat, bs, bt, site: site(env), vorschau });
  return { u, betreff: betreffVon(u), html: mailHtml(u), text: mailText(u) };
}

export async function versendeMail(env, m) {
  return mailSenden(env, { name: "Big-Cycle-Monitor", betreff: m.betreff, html: m.html, text: m.text });
}

export const MAIL_JOBS = [{
  id: "barometer_mail", label: "Monatsmail des Anlagebarometers: am Ersten um 7 Uhr an MAIL_EMPFANG (Cloudflare Email Service)", source: "mail",
  every: 1, cost: 0, requires: ["EMAIL"], noArchive: true, noRaw: true,
  async run(F, ctx) {
    const { env, now } = ctx;
    const m = faellig(now);
    const st = (await ctx.state.get("barometer_mail")) || { monate: {} };
    const zuletzt = Object.keys(st.monate).sort().pop();
    if (!m || (st.monate[m] && st.monate[m].versand) || !mailBereit(env)) {
      const info = !mailBereit(env) ? "kein Empfänger (Variable MAIL_EMPFANG)" : zuletzt ? `zuletzt ${zuletzt}: ${st.monate[zuletzt].versand}` : `erste Mail am 1. ${monatName(ERSTER_MONAT)} um ${VERSAND_STUNDE} Uhr`;
      return { series: {}, items: [{ monat: m, info }] };
    }
    const mail = await erstelleMail(env, { now, seed: p => ctx.seed(p), monat: m });
    const r = await versendeMail(env, mail);
    st.monate[m] = { versand: `E-Mail an ${r.an} Empfänger am ${berlin(now).tag}`, stand: mail.u.stand, fehler: r.fehler };
    await ctx.state.put("barometer_mail", st);
    return { series: {}, items: [{ monat: m, info: st.monate[m].versand + (r.fehler.length ? ` · Fehler: ${r.fehler.join(", ")}` : "") }] };
  },
}];
