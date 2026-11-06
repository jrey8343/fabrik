# Subscription usage as an equivalent API cost and weekly-limit share

Research for Decision #67 on the Map #62 (Wayfinder: Fabrik V2). Sources were read on 2026-11-04. Claude Code was at v2.1.317 and the Agent SDK at v0.3.317 (`@anthropic-ai/claude-agent-sdk`, type declarations in `sdk.d.ts`).

## Answer in brief

- **Equivalent API cost: yes, and the Kit already receives it.** The `result` message at the end of every `claude -p --output-format stream-json` run carries `total_cost_usd` and a per-model `modelUsage[model].costUSD`. Claude Code works these out on the machine from token counts at **list price**, whatever the auth method. On a subscription token they don't describe a bill. They do give exactly what this Decision asks for: what the run would have cost on the API. The Kit can also work the figure out itself from the token counts and the price table below.
- **Weekly-limit share: readable in two ways, but neither works with the Kit's current token; otherwise only an estimate.**
  1. The **`rate_limit_event`** stream message has a `rateLimitType` (which can be `seven_day`) and a `utilization` field. It is documented for claude.ai subscription sessions. How often it is emitted, and whether a `seven_day` one arrives on every run, is **not documented and not verified here**.
  2. The **`/usage` report** gives the exact `seven_day` percentage and reset time. You can get it as the `usage_report` field when `/usage` is sent as a prompt, or through the SDK's experimental `get_usage` control request. Both need the **`user:profile` OAuth scope**. A `claude setup-token` token, which is what the Kit uses, carries only `user:inference`, so the report comes back without rate limits.
  3. Otherwise the share **can only be estimated**. Anthropic publishes no numeric weekly allowance. The estimate is a run's API-equivalent dollars divided by a weekly allowance, calibrated in API-equivalent dollars.

## 1. Current API prices (USD per million tokens)

From the Anthropic pricing page [P1]. These are first-party, global-routing prices.

| Model                                                                             | Base input | 5m cache write | 1h cache write | Cache read (hit/refresh) | Output |
| --------------------------------------------------------------------------------- | ---------- | -------------- | -------------- | ------------------------ | ------ |
| Claude Opus 5.5 (`claude-opus-5-5`, Kit default for triage/design/review/step-up) | $4         | $5             | $8             | $0.20                    | $20    |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`, Kit default for implement)                | $2         | $2.50          | $4             | $0.10                    | $10    |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5                                             | $5         | $6.25          | $10            | $0.50                    | $25    |
| Claude Sonnet 5                                                                   | $2         | $2.50          | $4             | $0.20                    | $10    |
| Claude Sonnet 4.6 / 4.5                                                           | $3         | $3.75          | $6             | $0.30                    | $15    |
| Claude Haiku 5.5 (prompt ≤ 100k tokens)                                           | $0.10      | $0.125         | $0.20          | $0.01                    | $0.50  |
| Claude Haiku 5.5 (prompt > 100k tokens)                                           | $0.50      | $0.625         | $1             | $0.05                    | $2.50  |
| Claude Haiku 4.5                                                                  | $1         | $1.25          | $2             | $0.10                    | $5     |
| Claude Fable 5.1 / Mythos 5.1 (the Kit refuses Fable)                             | $10        | $12.50         | $20            | $0.25                    | $50    |

Multipliers [P1]:

- Cache writes cost 1.25× base input on the 5-minute TTL and 2× on the 1-hour TTL.
- Cache reads cost 0.1× base input on most models, 0.05× on Opus 5.5 and Sonnet 5.5, and 0.025× on Fable 5.1 and Mythos 5.1.
- Fast mode costs $8 / $40 on Opus 5.5 and $10 / $50 on Opus 5 and 4.8, with the caching multipliers applied on top.
- US-only inference (`inference_geo: "us"`) costs 1.1× on every token category.
- Web search costs $10 per 1,000 searches.
- The full 1M context window is billed at the standard rate on every 4.6+ model except Haiku 5.5. Haiku 5.5 prices each request by its prompt length, cache reads included, against the 100k threshold.

One discrepancy: the `claude-api` skill's model notes give Sonnet 5.5 cache reads as $0.20. The pricing page gives $0.10 and states the 0.05× multiplier in a footnote. This note follows the pricing page.

**Which cache-write rate applies to Kit runs.** Claude Code asks for the 1-hour TTL on the main conversation, and on some helper requests, _only on a Claude subscription within the plan's included usage_. Subagents get the 5-minute TTL by default, and so does any request once usage credits are being drawn [C4][C2]. So when a Kit run is priced, its main-loop cache writes belong at the **1h** rate, while subagent writes belong at the **5m** rate. The result message's `usage.cache_creation` splits writes into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`, but only for the main loop.

