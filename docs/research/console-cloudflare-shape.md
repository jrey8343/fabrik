# What Cloudflare gives the Console

Research for Decision #510 on the Wayfinder Map #507 (the Console). It feeds the Map's open questions on how the cache is fed and rebuilt, on guarding the deployment, and on standing up the Console's repo. It recommends a shape. The framework and final stack are decided by a later ticket.

**Question.** For a phone-first PWA used by one Operator, backed by a Worker that receives GitHub webhooks, keeps a cache that can be rebuilt from GitHub, pushes live updates to an open screen and sends web push: which Cloudflare pieces fit? Cover one Worker serving the app and the API; D1, KV and Durable Objects; Queues and Workflows; web push from a Worker; letting exactly one GitHub identity in; secrets; per-branch previews the Kit can link; local development and testing in a Sandbox; and the plan limits a factory of this size would meet.

**Date.** 2026-11-10.

**Method.** Desk research against primary sources only: Cloudflare's developer docs fetched on the day as Markdown (each page's "last updated" date is given where it matters), the `cloudflare/workers-sdk` source for one naming question, GitHub's webhook docs, and RFCs 8030, 8291 and 8292 for Web Push. No Cloudflare resource was created and nothing was run against an account, so nothing here is measured. Claims I could not confirm from a primary source are collected under "Not verified".

## Answer in brief

1. **One Worker, one SQLite-backed Durable Object, nothing else.** The Worker serves the built app as static assets and the API from the same origin. A single Durable Object holds the cache in its own SQLite database, accepts the open screen's WebSocket through the Hibernation API, and uses its alarm to work through stored webhook deliveries, rebuild from GitHub and send web push. This is the only shape of the ones compared that behaves the same in production, in a per-branch Preview and in the Sandbox.
2. **It beat D1, KV, Queues, Workflows and Cron Triggers for one reason each.** KV is eventually consistent and allows 1,000 writes a day on the free plan. D1 works but is a second store that Previews share unless each is bound to its own database, and the app needs a Durable Object for the socket anyway. Queue consumers and Cron Triggers do not run in a Preview. A Workflow binding in a Preview points at an existing Workflow, not the branch's code. Workflows stays the fallback if the rebuild outgrows an alarm.
3. **Cloudflare Access can be the outer wall, but it does not answer "exactly one GitHub identity" by itself, and the easy way to turn it on breaks the live updates.** Access matches on email and login method, not on a GitHub user id. Protecting the Worker from its Access tab ("Worker-level Access") refuses WebSocket upgrades with a 403. The hostname-based kind of Access application is the one to use, with a Bypass on the webhook path. The Worker should check identity itself either way.
4. **Web push needs no service from Cloudflare.** Sending is a signed `fetch()` to the push service. The Workers runtime has every Web Crypto primitive the RFCs call for.
5. **Per-branch previews now exist as a first-class feature, "Worker Previews", and fit the Kit's `preview.url` template.** Each Preview gets its own URL and its own Durable Object storage. Workers Builds can create them from Cloudflare's side, so no Cloudflare credential goes near an Implementer's Sandbox.
6. **Local development and tests need no Cloudflare account.** `wrangler dev` or `vite dev` simulate every binding locally, and the Vitest integration runs tests inside the Workers runtime. One catch: WebSocket tests against a Durable Object need storage isolation turned off.
7. **Plan for Workers Paid at $5 a month, and expect to pay exactly that.** The free plan would carry the steady state, but its 50 subrequests and 10 ms of CPU per invocation make a rebuild from GitHub awkward. Nothing at this size comes near the paid plan's included usage.
8. **Hard to reverse: the app's hostname and the VAPID key.** An installed PWA and its push subscriptions hang off both. Almost everything else is cheap to change because the cache is rebuildable. Two things the Worker stores are not rebuildable from GitHub: push subscriptions and secrets.

## The recommended shape

