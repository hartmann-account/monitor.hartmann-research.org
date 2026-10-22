/* E-Mail über Cloudflare Email Service: Bindung send_email „EMAIL“ (wrangler.jsonc), Absender noreply@monitor.hartmann.id
   (die Domain monitor.hartmann.id ist im Konto für den Versand eingerichtet; anderer Absender über die Variable MAIL_VON),
   Empfänger aus der Variablen MAIL_EMPFANG (Klartext, mehrere mit Komma). Jede Adresse bekommt eine eigene Nachricht,
   damit Empfänger einander nicht sehen. Fehler tragen den Code des Dienstes (E_SENDER_NOT_VERIFIED, E_RECIPIENT_NOT_ALLOWED …). */
export const MAIL_VON = "noreply@monitor.hartmann.id";
const ADRESSE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

export const empfaenger = env => [...new Set(String(env.MAIL_EMPFANG || "").split(/[,;\s]+/).map(s => s.trim()).filter(s => ADRESSE.test(s)))].slice(0, 20);
export const mailBereit = env => !!(env.EMAIL && typeof env.EMAIL.send === "function" && empfaenger(env).length);

/* an alle Empfänger; Ergebnis { an: zugestellt, fehler: [Text] }; wirft nur, wenn keine Nachricht angenommen wurde */
export async function mailSenden(env, { name, betreff, html, text }) {
  if (!env.EMAIL) throw new Error("Bindung EMAIL fehlt (send_email in wrangler.jsonc)");
  const an = empfaenger(env);
  if (!an.length) throw new Error("MAIL_EMPFANG enthält keine gültige Adresse");
  let n = 0;
  const fehler = [];
  for (const to of an) {
    try {
      await env.EMAIL.send({ from: { email: env.MAIL_VON || MAIL_VON, name }, to, subject: betreff, html, text });
      n++;
    } catch (e) {
      fehler.push(`${to}: ${(e && (e.code || e.message)) || "Versand gescheitert"}`);
    }
  }
  if (!n) throw new Error(fehler.join("; "));
  return { an: n, fehler };
}
