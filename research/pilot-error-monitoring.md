# Error monitoring for the Pilot that can feed GitHub issues

Research for Decision #69 on Map #62 (Wayfinder: Fabrik V2). Researched 2026-11-04.

## Question

Which error-monitoring options suit the Pilot (Penrith Physiotherapy & Sports Centre site), and which can file or feed GitHub issues? Candidates are compared on cost at the Pilot's scale, setup in its stack, GitHub issue integration or a pollable API, and error grouping and deduplication.

## Answer (short)

- **Instrument with `@sentry/astro`.** It is first-party for Astro on the Node adapter, which is exactly the Pilot's setup. The Sentry SDK is also the de facto wire protocol: GlitchTip and Bugsink both accept Sentry SDKs by changing only the DSN. So the instrumentation choice can't trap you, and the backend can be swapped later.
- **Let a scheduled Fabrik monitor file the issues. Don't use the vendor's own "create GitHub issue" automation.** Sentry gates automatic issue creation to Business and above, and manual creation and sync to Team. Polling is plan-gated too: the Developer (free) plan lists "API: No". If Fabrik's hourly schedule polls the issues API, the monitor controls labels (`needs-triage`), deduplication and volume. Volume is the binding constraint, because it sets how much the Operator has to read.
- **Cheapest viable backend for polling is uncertain:**
  - Sentry Team costs $26/mo (annual) or $29/mo, and includes the API and 50k errors.
  - GlitchTip hosted is $0 for 1k events/mo or $15/mo for 100k. It is MIT-licensed and takes Sentry SDKs, but I couldn't verify how compatible its issues API is with Sentry's.
  - Honeybadger Developer is $0 for 5k errors/mo, with a documented faults API and a GitHub integration. Its plan gating and Astro fit are unverified, and it would need its own SDK.
- **A $0, no-new-vendor fallback already exists.** ECS container stdout goes to CloudWatch Logs (`/ecs/<family>`), and the Logs Insights `pattern` command clusters similar lines. The deploy workflow already authenticates to AWS through GitHub OIDC. This only catches server-side errors that are logged, though. It sees no browser errors, and stack-trace grouping is weak.

## The Pilot's stack (from jrey8343/penrith-physiotherapy-sports-centre, read-only)

- Astro 5 with `output: 'server'` and `@astrojs/node` in `mode: 'standalone'` (`astro.config.mjs`). Alpine.js runs on the client. Stripe Checkout, the Nookal booking API, AWS SES and OpenAI are called server-side (`package.json`, `src/pages/api/*`).
- Hosting: a Docker image (`node:22-alpine`, `node ./dist/server/entry.mjs`) on **AWS ECS** in `ap-southeast-2`, behind an ALB. `.github/workflows/deploy.yml` deploys on every push to main, using an OIDC-assumed role, an ECR push and `ecs update-service`.
- Logs: ECS task logs go to CloudWatch (`aws logs tail /ecs/$FAMILY` in `scripts/setup-prod-env.sh`). The API routes use `console.error`.
- No error monitoring is wired up. `.env.example` lists `SENTRY_DSN`/`SENTRY_ENVIRONMENT` under "Monitoring & Analytics", but a code search shows only docs and `scripts/validate-env.js` mention Sentry. No SDK dependency is installed.
- Scale: a single-clinic marketing and booking site. Errors per month should sit far below any free tier's quota (this is an estimate, not measured).
- Sensitivity: the booking and intake forms carry patient details, which count as health information.
- The Operator already has a Sentry org (`gradually`, US region), found through the connected Sentry MCP. Its plan is unknown, and it has no Pilot project.

## Comparison

| | Sentry | GlitchTip (hosted) | Bugsink | Honeybadger | CloudWatch Logs (already there) |
|---|---|---|---|---|---|
| Free tier | Developer: 5k errors, 1 user, 30-day lookback, **API: No**, third-party integrations: No [1] | 1k events/mo, 30-day retention [5] | Self-host: free, unlimited. Hosted eval: 15k events, 1 user [7] | Developer: 5k errors/mo, 1 user, 15-day retention [8] | 5 GB/mo, shared by ingest, storage and Insights scans [12] |
| First paid tier | Team $26/mo annual or $29/mo: 50k errors, API and integrations [1] | Small $15/mo: 100k events, 90 days [5] | 75k events for €16/mo [7] | Team $26/mo: 50k errors, 90 days [8] | Usage-based. The Insights per-GB rate wasn't captured from the page [12] |
| Astro + Node setup | `npx astro add @sentry/astro`, client and server config files, source maps through an auth token at build. "Only works on Node runtimes, such as Node adapter" [2] | Same `@sentry/astro` SDK with a GlitchTip DSN [5][6] | Same Sentry SDK, "updating the DSN" [7] | Own JS SDK. No Astro guide checked (unverified) | None. `console.error` is already captured |
| GitHub issues | Manual create/link and two-way sync on Team+. Auto-create from an alert rule on **Business+** only [3] | Docs list only GitLab Error Tracking and Grafana integrations. No GitHub [6] | Not mentioned [7] | GitHub integration creates issues, with configurable labels and title [9]. Plan gating not readable from the pricing page | None |
| Pollable API | `GET /api/0/organizations/{org}/issues/` with `event:read`, `query=is:unresolved`, `statsPeriod`, `limit` up to 100, a cursor. Returns `id`, `shortId`, `title`, `culprit`, `count`, `userCount`, `firstSeen`, `lastSeen`, `permalink` [4] | API docs exist at app.glitchtip.com/api/docs but didn't render. Endpoint shape unverified [6] | "Give your agent stack traces and event data through Bugsink's API" [7] | `GET /v2/projects/{id}/faults` with token basic auth, `q`, `occurred_after`, `order`, `limit` up to 25 [10] | Logs Insights `StartQuery`/`GetQueryResults` through AWS credentials (standard AWS) |
| Grouping and dedupe | Fingerprint from stack trace, then exception, then message, using only in-app frames. Built-in rules for chunk-load and hydration noise. Optional AI merging. Custom fingerprint and stack-trace rules [11] | Not documented on the pages checked | "Groups repeated errors into issues, even when messages contain changing IDs or addresses" [7] | Errors grouped into "faults" (counts via `notices_count`) [10] | `pattern` clusters log lines into token patterns with counts. ML-based, on text only [13] |
| Data region | US (Iowa) or EU (Frankfurt), fixed when the org is created [14]. No AU | US or EU (Germany) [5] | Self-host anywhere, including AU | US, EU option [8] | `ap-southeast-2` (AU), same account as the site |