```
GitHub ──webhook──▶ Worker ──RPC──▶ Durable Object "console"
                      │               ├─ SQLite: deliveries, cache tables, push subscriptions
Operator's phone ─────┤               ├─ WebSocket (Hibernation API) to the open screen
  static assets (free)│               ├─ alarm: process deliveries, rebuild, reconcile
  /api/* , /ws        │               └─ fetch(): GitHub API, push services
```

- **Static app and API in one Worker.** `assets.directory` points at the built app, `not_found_handling: "single-page-application"` serves `index.html` for unknown paths, and `run_worker_first: ["/api/*", "/webhooks/*", "/ws"]` sends only those paths to code.
- **Webhook path.** The Worker checks `X-Hub-Signature-256`, hands the raw delivery to the Durable Object, which inserts it keyed by `X-GitHub-Delivery` and sets an alarm, and the Worker answers 2xx. Processing happens in the alarm. That keeps the response well inside GitHub's 10 seconds and makes a redelivery a no-op.
- **Cache.** Tables in the Durable Object's SQLite database, queried synchronously. Deleting the object's storage and running the rebuild restores it.
- **Live updates.** The app opens a WebSocket to `/ws`. The Durable Object accepts it with `ctx.acceptWebSocket()` and sends a small "this changed" message after each processed delivery. The app must reconnect by itself: a deploy or a runtime update can drop the socket.
- **Web push.** After processing, the Durable Object signs a VAPID token and posts an encrypted payload to each stored subscription.
- **Access.** A hostname-based Access application on the Console's custom domain, a second one on the webhook path with a Bypass policy, and identity checked again in the Worker.
- **Previews.** Workers Builds runs `npx wrangler preview` on every non-production branch. Previews run on seeded fake data and hold no real secret, so they can stay public.

A configuration sketch, not tested:

```jsonc
{
  "name": "console",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-09",
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/webhooks/*", "/ws"]
  },
  "durable_objects": { "bindings": [{ "name": "CONSOLE", "class_name": "ConsoleState" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ConsoleState"] }],
  "secrets": { "required": ["GITHUB_WEBHOOK_SECRET", "VAPID_PRIVATE_KEY"] },
  "previews": {
    "vars": { "FAKE_DATA": "true" },
    "durable_objects": { "bindings": [{ "name": "CONSOLE", "class_name": "ConsoleState" }] }
  }
}
```

## 1. Serving the app and the API from one Worker

- A Worker can carry static assets. A request that matches a file is served without running Worker code, and "requests to static assets are free and unlimited". Only requests that invoke the Worker are billed. ([Static Assets](https://developers.cloudflare.com/workers/static-assets/), [billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/))
- `not_found_handling: "single-page-application"` returns `index.html` with a 200 for paths that match no file. With a compatibility date of 2025-04-01 or later, a browser navigation (`Sec-Fetch-Mode: navigate`) never invokes the Worker, so navigating to `/api/x` in the address bar returns the app's HTML. ([SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/))
- `run_worker_first` takes `true` or a list of patterns such as `["/api/*", "!/api/docs/*"]`. The docs recommend the list form with SPA mode. On the free plan, paths in the list answer 429 once the daily request limit is spent instead of falling back to assets. ([Worker script routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), [billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/))
- Limits: 20,000 asset files per version on Free and 100,000 on Paid, 25 MiB per file. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))
- The Cloudflare Vite plugin runs the Worker in a local `workerd` during `vite dev` and builds the client assets for deployment. Its docs name TanStack Start and React Router v8 as officially supported and note a v2 in beta. ([Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)) Which framework to use is the later ticket's call.
- `workers.dev` hostnames pass through Browser Integrity Check, which cannot be turned off there. "Automated clients that send some default library `User-Agent` headers" get error 1010 before the Worker runs. The docs recommend a custom domain for production and call `workers.dev` "intended for personal or hobby projects that aren't business-critical". ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)) GitHub's deliveries carry a `GitHub-Hookshot/` user agent ([webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)); whether Browser Integrity Check lets that through is not stated.
- A Custom Domain needs an active Cloudflare zone. ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/))

