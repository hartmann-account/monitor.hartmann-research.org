/* Passwortschutz für die ganze Seite (Seiten, Dateien und API). Aktiv, sobald das Secret SITE_PASSWORD gesetzt ist;
   ohne es bleibt die Seite offen wie bisher.
   - Anmeldung unter /login, danach ein Sitzungscookie für 30 Tage (signiert mit dem Passwort: ein neues Passwort meldet
     alle Geräte ab), Abmeldung unter /logout
   - Maschinen (GitHub-Workflow, Skripte) melden sich mit "Authorization: Bearer <SITE_PASSWORD>" an; POST /api/run
     weiterhin mit ADMIN_TOKEN
   - Bremse für Passwortversuche über Formular und Bearer: höchstens 20 je Minute und Adresse (Rate-Limiting-Bindung
     AUTH_LIMIT, zählt auch parallele Anfragen), nach zehn Fehlversuchen 15 Minuten Pause (Zähler in KV) */
const COOKIE = "bcm_sitzung";
const DAYS = 30;
const MAX_FAILS = 10, LOCK_S = 900;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
// Vergleich ohne frühen Abbruch (gleiche Laufzeit für richtige und falsche Werte gleicher Länge)
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Passwortvergleich über HMAC beider Werte (gleich lange Zeichenketten, keine Rückschlüsse aus der Laufzeit)
const samePassword = async (secret, given) => same(await hmac(secret, "pw:" + given), await hmac(secret, "pw:" + secret));

export async function sessionToken(secret, now = Date.now()) {
  const exp = Math.floor(now / 1000) + DAYS * 86400;
  return `${exp}.${await hmac(secret, "sitzung:" + exp)}`;
}
export async function validSession(secret, token, now = Date.now()) {
  const m = /^(\d{9,12})\.([\w-]{20,})$/.exec(token || "");
  if (!m || +m[1] * 1000 < now) return false;
  return same(m[2], await hmac(secret, "sitzung:" + m[1]));
}
const cookieOf = (req, name) => {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
};

// Bearer-Token: das Seitenpasswort (Skripte, GitHub-Workflow) oder ADMIN_TOKEN
const bearerOk = async (env, t) => (await samePassword(env.SITE_PASSWORD, t)) || (!!env.ADMIN_TOKEN && same(t, env.ADMIN_TOKEN));

/* Ist die Anfrage angemeldet? (ohne SITE_PASSWORD immer; zählt keine Versuche, das übernimmt gate) */
export async function authorized(req, env) {
  const secret = env.SITE_PASSWORD;
  if (!secret) return true;
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && (await bearerOk(env, auth.slice(7)))) return true;
  return validSession(secret, cookieOf(req, COOKIE));
}

const ipOf = req => req.headers.get("cf-connecting-ip") || "unbekannt";
const failKey = ip => `auth:fehl:${ip}`;
/* Darf diese Adresse gerade ein Passwort probieren? Jeder Versuch zählt bei der Bindung AUTH_LIMIT (atomar je
   Cloudflare-Standort, auch bei parallelen Anfragen); nach zehn Fehlversuchen sperrt der KV-Zähler 15 Minuten */
