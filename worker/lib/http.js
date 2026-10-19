/* HTTP-Hilfen für die Abrufjobs. Läuft im Worker und in Node (scripts/fetch_live.mjs). */

// FRED weist Anfragen ohne oder mit generischem User-Agent ab (Verbindungsabbruch); ein beschreibender Agent wird angenommen.
export const UA = "Mozilla/5.0 (compatible; BigCycleMonitor/2.0; +https://monitor.hartmann-research.org)";

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} für ${shortUrl(url)}${body ? ": " + body.slice(0, 120).replace(/\s+/g, " ") : ""}`);
    this.status = status;
  }
}

export function shortUrl(url) {
  try { const u = new URL(url); return u.host + u.pathname.slice(0, 60); } catch { return String(url).slice(0, 80); }
}

/* Ein Fetch-Kontext zählt die Subrequests eines Laufs und bricht ab, bevor das Budget überschritten wird. */
export function makeFetcher(budget, fetchImpl = fetch) {
  const ctx = {
    used: 0,
    budget,
    async request(url, { headers = {}, timeout = 25000, method = "GET", body } = {}) {
      if (ctx.used >= ctx.budget) throw new Error(`Subrequest-Budget (${ctx.budget}) erschöpft`);
      ctx.used++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetchImpl(url, { method, body, headers: { "user-agent": UA, ...headers }, signal: ctrl.signal, redirect: "follow" });
        if (!r.ok) {
          let txt = "";
          try { txt = await r.text(); } catch { /* ignorieren */ }
          throw new HttpError(r.status, url, txt);
        }
        return r;
      } catch (e) {
        if (e.name === "AbortError") throw new Error(`Zeitüberschreitung nach ${timeout / 1000} s: ${shortUrl(url)}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    async text(url, opts) { return (await ctx.request(url, opts)).text(); },
    async json(url, opts) {
      const t = await ctx.text(url, opts);
      try { return JSON.parse(t); } catch { throw new Error(`Keine gültige JSON-Antwort von ${shortUrl(url)}: ${t.slice(0, 80)}`); }
    },
  };
  return ctx;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
