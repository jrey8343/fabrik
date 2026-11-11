# How far epicflare has fallen behind Remix 3 and the Agents SDK

Research for [#586](https://github.com/jrey8343/fabrik/issues/586) on the Wayfinder Map #507. It follows [#521](https://github.com/jrey8343/fabrik/issues/521) (what the Console is built with) and [#581](https://github.com/jrey8343/fabrik/issues/581) (the Console's repo, started from epicflare).

**Question.** The Console's repo is a copy of [epicweb-dev/epicflare](https://github.com/epicweb-dev/epicflare) at commit `f68b3109` (2026-07-10, still its newest). epicflare pins `remix` at exactly `3.0.0-beta.5` and `agents` at `^0.7.6`. npm's `latest` for the two is `3.2.0` and `0.33.0`. For each package, what would starting the build on the current release cost its first slice, against staying on the pin?

The Operator's lean before this research: treat epicflare as inspiration more than as a base, pin Remix at `3.2.0`, leave the Agents SDK at `0.7`. This note tests that lean. It agrees with two parts of it and disagrees with the third.

Everything below was read or run on 2026-11-12. Nothing was deployed. No browser was driven.

## Answer in brief

1. **Remix `3.2.0` is the same product as the beta, and the kept server code survives it almost untouched.** Same npm package, same router, same component model. With one documented rename (`remix/ui` to `remix/component`) applied, epicflare's `server/` has no type errors on `3.2.0` and all 11 of its kept server tests pass. Measured.
2. **What does not survive is epicflare's hand-written client router.** Since beta 9, Remix's own `run()` intercepts same-origin links and forms and reloads the page as a server-rendered frame. epicflare's 673-line `client/client-router.tsx` does the same job its own way. The epicflare author's own app built on this skeleton deleted its copy of that file when it moved to `3.0.0-rc.2`. Read in a primary source; the collision itself is inferred, not observed in a browser.
3. **The cross-origin middleware exists, is stable, and is not in epicflare.** epicflare passes `middleware: []` everywhere. `cop()` from `remix/middleware/cop` is new code for the Console on either version. It does less than the plan's wording asks: it checks `POST`, `PUT`, `PATCH` and `DELETE` only, and it lets a request through when it carries neither `Sec-Fetch-Site` nor `Origin`. Measured in a local Worker.
4. **Staying on Agents SDK `0.7` buys nothing and costs something. The lean is wrong here.** No kept code uses `agents`. The same minimal Durable Object source compiles and behaves identically on `0.7.9` and `0.33.0`. `0.7.9` is the last `0.7` release, eight months and 64 releases old. It forces `ai`, `react` and an old MCP SDK into the install. Cloudflare's docs now teach an API that `0.7` does not have. Measured and read.
5. **On either Agents version, the default WebSocket route is open.** A handshake with `Origin: https://evil.example` was accepted, and with the `Agent` class's defaults that client could overwrite the object's synced state. `cop()` does not cover this, because a WebSocket upgrade is a `GET`. Measured.
6. **There is a Remix skill for the stable release, and it is 113 lines.** It lives in the Remix repo and ships in every app made with `remix new`. It points at guides and READMEs installed inside `node_modules/remix`. epicflare's vendored skill is the upstream skill that this one replaced.
7. **epicflare has no successor, branch, pull request or fork on stable Remix.** `create-epicflare` just copies epicflare's `main`. The nearest thing is the author's public app `kentcdodds/kids-ledger`, which is the epicflare skeleton already moved to `remix@3.0.0`.

**Recommendation in one line:** pin `remix` at exactly `3.2.0` and `agents` at exactly `0.33.0`, and use epicflare as a reference for the Worker shell, not as code to strip.

## How it was read

- **npm metadata** for `remix`, `agents`, `create-epicflare` and their sub-packages, with `npm view`.
- **The three repos, cloned:** `remix-run/remix` (changelogs, READMEs, guides and source compared between the tags `remix@3.0.0-beta.5` and `remix@3.2.0`), `cloudflare/agents` (changelog, docs and source between `agents@0.7.9` and `agents@0.33.0`), and `epicweb-dev/epicflare` at `f68b3109`.
- **Cloudflare's hosted Agents docs**, fetched as Markdown from `developers.cloudflare.com/agents/` and read as text, not summarised by a model.
- **A measured trial**, described in section 2 and section 3. Node 26.12.0 and npm 11.20.0. Installs used `--ignore-scripts`. Bun is not installed on the machine, so epicflare's own scripts were replaced by direct `tsc` and `vitest` calls.
- Passages in quotation marks are verbatim. A claim marked **Inferred** was reasoned from sources and not observed.

### Versions, as npm reports them

| Package | Pin in epicflare | Resolves to | Published | `latest` | Published |
| --- | --- | --- | --- | --- | --- |
| `remix` | `3.0.0-beta.5` | `3.0.0-beta.5` | 2026-07-01 | `3.2.0` | 2026-11-04 |
| `agents` | `^0.7.6` | `0.7.9` | 2026-03-19 | `0.33.0` | 2026-11-03 |

- `remix` also has `3.0.0` (2026-10-01) and `3.1.0` (2026-10-23). Its `next` tag still says `3.0.0-rc.5`, which is older than `latest`.
- Between the two Remix tags there are 390 commits and, on npm, betas 6, 9 and 10, five release candidates, and three stable releases.
- `0.7.9` is the last `0.7` release. Nothing was published on that line after `0.8.0` came out four days later. 64 releases across 26 minor lines follow it.

## 1. Remix `3.0.0-beta.5` to `3.2.0`

Source for this section unless stated: [`packages/remix/CHANGELOG.md` at `remix@3.2.0`](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/remix/CHANGELOG.md).

### Is it the same product?

Yes. Same npm package and repository. The parts epicflare uses are still there under the same names: `createRouter` and `router.map` from `remix/router`, `route` and `post` from `remix/routes`, `createCookie` from `remix/cookie`, components as a setup function that returns a render function, `Handle`, `clientEntry`, `run`, and `renderToStream`. The server-rendered HTML still carries the `<!-- rmx:h:… -->` hydration markers that epicflare's own test asserts on, and that test passes on `3.2.0` (section 2).

`3.0.0` describes itself as "First stable release of Remix 3." Nearly every sub-package went to `1.0.0` with it.

### Is there a migration guide?

No standalone one was found. The repo's docs site and READMEs have no upgrade page. The changelog is the guide: each breaking entry carries a before-and-after diff, and the beta 10 entry is written for exactly this starting point ("Update imports when moving from beta.5 to beta.10"). 37 entries are marked `BREAKING CHANGE` between the two versions. Beta 10 restates beta 6's nine and `3.0.0` restates rc 5's one, which leaves 27 distinct.

A worked example exists. `kentcdodds/kids-ledger` is a public app by epicflare's author on the same skeleton (same layout, same commit history up to "Audit and adopt Remix 3 Beta 5 features"). It then moved in five steps:

| Commit | Date | Title | Size |
| --- | --- | --- | --- |
| [`b98265e8`](https://github.com/kentcdodds/kids-ledger/commit/b98265e8) | 2026-08-18 | Upgrade remix to 3.0.0-beta.10 | 26 files, +132 −113 |
| [`e50bb5f7`](https://github.com/kentcdodds/kids-ledger/commit/e50bb5f7) | 2026-09-10 | Upgrade remix to 3.0.0-rc.2 and adopt built-in frame navigation | 37 files, +363 −1404 |
| [`203b6c21`](https://github.com/kentcdodds/kids-ledger/commit/203b6c21) | 2026-09-30 | Upgrade remix to 3.0.0-rc.4 … | 126 files, +228 −10618 (105 of the files are removed agent docs) |
| [`f4ce041e`](https://github.com/kentcdodds/kids-ledger/commit/f4ce041e) | 2026-10-01 | Remix rc.4 follow-ups: … cop() middleware … | 14 files, +186 −45 |
| [`40d0defa`](https://github.com/kentcdodds/kids-ledger/commit/40d0defa) | 2026-10-02 | Upgrade remix to 3.0.0 | 37 files, +214 −131, nearly all one-line import renames |

It has not moved past `3.0.0`.

### What changed, by the part of the skeleton it touches

**Package layout and import paths.**

- `remix/ui` became `remix/component` in rc 5 and `3.0.0`: "Most existing `remix/ui` usage now moves to `remix/component`." The same rename applies to `remix/ui/server` and to `jsxImportSource` in `tsconfig.json`. epicflare imports `remix/ui` in 24 places and names it as the JSX source in five files and two esbuild flags.
- The styled components are gone, not moved: "The visually styled components and style mixins have been removed, including the previous `breadcrumbs`, `button`, `checkbox`, `input`, and `radio` modules." epicflare's sign-in screens import `remix/ui/button`, `remix/ui/input` and `remix/ui/checkbox`. The headless primitives moved to a separate `@remix-run/ui`, which is "currently unstable, versioned independently in the v0.x range".
- Beta 6 removed the old package-shaped aliases (`remix/fetch-router`, `remix/cop-middleware`). epicflare already uses the canonical `remix/router` and `remix/routes`, and beta 5 already had `remix/middleware/cop`. No change needed.
- The export map went from 133 entries to 108.

**Components.**

- `addEventListeners()` was removed in rc 1: "Use native `target.addEventListener(type, listener, { signal })` instead." epicflare calls it in four files, three of them kept.
- rc 3: raw HTML needs `unsafeHTML()`. epicflare's kept code does not set `innerHTML`.
- rc 1: framework attributes were renamed to `data-rmx-*`.
- `3.2.0` changed `css()` output: "Numbers stay unitless for properties that accept bare numbers. `flex: 2` is now a grow factor instead of `2px`", and generated class names changed.

**The client entry, hydration and navigation.** This is the large one.

- Beta 9: "`run()` from `remix/ui` now fetches frame HTML by default". The UI package's own changelog for that release is blunter: "All `run()` calls now enable frame reloads and same-origin link and form navigation through the Navigation API." ([`packages/ui/CHANGELOG.md`, v0.7.0](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/ui/CHANGELOG.md))
- In beta 5, a `run()` call with no `resolveFrame`, which is how epicflare calls it, got a placeholder resolver that returns the text "resolve frame unimplemented". From beta 9 the default resolver fetches the destination page for real, and from beta 6 it handles forms as well as links. Read in `run.ts` and `navigation.ts` under `packages/ui/src/runtime` at the beta 5 tag and under [`packages/component/src/runtime`](https://github.com/remix-run/remix/tree/remix@3.2.0/packages/component/src/runtime) at `3.2.0`.
- epicflare's `client/client-router.tsx` adds its own `navigate` listener, calls `event.intercept` itself, and fetches loader data as JSON. **Inferred:** on `3.2.0` it and `run()` would both act on the same link click. This was not run in a browser, and how the two listeners coexist on beta 5 was not worked out.
- The author resolved it by deleting the router. From [kids-ledger pull request #23](https://github.com/kentcdodds/kids-ledger/pull/23): "replaces the hand-rolled client router with Remix UI's built-in frame navigation … Net: **-1,075 lines**, 3 client modules deleted, all 28 Playwright e2e + 5 MCP e2e + unit tests green." And how it then works: "`run()` intercepts same-origin links/forms via the Navigation API, fetches the destination document, and reconciles it. Because the whole app is one client entry (`/client-entry.js#AppRoot`) with a stable identity, Remix preserves the hydrated instance and re-renders it with the streamed props". That is epicflare's own client entry, unchanged.
- A component can now reload its page from the server without a custom loader layer. From the installed guide [`06-streaming-ui-with-frames.md`](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/remix/guides/06-streaming-ui-with-frames.md): "`await handle.frames.top.reload();`" reloads the whole page, and "After a reload, Remix updates the region with the route's current HTML. Client entries inside matching content keep their setup state and receive current server props."

That last point bears on the Console's nudge. epicflare's "loaders" are not a Remix feature. They are its own client-side functions in `client/route-loader.ts`, wired through its own router. On `3.2.0` the plan's "a nudge re-runs the open screen's loader" has a first-party form: the nudge calls `handle.frames.top.reload()`, the server route runs again, and the page updates in place. kids-ledger's architecture doc describes navigation the same way: "Client-side navigations are full server renders of the destination document, so the destination route receives a fresh loader-data envelope … as new `AppRoot` props during the frame reload."

**Server rendering.**

- rc 1 added the conventional renderer: "Add the conventional Remix UI `render()` middleware to `remix/middleware/render`". Handlers then call `context.render(<Page />)`. Beta 5 has no equivalent, which is why epicflare calls `renderToStream` by hand. Its hand-rolled version still works on `3.2.0`.
- The renderer does not need Remix's Node-based asset server. From the [render-middleware README](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/render-middleware/README.md), on the `assets` option: "Omit it when client entries already use public URLs or the app has no client entries." epicflare's client entry is an esbuild bundle at a public URL.
- `3.1.0`: "Server rendering with `remix/component` is about twice as fast as in 3.0 and uses less memory, with no code changes."
- `3.2.0` added a nonce-based Content Security Policy middleware, `remix/middleware/csp`.

**Routing and controllers.**

- rc 2: "`remix/router` now returns `405 Method Not Allowed` with an `Allow` header when a URL matches a route but the request method does not. These requests previously reached `defaultHandler`". `GET` routes also answer `HEAD`.
- Beta 6: route params stop at `/` and `.`, and `href()` takes search params as `{ searchParams }`. epicflare's kept routes use neither feature.
- rc 4: the app-wide router context type is declared with `declare module 'remix'` instead of `'remix/router'`. epicflare does not declare one.

**Sessions and cookies.**

- Beta 6: "`remix/middleware/session` now makes session cookies HTTP-only when `httpOnly` is omitted."
- rc 3: "Session middleware now defaults to `Secure` on HTTPS requests while preserving explicit cookie settings", and "`remix/middleware/session` now enforces configured cookie lifetimes before loading session data."
- epicflare does not use the session middleware. It signs its own cookie with `createCookie`. That code compiles and its tests pass on `3.2.0`.

**Cross-origin and CSRF middleware.** `cop()` barely changed: one behaviour fix in rc 3 ("Use the original request method for safe-method and method-specific bypass checks") and the `1.0.0` label. Its README at `3.2.0` states the rule the plan leans on, and its limits:

> For requests whose original method is unsafe (`POST`, `PUT`, `PATCH`, `DELETE`) …
> - Allow `Sec-Fetch-Site: same-origin`
> - Allow `Sec-Fetch-Site: none`
> - Reject other `Sec-Fetch-Site` values unless the request matches a trusted origin or insecure bypass
> - If `Sec-Fetch-Site` is missing, compare `Origin` to the request host
> - If both `Sec-Fetch-Site` and `Origin` are missing, allow the request

> `cop()` is a browser-origin guard, not a universal CSRF solution.

Source: [`packages/cop-middleware/README.md`](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/cop-middleware/README.md). The safe list in [`cop.ts`](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/cop-middleware/src/lib/cop.ts) is `['GET', 'HEAD', 'OPTIONS']`. So "every non-GET request must come from the app's own origin" is true of browsers for the four unsafe methods. It is not true of a script that sends no `Origin`, and it says nothing about `GET`. `csrf()` (session-backed tokens) can be layered behind it; in rc 4 it stopped accepting tokens from the query string.

**Auth.** `remix/auth` has a built-in GitHub provider (`createGitHubAuthProvider`) in both beta 5 and `3.2.0`. rc 1 removed only the Atmosphere provider.

**Data.** Beta 6 replaced the `remix/data-table` adapter API. It breaks epicflare's D1 adapter, which the Console removes.

**Cloudflare Workers.** The stable guide names the runtime and its limit. From [`03-request-handling.md`](https://github.com/remix-run/remix/blob/remix@3.2.0/packages/remix/guides/03-request-handling.md): "A Cloudflare Worker exports an object with a `fetch` method", and "The router contract is portable, but every package in a middleware stack may not be. For example, the current static-file and compression middleware use Node filesystem and compression APIs. On a worker, serve static assets through the platform". `remix new` scaffolds a Node app (`node --import remix/node-tsx server.ts`, `engines.node >= 24.3.0`), so the Worker entry, the esbuild client bundle and the Wrangler config remain things to take from epicflare.

## 2. How much of epicflare's kept skeleton survives `3.2.0`: the measured trial

### Setup

epicflare at `f68b3109`, cloned to a scratch directory. `npm install --ignore-scripts` worked without Bun and resolved `remix 3.0.0-beta.5`, `agents 0.7.9`, `typescript 5.9.3`, `vitest 4.1.12`, `wrangler 4.160.1`. Then `npx tsc -b --noEmit` and `npx vitest run --config vitest-unit.config.ts`.

### Results

| Step | Type errors (distinct) | Unit tests |
| --- | --- | --- |
| On the pin | 0 | 6 files, 21 tests, all pass |
| `remix` bumped to `3.2.0`, nothing else touched | 405 | 4 files fail, 2 pass; 10 tests fail, 4 pass; two suites do not load |
| Plus the documented rename (`remix/ui` to `remix/component` in imports, `tsconfig` and the JSX pragma) | 15 | 3 files fail, 3 pass; 10 tests fail, 5 pass |
| Plus stubs for the three removed styled-component modules | not re-run | the 4 kept server test files: 11 tests, all pass |

The raw 405 is nearly all one cause: 331 are `TS7026` (JSX has no type because `remix/ui` no longer resolves) and 31 are the failed imports themselves. `tsc -b` prints 775 lines because `client/` belongs to two projects.

Where the errors fall, raw bump then after the rename:

| Code | Raw bump | After rename | What is left |
| --- | --- | --- | --- |
| `server/` (kept) | 28 | 0 | nothing |
| `worker/index.ts` (kept) | 0 | 0 | nothing |
| `client/`, kept files | 83 | 3 | `addEventListeners` no longer exported: `client-router.tsx`, `navigation-progress.tsx`, `router-location.tsx` |
| `client/` sign-in, OAuth and account screens | 160 | 7 | `remix/ui/button`, `input`, `checkbox` no longer exist: `login.tsx`, `reset-password.tsx`, `oauth-authorize.tsx` |
| `client/` tests | 3 | 0 | |
| `client/routes/chat.tsx` (removed) | 127 | 1 | `addEventListeners` |
| `worker/` D1 adapter and `db.ts` (removed) | 4 | 4 | `remix/data-table` adapter API |

The sign-in screens sit under `client/` but belong to email sign-in and the OAuth provider, which the Console removes. So of the 15 remaining errors, 3 are in code the Console keeps, and one of those three files is the client router that section 1 says to drop.

The 10 failing tests after the rename are all in removed code: 7 in the email sign-in handler (`createDatabase is not a function`, from the D1 adapter) and 3 in the Resend mock server. The one kept suite that fails, `server/ssr-render.test.ts`, fails to load because the route tree it renders imports `remix/ui/input` through the login screen. With those three imports aliased to an empty stub, `ssr-render`, `loader-data-context`, `health-handler` and `session-handler` pass: 11 of 11, including the assertions on the hydration marker and on the 404 state embedded for the client.

### A second measurement: the stable middleware in a Worker

A Worker of about 60 lines on `remix@3.2.0` with `cop()`, the session middleware with a `__Host-session` cookie, and `render()` with a `clientEntry` at a public URL, run under `wrangler dev --local` (workerd, compatibility date `2026-11-01`, `nodejs_compat`):

| Request | Result |
| --- | --- |
| `GET /` | 200, HTML with the `rmx:h` hydration marker and the client entry's props |
| `POST`, `Sec-Fetch-Site: same-origin` | 200, `Set-Cookie: __Host-session=…; HttpOnly; Path=/; SameSite=Lax; Secure` |
| `POST`, `Sec-Fetch-Site: cross-site` | 403, "Forbidden: cross-origin request detected from Sec-Fetch-Site header" |
| `POST`, foreign `Origin`, no `Sec-Fetch-Site` | 403 |
| `POST`, neither header | 200 |
| `GET`, `Sec-Fetch-Site: cross-site` | 200 |
| `GET` on a `POST`-only route | 405, `Allow: POST` |

The bundle was 204 KiB, 47 KiB gzipped.

### What the trial does not show

- Nothing ran in a browser, so hydration and navigation on `3.2.0` are unobserved.
- epicflare's client tests are outside its unit config. Under npm and vitest, 4 of them already fail on the pin, so they say nothing either way.
- epicflare's Playwright suite and its `bun`-based scripts were not run.

### What this says about "base or inspiration"

By line count, epicflare's TypeScript is about 17,900 lines. The files that carry over to `3.2.0` with a rename and nothing else (`server/router.ts`, `handler.ts`, `routes.ts`, `ssr-render.tsx`, `ssr-document.tsx`, `client/entry.tsx`, `app-root.tsx`) come to 280 lines. The client router and its loader plumbing, which stable Remix supersedes, come to 895. Most of the rest belongs to the seven features the Console removes.

## 3. Agents SDK `0.7` to `0.33`

Sources: [`packages/agents/CHANGELOG.md` at `agents@0.33.0`](https://github.com/cloudflare/agents/blob/agents@0.33.0/packages/agents/CHANGELOG.md), the docs in the same repo under `docs/agents/`, and Cloudflare's hosted docs.

### What epicflare uses it for

`agents` is imported in four files: `mcp/index.ts`, `worker/chat-agent.ts`, `worker/chat-agent-routing.ts` and `client/chat-client.ts`. All four belong to the MCP server and the AI chat. The Console's Durable Object is new code whichever version is chosen.

### What changed for one SQLite-backed `Agent` with a socket, state and an alarm

The SDK was rebuilt underneath the `Agent` class, and the class's own surface was kept.

- **`0.22.0`: `Agent` no longer sits on PartyServer.** "`Agent` now directly extends Cloudflare's `DurableObject` and composes the same lifecycle used by standalone objects". Also: "Lifecycle WebSockets always use Cloudflare's Hibernation API; the `static options.hibernate` switch and in-memory connection mode are removed."
- **`0.22.0` and `0.23.0`: scheduling moved onto a job queue that owns the alarm.** "Existing `cf_agents_schedules` rows are migrated into the `cf_agents_jobs` queue on startup and the legacy table is dropped. Agent's public scheduling and `keepAlive()` APIs are unchanged". One visible change: "Scheduled callbacks now receive the documented parsed `Schedule` object as their second argument (previously the raw storage row …)".
- **`0.24.0`: state moved into a `State` capability.** "`Agent`'s public API and wire protocol are unchanged: `state`, `setState()`, `onStateChanged`, and the `CF_AGENT_STATE` frames behave identically."
- **`0.23.0` and `0.24.0`: connections moved into a `WebSockets` capability.** "`Agent` installs the capability itself, so its `onConnect`/`onMessage`/`onClose`/`onError`/`getConnectionTags` overrides and connection APIs behave exactly as before".
- **`0.25.0`: address objects by name.** "address Agents by name because raw IDs from `newUniqueId()` and `idFromString()` now fail their first async RPC."
- **`0.24.0`: the queue helpers became asynchronous** (`dequeue`, `getQueue` and others). The Console's plan does not use them.
- **`0.8.0`: cron schedules are idempotent by default.**
- **`0.16.1`: sockets are pinned to `binaryType = "arraybuffer"`,** because on compatibility dates from `2026-03-17` the runtime's default became `"blob"`. `0.7` does not have this pin. It only matters for binary frames; the Console's nudges are text.

Routing kept its two entry points. `routeAgentRequest` and `getAgentByName` are still exported from `agents`, and the default URL is still `/agents/:binding/:name`.

### Measured: the same source on both versions

One file, a stand-in for the Console's object: an `Agent` subclass with a `cache` table created in `onStart`, a `put` that writes a row and broadcasts `{"type":"changed"}`, a `read`, and a one-second `schedule` whose callback writes and broadcasts. A Worker reaches it with `getAgentByName` and falls through to `routeAgentRequest`. Compatibility date `2026-11-01`, `nodejs_compat`, `wrangler 4.160.1`, run with `wrangler dev --local`.

| | `agents 0.7.9` | `agents 0.33.0` |
| --- | --- | --- |
| Type errors | 0 | 0 |
| Socket opens on `/agents/console-cache/main` | yes | yes |
| Write through `getAgentByName`, read back | works | works |
| Broadcast reaches the socket | yes | yes |
| One-second schedule fires and broadcasts | yes | yes |
| Frames sent to a new client without asking | `cf_agent_identity`, `cf_agent_mcp_servers` | the same two |
| Handshake with `Origin: https://evil.example` | accepted | accepted |
| That client sends a `cf_agent_state` frame | state overwritten | state overwritten |
| With `shouldSendProtocolMessages` false and `shouldConnectionBeReadonly` true | no SDK frames; write refused with "Connection is readonly" | the same |
| Packages installed for `agents` + `wrangler` + `typescript` | 188 | 118 |
| Bundle | 2788 KiB, 470 KiB gzipped | 2279 KiB, 421 KiB gzipped |

So for this shape of object, the `Agent` class is source-compatible across the whole gap.

### What is open by default

The same on both versions, by measurement above and by the docs:

- **The route.** Cloudflare's [Authentication](https://developers.cloudflare.com/agents/runtime/routing/authentication/) page opens: "Anyone who knows an agent's URL can send it requests. Check the caller in your Worker, before the request reaches the Durable Object." The hooks for that are `onBeforeConnect` and `onBeforeRequest` on `routeAgentRequest`. The page adds: "Browsers cannot set an `Authorization` header on a WebSocket upgrade. For WebSocket clients, read a token from a cookie or a query parameter in `onBeforeConnect`."
- **The socket's origin.** Nothing in the SDK checks it. The handshake is a `GET`, so Remix's `cop()` does not treat it as unsafe either; the Worker in section 2 let a cross-site `GET` through. Whether a browser attaches the session cookie to a cross-site handshake depends on the cookie's `SameSite` setting, which was not tested here. **Inferred from the two measurements together:** the Console's socket needs its own `Origin` check and session check before the upgrade is forwarded, and should not lean on `SameSite` alone. This is true on either version.
- **Protocol frames.** "When a client connects, an Agent sends it JSON protocol frames: its identity (`cf_agent_identity`), its state (`cf_agent_state`), and its MCP servers (`cf_agent_mcp_servers`)." ([Protocol messages](https://developers.cloudflare.com/agents/agent-class/protocol-messages/)) Turned off per connection with `shouldSendProtocolMessages()`.
- **State writes from clients.** `shouldConnectionBeReadonly` is documented as "Default: returns `false` (all connections are writable)." ([`docs/agents/readonly-connections.md`](https://github.com/cloudflare/agents/blob/agents@0.33.0/docs/agents/readonly-connections.md))
- **CORS is off unless asked for.** "Set `cors: true` when your frontend runs on another origin." ([Routing options](https://developers.cloudflare.com/agents/runtime/routing/options/)) With `cors: true` it sends `Access-Control-Allow-Origin: *`.
- **Callable methods are opt-in.** "Mark methods with `@callable()` to expose them to external clients like browsers, mobile apps, or other services." ([`docs/agents/callable-methods.md`](https://github.com/cloudflare/agents/blob/agents@0.33.0/docs/agents/callable-methods.md)) An undecorated method is reachable only from the Worker, over Durable Object RPC.

### Required flags and dates

- `nodejs_compat` is required on both. "The `agents` package requires the `nodejs_compat` compatibility flag." ([Add to an existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/))
- The class goes in `new_sqlite_classes`, as epicflare already does for its two.
- No minimum compatibility date is stated. The docs' examples use `2025-01-01`; the repo README uses `2026-06-11`; the troubleshooting note for an object that cannot find its name says "update Wrangler and use a current `compatibility_date`." epicflare's is `2026-01-31`. Both versions ran on `2026-11-01`.

### Do Cloudflare's docs still describe `0.7`?

No. The hosted docs were reorganised around the newer design, and most pages were last updated on 2026-10-29.

- The [Runtime](https://developers.cloudflare.com/agents/runtime/) page describes "a Durable Object with the Lifecycle installed, a Worker that routes requests to it, and the capabilities you attach to it", and its first example is a plain `DurableObject` importing from `agents/lifecycle`, `agents/routing`, `agents/schedules` and `agents/websockets`.
- None of those four subpaths exists in `0.7.9`. Its export map has 19 entries, among them `agents`, `agents/client`, `agents/mcp`, `agents/schedule` and `agents/react`, and no `lifecycle`, `routing`, `schedules`, `websockets` or `state`.
- The `Agent` class has its own section and is still documented as before. Its routing page still imports from `agents`.
- `Lifecycle`, `WebSockets`, `State` and `Scheduler` are listed as stable; `Queue`, `Tasks`, `Sessions`, `Streams` and `RoutedAgents` as experimental.
- One page is stale the other way: [Agent class internals](https://developers.cloudflare.com/agents/agent-class/internals/) still says "`Agent` does not extend `DurableObject` directly. It extends `Server` from the `partyserver` package", which stopped being true in `0.22.0`.
- The index lists "McpAgent (deprecated)", the class epicflare's MCP server is built on.

An agent building on `0.7` would be reading docs whose main path does not compile against its install.

### Is there any reason to write a new Durable Object against `0.7`?

None was found. What was looked for, and what turned up:

- **Reuse of epicflare's code.** There is none to reuse; all four files go.
- **A simpler or more familiar API.** The same source runs on both.
- **Fewer dependencies.** The reverse. `0.7.9` lists `ai ^6`, `react ^19` and `zod` as required peers and depends directly on `@modelcontextprotocol/sdk 1.26.0`, `partyserver`, `yargs` and `json-schema-to-typescript`. npm installed `ai`, `react`, `express` and `hono` for an app that uses none. `0.33.0` made `ai` and `react` optional; its required peers are `zod ^4` and `@modelcontextprotocol/client 2.4.0`.
- **Stability.** `0.7` is not a maintained line. Nothing has been published on it since 2026-03-19.
- **A lighter upgrade later.** The reverse. An object first created on `0.7` stores its schedules in `cf_agents_schedules` and its name under PartyServer's `__ps_name` key. Later releases migrate both on first start. The `0.24.0` changelog calls two of its one-shot migrations "temporary upgrade paths" that "will be removed in the next minor release", and adds "Deployments skipping this release should upgrade through it." **Inferred:** an object born on `0.33.0` has nothing to migrate, and one born on `0.7` takes on an upgrade path that the maintainers treat as temporary.

The one real caution about `0.33.0` is its pace: 26 minor lines in eight months, with breaking changes landing in minors. That argues for an exact pin, not for `0.7`.

### A choice that only exists on the current release

On `0.33.0` the object does not have to extend `Agent`. The same stand-in was rewritten as a plain `DurableObject` with `Lifecycle.install(this)`, the `WebSockets` capability and the `Scheduler` capability, and run the same way:

| | `extends Agent`, `0.33.0` | `Lifecycle` + two capabilities, `0.33.0` |
| --- | --- | --- |
| Works (table, socket, broadcast, schedule) | yes | yes |
| Frames sent without asking | identity, MCP servers | identity only; none with `protocol: false` |
| Client `cf_agent_state` frame | overwrites state unless made read-only | ignored; there is no `State` capability installed |
| Bundle | 2279 KiB, 421 KiB gzipped | 258 KiB, 55 KiB gzipped |
| Startup before an RPC method | automatic | manual |

The last row cost the trial a failed first run: `no such table: cache`. The docs say why: "RPC calls do not go through `fetch()`, so they do not start the Lifecycle. Call `await this.lifecycle.start()` at the top of each RPC method that uses a capability, or anything `onStart()` sets up." The `Agent` class "also starts the Lifecycle before its public `async` RPC methods run." ([Lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/))

Neither form checks the socket's origin or who is calling.

## 4. A Remix skill for the stable release

- **It exists, in the Remix repo:** [`.agents/skills/remix/SKILL.md`](https://github.com/remix-run/remix/blob/main/.agents/skills/remix/SKILL.md), 113 lines, last edited 2026-11-05.
- **It ships with new apps.** The published `@remix-run/cli@1.0.2` tarball contains `template/.agents/skills/remix/SKILL.md` and a `template/AGENTS.md` that points at it. The CLI's old `remix skills` command was removed in its `0.2.0`.
- **It is deliberately thin.** It tells the agent to read docs installed with the package: "Search `node_modules/remix/INDEX.md` by task, export, or keyword", then the guide, then the package README, and "Treat the installed documentation as canonical, including when it differs from this skill."
- **Those docs are in the npm package.** `remix@3.2.0` installs `INDEX.md`, 15 guides (about 7,100 lines) and a README per export under `node_modules/remix/`. They match the installed version by construction.
- **Four of the 15 guides are marked unfinished,** and one of them is the one the Console leans on. `10-auth-sessions-security.md` opens "This chapter is unfinished. The sections below outline what it will cover." and links to the session, auth, auth-middleware and CSRF READMEs. The other three are errors and cancellation, CLI and tooling, and production. The READMEs for `cop`, the session middleware and `auth` carry working examples; those are what an agent would build the sign-in from.
- **epicflare's vendored skill is the one this replaced.** Its `SKILL.md` and eleven reference files (3,499 lines) carry the same file names as the upstream skill that commit [`2bbc63f6`](https://github.com/remix-run/remix/commit/2bbc63f69) ("Make the Remix app skill installed-docs-first", 2026-09-17) deleted. Against `3.2.0` it is wrong in the ways section 1 lists: 31 mentions of `remix/ui`, `addEventListeners`, `resolveFrame(src, signal, target)`, the un-prefixed `rmx-target` attributes, `remix/ui/button`, and the asset server's `fileMap`.
- **No separate skills repository for Remix 3 was found.** epicflare's `skills-lock.json` lists one skill, `ship-pr`, from the author's own repo. kids-ledger dropped the vendored Remix skill and keeps its own notes under `docs/agents/remix/`.
- epicflare's `docs/remix-beta-5-adoption-audit.md` is a 139-line record of adopting beta 5 features, chiefly the styled `remix/ui/input`, `button` and `checkbox` that `3.0.0` removed.

## 5. Successors, branches, pull requests and forks

- **epicflare itself:** last push 2026-07-10. Besides `main` it has 12 branches, last touched between February and July 2026. Their `remix` pins run from `3.0.0-alpha.2` to `3.0.0-beta.5`; none is past the pin.
- **Pull requests:** one open, [#80](https://github.com/epicweb-dev/epicflare/pull/80) "Add compile-time module system for optional feature packages" (2026-09-09), marked WIP. It does not touch `package.json`. The last merged one is #79, the beta 5 audit.
- **Issues:** one open, from February, about API routing.
- **Forks:** three. The one behind #80 is on `remix 3.0.0-beta.5` and `agents ^0.7.6`. One is on `remix 3.0.0-alpha.2`. One returned nothing readable.
- **`create-epicflare`:** `1.7.0`, published 2026-03-04, unchanged since. It contains no template. It runs `degit epicweb-dev/epicflare`, so it hands out whatever is on epicflare's `main`, which is the beta 5 code.
- **No successor repo** was found under `epicweb-dev`. One GitHub code search for a public Worker project on `remix 3.2.0` returned nothing, which is weak evidence of absence.
- **The author's own apps have moved to stable.** `kentcdodds/kids-ledger` (the epicflare skeleton, on a Worker with esbuild and Wrangler) is on `remix 3.0.0` with `agents ^0.7.4`. Two of his other apps are on `remix 3.0.0`. kids-ledger is the closest thing to "epicflare after the move", with three limits: it stopped at `3.0.0`, it still renders by hand with `renderToStream`, and it kept the old Agents SDK.

## 6. The stand-in Durable Object used in the trial

The `Agent`-class form, which compiled and ran unchanged on `0.7.9` and `0.33.0`. `Env` is the type `wrangler types` generates.

```ts
import { Agent, getAgentByName, routeAgentRequest } from 'agents'
import type { Connection, ConnectionContext } from 'agents'

export class ConsoleCache extends Agent<Env> {
	onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS cache (
			key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL)`
	}
	shouldSendProtocolMessages() {
		return false
	}
	shouldConnectionBeReadonly() {
		return true
	}
	onConnect(connection: Connection, ctx: ConnectionContext) {
		connection.send(JSON.stringify({ type: 'hello' }))
	}
	async put(key: string, value: string) {
		this.sql`INSERT OR REPLACE INTO cache (key, value, fetched_at)
			VALUES (${key}, ${value}, ${Date.now()})`
		this.broadcast(JSON.stringify({ type: 'changed', key }))
	}
	async arm(seconds: number) {
		return (await this.schedule(seconds, 'tick', { n: 1 })).id
	}
	async tick(payload: { n: number }) {
		await this.put('tick', String(payload.n))
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url)
		if (url.pathname === '/put') {
			const stub = await getAgentByName(env.ConsoleCache, 'main')
			await stub.put('k', url.searchParams.get('v') ?? '')
			return new Response('ok')
		}
		return (
			(await routeAgentRequest(request, env)) ??
			new Response('not found', { status: 404 })
		)
	},
} satisfies ExportedHandler<Env>
```

The trial ran it twice on each version, switched by an environment variable: once with the two `should…` overrides returning the SDK's defaults, to record what an unconfigured `Agent` sends and accepts, and once as shown. The file that ran also had a `read` method and echoed the handshake's `Origin` in its hello frame. The composed form on `0.33.0` replaced the class with a `DurableObject` holding `new Scheduler({ callbacks: { tick } })`, `new WebSockets({ protocol: false, handlers: { onConnect } })` and `Lifecycle.install(this).use(scheduler).use(webSockets)`, wrote to `this.ctx.storage.sql` directly, sent nudges by looping over `webSockets.getConnections()`, and began each RPC method with `await this.lifecycle.start()`.

## What starting on the current release costs the first slice

### Remix: `3.2.0` against `3.0.0-beta.5`

| | On the pin | On `3.2.0` |
| --- | --- | --- |
| Server router, routes, handlers | work as copied | work as copied (0 type errors, measured) |
| Server rendering and client entry | work as copied | one rename across the kept files, then work (measured for the server; unobserved in a browser) |
| Client navigation | epicflare's 673-line router and loader plumbing, kept and maintained | deleted; Remix's `run()` does it. New work: the page's data comes from the server render, and the nudge calls `frames.top.reload()` |
| Three `addEventListeners` calls | fine | rewritten as `addEventListener(…, { signal })`, a line each, or gone with the router |
| Cross-origin rule | `cop()` exists in beta 5 too; new code either way | the same, at `1.0.0` |
| Session behind a `__Host-` cookie | hand-rolled on `createCookie`, or the beta's session middleware with older defaults | session middleware with `HttpOnly` and `Secure` defaults (measured) |
| Rendering in handlers | hand-rolled `renderToStream` | `context.render()` available; hand-rolled still works |
| Agent-facing docs | epicflare's vendored skill, matching the pin | the 113-line skill plus docs in `node_modules`; epicflare's skill must be removed or it will mislead |
| Later upgrade | all 27 breaking changes still ahead, on a build that then has real screens | done |
| Risk | a prerelease with no further fixes | eight days old; one open `css()` bug ([#12280](https://github.com/remix-run/remix/issues/12280)); unreleased router fixes already queued for the next release |

**Inferred estimate:** starting on `3.2.0` adds a few hours of mechanical work to the first slice and removes about 900 lines the slice would otherwise carry (kids-ledger's own figure for the same removal was a net 1,075). Starting on the pin saves those hours now and buys the kids-ledger sequence of five upgrade commits later, against screens that exist by then.

### Agents SDK: `0.33.0` against `0.7`

| | On `0.7.9` | On `0.33.0` |
| --- | --- | --- |
| The Durable Object's source | new code | the same new code (measured identical for the `Agent` class) |
| Install | 188 packages, including `ai`, `react`, `express`, `hono`, MCP SDK `1.26.0` | 118 packages, including `zod` and the MCP client |
| Docs the builder reads | describe an API the install lacks | match |
| Socket origin and caller checks | must be written | must be written |
| Storage layout | legacy tables, migrated by later releases | current |
| Option of a plain `DurableObject` with only the capabilities needed | not available | available, about a ninth of the bundle |
| Later upgrade | 26 minor lines of changelog to cross | done |
| Risk | unmaintained line | fast-moving `0.x`; pin exactly |

Starting on `0.33.0` costs the first slice nothing that starting on `0.7` would not also cost.

## Recommendation

For the Spec's writer to take or put to the Operator.

1. **Pin `remix` at exactly `3.2.0`.** The lean is right. Apply the `remix/ui` to `remix/component` rename as the first commit. Keep the pin exact, as epicflare does: `3.2.0` changed `css()` output in a minor release.
2. **Pin `agents` at exactly `0.33.0`, not `0.7`.** The lean is wrong on this one. Nothing kept depends on `0.7`, the same code runs on both, and `0.7` is the worse install, the worse docs match and the worse starting point for the object's storage.
3. **Treat epicflare as a reference, not a base to strip.** The lean is right, and more so on `3.2.0`. Take from it: the Worker entry and static-asset handling in `worker/index.ts`, the esbuild client bundle with a public client-entry URL, `server/ssr-document.tsx` and `client/entry.tsx` as the pattern for the document and hydration, the Wrangler, TypeScript, vitest and workflow setup. Do not carry over: `client/client-router.tsx` and the loader plumbing, the vendored Remix skill, `docs/remix-beta-5-adoption-audit.md`, the styled sign-in screens. Use kids-ledger as the second reference for how the same skeleton looks on stable.
4. **Replace epicflare's Remix skill with the upstream one** and let it point at `node_modules/remix`. The auth and security guide is an outline, so the Spec should name the four READMEs directly: session, auth, cop-middleware, csrf-middleware.
5. **Write the origin rule down as two rules, because one middleware does not cover both.**
   - `cop()` on the router for `POST`, `PUT`, `PATCH` and `DELETE`. Say in the Spec whether a request with no `Origin` and no `Sec-Fetch-Site` should pass (it does by default) and whether `csrf()` goes behind it.
   - A separate check before any WebSocket upgrade reaches the Durable Object: the `Origin` header equals the app's origin and the session cookie is valid. Do it in `onBeforeConnect`, or do not use the default `/agents/…` route at all and forward the upgrade from an authenticated Remix route.
6. **Decide the object's shape in the Spec; both work.** If it extends `Agent`: return `false` from `shouldSendProtocolMessages`, return `true` from `shouldConnectionBeReadonly`, and do not set `initialState`, so the socket carries only the Console's own nudges. If it is a plain `DurableObject` with `Lifecycle`, `WebSockets({ protocol: false })` and `Scheduler`: every RPC method starts with `await this.lifecycle.start()`. The second is the smaller surface and the smaller bundle, and is what Cloudflare's docs now lead with. The first needs less care.
7. **Address the object by name** (`getAgentByName` or `getByName`), never by a raw id.

The combination this note does not recommend is the mixed one in the lean. "Both on the pin" is coherent but defers every cost. "Both current" is what the evidence supports.

## Not verified

- **Anything in a browser.** Hydration, link and form navigation, `frames.top.reload()` driven by a socket message, and the suspected clash between epicflare's client router and `run()` on `3.2.0` are all unobserved. kids-ledger's pull request reports its browser tests green on rc 2; that is its author's result, not this research's.
- **How epicflare's router and beta 5's `run()` coexist today.** Both register a `navigate` listener on the pin. The reading did not establish which one wins.
- **Cookies on a cross-site WebSocket handshake.** Whether a `SameSite=Lax` session cookie is withheld from one was not tested, so the socket's `Origin` check is recommended without knowing how much `SameSite` already covers.
- **Anything deployed.** Every run was `wrangler dev --local` on one machine. Cloudflare's production runtime, hibernation across real evictions, and alarms after an eviction were not exercised.
- **Bun.** epicflare's `bun`-based scripts, its Playwright suite and its GitHub workflows were not run. The trial used npm, which resolved newer versions of floating dependencies (`wrangler 4.160.1`, `vitest 4.1.12`) than epicflare's lockfile.
- **epicflare's kept client code at runtime on `3.2.0`.** It type-checks after the rename except for three `addEventListeners` imports. It was not executed.
- **`render()` together with Remix `<Frame>`s inside a Worker.** The smoke test rendered one page with one client entry and no nested frames.
- **Whether `remix/auth`'s GitHub provider fits the Console's sign-in** as #567 describes it (a GitHub App, PKCE, expiring user tokens with refresh). Only its existence in both versions was checked.
- **Whether `nodejs_compat` is truly required by Remix `3.2.0`'s router, `cop`, session and render middleware.** The smoke test had it on and was not repeated without it.
- **Remix `3.1.0` and `3.0.0` as alternatives.** Only `3.2.0` was installed and run.
- **Agents SDK versions between `0.7.9` and `0.33.0`.** Only the two ends were run. The changelog between them was searched for terms and read in full only for `0.22.0` to `0.25.0`.
- **Whether the temporary migrations named in `0.24.0` have been removed yet.** References to the legacy tables are still in the `0.33.0` source; the removal was not traced.
- **`useAgent` and `AgentClient`.** The probe was a bare WebSocket. The Console is not expected to use the SDK's client.
- **What kids-ledger uses `agents ^0.7.4` for,** and why it stayed there.
- **The third epicflare fork,** which returned no readable branch list.
- **A complete search for Remix 3 skills outside the Remix repo and epicflare.** The Remix repo, its CLI tarball, epicflare and the author's repos were checked; a wider search was not made.
- **Cloudflare's hosted docs beyond the 17 pages fetched.** The claim that they describe the current API rests on the runtime, routing, capability, lifecycle, getting-started and `Agent` class pages.
