# Can the Pilot build and test without production secrets?

Research for [#8](https://github.com/jrey8343/fabrik/issues/8). Date: 2026-11-02.

**Question.** Can the Pilot (`jrey8343/penrith-physiotherapy-sports-centre`) build, lint, type-check and run its tests inside a Sandbox that holds no production secrets?

**Method.** Static reading of the Pilot repo only (nothing installed, built or run; no live service called). Env var **names** were taken from `.env.example`; `.env` / `.env.local` were not opened. The only network call was a read of the Pilot's recent GitHub Actions run list (`gh run list --workflow ci.yml`). Every claim below cites the Pilot file it comes from (paths are relative to the Pilot repo root).

## Answer

**Yes for build, format, lint and type-check. Partly for tests, and secrets are not the reason.**

- **Build needs no env vars at all.** CI already proves it: `.github/workflows/ci.yml` runs `npm ci && npm run build` on every pull request and non-`main` push with no `env:` and no secrets. The last seven runs (2026-09-23 to 2026-10-01) all passed.
- **`format:check`, `lint`, `typecheck` read no env vars**, but by CI's own account they **fail on the existing code**. That is a code-health blocker, not a secrets one (`ci.yml` comment: "lint / typecheck / format:check are not gated yet: all three fail on the existing code").
- **The Playwright suite cannot run at all**, with or without secrets. There is no `playwright.config.*`, no `test` script, `@axe-core/playwright` is imported but not installed, and the specs look like generated scaffolding that targets pages that don't exist.
- **`check:booking` cannot run without the production Nookal API key.** Nookal shows no test tenant: the only base URL is `/production/v2`. Without a key it **skips and exits 0**, so in a Sandbox it is a no-op, not a check. It belongs where it already lives: the Deploy workflow, after the Merge gate.

## Env var inventory

Only variables that some code actually reads are listed. `.env.example` also lists around 60 names that nothing reads (SMTP, Mailgun, SendGrid, JWT/CSRF, Cloudinary, Sentry, Twilio, CMS, social, most `FEATURE_*` flags, `TEST_MODE`, `MOCK_EXTERNAL_APIS`, `TEST_BASE_URL`…). The file itself marks most of them "unused legacy" or "aspirational". A grep for `import.meta.env` / `process.env` across `src/`, `scripts/`, `tests/` and `astro.config.mjs` finds no reads of them.

| Env var | Where read | Needed at | Test key or stub OK? |
|---|---|---|---|
| `npm_package_version` | `astro.config.mjs` (`vite.define`) | build (set by npm itself) | n/a, not a secret |
| `NOOKAL_API_KEY` | `src/lib/nookal.ts`, `src/pages/api/vestibular-intake.ts`, `src/pages/api/womens-pelvic-health-intake.ts`; `scripts/sync-nookal-prices.mjs`, `scripts/check-booking-catalogue.mjs` | runtime (SSR API routes, `/book/time`); deploy-time scripts | **No real test key**: Nookal has no sandbox in evidence. For runtime tests, unset + stub server via `NOOKAL_API_URL`. Both scripts skip (exit 0) when it's unset |
| `NOOKAL_API_URL` | same `src/` files + `check-booking-catalogue.mjs` (defaults to `https://api.nookal.com/production/v2`) | runtime | **Yes**: can point at a local stub. `sync-nookal-prices.mjs` hardcodes the URL and ignores it |
| `NOOKAL_VESTIBULAR_PRACTITIONER_ID` | both intake API routes (default `'3'`) | runtime | Yes, any value; not a secret |
| `STRIPE_SECRET_KEY` | `src/pages/api/booking/create.ts`, `src/pages/api/stripe-webhook.ts`; `scripts/setup-stripe-booking-fee.mjs` | runtime; one-off seed script | **Yes**: an `sk_test_…` key (or unset; the route refuses initial bookings without config) |
| `STRIPE_PRICE_BOOKING_FEE` | `create.ts` | runtime | Yes: a test-mode price ID. `.env.example` warns price IDs are mode-specific |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook.ts` | runtime | Yes: the local `stripe listen` secret (`.env.example`) |
| `STRIPE_RESTRICTED_KEY` | `scripts/setup-stripe-booking-fee.mjs` only | one-off manual script | Yes: test-mode restricted key; never needed for build/test |
| `PUBLIC_SITE_URL` / `SITE_URL` | `create.ts` (no fallback, by design); `SITE_URL` also `scripts/pre-deploy.js` | runtime | Yes: `http://localhost:…`; not a secret |
| `FEATURE_CUSTOM_BOOKING` | `src/pages/book/{index,time,details,confirm}.astro`, `create.ts` | runtime | Yes: leave unset (booking UI falls back to the Nookal-portal interstitial, and `create` returns 503) |
| `BOOKING_NOTIFY_EMAIL`, `BOOKING_REPLY_TO` | `src/lib/booking-confirmation.ts` (default to the clinic's reception address) | runtime | Yes: any address; not a secret |
| `SES_REGION`, `SES_FROM_EMAIL` | `src/lib/ses.ts` | runtime | Not secrets. SES **credentials** come from the AWS default chain (ECS task role in prod, per `.env.example`). See hazard 2 |
| `NODE_ENV` | `scripts/pre-deploy.js`, `scripts/validate-env.js`, `tests/performance.spec.ts` | test (one branch) | Yes |
| `DEBUG` | `scripts/pre-deploy.js` | manual script | Yes |
| `OPENAI_API_KEY` | `test-assistant-api.mjs` (root) only | manual script | Never needed: no `src/` file imports `openai` (the dependency is unused), and the `/api/assistant` route that script targets doesn't exist under `src/pages/api/` |
| `import.meta.env.DEV` | several `src/` files | build (Astro built-in) | n/a |

`scripts/validate-env.js` and `scripts/pre-deploy.js` are wired into nothing: no npm script, no workflow, not `deploy.sh`, not the `Dockerfile`.

## Sub-questions

### What does each command need?

| Command | Env vars needed | External services called | Runs in a secretless Sandbox? |
|---|---|---|---|
| `npm ci` | none | npm registry | Yes (needs registry network access) |
| `npm run build` (`astro build`) | none | none found | **Yes**, proven by `ci.yml` |
| `npm run check` (`format:check` + `lint` + `typecheck`) | none | none | Runs, but **fails today on existing code** (`ci.yml` comment) |
| Playwright specs in `tests/` | none in practice (`NODE_ENV` in one branch) | Would load GTM in the browser (`GTM-554CS3L` is hardcoded in `src/layouts/Base.astro`), polluting production analytics | **No**, for reasons that have nothing to do with secrets (below) |
| `npm run check:booking` | `NOOKAL_API_KEY` (production) | Nookal production (read-only list endpoints) | **No-op**: exits 0 with a warning when the key is unset |

Why the build is secret-free:

- `astro.config.mjs` reads only `npm_package_version`. Redirects come from the committed `scripts/blog-redirects.json`.
- Every module that reads a secret sets `export const prerender = false` or is only imported by such routes. `src/lib/nookal.ts` is imported by the `/api/booking/*` routes, `stripe-webhook.ts` and `/book/time.astro` (all `prerender = false`), and only as a type by `AvailabilityCalendar.astro`. Its `process.env` reads therefore run at request time, not at build.
- Prerendered pages read local content collections (`getCollection` in `src/pages/{services,practitioners,blog,…}/[slug].astro`). Prices come from the committed `scripts/nookal-prices.json`, which deploy refreshes from Nookal beforehand; CI and the Sandbox use the committed copy.
- Fonts come from `@fontsource-variable/*` (local), and `image.domains` / `remotePatterns` are empty, so there are no remote image fetches.
- `nookal.ts`'s header comment notes that `src/` deliberately uses `process.env`, not `import.meta.env` (which Astro inlines at build). So even a stray `.env` in the Sandbox would not be baked into `dist/`.

### Which external services get called during build or test?

| Service | Build | `check` | Playwright (as written) | Runtime |
|---|---|---|---|---|
| Stripe | no | no | no (booking flag off) | `create.ts`, `stripe-webhook.ts` |
| Nookal | no | no | no, unless a test hits the intake API routes | booking routes, `/book/time`, intake routes; deploy scripts |
| AWS SES | no | no | no, unless a test submits an intake form | `src/lib/ses.ts` |
| OpenAI | no | no | no | **never** (dependency unused in `src/`) |
| GA4 / GTM | no | no | **yes, client-side**: the tag in `Base.astro` loads in the test browser | client-side on every page |

### Which can run with test keys or stubs, and which can't?

- **Stripe: yes.** Test-mode secret key, test price ID, and the `stripe listen` webhook secret all exist by design (`.env.example`).
- **Nookal: no test key.** Every Nookal URL in the repo is `/production/v2`, and both deploy scripts guard the *production* catalogue. Runtime code can be stubbed, because `NOOKAL_API_URL` is configurable in `nookal.ts` and both intake routes. The one exception is `scripts/sync-nookal-prices.mjs`, which hardcodes the URL. `check:booking` validates the real production catalogue by definition, so no stub can stand in for it.
- **SES: stub or leave unconfigured.** It needs no keys in env, but see hazard 2.
- **OpenAI: not needed.**
- **GA4/GTM: no key involved.** The fix is to block `googletagmanager.com` in tests (or in Sandbox egress), not to supply a credential.

### What does the existing CI do on PRs?

- `ci.yml` runs on `pull_request` and on push to any branch except `main`. Its only job is `npm ci` then `npm run build` (Node 22, ~8 min per `docs/deployment-guide.md`). There are no secrets, no lint, no type-check and no tests.
- `deploy.yml` runs only on push to `main` (and `workflow_dispatch`), in the `production` GitHub environment. It assumes an AWS role via OIDC, loads the Nookal key from Secrets Manager, runs `sync-nookal-prices` then `check-booking-catalogue`, builds the `Dockerfile`, rolls out to ECS and smoke-tests the live homepage. The deployment guide says the AWS role trusts only that environment, and the environment accepts only `main`.
- So **a PR from any branch never sees a secret today.** The Pilot already lives under the "Sandboxes hold no production secrets" decision for CI.

### Blockers

1. **`check` fails on existing code** (`ci.yml` comment). Format, lint and type-check can't gate an agent PR until someone fixes the baseline or ratchets it, e.g. by gating only on changed files. Two contributing facts:
   - `typecheck` is `tsc --noEmit` with `tsconfig.json` including `.astro/types.d.ts`, which only exists after `astro sync`/`astro build`. This is a likely, unverified source of failures on a fresh clone; running build first, or `astro sync`, needs no secrets.
   - `eslint.config.js` ignores `**/*.astro`, `scripts/` and `tests/`, so lint covers only `.ts`/`.js` under `src/`.
2. **No runnable test suite.**
   - No `playwright.config.*`, so there is no `baseURL` or `webServer` and every `page.goto('/')` has nowhere to go.
   - No `test` npm script.
   - `tests/accessibility.spec.ts` imports `@axe-core/playwright`, which is in neither `package.json` nor `package-lock.json`.
   - `tests/seo.spec.ts` targets `/practitioners/sarah-mitchell`, which has no entry in `src/content/practitioners/`.
   - The specs were last touched in the initial "comprehensive site build" commit.
   - Nothing exercises booking, Stripe or Nookal logic.
3. **`check:booking` is a deploy-time production check, not a PR check.** In a Sandbox it silently passes, which is worse than not running it.

### Hazards for the Sandbox design (not blockers)

1. **Fail-open skips.** `check-booking-catalogue.mjs` and `sync-nookal-prices.mjs` exit 0 when the key is missing. A Sandbox or agent CI must not count that as "check passed".
2. **Ambient AWS credentials.** `src/lib/ses.ts` builds an `SESClient` from the default credential chain. `scripts/deploy.sh` uses an AWS profile named `penrith`, so the Operator's laptop holds production AWS credentials. If a Sandbox inherits `~/.aws` or `AWS_*` env, any runtime test that submits an intake form or booking could send real email from the clinic's verified identity. The Sandbox must not mount host AWS config.
3. **Production-default URLs.** If a Nookal key were ever present, the `/production/v2` default means runtime tests would hit the live practice. The intake routes and `/api/booking/check-patient` / `availability` are not gated by `FEATURE_CUSTOM_BOOKING`. A Sandbox should never hold a Nookal key, and should set `NOOKAL_API_URL` to a stub if runtime tests are ever added.
4. **`.env*` in a working copy.** `.gitignore` and `.dockerignore` both exclude `.env*`, so a Sandbox that clones from GitHub gets none. A Sandbox that copies the Operator's working directory would carry `.env` and `.env.local`. Sandboxes must clone, not copy.
5. **Analytics pollution.** Any browser test loads the production GTM container.

## Minimal check set to gate an agent PR

What can run today in a secretless Sandbox and in PR CI, in order:

1. `npm ci`
2. `npm run build`: **the only check that works today**, already in `ci.yml`. Make it a required status check under branch protection.
3. `npm run format:check`, `npm run lint` and `npm run typecheck`, **once the baseline passes**. Until then, gate on "no new failures in changed files" or don't gate.

Explicitly **not** in the agent PR gate:

- `check:booking`: it needs the production Nookal key and stays in `deploy.yml` after the Merge gate.
- The current Playwright specs: unrunnable.

Booking and payment logic has no automated coverage at all. To get any, the Pilot needs a real test seam: a `playwright.config` with an Astro `webServer`, GTM blocked, `FEATURE_CUSTOM_BOOKING=true`, Stripe test keys, `NOOKAL_API_URL` pointed at a local stub, and no AWS credentials. That would be the first Pilot-side ticket for "Pilot adoption specifics".

## Sources (Pilot repo)

- `package.json`: scripts, dependencies (no `@axe-core/playwright`; `openai` present but unused)
- `.env.example`: variable names and comments only
- `astro.config.mjs`: `output: 'server'`, Node adapter, only `npm_package_version` read
- `src/lib/nookal.ts`, `src/lib/ses.ts`, `src/lib/booking-confirmation.ts`, `src/pages/api/**`, `src/pages/book/*.astro`, `src/layouts/Base.astro`
- `scripts/check-booking-catalogue.mjs`, `scripts/sync-nookal-prices.mjs`, `scripts/setup-stripe-booking-fee.mjs`, `scripts/deploy.sh`, `scripts/validate-env.js`, `scripts/pre-deploy.js`; root `test-assistant-api.mjs`
- `tests/*.spec.ts`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, `.dockerignore`, `Dockerfile`
- `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- `docs/deployment-guide.md`
- GitHub Actions run history: `gh run list --workflow ci.yml`, last 7 runs, all `success`