## 2. The cache and live updates: D1, KV or a Durable Object

**Durable Object with SQLite storage (recommended).**

- Available on the free plan, SQLite backend only. SQLite is the only backend a new class can get. ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/))
- 10 GB per object, 8 MB per row, point-in-time recovery to any moment in the last 30 days. ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/))
- One object is single-threaded with a soft limit of 1,000 requests a second. Deliveries are therefore processed one at a time, in the order they were stored, with no locking to write. ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/))
- **WebSocket Hibernation.** `ctx.acceptWebSocket()` lets the object leave memory while the socket stays open, and "billable duration charges do not accrue during hibernation". Hibernation happens after 10 seconds with no events. A timer set with `setTimeout` or `setInterval` prevents it. Per-socket state up to 16,384 bytes survives through `serializeAttachment()`. `setWebSocketAutoResponse()` answers pings without waking the object. ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/))
- **Sockets drop on deploy.** By default an active object keeps its old code for up to 300 seconds after a deploy, or until it hibernates, and a forced update disconnects attached WebSockets. Runtime updates give connections up to 20 minutes. The app needs reconnect-and-refetch from the first version. ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/), [Workers limits: runtime updates](https://developers.cloudflare.com/workers/platform/limits/))
- **Alarms.** One alarm per object, "guaranteed at-least-once execution", retried with exponential backoff from 2 seconds for up to 6 retries, 15 minutes of wall time per run. The docs advise catching errors in the handler and setting a new alarm, because six failed retries otherwise leave no alarm set. Many scheduled jobs are run from one alarm by keeping the schedule in storage. ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/))

**D1 (not chosen).** A real SQL database with 500 MB per database on Free and 10 GB on Paid, Time Travel for 7 or 30 days, and migrations through Wrangler. ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)) It lost on three counts. The live socket needs a Durable Object regardless, so D1 would be a second store. Row pricing is identical to Durable Object SQLite, so it saves nothing. And in a Preview, "two Previews sharing the same `database_id` share rows": isolation takes a database per branch and a second Wrangler config file for migrations, where a Durable Object gets fresh storage per Preview automatically. ([Previews: resources](https://developers.cloudflare.com/workers/previews/resources/)) D1's one advantage is that `wrangler d1 execute` can query it from outside; a Durable Object's database is reachable only through the object's own code.

**KV (not chosen).** "Changes may take up to 60 seconds or more to be visible in other global network locations", one write a second per key, 1,000 writes a day on the free plan, and no queries. ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/)) A queue of moves owed has to be right the moment a webhook lands.

## 3. Webhook handling and rebuilds: Queues, Workflows or the alarm

What GitHub requires: a 2xx "within 10 seconds", or the delivery is recorded as failed. "GitHub does not automatically redeliver failed deliveries." A redelivery carries the same `X-GitHub-Delivery` value as the original. Payloads are capped at 25 MB. ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads))

So the receiver must store fast, process later, and be idempotent. Three ways to "process later":

| | Durable Object alarm | Queues | Workflows |
|---|---|---|---|
| Delivery | At least once, 6 retries then the handler must re-arm | At least once, no ordering guarantee, up to 100 retries, dead-letter queue | Per-step retries, state persisted between steps |
| Limits | 15 min wall time per alarm run | 128 KB per message, 15 min per consumer run | Steps unlimited in wall time; 1 MiB per step result |
| Free plan | 100,000 requests a day | 10,000 operations a day (about 3,300 messages), 24 hour retention | 3,000 steps a day |
| In a Preview | Own namespace and storage per Preview | Producer only: "Previews cannot consume messages from Queues today" | Binding runs "that Workflow's deployed code", not the branch's |
| Local | Simulated | Simulated | Simulated |

