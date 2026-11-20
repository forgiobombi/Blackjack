# Blackjack Royale

Private, real-time multiplayer Blackjack for friends. The interface is available in English and Italian. Chips are free and have no monetary value.

Administrators create tables with configurable rules, playable by up to seven registered players. Join by link, code or targeted friend invitation. Each table has a shared dealer, shoe, server clock and chat.

## Development

Use Node.js 24 and npm. From the repository root:

    npm ci
    npm run typecheck
    npm test
    npm run build:worker
    npm run test:integration
    npx playwright install chromium
    npm run test:e2e
    npm run test:load

Integration and browser tests run the bundled Worker, D1 and SQLite Durable Objects locally. A dedicated Auth fixture exercises email-code and token exchange flows without a cloud account.

For development with a real local Supabase project:

1. Start Supabase Auth locally and keep email confirmation enabled. Copy **apps/worker/.dev.vars.example** to **apps/worker/.dev.vars**. Set your local URL, publishable key and a 32-byte hex key from **openssl rand -hex 32**.
2. Copy **.env.example** to **.env**. Apply the local D1 migration with **npm run db:local**.
3. Start **npm run dev:worker** and **npm run dev** in separate terminals. Open **http://localhost:5173/**.
4. Register, verify the account and open the lobby to create its local profile. Run **npm run admin:bootstrap -- YOUR_USER_UUID --local** for the first host.

## Deployment

GitHub Pages serves the static frontend. Cloudflare Workers, SQLite Durable Objects and D1 run the game and wallet. Supabase Auth sends registration and recovery codes through the configured SMTP provider.

- [Production setup and free-tier limits](docs/deployment.md)
- [Architecture, rules and operations](docs/architecture.md)
- [Bilingual Supabase email templates](docs/email-templates.md)

The Pages workflow runs from **main**. The separate Worker workflow uses the **production** environment and runs on demand. The frontend uses the base path supplied by GitHub Pages, including for a custom domain.

The dealer and lounge images are project artwork. DM Sans and Cormorant Garamond use the included SIL Open Font License notices. Sound effects and optional ambient music are synthesized locally with Web Audio.