## Implications for a Fabrik monitor

1. **Stable dedupe key.** Every backend except CloudWatch gives each group a stable ID: Sentry `id`/`shortId`, Honeybadger fault `id`. The monitor can embed that ID in the GitHub issue body as a marker, then search for the marker before filing. One GitHub issue per error group follows naturally. With CloudWatch, the key would have to be a pattern string, which is less stable.
2. **Volume control lives in the query.** For example, Sentry's `query=is:unresolved firstSeen:-1h`, or `count` and `userCount` thresholds, can file only *new* groups that cross a threshold. This keeps what the Operator has to read in proportion to real breakages, not to noise.
3. **Vendor auto-filing is worse for Fabrik even where it's available.** It bypasses the triage labels and the monitor's thresholds. In Sentry it also needs the Business plan [3].
4. **The secret placement is new.** A Sentry-family token (`event:read`) would sit in the Product repo's Actions secrets, beside the existing Kit schedule.

## Setup notes for the Pilot (if Sentry-family is chosen)

- `@sentry/astro` adds `sentry()` to `integrations` in `astro.config.mjs`, plus `sentry.client.config.ts` and `sentry.server.config.ts` [2].
- Source maps: `SENTRY_AUTH_TOKEN` must be available inside `docker build` (the `npm run build` stage). In `deploy.yml` that means a build secret on `docker/build-push-action`. Without source maps, client-side grouping degrades [11].
- **Privacy:** by default the SDK sends user identity, HTTP bodies and query parameters, filtered only by a built-in denylist [2]. The booking and intake forms carry patient details, so trim `dataCollection` or scrub with `beforeSend` before go-live. Leave Session Replay out of the sample init. No Sentry region is in Australia [14].

## Uncertain or unverified

- **Sentry Developer "API: No"** comes from the pricing table [1]. I didn't confirm whether auth tokens are refused for the issues endpoint on the free plan. Test it against a free org before paying for Team.
- **GlitchTip issues API compatibility** with Sentry's `/api/0/organizations/{org}/issues/`: the docs page didn't render. Check it before relying on the cheap option.
- **Honeybadger:** which plan includes the GitHub integration, API access and EU residency. The pricing page's check marks weren't extractable. Its Astro and Node SDK fit is also unchecked.
- **Bugsink hosted evaluation:** whether the free tier includes API access.
- **CloudWatch Logs Insights per-GB price:** not captured from the pricing page.
- The Pilot's real error volume. No monitoring exists yet to measure it.

## Sources

1. Sentry pricing: https://sentry.io/pricing/
2. Sentry Astro guide: https://docs.sentry.io/platforms/javascript/guides/astro/
3. Sentry GitHub integration: https://docs.sentry.io/organization/integrations/source-code-mgmt/github/
4. Sentry API, list an organization's issues: https://docs.sentry.io/api/events/list-an-organizations-issues/ (the per-project endpoint is deprecated in favour of it: https://docs.sentry.io/api/events/list-a-projects-issues/)
5. GlitchTip pricing: https://glitchtip.com/pricing
6. GlitchTip docs and integrations: https://glitchtip.com/documentation, https://glitchtip.com/documentation/integrations. Licence MIT: https://gitlab.com/glitchtip/glitchtip-backend
7. Bugsink: https://www.bugsink.com/
8. Honeybadger plans: https://www.honeybadger.io/plans/
9. Honeybadger GitHub integration: https://docs.honeybadger.io/guides/integrations/github/
10. Honeybadger faults API: https://docs.honeybadger.io/api/faults/
11. Sentry event grouping: https://docs.sentry.io/concepts/data-management/event-grouping/
12. CloudWatch pricing: https://aws.amazon.com/cloudwatch/pricing/
13. CloudWatch Logs Insights pattern analysis: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_Patterns.html
14. Sentry data storage location: https://docs.sentry.io/organization/data-storage-location/
15. Pilot repo (private, read-only): jrey8343/penrith-physiotherapy-sports-centre. Files: `astro.config.mjs`, `Dockerfile`, `.env.example`, `.github/workflows/deploy.yml`, `scripts/setup-prod-env.sh`, `package.json`