## 2. Is the stream-json result's cost meaningful on a subscription token?

**What the field is.** `total_cost_usd` and `costUSD` are "client-side estimates, not authoritative billing data". The SDK "computes them locally from a price table bundled at build time, unless a `modelPricing` table is in effect" [C2]. The `/usage` docs say the same for the interactive figure: Claude Code works out the dollar amount "locally from token counts at list price" [C1]. For subscribers, "the session cost figure isn't relevant for billing purposes" [C1]. In other words, it is a list-price API equivalent, which is what this Decision needs.

**Caveats that matter to the Kit:**

- **Staleness.** The figure can drift from real prices when "pricing changes" or "the installed SDK version does not recognize a model" [C2]. Each `modelUsage` entry has a `costBasis` of `list`, `managed` or `unknown`. `unknown` means "no pricing row and no built-in price matched the model ID, so costUSD is a guess at the default model's rate" [S1]. The Kit should record `costBasis` and treat `unknown` as "no figure".
- **Subagents.** The result's `usage` "counts only the top-level agent loop". `total_cost_usd` and `modelUsage` include subagent requests [C2]. Today `src/agent/summary.ts` reads token counts from `result.usage`, so its step summary **undercounts any run that spawns subagents**. Read `modelUsage` for whole-run accounting.
- **Crashes and budgets.** An `error_during_execution` result after a crash "may carry zeroed `usage`, `total_cost_usd`, and `modelUsage`". On `error_max_budget_usd`, `usage` leaves out the response that crossed the budget [C2].
- **Resumed sessions.** A run that uses `--resume` or `--continue` reports the session's whole total, earlier runs included (since v2.1.277) [C2][C3]. The Kit doesn't resume today. If it ever does, it should take the difference between results rather than add them up.
- **Per-step output tokens** on assistant messages are placeholders. Only the result message carries real output totals [C2].
- `modelPricing` can override the price table, but only through _managed_ settings [C5]. It is not needed for list-price equivalence.

**Recomputing it independently** (recommended as a cross-check, and so the Kit owns its price table):

```
cost(model) = inputTokens·in + outputTokens·out + cacheReadInputTokens·read
            + cacheCreationInputTokens·write
```

Take the per-model token counts from `modelUsage`. For writes, price the main loop's `usage.cache_creation.ephemeral_1h_input_tokens` at the 1h rate and everything else at the 5m rate. Whether Claude Code's own built-in table prices 1h writes at 2× is **not documented**. Comparing the Kit's figure against `total_cost_usd` on real runs will show it.

Worked example, illustrative only: a Sonnet 5.5 implement run with 20k input, 60k output, 300k cache writes (1h) and 4M cache reads costs 0.02·2 + 0.06·10 + 0.3·4 + 4·0.10 = **$2.24**. Most of it is cache writes and output. Cache reads are a small share even at 4M tokens.

## 3. Can usage against the weekly limit be read?

### What the limit is

- Every paid plan has a weekly limit. All plans except verified Ultra accounts also have a five-hour session limit [K2]. "Weekly limits apply across all models, and some plans also have a separate weekly limit for Fable" [K1]. The Operator is on Ultra (`src/preflight/meteredBilling.ts`), so the **weekly window is the binding one**.
- Usage "is affected by … the length and complexity of your conversations, the features you use, which Claude model you're chatting with, and the effort level you've selected". Anthropic publishes **no numeric allowance** and "may adjust usage limits at our discretion" [K1].
- Claude Code usage shares one pool with claude.ai chat and Cowork [C1][K1]. Long sessions re-read their history "at the cached token rate" [C1]. That suggests plan usage weights tokens roughly the way API pricing does, cheap cache reads included, but this is an **inference, not a published rule**.

### Route A: `rate_limit_event` in the stream (no extra scope, opportunistic)

The SDK types declare a stream message `{ type: "rate_limit_event", rate_limit_info }`, which they describe as "Rate limit information for claude.ai subscription users" [S1]. Its info carries:

- `status`: `allowed`, `allowed_warning` or `rejected`
- `rateLimitType`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included` or `overage`
- `utilization`, `resetsAt` and `surpassedThreshold`, plus overage fields

The docs page describes it only as "Emitted when the session encounters a rate limit", and its listing leaves out `rateLimitType` [C6]. Because the `claude -p` stream-json stdout is the SDK's message stream, the Kit's agent jobs should see these lines. The Kit can pick out every `rate_limit_event` whose `rateLimitType` is `seven_day` and record `utilization` and `resetsAt`.

**Unverified:** whether such an event arrives on every run or only near a threshold or on a status change, and whether `utilization` is 0–1 or 0–100. A probe from this machine wasn't possible, because it authenticates with an API key and not a subscription token. The first Kit runs that log these lines will answer both questions.

### Route B: the `/usage` report (exact, but scope-gated and experimental)

- The SDK's `get_usage` control request (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`) returns `rate_limits.seven_day.utilization` (0–100) and `resets_at` "from the claude.ai usage endpoint". Its `rate_limits_available` is false "when plan rate limits do not apply (API key, Bedrock, Vertex, or missing profile scope)" [S1].
- Sending `/usage` as a prompt gives the same data as `usage_report` on the assistant message (`limits[]` rows with `kind: weekly_all` and similar, a `percent` and a `resets_at`). It does so only if the credential "shows a known plan type or carries the `user:profile` scope". The docs add: "A `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN` doesn't qualify by default, because it carries only the `user:inference` scope" [C6].
- The Kit authenticates with exactly that kind of token (`src/kit/secrets.ts`, `CLAUDE_TOKEN_ENV`; ADR-0004). **So Route B is closed to the Kit as it stands.** Opening it would mean a credential with `user:profile`, such as `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` with `CLAUDE_CODE_OAUTH_SCOPES` [C7]. That is a credential and ADR-0004 question, not a research one. Both surfaces are also marked experimental.
- The status line's `rate_limits.seven_day.used_percentage` [C8] shows the same figure, but status lines only run in interactive sessions, so the Kit can't use it.

### Route C: estimate (always available)

```
weekly share ≈ run API-equivalent $ / W
```

`W` is the Operator's weekly allowance expressed in API-equivalent dollars. Nothing publishes `W`, so it has to be calibrated:

- from Route A samples, as the change in `seven_day` utilization against the change in API-equivalent dollars across runs, or
- by hand, from the Operator's **Settings > Usage** weekly percentage before and after a known batch of runs [K1].

The calibration is noisy for three reasons:

- The pool is shared with the Operator's own claude.ai and interactive Claude Code use.
- Weights by model and effort are unpublished, so a separate `W` per model family may be needed.
- Anthropic can change limits at will.

Present it as "≈ x % of the week", not as a precise figure.

## Recommendation for the Decision

1. Record the **API-equivalent cost** on every run. Take it from `modelUsage` (per model: tokens, `costUSD` and `costBasis`) and `total_cost_usd`, and fix `summary.ts` to use `modelUsage` rather than `result.usage`. Optionally recompute it against a Kit-owned price table taken from section 1.
2. Capture every `rate_limit_event` line. When a `seven_day` one is present, record its `utilization` and `resetsAt`. That is the only weekly-limit reading available without a new credential.
3. Show the weekly share as an **estimate** calibrated from those readings. Don't promise an exact figure unless a separate Decision gives the Kit a `user:profile` credential.

## Sources

- [P1] Anthropic, Pricing: https://platform.claude.com/docs/en/about-claude/pricing (model table, cache multiplier footnotes, fast mode, data residency, long context, web search)
- [C1] Claude Code, Manage costs effectively: https://code.claude.com/docs/en/costs (`/usage`, list-price local computation, subscriber note, plan limits, why usage climbs)
- [C2] Claude Code, Agent SDK "Track cost and usage": https://code.claude.com/docs/en/agent-sdk/cost-tracking (estimate warning, `usage` vs `total_cost_usd` vs `modelUsage`, crashes, resumes, cache TTL on subscription)
- [C3] Claude Code, Headless mode: https://code.claude.com/docs/en/headless (`total_cost_usd` in `-p` output; stream-json result line)
- [C4] Claude Code, Prompt caching: https://code.claude.com/docs/en/prompt-caching (1h TTL only on subscription within plan usage; subagents 5m)
- [C5] Claude Code, Settings reference, `modelPricing`: https://code.claude.com/docs/en/settings-reference#modelpricing
- [C6] Claude Code, Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript (`SDKRateLimitEvent`, `SDKUsageReport`, `usage_report` scope conditions)
- [C7] Claude Code, Environment variables: https://code.claude.com/docs/en/env-vars (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`)
- [C8] Claude Code, Status line: https://code.claude.com/docs/en/statusline (`rate_limits.seven_day.used_percentage`, `cost.total_cost_usd`)
- [S1] `@anthropic-ai/claude-agent-sdk@0.3.317`, `sdk.d.ts` (`SDKRateLimitInfo.rateLimitType`, `SDKControlGetUsageResponse`, `ModelUsage.costBasis`)
- [K1] Claude Help Center, Understanding usage and length limits: https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits
- [K2] Claude Help Center, Understand Claude error messages: https://support.claude.com/en/articles/12466728-understand-claude-error-messages
