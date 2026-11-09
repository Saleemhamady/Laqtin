# Laqtine — notes for Claude

Read this before working on the project. It records decisions already made with the owner.

## Connecting to Cloudflare

**Status:** connected. Use the cloud environment **laqtine** (personal; network: api.cloudflare.com, github.com, package registries; its setup script runs `npm ci` and installs the Cloudflare plugin). A Cloudflare API token is saved on that environment as a network secret for `api.cloudflare.com` — just call the API with curl; the proxy adds the token. Never ask for the token in chat.

- Account: `f8de1c0fc217389c302f9304f8f6b598` (Keef.education@gmail.com's Account)
- Zone laqtine.com: `5d705b3f030d496324f5efb7db779c2b` (active, Free plan, SSL mode Full)
- Token can: DNS edit, zone read, email routing. **Stream: not yet** (user must subscribe to Stream and add Account → Stream → Edit to the token).
- The plugin's MCP server (mcp.cloudflare.com) can't complete its OAuth sign-in from a cloud session — use the API token instead.

If starting from scratch in another environment, do this (from Cloudflare's official agent setup, https://developers.cloudflare.com/agent-setup/prompt.md):

1. Run these two commands yourself (cloud session containers are temporary, so the plugin must be reinstalled each new session):
   ```bash
   claude plugin marketplace add cloudflare/skills
   claude plugin install cloudflare@cloudflare
   ```
2. Tell the user to type `/reload-plugins` to activate it (you cannot run that yourself).
3. On the first Cloudflare tool use, the Cloudflare MCP server (mcp.cloudflare.com) asks the user to approve access in their browser via OAuth. No API token is needed if this works.
4. Fallback if OAuth can't complete from the session: ask the user for a Cloudflare API token through the secure credential form (host `api.cloudflare.com`) — never in chat. Token permissions: Zone DNS Edit + Zone Read (zone laqtine.com), Account Stream Edit, Account Email Routing Addresses Edit, Account Settings Read.
5. The optional `cf` CLI (beta): the user chose to skip it unless asked.

## Decisions so far

- **Name / domain:** Laqtine, **laqtine.com**, registered at **Cloudflare Registrar** (the code and README still say "Laqtin" — renaming the branding to "Laqtine" is planned).
- **Social handles:** @laqtine looked free on Telegram, YouTube and X; Telegram bot name **@LaqtineBot**. ("laqtin" is taken on Telegram and YouTube.)
- **Students:** initially in **Lebanon**. Implications: WhatsApp is the main channel (Telegram optional); default phone country code **+961**; mobile data is expensive and power/internet cuts are common, so keep video bitrate modest (480–720p) and lessons short; Arabic (RTL) / English / French UI is being considered; Stripe isn't available to Lebanese businesses.
- **Video:** **Cloudflare Stream** (it has a Beirut data center). Expected load ~1,000 students × 7 h/month ≈ 420,000 delivered minutes ≈ $420/month delivery + storage ($1 per 1,000 min delivered, $5 per 1,000 min stored).
- **Hosting:** not Bluehost shared hosting (no long-running Node.js). Use a host with a persistent disk and an always-on process (e.g. Render paid plan, Frankfurt region, or a VPS with Docker).
- **Uploads via Cloudflare proxy** are capped at 100 MB on the free plan — videos should upload directly to Stream, not through the app.

## Planned next build

1. Rename branding to Laqtine.
2. Cloudflare Stream integration: direct uploads from the teacher UI, adaptive playback tuned for mobile data, resume position, playback speed, subtitles, watch tracking.
3. Personal sign-in-free lesson links in WhatsApp/Telegram messages.
4. +961 as the default phone country.

## Project basics

- Node 22.13+, Express, EJS, SQLite (`node:sqlite`). `npm run dev`, `npm test`, `npm run seed` (demo accounts, password `password123`: admin@laqtin.test, teacher@laqtin.test, student@laqtin.test).
- Messaging providers live in `src/whatsapp/providers/` (mock, baileys, cloud, telegram); the journey logic is `src/whatsapp/engine.js`.
