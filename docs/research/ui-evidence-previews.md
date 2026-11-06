# UI screenshots, video and preview deploys in Actions

Research for Decision #68 on the Wayfinder Map #62. It feeds #79 (visual evidence on UI pull requests) and #80 (UI prototypes in a design round).

**Question.** How can a Kit job capture UI evidence and a clickable preview for a Product repo like the Pilot? This compares headless Playwright in GitHub Actions with Claude in Chrome, surveys preview deploys, and says what a Product repo would have to declare in Kit config so the Kit stays provider-neutral.

## Answer in brief

1. **Capture evidence with headless Playwright, in the job that already built the branch.** That job is the Implementer's Sandbox job, or a Design prototype job. It serves the build on localhost, takes screenshots (and short video if asked), and passes them out as an artifact. Per ADR-0002, the push job never runs Product code, so it never serves or captures. It only posts what the Sandbox job passed out.
2. **Claude in Chrome cannot run in Actions.** It needs a visible Chrome with the extension, signed in through an interactive `/login`. It refuses the long-lived `claude setup-token` credential the Kit runs on. It stays a HITL tool for Pairing and Design sessions on the Operator's machine. For an agent that decides for itself what to click in CI, use **Playwright MCP** in `--headless` mode.
3. **Preview deploys are optional and owned by the Product repo.** The Kit should never call a hosting provider. A Product repo declares a URL template, or a GitHub Deployments environment, in Kit config. The Kit waits for that URL to answer, then links it.
4. **For the Pilot, there is no cheap preview deploy today.** It is an Astro SSR site (`output: 'server'`, `@astrojs/node`) on AWS ECS. Vercel, Netlify and Cloudflare each need a different Astro adapter. Vercel's free tier also bans commercial sites, and the Pilot takes payments. So the Pilot should start with **screenshots only**. Whether to add a preview host is a later Operator decision (see "Recommendation for the Pilot").

## The Pilot's stack (read-only inspection of `jrey8343/penrith-physiotherapy-sports-centre`)

- **Framework:** Astro 5 with `output: 'server'` and the `@astrojs/node` adapter in `standalone` mode, Tailwind 4 and Alpine.js (`astro.config.mjs`, `package.json`). It uses the sharp image service. Server routes under `src/pages/api/` call Nookal (booking), Stripe, SES and OpenAI.
- **Hosting:** a Docker image (`node:22-alpine`, `node ./dist/server/entry.mjs` on port 8080) pushed to ECR and rolled out to ECS in `ap-southeast-2`. This runs from `.github/workflows/deploy.yml` on push to `main` only, through an OIDC role limited to the `production` environment. There is **no preview or staging environment**.
- **CI:** `.github/workflows/ci.yml` runs `npm ci` and `npm run build` on PRs and non-main pushes. The build step takes **about 6 to 11 minutes** (run 41727954281: `npm run build` from 22:08:01 to 22:18:41). That is the dominant cost of any job that has to build before it captures.
- **Playwright:** `@playwright/test` ^1.59 is already a dependency. `tests/` holds `accessibility.spec.ts`, `performance.spec.ts` and `seo.spec.ts`, but no Playwright config and no CI job runs them. `.env.example` already names `TEST_BASE_URL`, `PLAYWRIGHT_BROWSERS`, `MOCK_EXTERNAL_APIS` and `TEST_MODE`.
- **Kit config:** `.fabrik/config.json` has `sandbox.setup: "npm ci"`, `sandbox.build: "npm run build"`, `sandbox.checks: ["build"]`, and no env or secrets. It has nothing about UI or previews.

## 1. Headless Playwright in GitHub Actions

