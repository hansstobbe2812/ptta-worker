/*
 * PinkThaiTakeAway — Cloudflare Worker (gratis backend, vervangt Google Apps Script)
 * Fase 1: bestellingen aannemen -> als JSON naar GitHub schrijven -> WhatsApp-melding.
 *
 * Secrets (Cloudflare > Worker > Settings > Variables and Secrets, als "Secret"):
 *   GH_TOKEN   = GitHub token met repo-schrijfrechten
 *   CB_PHONE   = jouw WhatsApp-nummer internationaal zonder + (bijv. 316...)
 *   CB_APIKEY  = CallMeBot API-key
 * Variables (staan al in wrangler.toml): GH_REPO, GH_BRANCH, SITE_ORIGIN
 */

export default {
  async fetch(request, env) {
    const origin = env.SITE_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ ok: false, fout: "POST vereist" }, 405, cors);

    let d;
    try { d = await request.json(); } catch (e) { return json({ ok: false, fout: "ongeldige body" }, 400, cors); }

    const naam = String(d.naam || "").slice(0, 80).trim();
    const tel = String(d.tel || "").slice(0, 30).trim();
    const bestelling = String(d.bestelling || "").slice(0, 4000);
    const telDigits = tel.replace(/\D/g, "");
    if (!naam || telDigits.length < 9 || telDigits.length > 15 || !bestelling) {
      return json({ ok: false, fout: "onvolledige bestelling" }, 400, cors);
    }

    // Bot-check (Cloudflare Turnstile) — alleen afdwingen als het secret is ingesteld (anders veilig-uit)
    if (env.TURNSTILE_SECRET) {
      const okBot = await verifyTurnstile(env, d.turnstile, request.headers.get("CF-Connecting-IP"));
      if (!okBot) return json({ ok: false, fout: "botcheck mislukt" }, 403, cors);
    }

    const id = (String(d.order_id || "").replace(/\D/g, "").slice(0, 8)) || String(Date.now()).slice(-6);
    const nu = new Date().toISOString();
    const order = {
      order_id: id, tijd: nu, naam, tel, bestelling,
      totaal: String(d.totaal || "").slice(0, 40),
      betaling: String(d.betaling || "").slice(0, 120),
      opmerking: String(d.opmerking || "").slice(0, 1000),
      afhaal: String(d.afhaal || "").slice(0, 120),
      start: String(d.start || "").slice(0, 40),
      taal: String(d.taal || "").slice(0, 5),
      vid: String(d.vid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
      mand: safeParse(d.mand),
      afgehaald: false, betaald: false,
    };

    const pad = `bestellingen/${nu.slice(0, 10)}-${id}.json`;
    const ghOk = await putGitHub(env, pad, order, `Bestelling #${id} (${naam})`);
    try { await sendWhatsApp(env, orderBericht(order)); } catch (e) {}
    return json({ ok: ghOk }, ghOk ? 200 : 502, cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(stuurOverzicht(env));
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) },
  });
}
function safeParse(s) { try { return typeof s === "string" ? JSON.parse(s) : (s || null); } catch (e) { return null; } }
async function verifyTurnstile(env, token, ip) {
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.set("secret", env.TURNSTILE_SECRET);
    form.set("response", String(token));
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    return !!(j && j.success);
  } catch (e) { return false; }
}
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function putGitHub(env, pad, obj, bericht) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return false;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(pad).replace(/%2F/g, "/")}`;
  const headers = {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "ptta-worker",
    "Content-Type": "application/json",
  };
  let sha;
  try { const g = await fetch(url + `?ref=${branch}`, { headers }); if (g.ok) { const j = await g.json(); sha = j.sha; } } catch (e) {}
  const body = { message: bericht, content: b64(JSON.stringify(obj, null, 2)), branch };
  if (sha) body.sha = sha;
  try { const r = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) }); return r.ok; } catch (e) { return false; }
}
function orderBericht(o) {
  return `\uD83C\uDF38 Nieuwe bestelling #${o.order_id}\n${o.naam} — ${o.tel}\nAfhalen: ${o.afhaal}\n${o.bestelling}\nTotaal: ${o.totaal}\nBetaling: ${o.betaling}` + (o.opmerking ? `\nOpmerking: ${o.opmerking}` : "");
}
async function sendWhatsApp(env, tekst) {
  if (!env.CB_PHONE || !env.CB_APIKEY) return;
  const url = "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(env.CB_PHONE)}&text=${encodeURIComponent(tekst)}&apikey=${encodeURIComponent(env.CB_APIKEY)}`;
  await fetch(url);
}
async function stuurOverzicht(env) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  let lijst = [];
  try { const r = await fetch(`https://api.github.com/repos/${repo}/contents/bestellingen?ref=${branch}`, { headers }); if (r.ok) lijst = await r.json(); } catch (e) {}
  let open = 0; const regels = [];
  for (const f of (Array.isArray(lijst) ? lijst : [])) {
    if (!f.name || !f.name.endsWith(".json") || !f.download_url) continue;
    try { const o = await (await fetch(f.download_url)).json(); if (o && !o.afgehaald) { open++; regels.push(`#${o.order_id} ${o.naam} — ${o.totaal}`); } } catch (e) {}
  }
  const tekst = open ? `\uD83C\uDF38 Afhaaloverzicht — ${open} openstaand\n` + regels.join("\n") : `\uD83C\uDF38 Afhaaloverzicht — geen openstaande bestellingen`;
  try { await sendWhatsApp(env, tekst); } catch (e) {}
}
