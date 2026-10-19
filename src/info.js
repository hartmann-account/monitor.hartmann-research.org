"use strict";
/* Erklär-Popups: ein kleines ⓘ an jeder berechneten Größe öffnet ein Mini-Fenster mit Bedeutung, Rechenweg und,
   wo möglich, der aktuellen Rechnung mit Zahlen. Am Desktop sitzt das Fenster am Symbol, auf dem Telefon kommt es
   als Blatt vom unteren Rand.
   spec: { t: Titel, d: was die Größe zeigt, f: Rechenweg (Text oder Liste), r: aktuelle Rechnung (Text oder Liste),
           s: Quelle oder Hinweis } – oder eine Funktion, die ein solches Objekt liefert (ausgewertet beim Öffnen). */
let INFO_POP = null, INFO_BTN = null;

function info(spec, label) {
  const title = label || (spec && typeof spec === "object" ? spec.t : null) || "Berechnung";
  const b = h("button", { type: "button", class: "info-btn", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": `Erklärung: ${title}`, title: "Wie wird das berechnet?" });
  b.append(sv("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }));
  b.firstChild.append(sv("circle", { cx: 8, cy: 8, r: 6.6 }), sv("path", { d: "M8 7.2v4.3" }), sv("circle", { cx: 8, cy: 4.9, r: 0.6, class: "dot" }));
  b.addEventListener("click", e => {
    // in aufklappbaren Zeilen (Barometer) darf das Symbol die Zeile nicht mitschalten
    e.stopPropagation();
    e.preventDefault();
    if (INFO_BTN === b) infoClose(false); else infoOpen(b, spec);
  });
  b.addEventListener("keydown", e => e.stopPropagation());
  return b;
}

function infoPop() {
  if (INFO_POP) return INFO_POP;
  const title = h("b", { id: "info-pop-t" });
  const body = h("div", { class: "ip-body" });
  const close = h("button", { type: "button", class: "ip-x", "aria-label": "Erklärung schließen" }, "×");
  const el = h("div", { class: "info-pop", id: "info-pop", role: "dialog", "aria-labelledby": "info-pop-t", tabindex: "-1", hidden: true },
    h("div", { class: "ip-head" }, title, close), body);
  const back = h("div", { class: "info-back", hidden: true });
  close.addEventListener("click", () => infoClose(true));
  back.addEventListener("click", () => infoClose(false));
  document.addEventListener("click", e => { if (INFO_BTN && !el.contains(e.target) && !INFO_BTN.contains(e.target)) infoClose(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && INFO_BTN) infoClose(true); });
  window.addEventListener("resize", () => { if (INFO_BTN) infoPlace(); });
  document.body.append(back, el);
  INFO_POP = { el, title, body, back };
  return INFO_POP;
}

function infoOpen(btn, spec) {
  infoClose(false);
  let o = null;
  try { o = typeof spec === "function" ? spec() : spec; } catch (e) { console.error("Erklärung", e); }
  if (!o) return;
  const P = infoPop();
  const list = v => (Array.isArray(v) ? v : [v]).filter(x => x != null && x !== "");
  P.title.textContent = o.t || "Erklärung";
  P.body.replaceChildren(...[
    ...list(o.d).map(x => h("p", null, x)),
    list(o.f).length ? h("div", { class: "ip-k", text: "So wird gerechnet" }) : null,
    ...list(o.f).map(x => h("p", { class: "ip-f" }, x)),
    list(o.r).length ? h("div", { class: "ip-k", text: "Aktuelle Rechnung" }) : null,
    ...list(o.r).map(x => h("p", { class: "ip-r" }, x)),
    ...list(o.s).map(x => h("p", { class: "ip-s" }, x)),
  ].filter(Boolean));
  INFO_BTN = btn;
  btn.setAttribute("aria-expanded", "true");
  P.el.hidden = false;
  infoPlace();
  P.el.focus({ preventScroll: true });
}

function infoClose(returnFocus) {
  if (!INFO_POP || !INFO_BTN) return;
  const b = INFO_BTN;
  INFO_BTN = null;
  b.setAttribute("aria-expanded", "false");
  INFO_POP.el.hidden = true;
  INFO_POP.back.hidden = true;
  if (returnFocus) b.focus({ preventScroll: true });
}

function infoPlace() {
  const { el, back } = INFO_POP;
  const sheetMode = window.innerWidth <= 560;
  el.classList.toggle("sheet-mode", sheetMode);
  back.hidden = !sheetMode;
  if (sheetMode) { el.style.left = el.style.top = ""; return; }
  const r = INFO_BTN.getBoundingClientRect();
  const w = el.offsetWidth, ht = el.offsetHeight, m = 8;
  const left = Math.max(m, Math.min(r.left - 16, window.innerWidth - w - m));
  let top = r.bottom + 8;
  if (top + ht > window.innerHeight - m && r.top - ht - 8 > m) top = r.top - ht - 8;
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

/* Spaltenkopf mit Erklärung */
function thInfo(text, spec, attrs) {
  return h("th", attrs || null, h("span", { class: "th-i" }, text, info(spec, text)));
}
/* Formatierte Rechnung "a op b = c" für die Popups */
function calc(...parts) { return parts.filter(x => x != null && x !== "").join(" "); }
/* Titel ergänzen, falls die Erklärung keinen eigenen hat */
function withTitle(spec, t) {
  if (!spec) return null;
  return typeof spec === "function" ? () => { const o = spec(); return o ? { t, ...o } : null; } : { t, ...spec };
}