Sources: [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Previews: limitations](https://developers.cloudflare.com/workers/previews/resources/#limitations), [bindings per mode](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

The Preview row decides it. The Kit's UI evidence and prototype rounds link a Preview, and a Preview whose webhook pipeline is switched off shows the Operator something production doesn't do. Cron Triggers have the same gap: "Cron Triggers target production" and never call a Preview's `scheduled()` handler. The alarm covers the periodic reconcile sweep too.

The same Durable Object that owns the cache also orders the work, so a Queue would add a second at-least-once hop with no ordering in front of something that already serialises. A rebuild across a handful of Product repos is a loop of paginated GitHub reads, which fits an alarm that does a slice and re-arms itself. If a rebuild ever needs hours of durable state or sleeps, Workflows is the upgrade: step and storage billing on Paid was announced to start no earlier than 10 August 2026, with 500,000 steps a month included. ([Workflows billing changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/))

## 4. Sending web push from a Worker

There is no Cloudflare product to adopt here. The application server's whole job is one HTTPS request per subscription.

- **The request** (RFC 8030): `POST` to the subscription's endpoint. A `TTL` header is required. `Urgency` is optional (`very-low`, `low`, `normal`, `high`). A `Topic` of up to 32 URL-safe characters makes a message replace "any outstanding push message with an identical topic", which suits a queue of moves owed: one topic per item means a phone that was offline gets the latest state once. Success is 201. A 404 means the subscription has expired and should be deleted. A push service may answer 429. It must accept bodies up to 4,096 bytes. ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030))
- **Encryption** (RFC 8291): ECDH on P-256 against the subscription's public key, HKDF with SHA-256 salted with the subscription's 16-byte auth secret, then one `aes128gcm` record. That leaves at most 3,993 bytes of plaintext. No other content coding is allowed. ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291))
- **VAPID** (RFC 8292): an `Authorization: vapid t=<JWT>, k=<public key>` header. The JWT is signed ES256 (ECDSA on P-256), its `aud` is the push service's origin, its `exp` "MUST NOT be more than 24 hours" ahead, and `sub` should be a `mailto:` or `https:` contact. A bad token gets a 403. A subscription created with an application server key is restricted to that key. ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292))
- **In the runtime:** Web Crypto in Workers supports ECDSA sign, ECDH and HKDF `deriveBits`, AES-GCM encrypt and HMAC verify (for the webhook signature). `node:crypto` is also "fully supported" bar a short list of exceptions, and Node compatibility is on by default from compatibility date 2026-08-04. ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/))
- Each push is one subrequest. The free plan allows 50 per invocation and Paid 10,000. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))
- The service worker shows the notification from the decrypted payload, so receiving a push never touches the Console's origin or Access.

Whether iOS and Android deliver these to an installed PWA reliably is the web-push ticket's question, not this one's.

## 5. Letting exactly one GitHub identity in

**What Access offers.** Every request is checked before the Worker runs. The Workers docs describe three scopes: all Workers on the account, one Worker, or a specific hostname or path. ([Workers: Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), last updated 2 Nov 2026)

Three findings shape the choice:

1. **Worker-level Access breaks WebSockets.** "Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error." The docs send Workers that use WebSockets or Durable Objects to a hostname-based Access application instead.
2. **`ctx.access` is not available to this Worker.** The new `ctx.access` API hands a Worker the signed-in identity, but "Workers with Static Assets execute behind an internal router Worker" and "the router does not pass `ctx.access` to the user Worker". The Worker must validate the `Cf-Access-Jwt-Assertion` header itself against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, matching the key by `kid` (keys rotate every 6 weeks) and checking the application's `aud` tag. ([Validating JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/))
3. **Access cannot pin a GitHub user id.** With GitHub as the identity provider (an OAuth app, no organisation needed), the policy selectors are Emails, Emails ending in, Login Methods and Identity provider group (organisation or team). An "Emails is X, Login Methods is GitHub" policy admits whoever controls a GitHub account whose email is X. ([GitHub IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/), [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/))

