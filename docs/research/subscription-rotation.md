# Rotating between two Claude subscriptions: terms, detection and mechanics

Research for Decision #88 on the Map #62 (Wayfinder: Fabrik V2). Sources were read on 2026-11-04. Claude Code docs at code.claude.com were fetched as Markdown on that date, and the Agent SDK was `@anthropic-ai/claude-agent-sdk@0.3.317`. The terms section is a reading of Anthropic's published terms. It is not legal advice.

The question: the Operator holds two Claude Ultra subscriptions. Can the Kit run on a `claude setup-token` token from the first, and switch to a token from the second when the first reaches its weekly limit?

## Answer in brief

- **Terms: not addressed by name, and the closest wording leans against it.** No Anthropic document says one person may, or may not, switch between their own subscriptions to keep working past a usage limit. Each piece around it is clear:
  - Using a `setup-token` token in CI is **explicitly permitted**.
  - Holding more than one account is **contemplated** in the docs, as "work and personal accounts".
  - Anthropic's listed remedies at a limit are **wait, buy usage credits, or upgrade**. Switching accounts is not one of them.
  - Its usage limits "assume ordinary, individual usage".
  - The Usage Policy forbids creating multiple accounts "to … circumvent product guardrails" and forbids intentionally bypassing "restrictions … established within our products".

  Whether a weekly limit is a "restriction" or "guardrail" in that sense is not defined. A plain reading of "Intentionally bypass … restrictions … established within our products" can cover a script whose purpose is to keep working once one account's limit is reached. **The terms neither permit this nor name it as forbidden. It is a grey area with real enforcement risk:** Anthropic "may … throttle, limit, suspend, or terminate your access", and termination for breach forfeits any refund. If the Operator wants certainty, the only first-party route is to ask Anthropic (the Claude Code legal page points to "contact sales").
- **Detection: the Kit only learns of the limit once a request is rejected.** `src/agent/failure.ts` classifies a run as `weekly-limit` when the stream has a `rate_limit_event` with `status: "rejected"` and a `seven_day*` `rateLimitType`. By then the run has failed. The same event type also carries `status: "allowed_warning"`, `utilization` and `surpassedThreshold`, so an earlier warning is possible in principle. Whether `claude -p` emits a `seven_day` warning, and at what threshold, is **not documented and not verified**. Plan to switch on rejection and treat any warning as a bonus.
- **Mechanics: feasible within ADR-0004 without new service accounts.** Put the second token in the same `Fabrik` vault as a second item. Choose which item to load in a step before `load-secrets-action`, keyed on which token has an open weekly-limit issue. Run the existing preflight unchanged against whichever token is loaded. Add one check per token: refuse a token whose `rate_limit_event` shows usage credits (overage) in use or enabled, because a subscription token with usage credits on can bill metered spend that the preflight can't see today.

## 1. Terms

### What applies

The Claude Code legal page says which terms govern a Free, Pro, Max or Ultra user [L1]:

> Your use of Claude Code is subject to: … [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) - for Free, Pro, Max, and Ultra users

The Consumer Terms (effective Oct 8, 2025 [T1]) bring in the Usage Policy and any supplemental terms posted on the Services, and those supplemental terms win where they conflict:

> You may access and use our Services only in compliance with our Terms, including our Acceptable Use Policy, … and any guidelines or supplemental terms we may post on the Services (the "Permitted Use"). [T1 §3]

> If these Terms conflict with Supplemental Terms, the Supplemental Terms will govern for the applicable Service. [T1 §12, "Supplemental terms"]

So the Claude Code legal page [L1] and the Usage Policy [U1] both bind the Operator.

### Automation with a subscription token: permitted

The Consumer Terms ban automated access except where Anthropic permits it:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise. [T1 §3]

