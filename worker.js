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
      // Bot-detectie: datacenter-herkomst of bot-user-agent (crawlers vervuilen anders de bezoekstatistiek)
      const _ua = String(request.headers.get("user-agent") || "").toLowerCase();
      const _org = String(cf.asOrganization || "").toLowerCase();
      const _botUa = !_ua || /bot|crawl|spider|slurp|headless|phantom|python|curl|wget|scan|monitor|preview|lighthouse|pagespeed|semrush|ahrefs|facebookexternalhit|whatsapp/.test(_ua);
      const _dc = ["amazon","aws","google","microsoft","azure","hetzner","ovh","digitalocean","linode","akamai","leaseweb","contabo","vultr","alibaba","tencent","oracle","scaleway","fastly","m247","choopa","datacamp","censys","shodan","palo alto"];
      const _isBot = _botUa || _dc.some(function(o){ return _org.indexOf(o) >= 0; });
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
        bot: _isBot,
      };
      const okV = await appendGitHub(env, `bezoek/${nu.toISOString().slice(0, 7)}.json`, visit, 8000, "bezoek");
      return json({ ok: okV }, okV ? 200 : 502, cors);
    }

    // --- Mijn account: bestellingen van een klant opzoeken via persoonlijke token ---
    if (d && d.soort === "verwijder") {
      const token = String(d.token || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
      if (!token) return json({ ok: false, fout: "token" }, 400, cors);
      const rec = await leesJson(env, `klant-tokens/${token}.json`);
      const telD = rec ? String(rec.telDigits || "").replace(/\D/g, "") : "";
      try { await deleteGitHub(env, `klant-tokens/${token}.json`); } catch (e) {}
      if (telD) {
        try { let lijst = await leesJson(env, "klanten.json"); if (Array.isArray(lijst)) { const nieuw = lijst.filter(k => String(k.tel || "").replace(/\D/g, "") !== telD); if (nieuw.length !== lijst.length) await putGitHub(env, "klanten.json", nieuw, "Klant verwijderd (AVG)"); } } catch (e) {}
        try { await anonimiseerOrders(env, telD); } catch (e) {}
      }
      return json({ ok: true }, 200, cors);
    }
    if (d && d.soort === "profiel") {
      const token = String(d.token || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
      if (!token) return json({ ok: false, fout: "token" }, 400, cors);
      const rec = await leesJson(env, `klant-tokens/${token}.json`);
      if (!rec || !rec.telDigits) return json({ ok: false, fout: "onbekend" }, 404, cors);
      const naam = String(d.naam || "").slice(0, 80).trim();
      const email = String(d.email || "").slice(0, 120).trim();
      const nieuwTel = String(d.tel || "").slice(0, 40).trim();
      const nieuwTelD = nieuwTel.replace(/\D/g, "");
      const oudTelD = String(rec.telDigits || "").replace(/\D/g, "");
      const telGewijzigd = !!(nieuwTelD && nieuwTelD !== oudTelD);
      const straat = String(d.straat || "").slice(0, 120).trim();
      const postcode = String(d.postcode || "").slice(0, 20).trim();
      const plaats = String(d.plaats || "").slice(0, 80).trim();
      const pittig = (d.pittig === "" || d.pittig === null || d.pittig === undefined) ? null : Math.max(0, Math.min(4, parseInt(d.pittig, 10) || 0));
      const allergie = String(d.allergie || "").slice(0, 200).trim();
      const variant = (d.variant === "kip" || d.variant === "garnaal") ? d.variant : "";
      const nieuw = Object.assign({}, rec, { naam: naam || rec.naam || "", email: email, straat: straat, postcode: postcode, plaats: plaats, allergie: allergie, variant: variant });
      if (pittig !== null) nieuw.pittig = pittig; else delete nieuw.pittig;
      if (telGewijzigd) { nieuw.telDigits = nieuwTelD; nieuw.tel = nieuwTel; }
      await putGitHub(env, `klant-tokens/${token}.json`, nieuw, "Profiel bijgewerkt (klant)");
      if (telGewijzigd) { try { await herKeyOrders(env, oudTelD, nieuwTel, naam); } catch (e) {} }
      try { await updateKlantJson(env, oudTelD || nieuwTelD, { naam: nieuw.naam, email: email, straat: straat, postcode: postcode, plaats: plaats, allergie: allergie, variant: variant, pittig: (pittig !== null ? pittig : undefined), tel: (telGewijzigd ? nieuwTel : undefined) }); } catch (e) {}
      return json({ ok: true, naam: nieuw.naam, tel: nieuw.tel || rec.tel || "", email: email, straat: straat, postcode: postcode, plaats: plaats, allergie: allergie, variant: variant, pittig: (typeof nieuw.pittig === "number") ? nieuw.pittig : null, telGewijzigd: telGewijzigd }, 200, cors);
    }
    if (d && d.soort === "account") {
      const token = String(d.token || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
      if (!token) return json({ ok: false }, 200, cors);
      const rec = await leesJson(env, `klant-tokens/${token}.json`);
      if (!rec || !rec.telDigits) return json({ ok: false }, 200, cors);
      const orders = await ordersVoorTel(env, rec.telDigits);
      const puntBonus = await klantBonus(env, rec.telDigits);
      let belRechten = Array.isArray(rec.belRechten) ? rec.belRechten.slice() : [];
      let spaarLid = !!rec.spaarLid || belRechten.length > 0;
      let kaartCap = (typeof rec.kaartCap === "number") ? rec.kaartCap : null;
      try {
        const loy = await loyConfig(env);
        const loyActief = loy.aan || spaarLid;
        if (loyActief) {
          const doel = loy.doel || 10;
          const stempels = orders.filter(o => bedragParse(o.totaal) >= (loy.min || 0)).length + puntBonus;
          if (loy.aan) {
            kaartCap = null;
            if (d.spaarOptIn) spaarLid = true;   // klant activeert sparen -> lid (blijft geldig als beheer later uitzet)
            const beschikbaar = Math.floor(stempels / doel) - (rec.beloningGebruikt || 0);
            if (beschikbaar >= 1) { spaarLid = true; if (loy.gerechtAan && belRechten.indexOf("gerecht") < 0) belRechten.push("gerecht"); if (loy.kortingAan && belRechten.indexOf("korting") < 0) belRechten.push("korting"); }
          } else if (kaartCap === null || kaartCap < 1) { kaartCap = Math.max(1, Math.ceil(stempels / doel)); }
          const capOud = (typeof rec.kaartCap === "number") ? rec.kaartCap : null;
          if ((belRechten.length !== (rec.belRechten || []).length) || ((!!rec.spaarLid) !== spaarLid) || (capOud !== kaartCap)) {
            try { await putGitHub(env, `klant-tokens/${token}.json`, Object.assign({}, rec, { belRechten, spaarLid, kaartCap }), "Spaarstatus vastgelegd"); } catch (e) {}
          }
        }
      } catch (e) {}
      return json({ ok: true, naam: rec.naam || "", tel: rec.tel || (orders[0] && orders[0].tel) || "", email: rec.email || "", straat: rec.straat || "", postcode: rec.postcode || "", plaats: rec.plaats || "", allergie: rec.allergie || "", variant: rec.variant || "", pittig: (typeof rec.pittig === "number") ? rec.pittig : null, taal: rec.taal || "", beloningGebruikt: rec.beloningGebruikt || 0, puntenBonus: puntBonus, belRechten, spaarLid, kaartCap, token, deelcode: token.slice(0, 8), aantal: orders.length, bestellingen: orders }, 200, cors);
    }

    // --- Test-WhatsApp (alleen beheer: token moet toegang tot de repo hebben) ---
    if (d && d.soort === "test-whatsapp") {
      const tok = String(d.token || "");
      if (!tok) return json({ ok: false, fout: "geen token" }, 200, cors);
      let mag = false;
      try {
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}`, { headers: { "Authorization": `Bearer ${tok}`, "User-Agent": "ptta-worker", "Accept": "application/vnd.github+json" } });
        mag = r.ok;
      } catch (e) {}
      if (!mag) return json({ ok: false, fout: "geen toegang" }, 200, cors);
      const cfg = await callMeBotConfig(env);
      if (!cfg.phone || !cfg.apikey) return json({ ok: false, fout: "callmebot niet ingesteld" }, 200, cors);
      try { await sendWhatsApp(env, "\uD83E\uDDEA Test-bericht van Pink Thai TakeAway \u2014 WhatsApp werkt!"); } catch (e) { return json({ ok: false, fout: "verzenden mislukt" }, 200, cors); }
      return json({ ok: true }, 200, cors);
    }

    // --- Huidige CallMeBot-instelling teruggeven (alleen beheer) ---
    if (d && d.soort === "callmebot-status") {
      const tok = String(d.token || "");
      if (!tok) return json({ ok: false }, 200, cors);
      let mag = false;
      try {
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}`, { headers: { "Authorization": `Bearer ${tok}`, "User-Agent": "ptta-worker", "Accept": "application/vnd.github+json" } });
        mag = r.ok;
      } catch (e) {}
      if (!mag) return json({ ok: false }, 200, cors);
      const file = await leesJson(env, "callmebot.json");
      const bron = (file && (file.tel || file.phone) && file.apikey) ? "file" : "secrets";
      const cfg = await callMeBotConfig(env);
      return json({ ok: true, tel: cfg.phone || "", apikey: cfg.apikey || "", bron }, 200, cors);
    }

    const naam = String(d.naam || "").slice(0, 80).trim();
    const email = String(d.email || "").slice(0, 120).trim();
    const straat = String(d.straat || "").slice(0, 120).trim();
    const postcode = String(d.postcode || "").slice(0, 20).trim();
    const plaats = String(d.plaats || "").slice(0, 80).trim();
    const allergie = String(d.allergie || "").slice(0, 200).trim();
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

    // Klant-token bepalen (nodig voor spaarkaart-validatie + hergebruik)
    let klanttoken = String(d.klanttoken || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
    let tokenGeldig = false; let tokenRec = null;
    if (klanttoken) { tokenRec = await leesJson(env, `klant-tokens/${klanttoken}.json`); if (tokenRec && tokenRec.telDigits === telDigits) tokenGeldig = true; }
    if (!tokenGeldig) { klanttoken = nieuwToken(); tokenRec = null; }
    // Spaarkaart-beloning SERVER-SIDE valideren + rechten vastleggen (blijven geldig, ook als beheer een type later uitzet)
    let belText = "", eindTotaal = String(d.totaal || "").slice(0, 40);
    let belRechten = (tokenRec && Array.isArray(tokenRec.belRechten)) ? tokenRec.belRechten.slice() : [];
    let spaarLid = !!(tokenRec && tokenRec.spaarLid);
    let kaartCap = (tokenRec && typeof tokenRec.kaartCap === "number") ? tokenRec.kaartCap : null;
    if (d.gebruikBeloning || tokenGeldig) {
      try {
        const loy = await loyConfig(env);
        if (loy.aan && d.spaarOpt) spaarLid = true;
        const loyActief = loy.aan || spaarLid;
        if (loyActief && tokenGeldig) {
          const doel = loy.doel || 10;
          const best = await ordersVoorTel(env, telDigits);
          const puntBonus = await klantBonus(env, telDigits);
          const stempels = best.filter(o => bedragParse(o.totaal) >= (loy.min || 0)).length + puntBonus;
          let verdiend = Math.floor(stempels / doel);
          if (!loy.aan) { if (kaartCap === null || kaartCap < 1) kaartCap = Math.max(1, Math.ceil(stempels / doel)); verdiend = Math.min(verdiend, kaartCap); } else { kaartCap = null; }
          const beschikbaar = Math.max(0, verdiend - ((tokenRec && tokenRec.beloningGebruikt) || 0));
          if (beschikbaar >= 1) {
            if (loy.aan) {
              if (loy.gerechtAan && belRechten.indexOf("gerecht") < 0) belRechten.push("gerecht");
              if (loy.kortingAan && belRechten.indexOf("korting") < 0) belRechten.push("korting");
            }
            if (d.gebruikBeloning) {
              const type = (d.beloningType === "korting") ? "korting" : "gerecht";
              if (belRechten.indexOf(type) >= 0) {
                belText = (type === "korting") ? ((loy.korting || 10) + "% korting") : (loy.beloning || "beloning");
                if (type === "korting") { const vol = bedragParse(d.totaalVol || d.totaal); if (vol > 0) eindTotaal = euro(vol * (1 - (loy.korting || 10) / 100)); }
              } else if (d.totaalVol) { eindTotaal = String(d.totaalVol).slice(0, 40); }
            }
          } else if (d.gebruikBeloning && d.totaalVol) { eindTotaal = String(d.totaalVol).slice(0, 40); }
        } else if (d.gebruikBeloning && d.totaalVol) { eindTotaal = String(d.totaalVol).slice(0, 40); }
        if (belRechten.length > 0) spaarLid = true;
      } catch (e) {}
    }
    let belBetaling = String(d.betaling || "").slice(0, 120);
    if (d.gebruikBeloning) { belBetaling = belBetaling.replace(/\(\u20ac[^)]*\)/, "(" + eindTotaal + ")"); }
    const id = (String(d.order_id || "").replace(/\D/g, "").slice(0, 8)) || String(Date.now()).slice(-6);
    const nu = new Date().toISOString();
    const order = {
      order_id: id, tijd: nu, naam, tel, email, straat, postcode, plaats, allergie, bestelling,
      totaal: eindTotaal,
      betaling: belBetaling,
      opmerking: String(d.opmerking || "").slice(0, 1000),
      afhaal: String(d.afhaal || "").slice(0, 120),
      start: String(d.start || "").slice(0, 40),
      taal: String(d.taal || "").slice(0, 5),
      vid: String(d.vid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
      mand: safeParse(d.mand),
      beloning: belText,
      afgehaald: false, betaald: false,
    };

    const pad = `bestellingen/${nu.slice(0, 10)}-${id}.json`;
    const ghOk = await putGitHub(env, pad, order, `Bestelling #${id} (${naam})`);

    try { const _tk = Object.assign({}, tokenRec || {}, { telDigits, tel, naam, taal: order.taal || (tokenRec && tokenRec.taal) || "", beloningGebruikt: ((tokenRec && tokenRec.beloningGebruikt) || 0) + (order.beloning ? 1 : 0), belRechten: belRechten, spaarLid: spaarLid, kaartCap: kaartCap, aangemaakt: (tokenRec && tokenRec.aangemaakt) || nu }); if (email) _tk.email = email; if (straat) _tk.straat = straat; if (postcode) _tk.postcode = postcode; if (plaats) _tk.plaats = plaats; if (allergie) _tk.allergie = allergie; await putGitHub(env, `klant-tokens/${klanttoken}.json`, _tk, "Klant-token"); } catch (e) {}
    if (straat || postcode || plaats || email || allergie) { try { await updateKlantJson(env, telDigits, { naam: naam, tel: tel, email: email || undefined, straat: straat || undefined, postcode: postcode || undefined, plaats: plaats || undefined, allergie: allergie || undefined }); } catch (e) {} }
    // Telefoon->token-index, zodat beheer een klant een persoonlijke inloglink kan sturen
    let nieuweKlant = false;
    try { const idx = (await leesJson(env, "klant-token-index.json")) || {}; nieuweKlant = !idx[telDigits]; if (idx[telDigits] !== klanttoken) { idx[telDigits] = klanttoken; await putGitHub(env, "klant-token-index.json", idx, "token-index"); } } catch (e) {}

    const _bericht = orderBericht(order, nieuweKlant);
    const _gemeld = await sendWhatsApp(env, _bericht).catch(() => false);
    if (!_gemeld) {
      try { const lijst = (await leesJson(env, "gemiste-meldingen.json")) || []; lijst.push({ id, tekst: _bericht, tijd: nu }); await putGitHub(env, "gemiste-meldingen.json", lijst, `Gemiste melding #${id}`); } catch (e) {}
    }
    return json({ ok: ghOk, token: klanttoken }, ghOk ? 200 : 502, cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await verwerkGemist(env);   // elke 15 min: eventueel gemiste ordermeldingen alsnog versturen
        // Stuur het besteloverzicht ~1 min ná de ingestelde sluiting (dag+tijd uit bedrijf.json),
        // in lokale tijd (Europe/Amsterdam) -> instelling-, zomer- en wintertijd-proof.
        const cfg = await leesJson(env, "bedrijf.json");
        const af = (cfg && cfg.afhaal) || {};
        const sluitDag = (typeof af.sluitDag === "number") ? af.sluitDag : 5;
        const st = String(af.sluitTijd || "17:00").split(":");
        const closeMin = (Number(st[0]) || 0) * 60 + (Number(st[1]) || 0);
        const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
        const gv = t => (parts.find(p => p.type === t) || {}).value;
        const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[gv("weekday")];
        const nowMin = Number(gv("hour")) * 60 + Number(gv("minute"));
        const diff = nowMin - closeMin;
        if (wd === sluitDag && diff >= 1 && diff <= 10) {
          await stuurOverzicht(env);
          await ruimOudeOrders(env);
          await ruimLogs(env);
        }
      } catch (e) {}
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
function euro(n){ return "\u20ac " + (Math.round(Number(n)*100)/100).toFixed(2).replace(".", ","); }
function bedragParse(s){ const m=String(s||"").replace(/[^0-9,.]/g,"").replace(/\.(?=\d{3}\b)/g,"").replace(",","."); const v=parseFloat(m); return isFinite(v)?v:0; }
async function loyConfig(env){ const c=(await leesJson(env,"loyaliteit.json"))||{}; return { aan:!!c.aan, doel:c.doel||10, min:c.min||0, korting:c.korting||10, gerechtAan:(c.gerechtAan!==undefined)?!!c.gerechtAan:(c.type!=="korting"), kortingAan:(c.kortingAan!==undefined)?!!c.kortingAan:(c.type==="korting") }; }
async function updateKlantJson(env, telDigits, fields){
  try{
    let lijst = await leesJson(env, "klanten.json"); if(!Array.isArray(lijst)) lijst=[];
    const t=String(telDigits||"").replace(/\D/g,""); let found=false;
    const clean={}; for(const k in fields){ if(fields[k]!==undefined && fields[k]!==null) clean[k]=fields[k]; }
    lijst.forEach(function(k){ if(t && String(k.tel||"").replace(/\D/g,"")===t){ Object.assign(k, clean); found=true; } });
    if(!found) lijst.unshift(Object.assign({tel:"", uitgenodigd:0}, clean));
    await putGitHub(env, "klanten.json", lijst, "Klantprofiel bijgewerkt (klant)");
  }catch(e){}
}
async function klantBonus(env, telDigits){ try{ const kl=await leesJson(env,"klanten.json"); if(Array.isArray(kl)){ const t=String(telDigits||"").replace(/\D/g,""); const k=kl.find(function(x){ return String(x.tel||"").replace(/\D/g,"")===t; }); if(k && typeof k.puntenBonus==="number" && isFinite(k.puntenBonus)) return Math.round(k.puntenBonus); } }catch(e){} return 0; }
async function leesJson(env, pad) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${pad}?ref=${branch}&t=${Date.now()}`, { headers: { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" } });
    if (!r.ok) return null;
    return JSON.parse(fromB64((await r.json()).content));
  } catch (e) { return null; }
}
async function deleteGitHub(env, pad) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN) return false;
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(pad).replace(/%2F/g, "/")}`;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker", "Content-Type": "application/json" };
  let sha;
  try { const g = await fetch(url + `?ref=${branch}`, { headers }); if (g.ok) sha = (await g.json()).sha; } catch (e) {}
  if (!sha) return false;
  try { const r = await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ message: "Verwijderd (AVG)", sha, branch }) }); return r.ok; } catch (e) { return false; }
}
async function anonimiseerOrders(env, telD) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN || !telD) return;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  try {
    const l = await fetch(`https://api.github.com/repos/${repo}/contents/bestellingen?ref=${branch}&t=${Date.now()}`, { headers });
    if (!l.ok) return;
    const files = (await l.json()).filter(f => f.name && f.name.endsWith(".json"));
    for (const f of files) {
      try {
        const rr = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=${branch}&t=${Date.now()}`, { headers });
        if (!rr.ok) continue;
        const o = JSON.parse(fromB64((await rr.json()).content));
        if (String(o.tel || "").replace(/\D/g, "") === telD) { o.naam = ""; o.tel = ""; o.email = ""; o.straat = ""; o.postcode = ""; o.plaats = ""; o.allergie = ""; await putGitHub(env, f.path, o, "Order geanonimiseerd (AVG)"); }
      } catch (e) {}
    }
  } catch (e) {}
}
async function herKeyOrders(env, oudTelD, nieuwTel, naam) {
  const repo = env.GH_REPO, branch = env.GH_BRANCH || "main";
  if (!repo || !env.GH_TOKEN || !oudTelD) return;
  const headers = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "ptta-worker" };
  try {
    const l = await fetch(`https://api.github.com/repos/${repo}/contents/bestellingen?ref=${branch}&t=${Date.now()}`, { headers });
    if (!l.ok) return;
    const files = (await l.json()).filter(f => f.name && f.name.endsWith(".json"));
    for (const f of files) {
      try {
        const rr = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=${branch}&t=${Date.now()}`, { headers });
        if (!rr.ok) continue;
        const o = JSON.parse(fromB64((await rr.json()).content));
        if (String(o.tel || "").replace(/\D/g, "") === oudTelD) { o.tel = nieuwTel; if (naam) o.naam = naam; await putGitHub(env, f.path, o, "Order her-sleutelen (profiel)"); }
      } catch (e) {}
    }
  } catch (e) {}
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
        if (String(o.tel || "").replace(/\D/g, "") === telDigits) uit.push({ order_id: o.order_id, tijd: o.tijd, bestelling: o.bestelling, totaal: o.totaal, afhaal: o.afhaal, afgehaald: !!o.afgehaald, tel: o.tel, email: o.email || "", allergie: o.allergie || "", mand: o.mand || null, beloning: o.beloning || "" });
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
function orderBericht(o, nieuweKlant) {
  const kop = o.ingevroren ? "\u2744\uFE0F INGEVROREN \u2014 OP AFSPRAAK\n" : "";
  const kk = (nieuweKlant === true) ? "\uD83C\uDD95 NIEUWE KLANT!\n" : (nieuweKlant === false ? "\uD83D\uDD01 Terugkerende klant\n" : "");
  const bel = o.beloning ? ("\uD83C\uDF81 SPAARKAART: " + o.beloning + "\n") : "";
  const alg = o.allergie ? ("\u26A0\uFE0F ALLERGIE/DIEET: " + o.allergie + "\n") : "";
  return kop + kk + bel + alg + `\uD83C\uDF38 Nieuwe bestelling #${o.order_id}\n${o.naam} — ${o.tel}\nAfhalen: ${o.afhaal}\n${o.bestelling}\nTotaal: ${o.totaal}\nBetaling: ${o.betaling}` + (o.opmerking ? `\nOpmerking: ${o.opmerking}` : "");
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
  if (!cfg.phone || !cfg.apikey) return false;
  const url = "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(cfg.phone)}&text=${encodeURIComponent(tekst)}&apikey=${encodeURIComponent(cfg.apikey)}`;
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) {}
  }
  return false;
}
// Gemiste ordermeldingen opnieuw versturen (backend-vangnet: mocht WhatsApp even haperen)
async function verwerkGemist(env) {
  let lijst;
  try { lijst = await leesJson(env, "gemiste-meldingen.json"); } catch (e) { return; }
  if (!Array.isArray(lijst) || !lijst.length) return;
  const rest = [];
  for (const m of lijst) {
    const ok = (m && m.tekst) ? await sendWhatsApp(env, m.tekst).catch(() => false) : true;
    if (!ok) rest.push(m);
  }
  if (rest.length !== lijst.length) { try { await putGitHub(env, "gemiste-meldingen.json", rest, "gemiste meldingen verwerkt"); } catch (e) {} }
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
