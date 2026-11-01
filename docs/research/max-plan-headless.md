# Can Claude Code on Max x20 drive headless agents in Sandboxes?

Research for [#6](https://github.com/jrey8343/fabrik/issues/6). All sources were read on **2026-11-02**. Support-centre pages carry a `dateModified` of 2026-10-30 unless noted. Terms follow `GLOSSARY.md` (Operator, Implementer, Reviewer, Sandbox, AFK, Loop, Kit, Product repo).

Each claim is tagged with how much weight it can bear:

- **[documented]**: stated on an Anthropic-owned page (code.claude.com, support.claude.com, claude.com, anthropic.com/legal).
- **[ambiguous]**: the documents say something, but not clearly enough to settle how Fabrik will use it.
- **[hearsay]**: from community sources or relayed emails. Treat these as context, not as fact.

## Answer in brief

**Yes, with conditions.** The unmodified `claude` binary can run headless (`claude -p` or the Agent SDK) inside a Sandbox on the Operator's own subscription, using a one-year OAuth token from `claude setup-token` passed in as `CLAUDE_CODE_OAUTH_TOKEN`. Anthropic documents this path for "CI pipelines and scripts" and ships it in its own GitHub Action. That counts as the "explicitly permit[ted]" exception to the Consumer Terms' ban on automated access.

The conditions:

1. **"Max x20" no longer exists.** It was renamed **Ultra** ($200/month), and existing subscribers moved over automatically. Ultra gives 10× Pro's *weekly* usage, has **no 5-hour limit once the account is verified**, and has a separate weekly Fable limit. Absolute token numbers are not published.
2. **One shared pool.** The headless runs, claude.ai chat, interactive Claude Code, cloud sessions and routines all draw from the same weekly allowance. Running more Implementers at once spends the week faster. It does not add capacity.
3. **"Ordinary, individual usage".** Advertised limits assume this, and Anthropic can add caps whenever it likes. A Loop that runs all day is at the edge of that wording, not clearly inside it.
4. **Metered spend can switch on without anyone choosing it.** This happens if *usage credits* are enabled on the account, if `ANTHROPIC_API_KEY` reaches a Sandbox, if `--bare` is used, or if a headless run selects Fable after its included share is used up. With usage credits **off** and no API key present, hitting a limit blocks the run. It never bills.

## 1. Is subscription auth permitted for automated or headless use?

| Claim | Source | Status |
|---|---|---|
| The Consumer Terms (Free/Pro/Max/Ultra) forbid accessing the Services "through automated or non-human means, whether through a bot, script, or otherwise", **"except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"**. Effective Oct 8, 2025. | [Consumer Terms §3](https://www.anthropic.com/legal/consumer-terms) | documented |
| The Claude Code docs explicitly provide `claude setup-token` "for CI pipelines, scripts, or other environments where interactive browser login isn't available". The token "authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan." | [Authentication: Generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) | documented |
| The official GitHub Action accepts `claude_code_oauth_token` ("an OAuth token that authenticates with your Claude subscription, available on Pro, Max, Ultra…"), and "if you authenticate with an OAuth token, runs use your Claude subscription instead of API billing." This includes automation mode on a cron schedule. | [GitHub Actions](https://code.claude.com/docs/en/github-actions) | documented |
| Support article (updates dated 2026-06-15 and 2026-10-07): "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits." | [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | documented |
| OAuth auth "is intended exclusively for purchasers of … subscription plans and is designed to support **ordinary use** of Claude Code and other native Anthropic applications." "Advertised usage limits for Pro, Max, and Ultra plans assume **ordinary, individual usage** of Claude Code and the Agent SDK." | [Legal and compliance: Usage policy](https://code.claude.com/docs/en/legal-and-compliance#usage-policy) | documented wording, **ambiguous** for a factory that runs all day |
| Developers may not "offer Claude.ai login into their own applications, or … route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and may not "collect, store, or intermediate Claude.ai credentials". The same section says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code" (for example, hosted sandboxes). | same page | documented |
| Agent SDK overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | documented |
| You "may not share your Account login information … or make your Account available to anyone else." | [Consumer Terms §2](https://www.anthropic.com/legal/consumer-terms) | documented |
| The Usage Policy forbids creating multiple accounts "to avoid detection, circumvent product guardrails…", and "intentionally bypass[ing] … restrictions … established within our products". Effective Nov 12, 2026. | [Usage Policy](https://www.anthropic.com/legal/aup) | documented |

**What this means for Fabrik.** One Operator running the unmodified `claude` CLI in their own Sandboxes, with their own token, on their own Product repos, is inside the documented path. Three things would take Fabrik outside it:

- offering the Kit to *other* people who use the Operator's token;
- building a custom harness that calls the API with the OAuth token instead of running the `claude` binary;
- spreading the work across several subscriptions to multiply limits.

The open question is volume, not mechanism. Nothing defines "ordinary, individual usage", and Anthropic "reserves the right to take measures to enforce these restrictions … without prior notice" [documented, same page].

**Policy volatility.** The support article records that a "previously-announced change" to Agent SDK and `claude -p` usage was **paused on 2026-06-15** [documented]. A user quoted Anthropic's email in [mattpocock/sandcastle#191](https://github.com/mattpocock/sandcastle/issues/191) (2026-06-15). Per that email, the change would have moved "the Claude Agent SDK, `claude -p`, and third-party apps built on the Agent SDK" off subscription limits "to a dedicated monthly credit" [hearsay: a relayed email, not a primary page]. Since 2026-10-07, Max and Ultra include monthly *API* credits that cover `claude -p` and the SDK **only when run with a Console API key** [documented]. Fabrik's main auth path has been close to changing once already this year.

## 2. How does a Sandbox authenticate without an interactive login?

- **Mechanism [documented]:** the Operator runs `claude setup-token` once on a machine with a browser. The token prints once and is never saved. The Operator stores it as a secret and injects it into each Sandbox as `CLAUDE_CODE_OAUTH_TOKEN`. It is valid for **one year** ([Authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
- **Scope limits [documented]:** the token "can only make model requests": it cannot open Remote Control sessions or fetch claude.ai connectors, though locally configured MCP servers work. It carries only the `user:inference` scope, so `/usage` inside the Sandbox does **not** return structured plan usage ([Agent SDK TypeScript: `usage_report`](https://code.claude.com/docs/en/agent-sdk/typescript)).
- **Precedence [documented]:** `CLAUDE_CODE_OAUTH_TOKEN` is 5th in priority. It is outranked by cloud-provider variables, `ANTHROPIC_AUTH_TOKEN`, **`ANTHROPIC_API_KEY`** and `apiKeyHelper`. "In non-interactive mode (`-p`), the key is always used when present", with no approval prompt ([Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)).
- **`--bare` cannot use it [documented]:** "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`." It needs an API key or an `apiKeyHelper`. The docs also say `--bare` "will become the default for `-p` in a future release" ([Headless](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)). **If that default changes, subscription-authenticated headless runs need an explicit opt-out.** Watch the changelog.
- **Organisation scope [documented]:** for a secret shared across repos, the docs recommend an API key "since an OAuth token is tied to the subscription of the person who ran `claude setup-token`" ([GitHub Actions: Set up for an organization](https://code.claude.com/docs/en/github-actions#set-up-for-an-organization)). With a single Operator this is fine, but it confirms the token is personal.

**How Sandcastle does it** (local clone at commit `85e8e6d`, 2026-11-01; read only):

- `sandcastle init` scaffolds `.sandcastle/.env` with `CLAUDE_CODE_OAUTH_TOKEN=`, a hint to run `claude setup-token` on the host, and a commented-out `ANTHROPIC_API_KEY=` fallback (`src/InitService.ts`, CHANGELOG entry `86aec83`).
- Each Sandbox gets a fresh private home, so host logins (`~/.claude`) never reach the agent. Auth comes only from env vars (`docs/guide/sandbox-providers.md`, `docs/guide/getting-started.md`).
- The agent runs `claude --print --verbose --output-format stream-json --model <m> [--effort e] -p -` with the prompt on stdin (`src/AgentProvider.ts`).
- Sandcastle's own verify script warns: "Claude Code may use ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN when both reach it … your own .sandcastle runs could bill the API" (`.sandcastle/setup-verify-keys.sh`). It also has an env-leak test that flags `ANTHROPIC_API_KEY` (`.sandcastle/verify/envLeaks.test.ts`).
- The subscription path was added after Anthropic's 2026-06-15 clarification ([sandcastle#191](https://github.com/mattpocock/sandcastle/issues/191), closed that day).

Fabrik can use this unchanged. That fits the standing decision to consume Sandcastle upstream rather than fork it.

**Tension with "Sandboxes hold no production secrets":** the OAuth token is not a production secret. It is, however, a year-long credential to the Operator's whole subscription, and it sits in an environment where an AFK agent runs arbitrary code. An agent that was prompt-injected could read it out of its own env. Treat it as a secret the Kit has to scope, and plan for rotation.

## 3. Ultra (formerly Max x20) limits and how they are measured

| Fact | Source | Status |
|---|---|---|
| "The Max 20x plan is now called the Ultra plan. Existing Max 20x subscribers move to Ultra automatically, with no price change." $200/month, monthly billing only. | [What is the Ultra plan?](https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan) | documented |
| Ultra gives "10 times the Pro plan's usage every week". **Verified Ultra accounts don't have a five-hour limit.** Unverified accounts get a temporary 5-hour limit, removed automatically based on account and payment history. To check: Settings › Usage shows no "Current session" bar on a verified account. | same | documented |
| "Ultra plans have a weekly usage limit that applies across all models, and a separate weekly limit for Fable." Pricing page: Fable is "included, up to 50% of weekly limits". | same; [claude.com/pricing](https://claude.com/pricing) | documented |
| Max is now $100/month: "5x Pro usage" every 5 hours and every week, with Fable "up to half your weekly limit". | [pricing](https://claude.com/pricing); [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) | documented |
| Weekly limits reset "at a fixed time each week that is assigned to your account". The 5-hour window (where it applies) starts at the first message and resets in full five hours later. | [How do usage and length limits work?](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) | documented |
| Usage across claude.ai, Claude Code and Desktop "counts towards the same usage limit". Cloud sessions and scheduled routines also draw on it. | same; [Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web); [Routines](https://code.claude.com/docs/en/routines#usage-and-limits) | documented |
| Usage depends on "length and complexity …, features, … model, and the effort level". Allowances are not published in tokens or hours. | same | documented (the absence is documented too) |
| "We may limit your usage … with weekly and monthly caps or model and feature usage … We don't guarantee uninterrupted service." | Ultra and limits articles | documented |
| Claude Code has model-family limit messages: "You've hit your Opus limit" and "You've hit your Sonnet limit". These "apply only to requests to that model family". Session and weekly limits are shared across all models. | [Errors: Usage limits](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit) | documented; whether Ultra currently has per-family caps is **ambiguous** |
| "A single burst of heavy activity, such as a large workflow fanout, can exhaust the weekly allowance before the session window resets." | same | documented |

**Measuring from a Sandbox:**

- The Agent SDK and `stream-json` emit `rate_limit_event` with `status` (`allowed` / `allowed_warning` / `rejected`), `utilization` and `resetsAt` ([SDK TypeScript: `SDKRateLimitEvent`](https://code.claude.com/docs/en/agent-sdk/typescript)) [documented].
- The structured `/usage` report is unavailable with a `setup-token` token, which lacks `user:profile`.
- An interactive status line exposes `rate_limits.five_hour` and `seven_day` `used_percentage` for subscribers ([Status line](https://code.claude.com/docs/en/statusline)).
- The `total_cost_usd` in `--output-format json` is a client-side list-price *estimate*, not a draw on the subscription ([Headless](https://code.claude.com/docs/en/headless)).

**Practical upshot:** the Kit can only see pressure on the limit by watching `rate_limit_event` across runs, or by having the Operator check Settings › Usage. That bears on the map's *Observability* gap.

## 4. Per-run model choice and its effect on limits

- **Per run [documented]:** `claude --model <alias|id>` or `ANTHROPIC_MODEL` applies to that session only. `/model` in a prompt also works under `-p`. Aliases are `opus` (Opus 5.5), `sonnet` (Sonnet 5.5), `haiku` (Haiku 5.5), `fable` (Fable 5.1), `best` and `opusplan`. The account default on Pro/Max/Ultra is **Opus 5.5** ([Model configuration](https://code.claude.com/docs/en/model-config)). Sandcastle already passes `--model` and `--effort` per run.
- **Effect on limits [documented]:** usage scales with model and effort. The support centre recommends "the most recent Sonnet model or the Haiku model" for most tasks because they cost fewer tokens than Opus ([Manage usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)). Implementers on Sonnet or Haiku stretch the weekly pool. The exact exchange rate between models within a plan is **not published**.
- **No automatic step-down at a limit [documented]:** `--fallback-model` triggers on overload or unavailability only. "Authentication, billing, rate-limit … errors … never trigger a switch" ([Model configuration: fallback chains](https://code.claude.com/docs/en/model-config)). The orchestrator has to switch models itself, which only helps for the per-family Opus or Sonnet limits.
- **Fable as the Reviewer's "frontier model" [documented]:** Fable has its own weekly cap (≤50% of the Ultra weekly limit). Past that point, "Fable usage can bill to usage credits". **In `-p` mode, "Claude Code never asks for consent. When a Fable request there would bill to usage credits, Claude Code bills it without asking."** ([Model configuration: Fable and usage credits](https://code.claude.com/docs/en/model-config)). Opus 5.5, the default, carries no such clause.

## 5. Realistic concurrency

- **No documented cap on simultaneous CLI or SDK sessions for a subscription [documented absence].** The constraint is the token pool. Cloud sessions "share rate limits with all other Claude and Claude Code usage within your account. Running multiple tasks in parallel consumes more rate limits proportionately" ([Cloud sessions: Limitations](https://code.claude.com/docs/en/claude-code-on-the-web)). The 429 guidance says "Reduce concurrency: avoid running many parallel subagents, or switch to a smaller model … for high-volume scripted runs" ([Errors: Request rejected (429)](https://code.claude.com/docs/en/errors#request-rejected-429)).
- **Short-lived server throttles** ("Server is temporarily limiting requests (not your usage limit)") are separate from the plan quota and retried automatically since v2.1.199 [documented].
- **Routines** (Anthropic-hosted scheduled runs) have a separate cap of 100 scheduled runs per hour per account, plus an organisation-level limit on "cloud sessions running at once" whose value is not published [documented].
- **Realistic figure [ambiguous / inference]:** with no 5-hour window on verified Ultra, a handful of parallel Implementers (say 2–4) is limited by how fast they burn the *weekly* allowance, not by any slot count. Anthropic publishes no token figures, so the only reliable number is one the Operator measures on the Pilot over a week. Treat concurrency as a budget knob ("what fraction of the week may AFK work consume?"), not a capacity one.
- **[hearsay]** Community reports since 2025 say Anthropic introduced weekly limits partly in response to accounts running Claude Code around the clock. No primary source was found for that rationale. Its fit with the "ordinary, individual usage" wording is the reason to keep AFK volume modest.

## 6. What happens at the limit

- **Usage credits off (recommended):** "Claude Code blocks further requests until the reset time shown in the message" ([Errors](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit)). In the SDK this shows up as `rate_limit_event` with `status: "rejected"`, and, where credits could be bought, `errorCode: "credits_required"` [documented]. By default a `-p` run retries 429s up to `CLAUDE_CODE_MAX_RETRIES` (10) and then fails.
- **Waiting it out unattended [documented]:** set `CLAUDE_CODE_RETRY_WATCHDOG=1`. It retries 429/529 indefinitely, backing off "until the limit resets when the response carries a rate-limit reset time, so a session that hits a usage limit waits out the remaining window". `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` caps the wait, and `…_USAGE_LIMIT_RECHECK_MS` re-checks early. The watchdog "fails at once" on a 429 that reports a spend limit or exhausted usage credits ([Env vars](https://code.claude.com/docs/en/env-vars)). The interactive "wait and continue after reset" feature exists only in interactive sessions.
- **Wrap-up allowance:** applies only to a 5-hour limit, so it is irrelevant on verified Ultra [documented].
- **Usage credits on:** "requests switch to pay-as-you-go pricing on usage credits and keep working … until you reach your monthly spend limit" ([Manage usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)). The orchestrator sees no prompt and no pause, only a bill.

## 7. Anything that would force or silently cause metered spend

| Trigger | Effect | Status | Kit guard |
|---|---|---|---|
| **Usage credits enabled** on the Operator's claude.ai account | Every run past the weekly (or Fable) limit continues at API rates, unattended | documented | Keep usage credits **disabled** (Settings › Usage), or set a hard monthly spend cap |
| **Fable selected in `-p` or SDK** after its included share is used, with credits on | Billed "without asking" | documented | Don't run Fable AFK, or keep credits off so the run blocks instead |
| **`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper`) visible in the Sandbox** | Outranks the OAuth token. In `-p` it is "always used when present", which means API billing | documented | Allow-list Sandbox env and fail a run if any such variable is present (Sandcastle's env-leak check does this) |
| **`--bare`** (and a future release where `-p` defaults to bare) | Cannot use the OAuth token; needs an API key | documented | Never pass `--bare`; re-check when `-p` defaults change |
| **Org-wide or shared tokens** | Docs steer shared CI secrets to API keys | documented | Not needed with one Operator |
| **Monthly API credits ($200 on Ultra)** | Cover `claude -p` only when run with a Console API key. They "can't be used in Claude Code"; exhausted credits stop API requests unless the Console has purchased credits or auto-reload | documented ([Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)) | Leave Console auto-reload off. This is a capped, prepaid pool the Operator could choose to use for overflow, not a quiet fallback |
| **1M context** | Included with Max and Ultra for the models listed; "requires usage credits" on Pro | documented | n/a on Ultra |
| **Anthropic reinstates the paused SDK / `-p` change** | Headless use would move to a separate credit | documented (paused) / hearsay (details) | Keep an API-key path designed but switched off, as an Operator decision |

Nothing in the documented setup *forces* API spend. Every path to metered billing goes through an account setting or an environment variable the Kit can control.

## 8. Alternatives noted in passing (not evaluated here)

- **Cloud sessions and routines** run on Anthropic infrastructure, keep running "after you close your laptop", use subscription credentials ("If you set `ANTHROPIC_API_KEY` … it doesn't override your subscription credentials"), and add no VM charge ([Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web); [Authentication](https://code.claude.com/docs/en/authentication)). They are relevant to the hosting research. They are not Sandcastle Sandboxes.
- **The GitHub Action** with `claude_code_oauth_token` is Anthropic's own sanctioned example of subscription-billed AFK runs.

## Open questions this research could not close

1. Absolute Ultra weekly allowance, and the relative cost of Haiku, Sonnet, Opus and Fable within it. Not published; measure on the Pilot.
2. Whether Ultra currently applies per-family (Opus or Sonnet) weekly caps. The messages exist in Claude Code, but the plan pages don't list them.
3. Where "ordinary, individual usage" ends. Only Anthropic sales or support can answer this ([contact link on the legal page](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
4. Whether a `setup-token` token can be revoked or rotated without logging out everywhere. Not documented.