Other facts that bear on a PWA:

- Sessions last at most one month, application or global. After that the Operator signs in again. ([Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/))
- GitHub cannot sign in to Access, so the webhook path needs its own Access application with a Bypass policy for Everyone. A more specific path wins over the hostname's policy. Bypassed requests are not logged by Access. The webhook secret is then that path's only guard. ([Access policies: Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#bypass), [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/))
- A seat is consumed per user who authenticates, so one Operator is one seat. A "Zero Trust Free plan" exists and asks for payment details at setup. ([Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/), [setup](https://developers.cloudflare.com/cloudflare-one/setup/))

**Recommendation.** Use a hostname-based Access application as the outer wall, so a leaked URL reaches a sign-in page and not the Worker. Decide the inner check with the credential ticket: every action the Console takes is a GitHub write made as the Operator, so the Worker will hold or obtain the Operator's GitHub credential anyway, and a GitHub sign-in handled by the Worker can compare the numeric user id with the Kit config's `operator`. That is the only check here that pins a GitHub identity exactly. Access alone is acceptable if "the email on the Operator's GitHub account" is judged close enough.

**The alternative, Worker-only sign-in.** It drops the Access dependency, the monthly re-login and the Bypass application. It costs writing session handling, and it leaves the static shell public (harmless: it holds no data) and every unauthenticated request reaching Worker code.

## 6. Secrets

- A secret is an encrypted per-Worker binding set with `wrangler secret put`, or uploaded with the code through `wrangler deploy --secrets-file`. Limits: 64 variables per Worker on Free, 128 on Paid, 5 KB each. ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/))
- `secrets.required` in the Wrangler config makes `wrangler deploy` fail when a named secret is missing, and limits what local development loads from `.dev.vars` or `.env`. Those files stay out of git. ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [local environment variables](https://developers.cloudflare.com/workers/local-development/environment-variables/))
- **Previews do not inherit production secrets.** They get what the "Previews Base configuration" holds (`wrangler preview base-config secret put`) or what is set on one Preview. ([Previews: configuration](https://developers.cloudflare.com/workers/previews/configuration/)) This is the property the Console wants: a Preview can be given fake values and never see the credential that reads private repos.
- Secrets Store, the account-level store, is in open beta. One Worker has no use for it. ([Secrets Store](https://developers.cloudflare.com/secrets-store/))
- The Console's secrets, as far as this ticket can see: the GitHub webhook secret, the VAPID private key, whatever GitHub credential the credential ticket settles on, and the Access `aud` tag and team domain (not secret, but configuration).

## 7. Preview deployments per branch

**Worker Previews** is the current feature (its pages were last updated between September and November 2026) and needs Wrangler 4.135.0 or later. `npx wrangler preview` "creates or updates a Preview for your current branch under the same Worker". ([Previews](https://developers.cloudflare.com/workers/previews/))

- **URLs.** `<preview-name>-<worker-name>.<subdomain>.workers.dev` always serves the branch's latest deployment. `<deployment-id>-<worker-name>.<subdomain>.workers.dev` pins one deployment. A custom domain gives `<preview-name>.app.example.com`.
- **Isolation.** "Cloudflare automatically provisions a new Durable Object namespace" per Preview, with state that "persists across deployments within the same Preview and is deleted when the Preview is deleted". KV, D1 and R2 are shared unless bound separately. If code reads the binding from `env`, it must be declared again under `previews`, or the Worker can return a 1101 error. ([Previews: resources](https://developers.cloudflare.com/workers/previews/resources/))
- **What does not run in a Preview:** Queue consumers, Cron Triggers, production routes, and per-branch Workflows.
- **Limits.** 100 Previews per Worker on Free, 500 on Paid, 100 deployments each. At the limit "the Preview that was deployed to least recently is deleted".
- **Public by default.** `workers.dev` Preview URLs carry `X-Robots-Tag: noindex`. Access can protect them.
- **The older ways are discouraged for this.** "Do not use Version URLs for branch or pull request testing": a Version URL, including one made with `--preview-alias`, runs against production resources. Wrangler environments are separate, persistent Workers. ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/))

**Who creates the Preview.** Two documented routes:

- **Workers Builds.** Cloudflare's GitHub integration builds every push to a non-production branch and runs the Preview command, `npx wrangler preview` by default, then comments the URL on the pull request. Free: 3,000 build minutes a month, one concurrent build, 20 minute timeout. Paid: 6,000 minutes then $0.005 a minute, six concurrent. ([Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/), [limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/))
- **A GitHub Actions workflow** holding `CLOUDFLARE_API_TOKEN`, running `npx wrangler preview --name "pr-<number>"` and deleting the Preview when the pull request closes. ([Previews: examples](https://developers.cloudflare.com/workers/previews/examples/))

Workers Builds fits the Kit better. The Implementer's Sandbox holds no production secret, and the Kit "never calls a hosting provider's API and needs no new secret". With Workers Builds the deploy credential never enters GitHub at all.

**The Kit's template.** `preview.url` may use `{pr}`, `{branch_slug}` and `{sha}`.

- With Workers Builds the Preview is named for the branch, so the template is `https://{branch_slug}-<worker>.<subdomain>.workers.dev`. Wrangler takes the name from `WORKERS_CI_BRANCH`, then `GITHUB_HEAD_REF`, then git, and the API returns a separate slug for the URL (`packages/deploy-helpers/src/preview/shared.ts` and `packages/wrangler/src/preview/preview.ts` in [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk)). The slug rule for a branch like `fabrik/ticket-12` is not documented. Setting the Preview command to pass `--name` with the branch already slugged the Kit's way removes the guess.
- With a GitHub Actions workflow, `--name "pr-<number>"` gives `https://pr-{pr}-<worker>.<subdomain>.workers.dev`. A Prototype round has no `{pr}`, so the Kit would link no preview for it.
- `{sha}` has no use: a deployment URL carries Cloudflare's deployment id, not the commit.

**Three things to check against the Kit before the Console's Spec relies on a preview link:**

1. The push job polls with Node's `fetch` and its default user agent. `workers.dev`, Preview URLs included, sits behind Browser Integrity Check. If that user agent is refused, the poll never sees a 2xx. A custom domain for Previews avoids the check.
2. The poll follows redirects and takes any 2xx as "the preview answered". A Preview behind Access redirects to a sign-in page that answers 200, so the Kit would link it whether or not the deployment exists yet. Previews on fake data with no real secret can stay public, which keeps the poll honest.
3. The poll waits 4 minutes at most. A Workers Builds build has to install, build and deploy inside that window after the push.

## 8. Local development and testing in a Sandbox

- **Local by default.** `wrangler dev` and `vite dev` run the Worker in a local `workerd` through Miniflare, and "all resources your Worker is bound to in your Wrangler configuration are simulated locally". Durable Objects, D1, KV, Queues and Workflows all have local simulations. ([Local development](https://developers.cloudflare.com/workers/local-development/), [bindings per mode](https://developers.cloudflare.com/workers/local-development/bindings-per-env/))
- **Unit tests.** The Workers Vitest integration, now the `@cloudflare/vitest-plugin` package (the successor to `@cloudflare/vitest-pool-workers`), "runs tests fully-locally using Miniflare" inside the Workers runtime with per-test-file storage. `cloudflare:test` gives `runInDurableObject()`, `runDurableObjectAlarm()` and `evictDurableObject()`, so alarm processing and wake-from-hibernation can be tested directly. Outbound requests to GitHub and push services are mocked with `@msw/cloudflare`. ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/), [migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/))
- **A catch for this app.** "Using WebSockets with Durable Objects is not supported with per-file storage isolation. To work around this, run your tests with shared storage using `--max-workers=1 --no-isolate`." ([known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)) Keep the socket tests in their own Vitest project so the rest keep isolation.
- **Integration tests.** `createTestHarness()` from `wrangler` (page last updated July 2026) runs the production build output, works with any Node test runner, and has guides for Playwright and MSW. That is the piece UI evidence can serve from: the built Console with seeded storage and mocked GitHub. ([Testing](https://developers.cloudflare.com/workers/testing/), [test harness](https://developers.cloudflare.com/workers/testing/test-harness/))
- **Access in local development.** The `access.dev` block in the Wrangler config simulates an identity for `ctx.access`. It does not help a Worker with static assets, for the reason in section 5. Tests should mint their own JWT against a mocked certs endpoint. ([Workers: Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/))
- **Real webhooks and a real phone** are HITL work: `wrangler dev` or the Vite plugin can expose the local server through a Cloudflare Tunnel "to test a webhook, or access your app from another device". ([Local dev tunnels](https://developers.cloudflare.com/workers/local-development/local-dev-tunnels/))
- Cloudflare's own warning: "Miniflare is not a hardened sandbox". The Kit's Sandbox is the boundary, not Miniflare.

## 9. Limits and cost at this size

**The size, as an assumption.** "Hundreds of runs a fortnight" is taken as up to 50 runs a day. Which events the Console subscribes to is another ticket's question, so take a generous 100 deliveries per run: about 5,000 deliveries a day, 150,000 a month. Every figure below is from the pricing and limits pages on 2026-11-10, and the arithmetic is mine.

| What | Workers Free | Workers Paid ($5 a month) | This workload |
|---|---|---|---|
| Worker requests | 100,000 a day | 10 million a month | About 5,000 a day plus the Operator's own |
| CPU per invocation | 10 ms | 30 s default, up to 5 min | Signature check, JSON parse, a few writes |
| Subrequests per invocation | 50 | 10,000 | A rebuild is hundreds of GitHub reads |
| Durable Object requests | 100,000 a day | 1 million a month | About 150,000 a month |
| Durable Object duration | 13,000 GB-s a day | 400,000 GB-s a month | See below |
| SQLite rows written | 100,000 a day | 50 million a month | A few per delivery; a rebuild writes thousands |
| SQLite rows read | 5 million a day | 25 billion a month | Needs indexes, nothing more |
| SQLite storage | 5 GB | 5 GB, then $0.20 per GB-month | Megabytes |
| Static asset requests | Free | Free | |
| Workers Logs | 200,000 events a day, 3 days | 20 million a month, 7 days | Pricing moves to Observability pricing on 1 Dec 2026 |
| Previews per Worker | 100 | 500 | One per open branch |
| Workers Builds | 3,000 min a month, 1 at a time | 6,000 min a month, 6 at a time | One build per push to the Console's repo |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (updated 2 Oct 2026), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (updated 29 Oct 2026), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

- **Duration cannot be exceeded by one object.** A Durable Object is billed as 128 MB whatever it uses. 13,000 GB-s ÷ 0.128 GB is about 101,500 seconds, more than the 86,400 in a day, and 400,000 GB-s ÷ 0.128 GB is about 36 days. A single object that never hibernated would still sit inside both allowances. Hibernation is good practice here, not a cost control.
- **What the free plan would break.** The rebuild: 50 subrequests per invocation means slicing it into many small alarm runs, and 10 ms of CPU is thin for parsing GitHub's larger payloads and encrypting pushes in the same invocation. On Free, going over a daily limit makes "further operations of that type fail with an error", which for a webhook receiver means lost deliveries that GitHub will not resend. The free plan is fine for prototypes.
- **What the alternatives would have hit on Free:** KV's 1,000 writes a day and Queues' 10,000 operations a day (three per message) are both below 5,000 deliveries a day. Workflows' 3,000 steps a day is too.
- **Expected bill:** $5 a month for Workers Paid, $0 for Access with one seat, $0 for Workers Builds inside 6,000 minutes. A custom domain is the only other cost.

## 10. Hard to reverse, and cheap to reverse

**Hard to reverse.**

1. **The Console's hostname.** The installed PWA, its service worker and its push subscriptions belong to the origin, and the Access application and its `aud` tag belong to the hostname. Moving from `workers.dev` to a custom domain later means the Operator reinstalls and resubscribes on every device. Pick the custom domain before the first install.
2. **The VAPID key pair.** A subscription is restricted to the application server key it was created with (RFC 8292, section 4). Losing or rotating the key means every device subscribes again. With one Operator that is a nuisance, not a migration, but the private key is a secret that cannot be re-derived.
3. **Durable Object class lifecycle.** A class's storage backend "is immutable once a namespace exists". Deleting a class "removes its namespace and all of its stored data permanently". There are now two ways to declare classes, the `exports` field and the legacy `migrations` array, and "once a Worker has been deployed with `exports`, subsequent deploys cannot return to the legacy `migrations` array". The Previews docs' examples still use `migrations`. ([class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/))

**Cheap to reverse, because the cache is rebuildable.** The table layout, moving the cache to D1, adding a Queue or a Workflow later, splitting into more objects, Access on or off, Workers Builds or GitHub Actions for Previews, and Free or Paid (a downgrade only needs no key-value-backed Durable Objects, which a new account cannot create anyway).

**Not rebuildable from GitHub, so not covered by "delete and rebuild".** Push subscriptions live only in the Worker's storage. Have the app send its current subscription on every launch as an upsert, and a wiped cache heals itself the next time the Operator opens the Console. Secrets are the other exception.

## Not verified

- **How a branch name becomes a Preview's URL slug.** The API assigns it and no doc states the rule or the length limit. Version URL aliases document a 63-character DNS label limit for alias plus Worker name; the same limit presumably binds Previews.
- **Whether Browser Integrity Check on `workers.dev` refuses Node's default `fetch` user agent or GitHub's `GitHub-Hookshot/` one.** The docs give Python's `urllib` as the example and no list.
- **Whether the WebSocket limitation also applies to account-level Access** (`all_workers`, `all_preview_workers`). It is stated for Worker-level policies.
- **Whether a hostname-based Access application can take a wildcard `workers.dev` hostname** to cover every Preview of one Worker. The docs say a hostname-based application can protect a `workers.dev` hostname and that partial wildcards exist, not that the two combine.
- **How an installed PWA behaves when its Access session expires:** what an API `fetch` from the app receives, and whether the web app manifest and service worker script load cleanly behind Access. The docs say only to send requests with `credentials: 'same-origin'`.
- **The Zero Trust Free plan's seat limit.** Cloudflare's plan pages did not state it when fetched. One Operator needs one seat.
- **Whether the free plan's 10 ms CPU limit applies inside a Durable Object.** The Workers limits page gives 10 ms for Free; the Durable Objects limits page gives 30 seconds without naming a plan.
- **Whether Previews work with the `exports` way of declaring Durable Object classes.** Only `migrations` appears in the Previews examples.
- **How long a Workers Builds build of the Console takes,** against the Kit's 4-minute poll.
- **Named curves in Workers' Web Crypto.** The page lists ECDSA and ECDH without listing curves. P-256 is the baseline curve of the Web Crypto standard.
- **Which status a real push service gives for a dead subscription.** RFC 8030 says 404. Treating 410 the same way is common practice, not something the RFC says.
- **That a push subscription is bound to the origin.** Stated from the Push API's model (a subscription belongs to a service worker registration); the W3C spec was not re-read for this note.
- **Other things seen and not evaluated:** the Agents SDK (a layer over Durable Objects with WebSocket state sync), a `cf` command line in beta beside Wrangler, the Vite plugin's v2 beta, and `wrangler deploy --temporary` (a deploy to a temporary account with no credentials, claimable within 60 minutes).