**Setup.** Playwright's CI guide installs browsers with `npx playwright install --with-deps`. The `--with-deps` flag also installs the OS packages the browsers need. You can instead run the job in the `mcr.microsoft.com/playwright:v<version>-noble` container for consistent rendering. The guide advises against caching browser binaries: restoring the cache takes about as long as downloading them, and the OS dependencies can't be cached anyway. It suggests `workers: 1` on CI. ([playwright.dev/docs/ci](https://playwright.dev/docs/ci)) To save time, a capture step can install Chromium only (`npx playwright install --with-deps chromium`).

**Serving the build.** Playwright's `webServer` option takes a `command` that starts the server, a `url` it polls until it returns 2xx, 3xx, 400, 401, 402 or 403, a `timeout` (default 60 s) and a `reuseExistingServer` flag. ([playwright.dev/docs/test-webserver](https://playwright.dev/docs/test-webserver)) For the Pilot, that command is `node ./dist/server/entry.mjs` with `HOST`/`PORT` set, or `npm run preview`. The build has already run in the Sandbox job, so the capture adds no second build.

**Screenshots.** `page.screenshot({ path, fullPage: true })` captures the full page, and `locator.screenshot()` captures one element. ([playwright.dev/docs/screenshots](https://playwright.dev/docs/screenshots))

**Video.** The config option `video` is one of `'off'` (the default), `'on'`, `'retain-on-failure'` or `'on-first-retry'`. Size defaults to the viewport scaled down to fit 800x800. Files land in `test-results` and are written when the browser context closes. ([playwright.dev/docs/videos](https://playwright.dev/docs/videos)) The docs page doesn't state the file format. Playwright writes WebM (from general knowledge, not confirmed on that page).

**Run time.** I did not measure it on a runner. The estimate is: browser install (tens of seconds to about a minute), server start (seconds), and a few seconds per route and viewport. For the Pilot, this is small next to the 6 to 11 minute build the Sandbox job already pays for. A capture in a **separate** job would have to rebuild, or download `dist/` as an artifact, so keep it in the same job.

**Cost.** Linux 2-core runners cost $0.006 per minute. GitHub Free and Pro include $12 and $18 a month of Actions usage on private repos (about 2,000 and 3,000 Linux minutes). Public repos are free on standard runners. Artifact storage includes 500 MB (Free) or 1 GB (Pro), then $0.25 per GB per month. ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) A few PNGs per PR, with short retention, cost close to nothing.

### Getting the evidence in front of the Operator

- **Artifacts.** `actions/upload-artifact@v7` with `archive: false` uploads a single file unzipped. Its name becomes the artifact name. Outputs are `artifact-id`, `artifact-url` and `artifact-digest`. The URL works only for signed-in users. Retention is 1 to 90 days. ([actions/upload-artifact](https://github.com/actions/upload-artifact)) Since 26 Feb 2026, a non-zipped artifact opens **directly in the browser** if the browser can show that file type: images, Markdown, or simple HTML without linked CSS/JS. Downloading needs `actions/download-artifact@v8`. ([GitHub changelog](https://github.blog/changelog/2026-02-26-github-actions-now-supports-uploading-and-downloading-non-zipped-artifacts/))
  - So one file per artifact works. One neat option is a **single self-contained HTML gallery** with the screenshots inlined as data URIs (and the video, if small). It opens in one click from a link in the PR comment.
- **Inline images in a PR comment.** GitHub has **no public API** for uploading images to a comment. The `user-attachments` URLs come from an internal, browser-session endpoint that unofficial tools such as `gh-image` copy. ([gh-image](https://github.com/drogers0/gh-image), [cli feature-request discussion](https://claudeissues.com/issue/26831-feature-request-allow-posting-images-screenshots-to-github-pr-issue-comments)) Don't depend on that. A documented route the Kit could take: the **push job** (which already holds the App's Contents permission) commits the PNGs to a dedicated evidence branch (for example `fabrik/evidence`) and embeds them by URL. *Not verified:* whether github.com renders those images inline for a private repo's signed-in viewers. Test it on the Pilot before #79 commits to it.

## 2. Claude in Chrome vs agent-driven capture in CI

**Claude in Chrome** ([code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)):
- It needs a Chromium browser with the Claude in Chrome extension (≥1.0.36) and a direct Anthropic plan. Browser actions "run in a visible Chrome window in real time". It pauses on login pages and CAPTCHAs for the human.
- **It is disabled under the Kit's credential.** "If you authenticate with an API key or a long-lived token from `claude setup-token`, Claude Code keeps Chrome integration off, even when you pass `--chrome`." AFK jobs run on `CLAUDE_CODE_OAUTH_TOKEN` (ADR-0004), so this rules it out in Actions entirely.
- A project's `.claude/settings.json` can't turn it on either (`CLAUDE_CODE_ENABLE_CFC` is ignored by design).
- What it does well: it records GIFs of a session and saves screenshots to disk. That makes it a good tool **inside a Pairing session or Design session on the Operator's machine**, for example to show the Operator a prototype flow live. It is not a Kit job.

**Playwright MCP** is the in-CI substitute for agent-driven capture ([playwright.dev/docs/getting-started-mcp](https://playwright.dev/docs/getting-started-mcp), [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)):
- Claude Code adds it with `claude mcp add playwright npx @playwright/mcp@latest`. It needs Node 20+ and works from accessibility snapshots, so it needs no vision model.
- It runs headed by default. Pass `--headless` (or `PLAYWRIGHT_MCP_HEADLESS`) on a runner. `--output-dir` sets where screenshots land, and `--viewport-size 1280x720` sets the viewport. `--caps devtools` adds `browser_start_video` and `browser_start_tracing`, and `--save-session` saves the session.
- Use it when the agent should decide what to click, for example to walk a booking flow. Use a scripted Playwright capture when the routes are known up front. **The scripted capture is cheaper, deterministic and uses no model turns, so it should be the Kit's default.** The agent's role is choosing *which routes* to capture, which it writes into the run (see config below), not driving the browser.

## 3. Preview deploys

| Host | How a per-branch URL appears | Fits the Pilot as is? | Cost for a commercial site |
|---|---|---|---|
| **Vercel** | The Git integration deploys every push. Each commit gets `<project>-<hash>-<scope>.vercel.app` and each branch gets `<project>-git-<branch>-<scope>.vercel.app`, linked from a PR comment. URLs are public unless Deployment Protection is on. ([generated URLs](https://vercel.com/docs/deployments/generated-urls)) Automation reaches protected previews with the `x-vercel-protection-bypass` header, which is available on all plans. ([bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)) Vercel's own CI recipe tells you about readiness through a `repository_dispatch` of type `vercel.deployment.success` with `client_payload.url`. ([KB](https://vercel.com/kb/guide/how-can-i-run-end-to-end-tests-after-my-vercel-preview-deployment)) | No: it needs `@astrojs/vercel` in place of `@astrojs/node`. | Hobby is "non-commercial personal use only". Commercial use explicitly includes "any method of requesting or processing payment" and "receiving payment to create… or host the site". ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)) So the Pilot needs **Pro at $20 per developer seat per month**. Password protection costs another $20 per project per month. ([pricing](https://vercel.com/pricing)) |
| **Netlify** | Each PR gets a Deploy Preview at `deploy-preview-<PR>--<site>.netlify.app`, and every deploy has a permalink `<deployId>--<site>.netlify.app`. A status on the PR tracks progress. Previews can be password-protected. ([deploy previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/)) | No: it needs `@astrojs/netlify`. | The free plan includes 300 credits and "unlimited deploy previews". Production deploys cost 15 credits. Personal is $9 and Pro is $20 a month. ([pricing](https://www.netlify.com/pricing/)) The pricing page doesn't say whether commercial use is allowed on Free. *Unverified.* |
| **Cloudflare Workers** | `wrangler versions upload --preview-alias <alias>` gives `<alias>-<worker>.<subdomain>.workers.dev`. Aliases are lowercase alphanumerics and dashes, at most 63 characters with the Worker name, and the latest 1000 are kept. Previews are public unless Cloudflare Access protects them. ([previews](https://developers.cloudflare.com/workers/configuration/previews/)) | No: it needs `@astrojs/cloudflare`, and code runs on `workerd` with `nodejs_compat`. The AWS SDK, Stripe and sharp would each need checking. ([adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)) | Free: 100k requests a day, with no commercial restriction stated. Paid starts at $5 a month. ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) The upload needs a Cloudflare API token in CI. |
| **Quick tunnel from the runner** (`cloudflared tunnel --url http://localhost:8080`) | A temporary `trycloudflare.com` URL. Needs no account. "For testing and development", 200 concurrent requests, no SSE, no uptime guarantee. ([docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)) | Technically yes. | Free, but the URL dies with the job. The Operator reviews asynchronously, so this **doesn't work as a review link**. At most it suits a live Pairing session. |
| **Pilot's own AWS** (a per-PR ECS service) | Whatever the Product repo builds. | Yes, it reuses the Dockerfile. | Fargate time per open PR, plus a deploy role the Sandbox must not hold. I haven't priced it, and it is heavy for a solo Operator. |

Preview servers must hold **no production secrets** (the Sandbox definition). For the Pilot that means booking and payment routes run with `MOCK_EXTERNAL_APIS`/`TEST_MODE` or with test keys. The `.env.example` names suggest the app already has mock switches. *Unverified:* whether those switches are actually wired up.

## 4. What a Product repo declares in Kit config

Keep the Kit provider-neutral by having the Product repo declare **how to serve its build locally** and, optionally, **where a preview URL will appear**. The Kit never calls a host's API. A sketch of `.fabrik/config.json` additions:

```jsonc
{
  "ui": {
    // which changed paths make a PR "UI" (for #79); null = never capture
    "paths": ["src/**/*.astro", "src/components/**", "src/styles/**", "public/**"],
    // started after sandbox.build, in the same Sandbox job
    "serve": "node ./dist/server/entry.mjs",
    "serve_env": { "HOST": "127.0.0.1", "PORT": "4321", "MOCK_EXTERNAL_APIS": "true" },
    "url": "http://127.0.0.1:4321",
    "ready_timeout_seconds": 60,
    // routes captured when the run names none
    "default_routes": ["/", "/book", "/services"],
    "viewports": [{ "name": "mobile", "width": 390, "height": 844 },
                  { "name": "desktop", "width": 1440, "height": 900 }],
    "video": false
  },
  "preview": null
  // or, when the repo connects a host itself:
  // "preview": {
  //   "url": "https://deploy-preview-{pr}--penrith-physio.netlify.app",  // tokens: {pr} {branch_slug} {sha}
  //   "ready_timeout_minutes": 15,
  //   "bypass_header": { "name": "x-vercel-protection-bypass", "secret": "op://Fabrik Sandbox · penrith/vercel-bypass" }
  // }
}
```

Notes on that contract:
- **The URL template is the neutral seam.** All three hosts give predictable URLs keyed by PR number, branch or alias, so the Kit only has to fill the template in and poll until it gets a 2xx response. Using GitHub Deployments `environment_url` ([REST: deployment statuses](https://docs.github.com/en/rest/deployments/statuses)) as an alternative source is possible, but I did not confirm which hosts create GitHub Deployments, so treat it as a later option. Vercel's documented signal is a `repository_dispatch`, which the fixed `fabrik.yml` should not have to listen for.
- **Product repos without a server** (static sites) declare `serve` as a static file server. Product repos with no UI leave `ui` null.
- **Secrets** for `serve_env` and `bypass_header` go through the existing `op://` mechanism (ADR-0004), resolved in the Sandbox job only.
- **Trust roots:** `.fabrik/config.json` is already Kit config. Agents must not be able to change `ui.paths` or `preview`, or they could switch evidence off.
- The scripted capture (Playwright installed by the Kit, driven by these keys) means a Product repo writes **no Playwright config of its own**. A repo that already has one keeps it.

## Recommendation for the Pilot

- **V2 baseline:** screenshots only, captured at mobile and desktop viewports in the Implement Sandbox job right after `npm run build`. They are passed out as one browser-viewable artifact, which the push job links (or embeds) in the PR. This adds roughly a minute to a job that already spends 6 to 11 minutes building.
- **Video:** off by default. It is useful for #80 prototypes that involve interaction, such as booking-flow variants. Turn it on per run, not per repo.
- **Clickable preview:** `"preview": null` for now. If the Operator wants one, the least-change option is Netlify or Cloudflare with their adapter used **only for previews**. Production stays on ECS with `@astrojs/node`, with the adapter chosen by an env var at build time. Separately, check whether Netlify's free plan allows commercial use. Vercel works but costs at least $20 a month. Treat this as an Operator step in whatever Spec takes it on, not a Kit feature.

## Uncertain or not verified

- Actual run time of a Playwright capture on a hosted runner: not measured.
- Whether images committed to a branch in a **private** repo render inline in PR comments for signed-in viewers.
- Whether non-zipped image artifacts can be embedded with `<img>` (they need a signed-in session, so probably not). The safe assumption is a link, not an embed.
- Netlify Free and commercial use, and which hosts emit GitHub Deployments with `environment_url`.
- Whether the Pilot's `MOCK_EXTERNAL_APIS`/`TEST_MODE` switches are implemented.
- Why the Pilot build takes 6 to 11 minutes (possibly image optimization). Astro's `cacheDir` (default `./node_modules/.astro`) is "used in subsequent builds to speed up the build time" ([config reference](https://docs.astro.build/en/reference/configuration-reference/)), so `actions/cache` on it may help. Not tested.
