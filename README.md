# ptta-worker

Cloudflare Worker die dienstdoet als backend voor pinkthaitakeaway.nl:
neemt bestellingen aan, slaat ze als JSON op in de map `bestellingen/` van de
site-repo, en stuurt een WhatsApp-melding via CallMeBot.

## Koppelen in Cloudflare
1. Cloudflare dashboard → Compute → Workers → **Create** → **Import a repository / Connect GitHub**.
2. Kies deze repo (`ptta-worker`) en deploy. Cloudflare leest `wrangler.toml`.
3. Zet in de Worker onder **Settings → Variables and Secrets** deze **Secrets**:
   - `GH_TOKEN`  — GitHub token met schrijfrechten op de site-repo
   - `CB_PHONE`  — WhatsApp-nummer internationaal zonder + (bijv. 316...)
   - `CB_APIKEY` — CallMeBot API-key
4. De cron (vrijdag 17:00) en variabelen staan al in `wrangler.toml`.