Anthropic does explicitly permit it for `setup-token` tokens in CI:

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token` [C1, "Generate a long-lived token"]

> `CLAUDE_CODE_OAUTH_TOKEN`: an OAuth token that authenticates with your Claude subscription, available on Pro, Max, Ultra, Team, and Enterprise plans. Generate one by running `claude setup-token` locally. [C2, "Manual setup"]

> If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing. [C2, "Manage costs"]

The Kit's use of one token in GitHub Actions on the Operator's own repos is therefore within the explicit permission. Two limits on that permission matter here.

First, the token is personal:

> an OAuth token is tied to the subscription of the person who ran `claude setup-token`. [C2, "Set up for an organization"]

Second, subscription OAuth is for "ordinary use":

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications. [L1, "Authentication and credential use"]

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK. [L1, "Acceptable use"]

"Ordinary" and "individual" are not defined.

### One person holding several accounts: contemplated, not restricted

The Consumer Terms say nothing about how many accounts a person may hold. They only bar sharing:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else. [T1 §2]

The Claude Code docs describe being signed in to several accounts as a normal setup:

> To stay signed in to multiple accounts at once, such as work and personal accounts, give each account its own configuration directory. [C1, "Log in with multiple accounts"]

Both of the Operator's subscriptions are their own, used only by them, so §2 isn't engaged. Holding two is not forbidden.

### Switching accounts to continue past a limit: not addressed by name

No source read says "you may switch accounts when you reach a limit" or "you may not". These are the closest passages.

**Anthropic's own remedies.** None of them is a second account:

> If you hit your session limit or weekly limit, you can wait for it to reset or upgrade your plan. … With usage credits enabled, your work continues on usage credits instead of stopping. [K1]

> **What to do:** Wait for the reset time shown in the error … Run `/usage-credits` to buy additional usage on Pro, Max, and Ultra … To upgrade your plan for higher base limits, see claude.com/pricing [C3, "You've hit your session limit"]

**The Usage Policy's platform-abuse rules.** The version on anthropic.com/legal/aup today shows **effective Nov 12, 2026**, eight days after this research. Its version history lists Sep 15, 2025 as the previous version. Only the Nov 12 text could be read. Under "Do Not Abuse Our Platform" it forbids using the products to [U1]:

> Coordinate malicious activity across multiple accounts, or create multiple accounts, to avoid detection, circumvent product guardrails, or generate identical or similar inputs that otherwise violate our Usage Policy

> Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products, including by circumvention of the account sign-up or log-in process or by instructing the model to produce harmful outputs (e.g., jailbreaking or prompt injection), without prior authorization from Anthropic

> Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used

And the Consumer Terms' catch-all [T1 §3]:

> You also must not abuse, harm, interfere with, or disrupt our Services, including, for example, … bypassing any of our systems or protective measures.

**Reading them against the plan:**

- The first clause covers *creating* accounts *to* circumvent guardrails. If the second subscription was bought so the Kit could keep running past the first one's limit, that matches the purpose the clause names, assuming a usage limit counts as a "product guardrail". Neither document defines "guardrail".
- The second clause is the closest fit. A weekly usage limit is plainly a restriction "established within our products", and the Kit would be switching tokens on purpose so that the restriction stops it working. The clause's examples (sign-up or log-in circumvention, jailbreaking) are about safety controls, not quotas. Nothing says the clause is limited to them, and nothing says quotas are included.
- The third clause targets third parties routing *other people's* requests through consumer subscriptions. The Kit serves only the Operator, so it doesn't apply, as long as every Product repo is the Operator's own.
- The "ordinary, individual usage" line [L1] is an assumption behind the advertised limits, not a prohibition. It does signal that Anthropic sizes limits for one person, and two subscriptions driven by one automation exceeds that.

**Enforcement.** The Usage Policy says [U1]:

> If we suspect that you may have violated our Usage Policy, we may warn you or throttle, limit, suspend, or terminate your access to our products and services.

The Claude Code legal page says [L1]:

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The Consumer Terms say [T1 §12, "Termination"]:

> If we terminate your access to the Services due to a violation of these Terms and you have a Subscription, you will not be entitled to any refund.

**Verdict.** **Not addressed.** The terms explicitly allow the two ingredients separately: a subscription token in CI, and one person holding several accounts. Nothing allows or forbids combining them to continue past a limit. The Usage Policy's ban on intentionally bypassing "restrictions … established within our products" can reasonably be read to cover it, and Anthropic's own list of what to do at a limit leaves it out. Treat it as a risk to the Operator's accounts, not as a permitted feature. The sanctioned ways to keep working are usage credits (metered, which the Kit refuses today) or waiting. Anthropic names "contact sales" as the place to ask about authentication use cases [L1].

## 2. Detection

### What the Kit does today

- `src/agent/failure.ts` (`providerError`): when the run's last `result` is an error, it collects `rate_limit_event` messages with `rate_limit_info.status === "rejected"`. If any has a `rateLimitType` starting `seven_day`, the run is a `weekly-limit` failure, with `resetsAt` (epoch seconds) converted to ISO 8601. A rejected non-weekly limit becomes `provider-error`.
- `src/loop/failures.ts`: `weekly-limit` is an Infrastructure failure. It is never retried and never counts against a Ticket's retries.
- `src/loop/kitIssues.ts`: the first such failure opens one Kit-owned issue labelled `fabrik:weekly-limit`, recording the reset time. Each later failure in the window comments on that issue. The scheduled tick (`schedule.yml`) closes it after `resetsAt`. Stalled Tickets stay stalled "until their trigger label is re-added".
- Nothing gates new runs on that issue. `dispatch.ts` and `rules.ts` don't read `WEEKLY_LIMIT_LABEL`, so every run in the window starts, fails and adds a comment.
- The issue is per Product repo, but the token is shared by every Product repo (ADR-0004). Each repo learns about the limit on its own, by losing one run.

### Does `rate_limit_event` warn early enough?

The SDK type (`sdk.d.ts`, `SDKRateLimitInfo`, documented as "Rate limit information for claude.ai subscription users") [S1]:

```ts
status: 'allowed' | 'allowed_warning' | 'rejected';
resetsAt?: number;
rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
utilization?: number;
overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
overageDisabledReason?: 'overage_not_provisioned' | … | 'out_of_credits' | … ;
isUsingOverage?: boolean;
overageInUse?: boolean;
overageEnabled?: boolean;
surpassedThreshold?: number;
```

The CLI does warn interactively before a window runs out [C3]:

> Before a window runs out, Claude Code can warn you that you've used most of it, with a message such as `You've used 85% of your session limit · resets 3:45pm`.

