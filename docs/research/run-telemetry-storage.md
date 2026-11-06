# Run telemetry and durable storage from Claude Code in Actions

Research for [#66](https://github.com/jrey8343/fabrik/issues/66), feeding [#74](https://github.com/jrey8343/fabrik/issues/74) "Run records and the durable store". Date: 2026-11-04.

**Sources.** Claude Code docs at `code.claude.com/docs/en/` (`headless`, `monitoring-usage`, `sessions`, `agent-sdk/cost-tracking`, `agent-sdk/typescript`), GitHub docs (`docs.github.com`), the READMEs of `actions/upload-artifact` and `actions/create-github-app-token`, Cloudflare R2 docs, the AWS S3 pricing page and AWS OIDC guide, and the Grafana Cloud and Honeycomb pricing pages. All were read on the date above. The Kit's own code is cited by path (`src/agent/summary.ts`, `src/agent/run.ts`, `src/agent/failure.ts`, `.github/workflows/loop.yml`). Fabrik terms follow `GLOSSARY.md`.

---

## TL;DR

- **The stream-json the Kit already captures holds everything a Run record needs.** The `result` message carries `session_id`, `subtype` and `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`, a per-model `modelUsage`, `permission_denials`, `stop_reason` and `terminal_reason`. The `system/init` message carries `model`, `claude_code_version`, `skills`, `tools`, `plugins`, `mcp_servers` and `apiKeySource`. `rate_limit_event` messages carry `utilization` and `resetsAt`. OpenTelemetry adds nothing a Run record needs that the stream lacks.
- **Two gaps in `summary.ts` today.** (1) It reads `usage`, which **leaves out subagent tokens**. `modelUsage` and `total_cost_usd` include them. (2) It reads `effort` from the init message, but Claude Code **omits `effort` from the init message an application reads** (it is only sent to Remote Control clients). So the summary will always print "CLI default". The Kit already knows the effort it chose (`FABRIK_EFFORT`) and should record that.
- **Transcripts are thrown away today.** `run.ts` writes the stream to `agent.log` in `FABRIK_OUT_DIR`, but no `upload-artifact` step picks it up. Claude Code's own `~/.claude/projects/.../<session-id>.jsonl` is on the runner VM and dies with it. Only the step summary survives, and only as long as the run's logs.
- **Actions storage is a hand-off, not a store.** Logs and artifacts are deleted after 90 days by default (configurable from 1 to 400 days for a private repo). Artifact storage is 500 MB free on GitHub Free, 1 GB on Pro and 2 GB on Team, and $0.25/GB-month beyond that.
- **The best durable store is a private GitHub repo, written by the push job with the Fabrik App token.** This could be a central `fabrik-runs` repo or an orphan branch in each Product repo. It needs no new vendor and no new secret, and costs nothing at this volume. It also keeps ADR-0002's rule that the agent job never holds a write credential. R2 or S3 only pays off if transcripts grow past a few GB, and each needs a new account and a new credential. OTel backends are a poor store: free tiers keep data for about 14 days, and content attributes are cut off at 60 KB.

---

## 1. What `claude -p --output-format stream-json` already carries

The Kit runs `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> [--effort <e>] -p -` through Sandcastle (`src/agent/run.ts`, `claudeArgs`). `onAgentStreamEvent` collects every raw stdout line into `lines`.

The stream is newline-delimited JSON. Its message union (`SDKMessage`, `agent-sdk/typescript`) includes `assistant`, `user`, `result`, `system` (subtypes `init`, `api_retry`, `plugin_install`, `permission_denied`, and others), `rate_limit_event`, `tool_progress`, `task_*` and `compact_boundary`. The last line is the `result` message (`headless`, "Stream responses").

### The `system/init` message (`SDKSystemMessage`)

It holds `session_id`, `apiKeySource`, `claude_code_version`, `cwd`, `model`, `permissionMode`, `tools`, `mcp_servers` (name and status), `skills`, `plugins`, `plugin_errors`, `slash_commands`, `agents`, `betas`, `output_style` and `capabilities`.

`effort` is in the type, but the reference says: "Claude Code sets the field only on the init message it sends to Remote Control clients, and omits it from the init message your application reads" (`agent-sdk/typescript`). This contradicts `summary.ts`, which reads `init.effort` and otherwise prints `"CLI default"`.

### The `result` message (`SDKResultMessage`)

| Field | What it gives a Run record |
| --- | --- |
| `subtype` (`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), `is_error`, `api_error_status`, `stop_reason`, `terminal_reason` | Outcome of the agent process itself |
| `session_id`, `uuid` | Key for joining to the transcript |
| `duration_ms`, `duration_api_ms`, `ttft_ms` | Wall time vs time spent waiting on the API |
| `num_turns` | Turns |
| `total_cost_usd` | **List-price estimate**, subagents included |
| `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) | **Top-level loop only: subagent tokens are left out** |
| `modelUsage[model]` (`inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`, `costBasis`, `contextWindow`) | Per-model totals, subagents included |
| `permission_denials` | Tool calls that were refused |

The cost-tracking guide says: "Use `modelUsage` … for whole-tree token accounting; the `usage` field undercounts as soon as nesting occurs". It also warns that `total_cost_usd` and `costUSD` "are client-side estimates, not authoritative billing data", computed from a bundled price table (`agent-sdk/cost-tracking`). On the subscription (ADR-0004), that makes `total_cost_usd` exactly the **"cost equivalent"** #74 asks for: what the run would have cost at list price. It is not money spent.

A crash can end in an `error_during_execution` result with zeroed `usage`, `total_cost_usd` and `modelUsage`. Input and cache tokens can then be recovered by summing the assistant messages' `message.usage`, deduplicated by `message.id`. Output tokens and cost cannot be recovered that way, because "per-step `output_tokens` is a placeholder" (`agent-sdk/cost-tracking`). A run killed by `timeout-minutes` gets no result message at all.

### Other messages worth keeping

- **`rate_limit_event`**: `rate_limit_info.status` (`allowed`, `allowed_warning`, `rejected`), `utilization`, `resetsAt`, and `errorCode: "credits_required"` when the subscription's included usage is exhausted (`agent-sdk/typescript`). This is the only first-party signal for the **"share of weekly limit"** field #74 lists. It only arrives when the CLI emits one, so it is a point sample, not a per-run figure. `src/agent/failure.ts` also reads `rate_limit_info.rateLimitType`, which the published type does not list. It has apparently been seen in practice, but it is undocumented.
- **`system/api_retry`**: `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (category) (`headless`, "Handle API retries"). Useful for telling a slow run from a degraded one.
- **`assistant` / `user`**: the transcript itself, tool calls and results included. Subagent messages carry `parent_tool_use_id`. Their text and thinking are only forwarded with `--forward-subagent-text` or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` (`headless`, "Follow subagent messages").

### Where the transcript goes today

- The Kit holds `lines` in memory, and Sandcastle writes `agent.log` to `FABRIK_OUT_DIR` (`run.ts`, `logging: { type: "file" }`). No workflow step uploads `agent.log`. The `upload-artifact` steps in `loop.yml` take only `agent-result.json`, `agent-failure.json` and the Implementer's bundle. So the transcript is lost when the VM is torn down.
- Claude Code also writes its own transcript to `~/.claude/projects/<project>/<session-id>.jsonl`. Its format "is internal to Claude Code and changes between versions" (`sessions`, "Where transcripts are stored"). It is on the same throwaway VM. The documented way to keep it is the stream, or a `SessionEnd` hook reading `transcript_path`.
- The step summary (`GITHUB_STEP_SUMMARY`) survives, but it is limited to 1 MiB per step and expires with the run's logs.

**Conclusion.** The stream-json lines the Kit already collects are a complete, documented transcript and the raw material for a Run record. The cheapest first step is to upload `agent.log`, or a gzipped copy of `lines`, as one more `fabrik-agent-*` artifact, so the push job can store it durably.

## 2. Claude Code's OpenTelemetry export

### What it needs configured (`monitoring-usage`)

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp          # otlp | prometheus | console | none
OTEL_LOGS_EXPORTER=otlp             # otlp | console | none
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # no default: must be set (grpc | http/json | http/protobuf)
OTEL_EXPORTER_OTLP_ENDPOINT=https://<backend>
OTEL_EXPORTER_OTLP_HEADERS="Authorization=..."
OTEL_METRIC_EXPORT_INTERVAL=60000   # default 60 s
OTEL_LOGS_EXPORT_INTERVAL=5000      # default 5 s
OTEL_RESOURCE_ATTRIBUTES="fabrik.role=implement,fabrik.issue=123,..."   # no spaces; percent-encode
# Traces are beta: CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 and OTEL_TRACES_EXPORTER=otlp
```

"Repository `.claude/settings.json` files cannot enable telemetry or set its destination" (`monitoring-usage`). So a Product repo cannot redirect it. In the Kit, these would be env on the agent step, which `noSandbox()` passes through to `claude`.

### What it emits

- **Metrics:** `claude_code.session.count`, `token.usage` (by `type` and `model`), `cost.usage` (USD, an estimate), `lines_of_code.count`, `commit.count`, `pull_request.count`, `code_edit_tool.decision`, `active_time.total`.
- **Events (OTLP logs):** `user_prompt`, `assistant_response`, `tool_result` (`tool_name`, `success`, `duration_ms`, sizes), `tool_decision`, `api_request` (`model`, `cost_usd`, tokens, `duration_ms`, `request_id`), `api_error`, `api_refusal`, `safety_event`, `subagent_completed`, and others. They are correlated by `session.id`, `prompt.id` and `tool_use_id`.
- **Traces (beta):** `claude_code.interaction` → `llm_request` / `tool` → `tool.execution`. Under `-p`, Claude Code reads an inbound `TRACEPARENT` so its spans can join a caller's trace.
- **Redaction by default.** Prompt, response, tool input and tool output content are left out unless `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` or `OTEL_LOG_TOOL_CONTENT` is set. When they are included, content attributes are cut off at `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`, which defaults to 60 KB. `OTEL_LOG_RAW_API_BODIES=file:<dir>` writes full request and response bodies to files instead, for a collector to ship. With OAuth, `user.email` is attached to every signal.

### Fit for the Kit

- **Little gain over the stream.** Per run, the stream already has tokens, estimated cost, turns, durations, tool calls and errors. OTel's added value is per-request `api_request` and `tool_result` timings without parsing, and a ready-made dashboard backend.
- **A credential in the wrong job.** The exporter runs inside the agent process, so the OTLP ingest token must be in the agent job's env. That job runs Product code, and Bash subprocesses inherit the env. The token is ingest-only and low value, about the same exposure as `CLAUDE_CODE_OAUTH_TOKEN` already there. Still, it is a second secret for ADR-0004's agent vault, and a prompt-injected agent could forge or flood records.
- **Flush on exit is not documented.** The docs give the export intervals but say nothing about flushing the last batch when a `-p` process exits. A short job could lose its final metrics (60 s interval) unless the interval is lowered. A run killed by `timeout-minutes` would lose whatever was buffered. *Unverified; test before relying on it.*
- **Not a store** (see §4d).

**Conclusion:** leave OTel off in V2. If a live dashboard ever matters, turn it on later with a few env vars; nothing in the Run-record design depends on it.

## 3. Actions logs, artifacts and step summaries

| Item | Limit | Source |
| --- | --- | --- |
| Log and artifact retention | 90 days by default; a repo setting allows 1–90 days (public) or **1–400 days (private)** | docs.github.com "Managing GitHub Actions settings for a repository" |
| `upload-artifact` `retention-days` | 1–90, "Maximum 90 days unless changed from the repository settings page" | `actions/upload-artifact` README |
| Artifact storage included | Free 500 MB, Pro 1 GB, Team 2 GB (shared with Packages); billed hourly as GB-hours; **$0.25/GB-month** above that | docs.github.com "GitHub Actions billing", "Actions limits" |
| Logs and job summaries | "do not count towards the repository owner's artifact storage allowance" | "GitHub Actions billing" |
| Artifacts per job | 500; artifacts are immutable since v4; names must be unique within a run | `actions/upload-artifact` README |
| Step summary | 1 MiB per step; 20 step summaries shown per job | "Workflow commands" |
| Job time | 6 h on GitHub-hosted runners | "Actions limits" |
| `GITHUB_TOKEN` API rate | 1,000 requests/hour/repo | "Actions limits" |

Artifacts are per run, scattered across Product repos, deleted on a timer, and readable only through the Actions API. They are the right way to pass the transcript from the agent job to the push job (they already do this for `agent-result.json`, at `retention-days: 7`). They are not the store. Raising a private repo's retention to 400 days is a cheap safety net, not a query surface.

## 4. Candidate durable stores

The write should happen in the **push job**, not the agent job. ADR-0002 keeps every write credential out of the job that runs Product code. The push job already downloads `fabrik-agent-*` artifacts and mints a Fabrik App token through `.github/actions/run-loop` (`actions/create-github-app-token`, App credentials from 1Password via `OP_PUSH_TOKEN`). It has `permissions: {}` and never checks out Product code.

### 4a. A private GitHub repo or orphan branch (recommended)

**How the push job writes.** There are two shapes:

- **An orphan branch in each Product repo** (for example `fabrik/runs`). The App already has Contents write on the Product repo, because it pushes agent branches (ADR-0002), and the App token is scoped to the current repo by default. **No new credential or install is needed.**
- **One central private repo** (for example `jrey8343/fabrik-runs`). The Fabrik App must be installed on it with Contents write. The push job then mints a second token with `repositories: fabrik-runs` and `permission-contents: write`. `create-github-app-token`'s docs: "If `owner` and `repositories` are empty, access will be scoped to only the current repository". Narrowing works through `permission-<name>` inputs, which must be within the installation's grant. **One install and one workflow step, no new secret.**

Writing uses `git` (clone with `--depth 1` or sparse, add a file, commit, push, and retry on a non-fast-forward) or the REST API. The Contents API (`PUT /repos/{o}/{r}/contents/{path}`) is simplest, but the docs warn that concurrent create, update and delete calls "will conflict", so they should run "serially". Parallel push jobs from several Tickets will race. Use one file per run, with retry on 409, or the Git Data API (blob → tree → commit → update ref with retry).

**Limits.** GitHub warns at 50 MiB per file and blocks at 100 MiB. Recommended repo size is "ideally less than 1 GB, and less than 5 GB is strongly recommended" (soft). The Contents GET API serves files of 1–100 MB only as raw. Secondary limits allow "no more than 80 content-generating requests per minute and no more than 500 … per hour". App installation tokens get 5,000 to 12,500 requests/hour. A few writes per run is far below all of these.

**Cost.** Free (private repos on a personal account).

**Trade-offs.** Records are greppable with `gh`, `git log` and `jq`, and readable by a later Retro, Scorer or Replay job. Diffs and history come for free. They are private to whoever can read the repo. Transcripts can hold the Product's secrets if the agent echoed them, so a central repo should be at least as private as the most private Product repo.

An orphan branch in the Product repo shows up in its branch list. Pushes made with the App token start workflows (ADR-0002 relies on that), so a Product CI that runs `on: push` for every branch would run. Either add `[skip ci]` to the commit message or filter branches. The caller workflow `fabrik.yml` has no `push` trigger, so the Loop itself would not fire. A central repo avoids both problems and puts every Product's records in one place, which cross-repo metrics (cost per merged PR, and so on) need.

### 4b. Cloudflare R2

- **Pricing:** $0.015/GB-month (Standard), Class A writes $4.50 per million, Class B reads $0.36 per million, **egress free**. The free tier each month is 10 GB-month, 1 M Class A and 10 M Class B.
- **Limits:** 5 GiB per single PUT, 5 TiB per object, 1 write per second to the same key.
- **How to write:** R2 speaks the S3 API. Create an R2 API token (access key ID and secret) scoped to one bucket and store it in a 1Password vault the push service account can read. The push job then runs `aws s3 cp --endpoint-url https://<account_id>.r2.cloudflarestorage.com`. GitHub OIDC federation was not found in the R2 docs, so this is a **long-lived static secret**.
- **Trade-offs:** a new vendor account and secret, and no `gh`/`git` browsing. It is free at Fabrik's likely volume (10 GB is thousands of gzipped transcripts) and cheap well past it. It is the natural upgrade if transcripts outgrow a git repo.

### 4c. Amazon S3

- **Pricing:** GET is $0.0004 per 1,000. The first 100 GB/month of internet egress is free. *The S3 Standard storage and PUT rates did not render on the pricing page when fetched. The long-standing us-east-1 list price is about $0.023/GB-month and $0.005 per 1,000 PUTs; confirm before quoting.*
- **How to write:** GitHub OIDC, with no static secret. Give the push job `id-token: write` (the caller already grants it to the Loop, and the push job narrows it to `{}` today). Then use `aws-actions/configure-aws-credentials` with `role-to-assume`. Pin the IAM trust policy's `sub` to the Product repos and `aud` to `sts.amazonaws.com`.
- **Trade-offs:** the strongest credential story (short-lived and scoped by repo), but the heaviest setup (AWS account, IAM role, bucket policy). It is overkill unless the Operator already lives in AWS.

### 4d. An OTel backend

- **Grafana Cloud free:** 10k active metric series, 50 GB of logs and 50 GB of traces per month, **14-day retention** on each. OTLP over HTTP goes to `https://otlp-gateway-<region>.grafana.net/otlp`, with an auth header the portal generates.
- **Honeycomb free:** up to 20 M events/month. Retention was not stated on the pricing page.
- **Fit:** good for live dashboards, but a poor home for Run records and transcripts. Free retention is weeks, not the months a Retro or Replay needs. Content attributes are cut off at 60 KB. The data is not a replayable transcript. It is also only reachable through vendor query languages. It only works if OTel is turned on (§2), which puts a credential in the agent job.

### Comparison

| Store | New credential | Writer | Cost at Fabrik scale | Retention | Reads |
| --- | --- | --- | --- | --- | --- |
| Actions artifacts | none | agent job | in plan's 0.5–2 GB, then $0.25/GB-mo | ≤90 d (≤400 d private) | Actions API, per run |
| Orphan branch per Product repo | none | push job, App token | free | forever | `gh`, `git` |
| Central private repo | App install on one repo | push job, App token scoped to it | free | forever | `gh`, `git`, cross-repo |
| R2 | R2 API token in 1Password | push job | free ≤10 GB, then $0.015/GB-mo | forever | S3 tools |
| S3 | none static (OIDC + IAM role) | push job with `id-token: write` | ~$0.023/GB-mo (unconfirmed) | forever | S3 tools |
| OTel backend | ingest token in agent job | agent process | free tier | ~14 d free | vendor UI/query |

## 5. What this means for #74

1. **Source of truth:** the stream-json lines. Build the Run record in the agent job from the `init` and `result` messages, in a pure function beside `runSummary`. Use `modelUsage`/`total_cost_usd` for tokens and cost, and the Kit's own `FABRIK_MODEL`/`FABRIK_EFFORT` plan for effort. Add the last `rate_limit_event` and the retry count. Fields the stream cannot know (Verdict, rework count, merge, revert, human touches) come from GitHub state when the push job or a scheduled job writes the record.
2. **Hand-off:** upload `agent.log` (gzipped) alongside `agent-result.json` and `agent-failure.json`, uploaded on failure too. Raising the artifact `retention-days` is optional.
3. **Store:** the push job writes `runs/<repo>/<yyyy-mm>/<run-id>.json` and `transcripts/…/<run-id>.jsonl.gz` to a private GitHub repo with the Fabrik App token. Choosing between a central repo and per-Product orphan branches is #74's call. The central repo is favoured for cross-repo metrics and keeps Product CI out of it.
4. **Defer:** R2 until transcripts approach the GB range. OTel until a live dashboard earns its review cost.

## Open points

- **A timed-out agent job.** GitHub cancels the job at `timeout-minutes`. It is unverified whether a later `if: always()` upload step still runs, and whether Sandcastle has flushed `agent.log` by then. If not, timed-out runs, which are the ones most worth reading, lose their transcript. Test this on the Pilot.
- **Transcript size per run** was not measured. Measure it from `agent.log` on a few Pilot runs before settling the store's growth budget.
- **`effort` in the init message.** The docs say an application never sees it. Confirm on a Pilot log, then fix `summary.ts` either way.
- **S3 list prices** need confirming (the pricing table did not render).
