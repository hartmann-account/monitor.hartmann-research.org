/* Monatsmail des Anlagebarometers: Fälligkeit, Inhalt aus dem Barometer, ganzer Lauf mit der E-Mail-Bindung
   (Snapshot aus public/data/live.json, Bindung nachgebildet) */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { faellig, baueUebersicht, mailHtml, mailText, MAIL_JOBS, erstelleMail } from "../worker/mail-barometer.js";
import { empfaenger, mailSenden } from "../worker/lib/mail.js";
import { SNAP_KEY } from "../worker/keys.js";

test("Fälligkeit: am Ersten ab 7 Uhr Berliner Zeit der laufende Monat, frühestens November 2026", () => {
  assert.equal(faellig(Date.parse("2026-10-22T10:00:00Z")), null);
  assert.equal(faellig(Date.parse("2026-11-01T05:30:00Z")), null);
  assert.equal(faellig(Date.parse("2026-11-01T06:30:00Z")), "2026-11");
  assert.equal(faellig(Date.parse("2026-11-14T12:00:00Z")), "2026-11");
  assert.equal(faellig(Date.parse("2027-07-01T05:30:00Z")), "2027-07");
});

const groups = [{ id: "klassen", label: "Anlageklassen" }, { id: "gold", label: "Gold und Silber", note: "eigene Monatsübersicht" }];
const zeile = (id, label, group, n, prev, y1 = 0.1) => ({ row: { id, label, group, sub: "" }, now: { score: n / 2, cat: { n, sym: ["−−", "−", "=", "+", "++"][n + 2] } }, prev: prev == null ? null : { cat: { n: prev } }, perf: { y1 } });
const bar = rows => ({ tNow: Date.UTC(2026, 9, 30) / 864e5, groups, rows });

test("Inhalt: Kurzfassung, Stufenwechsel, Tabellen je Gruppe, HTML für E-Mail-Programme und Text", () => {
  const u = baueUebersicht({ monat: "2026-11", site: "https://beispiel.invalid",
    bs: {
      m1: bar([zeile("eq", "Aktien", "klassen", 1, 1, 0.151), zeile("bd", "Staatsanleihen", "klassen", -1, 0, -0.038), zeile("gold_usd", "Gold", "gold", -2, -1, -0.023)]),
      y1: bar([zeile("eq", "Aktien", "klassen", 0, 0), zeile("bd", "Staatsanleihen", "klassen", 0, 0), zeile("gold_usd", "Gold", "gold", 1, 1)]),
      lt: bar([zeile("eq", "Aktien", "klassen", -1, -1), { row: { id: "bd", label: "Staatsanleihen", group: "klassen" }, now: null, prev: null }, zeile("gold_usd", "Gold", "gold", 0, 0)]),
    },
    bt: { m1: { rel: 0.53, relBase: 0.5 } } });
  assert.equal(u.titel, "Anlagebarometer November 2026");
  assert.equal(u.stand, "2026-10-30");
  assert.match(u.kurz[0], /über üblich Aktien; unter üblich Staatsanleihen/);
  assert.match(u.kurz[1], /Stufenwechsel gegenüber dem Vormonat \(2\): Staatsanleihen 1 Monat wie üblich → unter üblich; Gold 1 Monat unter üblich → klar unter üblich/);
  assert.match(u.kurz[2], /Gold \(klar unter üblich\)/);
  assert.deepEqual(u.gruppen.map(g => [g.id, g.note, g.zeilen.length]), [["klassen", "", 2], ["gold", "", 1]]);
  const html = mailHtml(u), text = mailText(u);
  for (const t of ["Anlagebarometer November 2026", "Einstufung zum 30.10.2026", "Anlageklassen", "Gold und Silber", "+15,1 %", "53 % (Mehrheitsregel 50 %)", "▼", "/barometer-mail"]) assert.ok(html.includes(t), t);
  assert.ok(!/undefined|NaN|\[object/.test(html + text));
  assert.ok(!/<script|<link|@import/i.test(html));
  assert.match(text, /^BIG-CYCLE-MONITOR · Anlagebarometer November 2026/);
  assert.match(text, /• Staatsanleihen: 1 Monat unter üblich ▼, 12 Monate wie üblich, 5–10 Jahre –; 12 Mt\. −3,8 %/);
});

test("Lauf am 1. November: Mail aus dem Snapshot, je Empfänger eine Nachricht, nur einmal im Monat", async () => {
  const m = new Map([[SNAP_KEY, readFileSync("public/data/live.json", "utf8")]]);
  const kv = { get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => m.set(k, String(v)) };
  const post = [];
  const env = { DATA: kv, MAIL_EMPFANG: "ich@beispiel.invalid,du@beispiel.invalid", EMAIL: { send: async x => { post.push(x); return { messageId: "1" }; } } };
  const ctx = { env, now: Date.parse("2026-11-01T07:10:00Z"), state: { get: k => kv.get("state:" + k, "json"), put: (k, v) => kv.put("state:" + k, JSON.stringify(v)) },
    seed: async p => JSON.parse(readFileSync("public/" + p, "utf8")) };
  const job = MAIL_JOBS[0];
  const r = await job.run(null, ctx);
  assert.match(r.items[0].info, /E-Mail an 2 Empfänger am 2026-11-01/);
  assert.deepEqual(post.map(x => x.to), ["ich@beispiel.invalid", "du@beispiel.invalid"]);
  assert.deepEqual(post[0].from, { email: "noreply@monitor.hartmann.id", name: "Big-Cycle-Monitor" });
  assert.equal(post[0].subject, "Big-Cycle-Monitor · Anlagebarometer November 2026");
  for (const t of ["Anlageklassen", "Aktien", "Staatsanleihen", "Währungen gegenüber dem US-Dollar", "12 Monate", "5–10 J."]) assert.ok(post[0].html.includes(t), t);
  assert.ok(!/undefined|NaN/.test(post[0].html + post[0].text));
  // zweiter Lauf im selben Monat: kein erneuter Versand
  const r2 = await job.run(null, ctx);
  assert.equal(post.length, 2);
  assert.match(r2.items[0].info, /zuletzt 2026-11/);
  // Vorschau im Browser ohne Versand
  const v = await erstelleMail(env, { now: ctx.now, seed: ctx.seed, vorschau: true });
  assert.match(v.betreff, /\(Vorschau\)$/);
});

test("E-Mail-Hilfe: Empfängerliste, Fehlercode des Dienstes", async () => {
  assert.deepEqual(empfaenger({ MAIL_EMPFANG: "jonas@beispiel.invalid; zweite@beispiel.invalid" }), ["jonas@beispiel.invalid", "zweite@beispiel.invalid"]);
  const nein = { send: async () => { const e = new Error("x"); e.code = "E_SENDER_NOT_VERIFIED"; throw e; } };
  await assert.rejects(mailSenden({ EMAIL: nein, MAIL_EMPFANG: "a@b.de" }, { name: "X", betreff: "B", html: "h", text: "t" }), /E_SENDER_NOT_VERIFIED/);
});
