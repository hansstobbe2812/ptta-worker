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

    // --- Bezoek-tracking (voedt de Bezoek-tab); geo komt uit Cloudflare, geen externe lookup ---
    if (d && d.soort === "bezoek") {
      const nu = new Date();
      const cf = request.cf || {};
      const visit = {
        tijd: nu.toISOString(),
        vid: String(d.vid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
        type: (["klant", "beheer", "volg"].indexOf(String(d.type || "")) >= 0) ? d.type : "klant",
        herkomst: (["direct", "whatsapp", "google", "overig"].indexOf(String(d.herkomst || "")) >= 0) ? d.herkomst : "overig",
        toestel: String(d.toestel || "") === "mobiel" ? "mobiel" : "desktop",
        taal: String(d.taal || "").slice(0, 5),
        via: String(d.via || "").slice(0, 60),
        klant: !!d.klanttoken,
        land: String(cf.country || "").slice(0, 4),
        plaats: String(cf.city || "").slice(0, 60),
        open: (typeof d.open === "boolean") ? d.open : null,
      };
      const okV = await appendGitHub(env, `bezoek/${nu.toISOString().slice(0, 7)}.json`, visit, 8000, "bezoek");
      return json({ ok: okV }, okV ? 200 : 502, cors);
    }

    // --- Mijn account: bestellingen van een klant opzoeken via persoonlijke token ---
    if (d && d.soort === "account") {
      const token = String(d.token || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
      if (!token) return json({ ok: false }, 200, cors);
      const rec = await leesJson(env, `klant-tokens/${token}.json`);
      if (!rec || !rec.telDigits) return json({ ok: false }, 200, cors);
      const orders = await ordersVoorTel(env, rec.telDigits);
      return json({ ok: true, naam: rec.naam || "", tel: rec.tel || (orders[0] && orders[0].tel) || "", token, deelcode: token.slice(0, 8), aantal: orders.length, bestellingen: orders }, 200, cors);
    }

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

    // Persoonlijk klant-token (Mijn account via inloglink): hergebruik geldig bestaand, anders nieuw
    let klanttoken = String(d.klanttoken || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
    let tokenGeldig = false;
    if (klanttoken) { const b = await leesJson(env, `klant-tokens/${klanttoken}.json`); if (b && b.telDigits === telDigits) tokenGeldig = true; }
    if (!tokenGeldig) { klanttoken = nieuwToken(); try { await putGitHub(env, `klant-tokens/${klanttoken}.json`, { telDigits, tel, naam, aangemaakt: nu }, "Klant-token"); } catch (e) {} }
    // Telefoon->token-index, zodat beheer een klant een persoonlijke inloglink kan sturen
    try { const idx = (await leesJson(env, "klant-token-index.json")) || {}; if (idx[telDigits] !== klanttoken) { idx[telDigits] = klanttoken; await putGitHub(env, "klant-token-index.json", idx, "token-index"); } } catch (e) {}

    return json({ ok: ghOk, token: klanttoken }, ghOk ? 200 : 502, cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // Alleen draaien 1 minuut ná sluiting: vrijdag 17:00 lokale tijd (Europe/Amsterdam).
      // Twee cron-tijden (zomer/wintertijd); alleen die op lokaal 17:0x stuurt daadwerkelijk.
      let hh = -1;
      try {
        const parts = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).formatToParts(new Date());
        hh = Number((parts.find(p => p.type === "hour") || {}).value);
      } catch (e) {}
      if (hh === 17) {
        await stuurOverzicht(env);
        await ruimOudeOrders(env);
        await ruimLogs(env);
      }
    })());
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
function fromB64(s) {
  const bin = atob(String(s || "").replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function nieuwToken() {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  let s = ""; for (const b of a) s += (b % 36).toString(36); return s.slice(0, 32);
}
async function leesJson(env, pad) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${pad}?ref=${branch}&t=${Date.now()}`, { headers: { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" } });
    if (!r.ok) return null;
    return JSON.parse(fromB64((await r.json()).content));
  } catch (e) { return null; }
}
async function ordersVoorTel(env, telDigits) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN || !telDigits) return [];
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  try {
    const grens = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
    const l = await fetch(`https://api.github.com/repos/${repo}/contents/bestellingen?ref=${branch}&t=${Date.now()}`, { headers });
    if (!l.ok) return [];
    const files = (await l.json()).filter(f => f.name && f.name.endsWith(".json") && f.name.slice(0, 10) >= grens);
    const uit = [];
    for (const f of files) {
      try {
        const rr = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=${branch}&t=${Date.now()}`, { headers });
        if (!rr.ok) continue;
        const o = JSON.parse(fromB64((await rr.json()).content));
        if (String(o.tel || "").replace(/\D/g, "") === telDigits) uit.push({ order_id: o.order_id, tijd: o.tijd, bestelling: o.bestelling, totaal: o.totaal, afhaal: o.afhaal, afgehaald: !!o.afgehaald, tel: o.tel });
      } catch (e) {}
    }
    uit.sort((a, b) => String(b.tijd).localeCompare(String(a.tijd)));
    return uit;
  } catch (e) { return []; }
}
async function ruimLogs(env) {
  // Verwijdert maandbestanden van bezoek/audit/admin-logins ouder dan ~6 maanden.
  // klant-tokens blijven staan (anders breken persoonlijke inloglinks).
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  const grens = new Date(Date.now() - 6 * 31 * 864e5).toISOString().slice(0, 7);
  for (const map of ["bezoek", "audit", "admin-logins"]) {
    try {
      const l = await fetch(`https://api.github.com/repos/${repo}/contents/${map}?ref=${branch}&t=${Date.now()}`, { headers });
      if (!l.ok) continue;
      const files = await l.json();
      for (const f of (Array.isArray(files) ? files : [])) {
        const m = String(f.name || "").slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(m) && m < grens) {
          try { await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message: `oude ${map} opgeschoond`, sha: f.sha, branch }) }); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}
async function appendGitHub(env, pad, entry, cap, bericht) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return false;
  const url = `https://api.github.com/repos/${repo}/contents/${pad}`;
  const headers = {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "ptta-worker",
    "Content-Type": "application/json",
  };
  for (let poging = 0; poging < 4; poging++) {
    let arr = [], sha;
    try {
      const g = await fetch(url + `?ref=${branch}&t=${Date.now()}`, { headers });
      if (g.ok) { const j = await g.json(); sha = j.sha; try { arr = JSON.parse(fromB64(j.content)); } catch (e) { arr = []; } }
    } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(entry);
    if (cap && arr.length > cap) arr = arr.slice(0, cap);
    const body = { message: bericht || ("append " + pad), content: b64(JSON.stringify(arr)), branch };
    if (sha) body.sha = sha;
    try {
      const r = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
      if (r.ok) return true;
      if (r.status === 409 || r.status === 422) continue;   // sha-conflict -> opnieuw
      return false;
    } catch (e) { return false; }
  }
  return false;
}
function orderBericht(o) {
  const kop = o.ingevroren ? "\u2744\uFE0F INGEVROREN \u2014 OP AFSPRAAK\n" : "";
  return kop + `\uD83C\uDF38 Nieuwe bestelling #${o.order_id}\n${o.naam} — ${o.tel}\nAfhalen: ${o.afhaal}\n${o.bestelling}\nTotaal: ${o.totaal}\nBetaling: ${o.betaling}` + (o.opmerking ? `\nOpmerking: ${o.opmerking}` : "");
}
async function callMeBotConfig(env) {
  // Beheer kan dit instellen via callmebot.json in de repo; anders de secrets (CB_PHONE/CB_APIKEY).
  try {
    const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
    if (repo && env.GH_TOKEN) {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/callmebot.json?ref=${branch}&t=${Date.now()}`, { headers: { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" } });
      if (r.ok) { const j = await r.json(); const c = JSON.parse(fromB64(j.content)); const phone = String((c && (c.tel || c.phone)) || "").replace(/\D/g, ""); const apikey = String((c && c.apikey) || "").trim(); if (phone && apikey) return { phone, apikey }; }
    }
  } catch (e) {}
  return { phone: env.CB_PHONE, apikey: env.CB_APIKEY };
}
async function sendWhatsApp(env, tekst) {
  const cfg = await callMeBotConfig(env);
  if (!cfg.phone || !cfg.apikey) return;
  const url = "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(cfg.phone)}&text=${encodeURIComponent(tekst)}&apikey=${encodeURIComponent(cfg.apikey)}`;
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
    try { const o = await (await fetch(f.download_url)).json(); if (o && !o.afgehaald) { open++; regels.push(`${o.ingevroren ? "\u2744\uFE0F " : ""}#${o.order_id} ${o.naam} — ${o.totaal}`); } } catch (e) {}
  }
  const tekst = open ? `\uD83D\uDD12 Bestellen gesloten — ${open} bestelling(en)\n` + regels.join("\n") : `\uD83D\uDD12 Bestellen gesloten — geen bestellingen`;
  try { await sendWhatsApp(env, tekst); } catch (e) {}
}

// Wekelijkse opruiming: verwijdert AFGEHAALDE bestellingen ouder dan 90 dagen (openstaande blijven altijd staan)
async function ruimOudeOrders(env) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  let lijst = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/bestellingen?ref=${branch}`, { headers });
    if (r.ok) lijst = await r.json();
  } catch (e) { return; }
  const grens = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);   // ouder dan 90 dagen
  for (const f of (Array.isArray(lijst) ? lijst : [])) {
    if (!f.name || !f.name.endsWith(".json") || !f.download_url) continue;
    if (f.name.slice(0, 10) >= grens) continue;                 // recent -> laten staan
    try {
      const o = await (await fetch(f.download_url)).json();
      if (!o || !o.afgehaald) continue;                         // openstaand -> NOOIT verwijderen
      await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}`, {
        method: "DELETE", headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify({ message: `Oude afgehaalde bestelling #${o.order_id} opgeruimd`, sha: f.sha, branch })
      });
    } catch (e) {}
  }
}
