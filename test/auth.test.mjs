/* Passwortschutz der Seite: Sitzung, Anmeldung, Sperre und Durchlass */
import test from "node:test";
import assert from "node:assert/strict";
import { gate, authorized, sessionToken, validSession, privateHeaders } from "../worker/auth.js";

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const env = (extra = {}) => ({ SITE_PASSWORD: "geheim-123", ADMIN_TOKEN: "admin-xyz", DATA: kv(), ...extra });
const req = (path, init = {}) => new Request("https://monitor.example" + path, init);

test("ohne SITE_PASSWORD bleibt alles offen", async () => {
  assert.equal(await gate(req("/api/snapshot"), {}), null);
  assert.equal(await gate(req("/"), {}), null);
  assert.equal(await authorized(req("/"), {}), true);
  const r = await gate(req("/robots.txt"), {});
  assert.match(await r.text(), /Disallow: \//);
});

test("Sitzung: gültig, abgelaufen, falsch signiert, neues Passwort", async () => {
  const t = await sessionToken("geheim-123", Date.UTC(2026, 9, 19));
  assert.equal(await validSession("geheim-123", t, Date.UTC(2026, 9, 20)), true);
  assert.equal(await validSession("geheim-123", t, Date.UTC(2026, 11, 31)), false);
  assert.equal(await validSession("anderes", t, Date.UTC(2026, 9, 20)), false);
  assert.equal(await validSession("geheim-123", t.replace(/.$/, c => (c === "A" ? "B" : "A")), Date.UTC(2026, 9, 20)), false);
  assert.equal(await validSession("geheim-123", "unsinn"), false);
});

test("gesperrt: Seite leitet zur Anmeldung, Daten antworten 401", async () => {
  const e = env();
  const page = await gate(req("/?h=y1", { headers: { accept: "text/html" } }), e);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login?ziel=%2F%3Fh%3Dy1");
  const api = await gate(req("/api/snapshot"), e);
  assert.equal(api.status, 401);
  assert.equal((await gate(req("/app.js"), e)).status, 401);
  assert.equal(await gate(req("/favicon.svg"), e), null);
});

test("Anmeldung: richtiges Passwort setzt das Cookie, falsches nicht, Ziel nur auf dieser Seite", async () => {
  const e = env();
  const form = (pw, ziel) => req("/login", { method: "POST", body: new URLSearchParams({ passwort: pw, ziel }) });
  const ok = await gate(form("geheim-123", "/?h=lt#gold"), e);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/?h=lt#gold");
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /^bcm_sitzung=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  const ext = await gate(form("geheim-123", "//boese.example/"), e);
  assert.equal(ext.headers.get("location"), "/");
  const bad = await gate(form("falsch", "/"), e);
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Passwort falsch/);
  assert.equal(e.DATA.m.get("auth:fehl:unbekannt"), "1");
  // mit dem Cookie durchgelassen
  const c = cookie.split(";")[0];
  assert.equal(await gate(req("/api/snapshot", { headers: { cookie: "x=1; " + c } }), e), null);
});

test("Maschinen: Bearer mit Passwort oder ADMIN_TOKEN; nach zehn Fehlversuchen Pause", async () => {
  const e = env();
  assert.equal(await gate(req("/api/snapshot", { headers: { authorization: "Bearer geheim-123" } }), e), null);
  assert.equal(await gate(req("/api/run", { method: "POST", headers: { authorization: "Bearer admin-xyz" } }), e), null);
  assert.equal((await gate(req("/api/snapshot", { headers: { authorization: "Bearer falsch" } }), e)).status, 401);
  e.DATA.m.set("auth:fehl:1.2.3.4", "10");
  const r = await gate(req("/login", { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" }, body: new URLSearchParams({ passwort: "geheim-123", ziel: "/" }) }), e);
  assert.equal(r.status, 429);
});

test("Abmelden löscht das Cookie; Antworten werden privat", async () => {
  const r = await gate(req("/logout"), env());
  assert.equal(r.status, 303);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  const res = privateHeaders(new Response("x", { headers: { "cache-control": "public, max-age=600" } }), env());
  assert.equal(res.headers.get("cache-control"), "private, max-age=600");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const open = privateHeaders(new Response("x", { headers: { "cache-control": "public, max-age=600" } }), {});
  assert.equal(open.headers.get("cache-control"), "public, max-age=600");
});
