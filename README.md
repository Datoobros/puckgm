# puckgm

Dynasty fantasy hockey GM sim. Design and roadmap live one level up: [`../DESIGN.md`](../DESIGN.md),
[`../ROADMAP.md`](../ROADMAP.md).

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind) — app + API routes, one deploy target
- **Prisma 6** (`prisma/schema.prisma`) — mirrors the data model in `DESIGN.md` §4. Keep them in sync.
- **Postgres via [Neon](https://neon.tech)** — not provisioned yet
- **Auth via [Clerk](https://clerk.com)** — not wired up yet
- **Hosting via [Vercel](https://vercel.com)** — not deployed yet

> Pinned to **Prisma 6**, not 7 — Prisma 7 changed how the datasource URL is configured
> (`prisma.config.ts` + driver adapters instead of `url = env(...)` in the schema file),
> and most current guides/examples still target the v6 pattern. Revisit the upgrade later
> once the ecosystem catches up: https://pris.ly/d/major-version-upgrade

> **Before writing Next.js route/page code**, read `AGENTS.md` in this directory — this
> Next.js version postdates training data and has real breaking changes. Check
> `node_modules/next/dist/docs/` first.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in once Neon + Clerk accounts exist
npx prisma generate
npm run dev
```

## Accounts still needed (you create these — sign-up needs your email)

1. **[neon.tech](https://neon.tech)** — free Postgres. Copy the connection string into
   `DATABASE_URL` in `.env.local`.
2. **[clerk.com](https://clerk.com)** — free auth. Copy the publishable + secret keys into
   `.env.local`. Set sign-up to invite-only so the league stays friends-only.
3. **[vercel.com](https://vercel.com)** — free hosting. Connect the GitHub repo once one
   exists; add the same env vars in the Vercel project settings. Deploying gives a public
   HTTPS URL friends can open from any browser or phone — no installs, no local network.

## Database

```bash
npx prisma migrate dev --name init   # once DATABASE_URL is set
npx prisma studio                    # browse data locally
```
