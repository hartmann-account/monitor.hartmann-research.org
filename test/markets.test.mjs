/* Abruf der Bank of England: Fehlerseite und HTTP-Fehler beim ersten Aufruf werden wiederholt */
import test from "node:test";
import assert from "node:assert/strict";
import { makeFetcher } from "../worker/lib/http.js";
import { boe } from "../worker/providers/markets.js";

const CSV = "DATE,IUDMNPY,IUDBEDR\n15 Oct 2026,5.3092,3.75\n16 Oct 2026,5.2987,3.75\n";
const fake = answers => {
  const calls = [];
  return { calls, fetch: async url => { calls.push(url); const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)]; return new Response(body, { status }); } };
};

test("BoE: HTTP 500 und Fehlerseite, dann Daten", async () => {
  const f = fake([[500, "<!DOCTYPE html><html>Access denied.</html>"], [200, "<html><title>Error</title></html>"], [200, CSV]]);
  const r = await boe(makeFetcher(10, f.fetch), ["IUDMNPY", "IUDBEDR"], "2026-10-01", 1);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(r.IUDMNPY, [["2026-10-15", 5.3092], ["2026-10-16", 5.2987]]);
  assert.equal(r.IUDBEDR.length, 2);
});

test("BoE: nach drei Fehlschlägen der letzte HTTP-Fehler", async () => {
  const f = fake([[500, "<html>Access denied.</html>"]]);
  await assert.rejects(boe(makeFetcher(10, f.fetch), ["IUDMNPY"], "2026-10-01", 1), /HTTP 500/);
  assert.equal(f.calls.length, 3);
});
