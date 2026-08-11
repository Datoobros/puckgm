# puckgm

Dynasty fantasy hockey GM sim. Live at **[puckgm.vercel.app](https://puckgm.vercel.app)**.

Start here if you're new to this project: [`PROGRESS.md`](PROGRESS.md) — what's built, what's
next. Then [`DESIGN.md`](DESIGN.md) for game rules/data model and [`ROADMAP.md`](ROADMAP.md)
for the original build plan (written before most of this existed — PROGRESS.md is the
current source of truth on status, ROADMAP.md is the original intent).

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind) — app + API routes, one deploy target
- **Prisma 6** (`prisma/schema.prisma`) — mirrors the data model in `DESIGN.md` §4. Keep them in sync.
- **Postgres via [Neon](https://neon.tech)** — live. **Shared between local dev and production** — no branch separation yet, be careful with scripts (every test script in this repo cleans up by exact name match for exactly this reason)
- **Auth via [Clerk](https://clerk.com)** — live, **Development instance** (not Production — deferred until there's a custom domain, see PROGRESS.md)
- **Hosting via [Vercel](https://vercel.com)** — live, auto-deploys on push to `master`

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
cp .env.example .env.local   # fill in DATABASE_URL, Clerk keys, CRON_SECRET
npx prisma generate
npm run dev
```

Ask whoever owns this project for the Neon connection string and Clerk dev keys — see
PROGRESS.md for what's already provisioned.

## Database

```bash
npx prisma migrate dev --name <description>   # after changing prisma/schema.prisma
npx prisma studio                              # browse data locally
```

**This is the same database production uses.** Any test/seed script must clean up after
itself by exact name match — see `git log` for the established pattern (every throwaway
script this session named its test data distinctly and deleted only that).

## Testing changes

No test framework — verification has been: `npx tsc --noEmit`, `npm run build`, then a
real browser check (`preview_start` + `read_page`/`get_page_text`) against seeded data
before every commit. For pages behind `auth.protect()`, the established pattern is to
temporarily hardcode a fake userId (comment marked `// TEMP:`), verify, then revert before
committing — `grep -rn "TEMP:" src/` should always be clean before a commit.