`allowed_warning` with `surpassedThreshold` is very likely the stream form of that warning. What isn't known:

- whether `claude -p` emits a `seven_day` `allowed_warning` on a `setup-token` token, and at which thresholds. The docs' example is the session limit, which verified Ultra accounts don't have [K2];
- whether `utilization` is 0–1 or 0–100. The prior finding left this open too.

The `/usage` report, which gives the exact weekly percentage, needs the `user:profile` scope. A `setup-token` token carries only `user:inference` (prior finding [R1], Route B), so it is closed to the Kit.

**What this means for switching:**

- **Reactive switching works with what's there.** A `rejected` `seven_day` event is reliable and already parsed. The run that hit it is lost, but it's an Infrastructure failure, so it costs no retries. The Operator, or a rule, re-adds the trigger label once the next token is active.
- **Proactive switching is speculative until observed.** Log every `rate_limit_event` line (Decision #67 already recommends capturing them). After a week or two of real runs, see whether `allowed_warning` / `seven_day` lines appear and at what `utilization`. Only then add a rule such as "at the first `seven_day` warning, prefer the other token for new runs".
- **A run can't move tokens mid-flight.** `CLAUDE_CODE_OAUTH_TOKEN` is read at launch, and the docs give no way to swap it inside a `-p` process. The next run has to pick the other token.

## 3. Mechanics under ADR-0004

### Storage

- Add a second 1Password item in the existing `Fabrik` vault, for example `Claude token 2`, holding the second account's `setup-token` output as an API Credential with its expiry date. Watchtower then covers both tokens, as ADR-0004 does for the first.
- ADR-0004 says "Service-account permissions can't be changed after creation". That doesn't block this: the `agent` and `implement` accounts are granted the whole `Fabrik` vault, so a new item in it is readable without new service accounts.
- Today the reference is a literal in `loop.yml`, repeated in each agent job: `CLAUDE_CODE_OAUTH_TOKEN: op://Fabrik/Claude token/credential`. Because `loop.yml` is the Kit's own reusable workflow, versioned with the Kit (ADR-0003), changing it doesn't touch the Product repo's `fabrik.yml`.

### Selection

Two shapes are possible.

1. **Choose before loading (recommended).** A step before `load-secrets-action` decides which item to load, and the reference becomes `op://Fabrik/${{ steps.token.outputs.item }}/credential`. The step can run in the existing `prepare-agent` action, which already has a GitHub token. It decides from the open Kit-owned weekly-limit issues: if token 1's issue is open and token 2's isn't, load token 2.

   This keeps ADR-0004's property that "even an agent that dumps memory reaches only the token it already has". The agent job holds one token, never both.

   It needs the weekly-limit issue to say **which token** hit the limit, so there can be one open issue per token: a slot field in the body beside the reset time, or a label per slot. It also needs `failure.ts` / `agent-failure.json` to carry the slot (`FailureReport` gains `token`), and `kitIssues.ts` to open, comment on and close per slot.

   **Each account's weekly reset is at "a fixed time each week that is assigned to your account" [K1], so the two tokens reset at different times.** The scheduled tick has to close each slot's issue on its own reset.
2. **Load both and choose in `run.ts`.** This is simpler in the workflow, but every agent job then holds both tokens in memory, which widens what a memory dump reaches. Both credentials are the Operator's, so it's no new *kind* of exposure. It still breaks the "only the token it already has" wording of ADR-0004 and would need an ADR amendment. Not recommended.

The Kit also has to decide what happens when **both** tokens are limited. The behaviour would be what it does today: stall, with both issues open, notifying the Operator once per slot.

`run.ts` and `secrets.ts` need almost no change: `CLAUDE_TOKEN_ENV` stays the one env name, and only the value differs. `sandboxEnv` takes `CLAUDE_CODE_OAUTH_TOKEN` from the resolved outputs whichever item it came from. `src/kit/config.ts` doesn't hold the token at all, and should stay that way: `RESERVED_ENV_PREFIXES` already stops a Product repo from naming `CLAUDE_*`. Whether rotation is enabled could be a Kit config field (for example `claude_tokens: 1 | 2`), or simply follow from whether the second item exists.

### What the metered-billing preflight must check per token

The preflight is `src/preflight/meteredBilling.ts` (the task brief points at `src/kit/config.ts`; that file only refuses Fable and reserved env names). It already runs per launch, against the env, settings files, arguments and `claude auth status --json`, and `checkInitMessage` requires `apiKeySource: "none"`. Because it runs on whichever token was loaded, **every existing check covers the second token without change.** Each token still has to pass `loggedIn: true`, `authMethod: "oauth_token"` and `apiProvider: "firstParty"`.

One gap matters more with two accounts: **usage credits.** A subscription token on an account with usage credits turned on keeps working past the plan limit, billed as metered spend:

> With usage credits enabled, your work continues on usage credits instead of stopping. [K1]

> Usage credits let you keep working past your plan's usage limit. [C4]

That is exactly the metered billing the preflight exists to refuse. None of its current checks can see it, because the env, settings and auth status look the same either way. The more accounts the Kit runs on, the more chance one has usage credits on. Two checks would close it:

- **Backstop in the stream.** Treat any `rate_limit_event` with `isUsingOverage: true` or `overageInUse: true`, or a `rateLimitType` of `overage`, as a metered-billing refusal. Stop the run and report `metered-billing` with the token slot, the same way `checkInitMessage` is a backstop today.
- **Preflight per token, best effort.** If the first `rate_limit_event` of a run shows `overageEnabled: true`, refuse before real work starts. Whether that field arrives early, on every run, on a `setup-token` token is **not verified**. Until it is, keep this as the backstop above, and require in setup that usage credits are off on both accounts (Settings > Usage on claude.ai [C4]).

## Open questions

- Whether `claude -p` emits `seven_day` `allowed_warning` events, at which `surpassedThreshold`, and the scale of `utilization`. Answer it by logging `rate_limit_event` lines from real Kit runs.
- Whether the overage fields arrive on every run, early enough to refuse before work starts.
- The terms question cannot be settled from published text. Only Anthropic can say whether rotating between one person's two subscriptions is acceptable. The Usage Policy version in force today (Sep 15, 2025) was not read; the quotes are from the Nov 12, 2026 version that the page now shows.

## Sources

- [T1] Anthropic, Consumer Terms of Service, effective Oct 8, 2025: https://www.anthropic.com/legal/consumer-terms (§2 Account creation and access; §3 Use of our Services; §6 Subscriptions; §12 Supplemental terms and Termination)
- [U1] Anthropic, Usage Policy, effective Nov 12, 2026 (latest in version history; previous version Sep 15, 2025): https://www.anthropic.com/legal/aup ("Do Not Abuse Our Platform"; enforcement paragraph)
- [L1] Claude Code, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance ("License", "Acceptable use", "Authentication and credential use")
- [C1] Claude Code, Authentication: https://code.claude.com/docs/en/authentication ("Log in with multiple accounts", "Authentication precedence", "Generate a long-lived token")
- [C2] Claude Code, GitHub Actions: https://code.claude.com/docs/en/github-actions ("Manual setup", "Set up for an organization", "Manage costs")
- [C3] Claude Code, Error reference: https://code.claude.com/docs/en/errors ("You've hit your session limit")
- [C4] Claude Code, Manage costs effectively: https://code.claude.com/docs/en/costs (usage credits)
- [K1] Claude Help Center, Understanding usage and length limits: https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits
- [K2] Claude Help Center, Use Claude Code with your Pro, Max, or Ultra plan: https://support.claude.com/en/articles/11145838-using-claude-code-with-your-max-plan ("verified Ultra accounts don't have a five-hour session limit"; limits shared across Claude and Claude Code)
- [S1] `@anthropic-ai/claude-agent-sdk@0.3.317`, `sdk.d.ts`, `SDKRateLimitInfo`
- [R1] Prior finding for Decision #67: https://github.com/jrey8343/fabrik/blob/research/subscription-cost-equivalent/research/subscription-cost-equivalent.md
- Fabrik source: `src/agent/failure.ts`, `src/agent/run.ts`, `src/kit/config.ts`, `src/kit/secrets.ts`, `src/preflight/meteredBilling.ts`, `src/loop/failures.ts`, `src/loop/kitIssues.ts`, `.github/workflows/loop.yml`, `docs/adr/0004-afk-secrets-come-from-1password.md`