async function blocked(env, ip) {
  if (env.AUTH_LIMIT && !(await env.AUTH_LIMIT.limit({ key: ip })).success) return true;
  return env.DATA ? +((await env.DATA.get(failKey(ip))) || 0) >= MAX_FAILS : false;
}
async function failed(env, ip) {
  if (env.DATA) await env.DATA.put(failKey(ip), String(+((await env.DATA.get(failKey(ip))) || 0) + 1), { expirationTtl: LOCK_S });
  await new Promise(r => setTimeout(r, 800));
}
const jsonErr = (msg, status, extra = {}) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// nur Pfade dieser Seite als Ziel nach der Anmeldung
const safeTarget = t => (typeof t === "string" && /^\/(?!\/)[\w\-./?=&%#:,+]*$/.test(t) && !t.startsWith("/login") ? t : "/");

function loginPage(target, msg = "", status = 200) {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Big-Cycle-Monitor · Anmeldung</title><link rel="icon" href="/favicon.svg">
<style>
:root{--paper:#f4f2ec;--sheet:#fbfaf6;--ink:#1d1d1b;--ink-2:#55534d;--rule:#d9d5cb;--accent:#1f4e3d;--bad:#a1321f}
@media (prefers-color-scheme:dark){:root{--paper:#161614;--sheet:#1f1f1c;--ink:#ecebe6;--ink-2:#b3b0a6;--rule:#3a3934;--accent:#7fc4a6;--bad:#f08a73}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--sheet);border:1px solid var(--rule);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:0 0 16px;color:var(--ink-2);font-size:.9rem}
label{display:block;font-size:.85rem;margin-bottom:6px;color:var(--ink-2)}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--rule);border-radius:8px;background:var(--paper);color:var(--ink)}
button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:var(--accent);color:var(--sheet);cursor:pointer}
.err{color:var(--bad);font-size:.9rem;margin:10px 0 0}
</style></head><body><form method="post" action="/login">
<h1>Big-Cycle-Monitor</h1><p>Private Seite. Bitte mit dem Passwort anmelden.</p>
<label for="pw">Passwort</label><input id="pw" name="passwort" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="ziel" value="${esc(target)}"><button type="submit">Anmelden</button>
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ""}</form></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

/* Anmeldung, Abmeldung und Sperre; gibt eine Antwort zurück oder null, wenn die Anfrage durchgelassen wird */
export async function gate(req, env) {
  const url = new URL(req.url);
  const secret = env.SITE_PASSWORD;
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!secret) return null;
  if (url.pathname === "/logout") {
    return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, "cache-control": "no-store" } });
  }
  if (url.pathname === "/login") {
    if (req.method !== "POST") return loginPage(safeTarget(url.searchParams.get("ziel")));
    const ip = ipOf(req);
    const form = await req.formData().catch(() => null);
    const target = safeTarget(form && form.get("ziel"));
    if (await blocked(env, ip)) return loginPage(target, "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", 429);
    const given = form ? String(form.get("passwort") || "") : "";
    if (given && (await samePassword(secret, given))) {
      return new Response(null, { status: 303, headers: { location: target,
        "set-cookie": `${COOKIE}=${await sessionToken(secret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`, "cache-control": "no-store" } });
    }
    await failed(env, ip);
    return loginPage(target, "Passwort falsch.", 401);
  }
  if (url.pathname === "/favicon.svg") return null;
  // angemeldeter Browser: gültiges Sitzungscookie (zählt nicht als Versuch)
  if (await validSession(secret, cookieOf(req, COOKIE))) return null;
  // Skripte: Bearer-Token mit derselben Bremse wie das Formular
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const ip = ipOf(req);
    if (await blocked(env, ip)) return jsonErr("Zu viele Versuche, bitte in 15 Minuten erneut versuchen", 429, { "retry-after": String(LOCK_S) });
    if (await bearerOk(env, auth.slice(7))) return null;
    await failed(env, ip);
    return jsonErr("Anmeldung erforderlich", 401);
  }
  // Seitenaufruf: zur Anmeldung; Daten und Dateien: 401
  const wantsHtml = req.method === "GET" && (req.headers.get("accept") || "").includes("text/html");
  if (wantsHtml) return new Response(null, { status: 302, headers: { location: `/login?ziel=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
  return jsonErr("Anmeldung erforderlich", 401);
}

/* Sicherheits-Header für HTML-Seiten (auch die Anmeldung): nur eigene Skripte, Daten, Bilder und Schriften, keine
   Einbettung in fremde Seiten (Schutz vor Clickjacking). Inline-Stile bleiben erlaubt, die Seite setzt style-Attribute. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function securityHeaders(res) {
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const r = new Response(res.body, res);
  r.headers.set("content-security-policy", CSP);
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return r;
}

/* Antworten hinter der Sperre nicht in fremden Zwischenspeichern ablegen und nicht indexieren */
export function privateHeaders(res, env) {
  if (!env.SITE_PASSWORD) return res;
  const r = new Response(res.body, res);
  const cc = r.headers.get("cache-control");
  if (cc && cc.includes("public")) r.headers.set("cache-control", cc.replace("public", "private"));
  r.headers.set("x-robots-tag", "noindex, nofollow");
  return r;
}
