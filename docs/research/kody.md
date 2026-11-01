# Kody: how it is built by agents, and whether it could serve as part of Fabrik

Research for [#15](https://github.com/jrey8343/fabrik/issues/15). Date: 2026-11-02.

**Sources.** The local clone of `kody-hq/kody` at `333e837de` (2026-11-01), read-only. Paths below are relative to that repo unless they start with `https://`. Merge and authorship data come from `git log` on that clone and from `gh pr view/list -R kody-hq/kody` (read-only). The Kody packages that hold the agent chores (`@kentcdodds/friction-log`, `@kentcdodds/ship-pr`) live on kody.codes, not in the repo. Their public pages (https://kody.codes/@kentcdodds/friction-log, https://kody.codes/@kentcdodds/ship-pr) were read with WebFetch, so the package internals are known only from those pages. Kent C. Dodds' launch post is https://kentcdodds.com/blog/introducing-kody-your-personal-software-factory (2026-09-08). Pricing is from https://kody.codes/pricing.

Fabrik terms (Operator, Implementer, Reviewer, Sandbox, Merge gate, Loop, AFK, HITL, Triage, Kit, Product repo) follow `GLOSSARY.md`. Kody's own terms (package, job, execute, credential, memory, execution context) are marked as Kody's where they could be confused with Fabrik's.

---

## TL;DR

- **Kody is a hosted MCP product, not a factory kit.** It is "Your agents' cloud": a multi-tenant Cloudflare Workers service where an agent from any MCP host stores Kody's *packages*, *jobs*, *credentials*, *memories* and *email inboxes*, behind two tools, `search` and `execute` (`docs/contributing/project-intent.md`, `README.md`). Its own docs call it a "hosted factory" (`docs/guides/kody-factory.md`) and the pricing page says Free is "The whole factory". That means a personal automation runtime. It is not a code-change Loop.
- **The repo itself is a strong example of an agent-driven project.** Most PRs come from cloud agents (Devin, Cursor Cloud Agents). One `npm run validate` gate mirrors CI, every non-draft PR gets a preview deploy, AI review bots review, and a `kody-bot` account **auto-merges low/medium-risk PRs**. That auto-merge contradicts Fabrik's Merge gate. Production deploys run only from CI after merge.
- **Recurring chores live in two places.** Dependency audits run as a GitHub Actions cron (`.github/workflows/audit-bump.yml`). The daily friction sweep is a **Kody package job** that spawns a Cursor Cloud Agent through the Cursor API. Kody itself is the scheduler for Kent's agent chores.
- **As a Fabrik component, it fits none of the four jobs well enough.** It cannot host a Sandbox: no containers, and heavy work goes to processes the owner runs (`docs/guides/heavy-work-offload.md`). Its "keys agents never see" credentials only fill outbound `fetch` calls routed through Kody's gateway, not env vars in a test process. Its memories would be a second system of record beside GitHub. Its jobs duplicate what GitHub Actions cron and label triggers already do. Every use would mean writing Kody packages, which is bespoke glue on a third-party hosted runtime that needs another account.
- **Recommendation: borrow patterns only.** Do not adopt Kody as a component. Several patterns transfer directly (see §4).

---

## 1. What Kody is

| Aspect | Finding | Source |
| --- | --- | --- |
| Product | Hosted MCP server. Agents connect over OAuth from Claude Code, Cursor, ChatGPT, Codex, Devin and others. The public surface is deliberately tiny (`search`, Code Mode `execute`, `api`). | `docs/contributing/project-intent.md`, `docs/use/connect-your-agent.md`, `docs/guides/kody-factory.md` |
| Primitives (Kody's terms) | Packages (versioned TS capabilities run server-side), `packageStorage()`, jobs (cron in `package.json#kody.jobs`), workflows (`runAt` one-shots), webhooks, package apps, credentials/secrets, memories, per-account inbox `{username}@inbox.kody.codes`, remote MCP servers | `docs/guides/kody-factory.md`, `docs/guides/wake-your-agent.md` |
| Hosting | Multi-tenant SaaS at kody.codes. Five-plus Workers (`kody-production`, `-platform`, `-runtime`, `-jobs`, `-highlight`) plus D1, KV, Durable Objects, Vectorize and Cloudflare Artifacts. The scheduler is a five-minute cron on `kody-jobs`. | `README.md` "How It Works", `docs/contributing/rollback.md` |
| Self-hosting | Not documented as a supported path. Intent says it is "not trying to become a generic starter kit for others". Local dev mocks Artifacts, and Vectorize isn't emulated. | `docs/contributing/project-intent.md`, `docs/contributing/cloud-agents.md` "Local limitations" |
| Licence | FSL-1.1-ALv2. Any use except "Competing Use" is allowed, and each version becomes Apache-2.0 after two years. Outside PRs need a CLA. | `LICENSE`, `README.md` "License" |
| Account | Needs a kody.codes account with a verified email; unverified accounts are deleted after 7 days. Free tier: 5 scheduled jobs, no faster than every 15 min, 25 secrets, 10 email sends/day. Pro is $12/mo. | `docs/contributing/project-intent.md`, https://kody.codes/pricing |
| Compute boundary | Packages run in Worker isolates. "Kody does not host containers or long-running processes for a package. The owner operates that process." | `docs/guides/heavy-work-offload.md`, ADR `0025-no-package-services-primitive.md` |
| Maturity | First commit 2026-03-18, public launch 2026-09-08. 4,333 commits, about 1,840 of them since 2026-10-01. 99 decision records. Key features are still behind experiment flags (execution contexts, MCP Events). Fast-moving, with high churn. | `git log`, `docs/contributing/decisions/`, `docs/guides/execution-contexts.md` |

---

## 2. Angle 1: Kody as a factory example

### 2.1 How work enters

- **Friction issues.** Agents and humans log repo papercuts as GitHub issues labeled `friction`. Humans use an issue form (`.github/ISSUE_TEMPLATE/friction.yml`, with required "How to reproduce", "Cost" and "Preliminary investigation" fields). Agents never call `gh issue create`. They file through the `kody:@kentcdodds/friction-log/file` package export, which *qualifies* the item first and soft-skips one-off or session-bound noise (`docs/contributing/friction-log.md`, `.agents/skills/file-friction/SKILL.md`). The bar is "durable, recurring, clear owner, reproducible contract gap".
- **Operator requests to cloud agents.** Devin PR bodies end with "Requested by: @kentcdodds" and a Devin session link (e.g. kody-hq/kody#4715, #4694). Weekly Sentry reports become fix PRs ("fix: Sentry weekly (Oct 24-31) …", #4694).
- **Product feedback.** Kent's launch post says Kody's feedback system "starts an agent to triage submitted feedback automatically".
- **Nothing like Fabrik's Triage labels.** There is no `needs-triage` → `ready-for-agent` state machine. Work is either a direct Operator request to an agent or a `friction` issue the daily sweep picks up.

### 2.2 Which agents do the work, and where they run

- **Authorship (last 1,500 commits):** Kent C. Dodds 719, Tanner Linsley 416, `devin-ai-integration[bot]` 233, Kody (kody-bot) 79, `cursor[bot]` + Cursor Agent 38. Co-author trailers tell more: `Cursor Agent` appears on 709 commits and Devin on 245. Cursor work is squash-merged under Kent's name with `Co-authored-by: Cursor Agent`. Claude appears 7 times. In the last 60 merged PRs, 46 were authored by Devin.
- **Cursor Cloud Agents** run on Cursor-hosted VMs (4 cores, about 16 GB) built from a snapshot that the Cursor dashboard install command produces. Most of `docs/contributing/cloud-agents.md` is VM gotchas: Node 26 on `PATH` before `npm ci`, a Playwright install that hangs, `validate` serialised on small machines (`tools/run-validate.ts`), the Cursor hook dispatcher composed with Husky (`npm run hooks:ensure`), and a GitHub token that expires mid-run. The VM's `gh` token **cannot write issues or PR comments** (403). Those writes go through `kody:@kentcdodds/github/request` acting as kody-bot.
- **Devin** runs in Devin's own VMs and monitors its PRs ("I'll fix CI failures and address comments from users with write access", kody-hq/kody#4715).
- `.cursor/CLOUD.md` is a short quick-reference for Cursor agents. `AGENTS.md` is a 20-line index whose length is enforced by a file-size ratchet (`docs/contributing/repo-health.md`, `docs/principles/lean-agent-context.md`).

### 2.3 How `npm run validate` and previews gate changes

- **One local gate that mirrors CI.** "`npm run validate` is the single authoritative local gate. CI runs the same checks as parallel jobs … so a green local `validate` means CI will pass" (`.cursor/CLOUD.md`, `AGENTS.md`). It covers format, lint, typecheck, Node and Workers unit tests, Playwright and MCP E2E, worker builds, startup budget, migrations, deploy guardrails, docs checkers and a dependency audit (`docs/contributing/rollback.md` §4). Pre-push hooks run a scoped subset (`cloud-agents.md` "Git hooks").
- **CI:** `.github/workflows/validate.yml` runs on push to main, PRs, merge groups and dispatch.
- **Previews.** `.github/workflows/preview.yml` deploys every non-draft, non-fork PR to its own Workers (`kody-pr-<n>`, plus platform, runtime and API siblings), seeds a fixed account, and comments the URL. `preview-flag:<key>` labels turn experiments on for the preview. Sweep and cleanup crons tear previews down (`preview-sweep.yml`, `preview-pr-cleanup.yml`).
- **Proof beyond CI.** The `control-kody` CLI and skill hold that "CI green is not enough for a user-visible account change". Agents must exercise the change as the seeded user locally (`control-kody dev/login/request/browse`), and use the preview only when local can't reach the change (`.agents/skills/control-kody/SKILL.md`, `.agents/skills/preview-manual-test/SKILL.md`). A "Feature Map" of routes is checked in CI (`npm run feature-map:check`).
- **Harness engineering.** `docs/contributing/harness-engineering.md` (after OpenAI's "Harness engineering" post) says to promote repeated review comments into lint, type or validate checks, ahead of tests, scripts and docs, in that order. "If reviewers repeat the same comment twice, encode it."

### 2.4 How review and merge happen

- **AI review bots.** Bugbot (Cursor), CodeRabbit, Devin review and Sentry Seer comment on PRs. CodeRabbit skips bot-authored PRs (kody-hq/kody#4715).
- **`ship-pr` is the merge driver.** The repo skill (`.agents/skills/ship-pr/SKILL.md`) is a 20-line stub that runs the Kody package `kody:@kentcdodds/ship-pr/tick` via `npx @kodycodes/cli execute --local`. Each tick reports the next step: ready, CI, ai-review sort, merge, deploy (production `/health` serves the merge SHA), friction (file leftovers), report (Discord summary) (https://kody.codes/@kentcdodds/ship-pr).
- **Risk-based auto-merge.** "Auto-merge low and medium once CI is green and valid reviewer feedback is handled. High waits for Kent unless he explicitly said to merge." High risk covers auth, secrets, billing, data migrations, destructive changes and anything hard to undo. **The agent picks the risk itself** (`ship-pr/SKILL.md`). Human feedback from a collaborator blocks at every risk level. The package "never resolves a person's thread".
- **In practice the bot merges almost everything.** Of the last 60 merged PRs, 55 were merged by `kody-bot`: all 46 Devin PRs and all 9 of Kent's PRs, every one from a `cursor/…` branch. The other 5 are Tanner Linsley's own merges. The friction-sweep PR #4727 was opened under Kent's account from a `cursor/friction-log-…` branch, reviewed by CodeRabbit and kody-bot, and merged by kody-bot 44 minutes later.
- **The PR template asks for a "Door".** `two-way` (cheap to reverse) or `one-way` (stored shapes, public contracts, deleted data: "spend the review here"), plus `Cleanup` and `Testing` sections (`.github/pull_request_template.md`, `docs/principles/two-way-doors.md`). The `visual-recap` skill adds a Mermaid "system recap" block that rolls risk up from which primitives the diff touches (`.agents/skills/visual-recap/SKILL.md`).

### 2.5 How recurring agent chores are scheduled

| Chore | Scheduler | What runs | Source |
| --- | --- | --- | --- |
| Daily friction sweep | **Kody package job** `@kentcdodds/friction-log` `daily`, 5am America/Denver | Lists open `friction` issues without `friction-skipped` across its sweep repos (`kody-hq/kody`, `kentcdodds/mediarss`). Spawns **at most one Cursor Cloud Agent per repo per day** via the Cursor API (`cursorApiKey` secret). The agent closes fixed or invalid issues, ships low/medium fixes through `ship-pr`, or comments a recommendation and applies `friction-skipped`. `./pause` is a kill switch, and `dryRun` previews without spawning. | `docs/contributing/friction-log.md`, https://kody.codes/@kentcdodds/friction-log |
| Dependency audit bump | GitHub Actions cron `17 13 * * *` | `npm audit fix`, then force-push to one reused `ci/audit-bump` branch and open or refresh one PR. It leaves the branch alone if a human has pushed to it. It **dispatches Validate itself because `GITHUB_TOKEN` pushes do not trigger `pull_request` workflows**. | `.github/workflows/audit-bump.yml`, `docs/contributing/dependency-overrides.md` "Dependency bump PRs" |
| Duplicate-PR rule for agents | Prose rule in `AGENTS.md` | "reuse an open PR, never open a duplicate": search open PRs for the package before bumping | `AGENTS.md`, `dependency-overrides.md` |
| Perf, latency, preview hygiene | GitHub Actions crons | `weekly-site-perf.yml`, `latency-bench.yml`, `preview-sweep.yml`, `preview-pr-cleanup.yml` | `.github/workflows/` |
| Other recurring sweeps (inferred) | Not in the repo; probably Kody package jobs like friction-log | Recent merged PRs come from Cursor branches named `cursor/<chore>-kody-hq-kody-<id>` for `friction-log`, `docs-freshness` and `keep-tests-tight`, each appearing on more than one day (e.g. #4724, #4725). They match the friction sweep's naming, but their scheduler isn't visible from the repo. | `gh pr list -R kody-hq/kody --state merged` |
| Doc and quality gardening | Prose cadence ("weekly") | Remove stale guidance, add one new mechanical guardrail | `docs/contributing/harness-engineering.md` |

The sweep's git history matches this: "Friction sweep: …" PRs on 2026-10-23, -24 and -25, and "fix: daily friction sweep for …" on 2026-11-01 (#4727). Each bundles several small fixes, one per commit, with CodeRabbit follow-ups.

### 2.6 How production deploys are kept out of agents' hands

- **Rule:** "Never run `wrangler deploy`, `versions upload|deploy`, or `secret put|bulk` against `kody-production` or any production Worker; only the Deploy workflow deploys" (`AGENTS.md`). The full rationale and the human-only rollback exception are in `docs/contributing/rollback.md` "CI-only production deploys".
- **Mechanism:** `.github/workflows/deploy.yml` runs only on `workflow_run` of a **successful Validate on a push to `main`**, or a no-input `workflow_dispatch` on `main`. A `sha-guard` refuses anything that isn't ahead of live production. Concurrency is queue-not-cancel.
- **Caveat:** agents can't run a deploy, but kody-bot auto-merges low/medium PRs and merge triggers deploy. So agents effectively *cause* production deploys without a human in the loop. Agents are kept away from the deploy mechanism, not from deploy authority.

### 2.7 How skills are pinned and shared

- **Repo-local skills** live in `.agents/skills/` (`control-kody`, `file-friction`, `prefer-local-cli-execute`, `preview-manual-test`, `ship-pr`, `visual-recap`). They are kept thin by policy; durable logic belongs in a package or script (`docs/principles/lean-agent-context.md`, `friction-log.md` "How to fix").
- **`skills-lock.json`** is the lock file of `vercel-labs/skills`. It pins only `ship-pr`, as `sourceType: "local"` with a folder `computedHash`. `tools/check-skills-lock.ts` explains why: `skills update` would reinstall the upstream `kentcdodds/kcd-skills` version and "replace this repo's ship-pr policy". So the repo holds a **local override of an upstream skill**, and the hash check (in `deps:check` and pre-push) fails any edit that doesn't refresh the hash.
- **Cross-repo sharing happens through Kody packages, not skills.** The behaviour that matters (`ship-pr`, `friction-log`, `github/request`, `discord/send-shipped-pr`) is versioned code on kody.codes, called from any repo with `npx @kodycodes/cli execute --local`. Each repo carries only a stub skill. The friction sweep already covers two repos from one package.

---

## 3. Angle 2: Kody as a Fabrik component

The four candidate jobs from the ticket:

### 3.1 Holding Sandbox test credentials: no

- Kody credentials are "Keys your agents use, never see". `packageSecrets.get()` returns an opaque `{{secret:…}}` placeholder, and "only platform use sites resolve it", in a secret-aware `fetch` to an **approved host** (`docs/use/secrets-and-values.md`). Execution contexts behave the same way: "Credentials stay in Kody cloud and never reach the machine. When code on your machine calls a service with a credential, that request leaves from Kody cloud" (`docs/guides/execution-contexts.md`).
- A Product repo's build/test in a Sandbox needs plain env vars (a Stripe test key in the test process, `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code itself). Kody deliberately never hands those out, so it can't fill them without the Product repo's code being rewritten to call through Kody. GitHub Actions secrets or environment secrets already do this job with no extra account.
- The idea worth keeping is a gateway that injects credentials and redacts echoes. It speaks to the map's "prompt-injection exposure" hazard, but in v1 Fabrik terms it is a design idea, not a component.

### 3.2 Scheduling AFK runs: technically possible, but redundant and bespoke

- Kody jobs can run on cron (Free: 5 jobs, every 15 minutes at most; the scheduler ticks every 5 minutes), and a package can call GitHub's API with a stored token. That is how the friction sweep spawns Cursor agents.
- An AFK run still needs a Sandbox to run Claude Code, and Kody can't host one (`heavy-work-offload.md`: "Kody does not host containers or long-running processes"). So a Kody job could only *poke* something else, such as `workflow_dispatch` on GitHub Actions. GitHub Actions already has cron and label triggers, and #4 found that is how Matt Pocock runs Sandcastle. A Kody layer would add a hop, an account, a token to manage and bespoke package code.
- Kent's own split confirms it: the dependency bump, which needs no external agent, stays in GitHub Actions. Kody schedules only the job that calls a non-GitHub agent API (Cursor).

### 3.3 Memory across Loop stages: conflicts with a standing decision

- Kody memories are account-level facts surfaced by `search`/`execute` through a `memoryContext` hint, "top one or two" per call (`docs/use/memory.md`, `docs/guides/memory.md`).
- Fabrik's standing decision is that **GitHub is the system of record**. Context between Triage, Design session, Implementer and Reviewer belongs in the issue, spec, PR and `GLOSSARY.md`/ADRs. A ranked, invisible second store would hide decisions from the Operator and from the issue history. Kody's own principle agrees: "Normalized source of truth" (`docs/principles/normalized-source-of-truth.md`).

### 3.4 Reaching the Operator: possible, but not needed for v1

- Kody offers per-account inboxes, a Discord package (`@kentcdodds/discord/send-shipped-pr`) and MCP Events. Per `docs/guides/wake-your-agent.md`, MCP Events work only in ChatGPT today: "Cursor and Claude do not today".
- Notifications are still "not yet specified" on the map. GitHub's own notifications and mobile app, or a plain Slack/Discord webhook from the workflow, do the same with no new account. Kody would only make sense if the Operator already lived in Kody.

### 3.5 Cross-cutting objections

- **Bespoke by construction.** Every use above means writing and publishing Kody packages (TypeScript in Kody's runtime, `package.json#kody` manifests). That is Fabrik-owned glue in a proprietary runtime, the opposite of "thinnest possible glue" over upstream tools.
- **Least ongoing ops.** It adds an account, OAuth connections (GitHub bot, Cursor), secret rotation, a usage quota and a dependency on a seven-month-old fast-moving service, beside GitHub, which Fabrik needs anyway.
- **Billing model mismatch.** Kody's agent chores spawn **Cursor Cloud Agents** through a metered Cursor API key. Fabrik runs Claude Code on the Operator's Max x20 subscription. Nothing in Kody runs Claude Code.
- **Licence and self-hosting.** Using hosted Kody is fine under FSL. Self-hosting is undocumented and operationally heavy (five Workers, D1, DOs, Vectorize, Artifacts). If the Kit ever became something offered to others, it would need a check against FSL's "Competing Use" clause, given Kody markets itself as "the whole factory".

---

## 4. Patterns worth borrowing

1. **One authoritative gate that mirrors CI** (`npm run validate` ≡ CI jobs). A Kit convention could be: each Product repo names one command that the Implementer runs in the Sandbox and CI runs as required checks. Its failure messages carry remediation hints.
2. **Friction capture as a feedback loop.** Agents file durable papercuts against a strict bar (reproducible gap, clear owner, cost), dedupe against open issues, and a scheduled AFK sweep handles them with a `skipped` label as the off switch. This maps onto Fabrik's Triage: a `friction` issue is just another issue entering `needs-triage`.
3. **Promote repeated review comments into checks** ("if reviewers repeat the same comment twice, encode it"). This gives the Reviewer's design-flaw and execution-flaw verdicts a durable output beyond the PR.
4. **"Door" field on every PR** (`two-way`/`one-way`). It is a cheap signal for where the Operator spends Merge-gate attention, and for which changes need an ADR.
5. **Reuse-one-PR for chores.** A fixed branch (`ci/audit-bump`), refresh the body instead of duplicating, back off when a human has pushed. Plus the gotcha: **pushes and PRs made with `GITHUB_TOKEN` don't trigger `pull_request` workflows**, so a workflow that opens PRs must dispatch CI itself or push with an App/PAT token. This bites any Fabrik workflow that pushes the Implementer's branch (cf. #4).
6. **Daily spawn cap and kill switch** for AFK chores (one agent per repo per day, `./pause`, `dryRun`). This speaks to the open "concurrency and queueing" question.
7. **Agents can't touch deploy mechanics.** A prose rule in `AGENTS.md`, backed by deploy-only-from-CI-after-Validate-on-main and a sha-guard. Fabrik leaves deploy to the Product repo, but the Pilot's merge-is-deploy fits this shape.
8. **Thin repo skills, logic one hop away, skill lock with hash check.** `skills-lock.json` from `vercel-labs/skills` plus a CI hash check pins exactly which skill text agents load. That fits "Matt's skills consumed upstream". Note that Kody uses a *local* override of an upstream skill, which is the forking Fabrik rules out. Fabrik should pin upstream entries instead.
9. **Lean `AGENTS.md` enforced by a line-count ratchet** (20 lines), with progressive disclosure into focused docs.
10. **Cloud-agent VM gotchas doc** (`cloud-agents.md`). Expect a per-Product-repo equivalent for Sandboxes: runtime version, browser install, memory limits, token expiry.

Patterns **not** to borrow: agent-chosen risk levels and bot auto-merge (they break the Merge gate). Also the bot reading a GitHub token from a third-party service to write issues and merge, and multiple paid agent vendors (Devin, Cursor) in parallel.

---

## 5. Conflicts with the map's standing decisions

| Standing decision | What Kody does | Implication |
| --- | --- | --- |
| **Merge gate:** the Operator merges every PR | `kody-bot` auto-merges low/medium PRs; the agent picks the risk; 55 of the last 60 merges were by the bot | Kody shows a single-maintainer factory *can* run with bot merges after AI review. Fabrik's v1 deliberately does not. This is evidence on the cost side of the Merge gate (Operator attention), not a reason to reopen it, unless the Operator wants to. |
| **Claude Code on Max x20, no metered spend** | Chores spawn Cursor Cloud Agents on a metered Cursor API key; most PRs come from Devin | Kody's agent layer can't be reused under Fabrik's billing constraint. |
| **GitHub is the system of record** | Agent memories and chore state (sweep outcomes via `record-outcome`, package storage) live in Kody | Adopting Kody memory or jobs would split the record. Kody's GitHub-facing behaviour (labels, issues, PRs) is GitHub-first, though. |
| **Consume upstream, never fork** | `ship-pr` is a local override of `kentcdodds/kcd-skills`, guarded by a hash so `skills update` won't restore upstream | Copy the lock-file mechanism, not the override. |
| **Hosting: laptop shut, then least ongoing ops** | Kody does run with the laptop shut, but adds a service account and bespoke packages beside GitHub Actions | GitHub Actions wins on least ops for every job considered here. |

---

## 6. Recommendation

**Borrow patterns only. Do not adopt Kody as a Fabrik component.**

- None of the four candidate jobs needs Kody. Sandbox credentials need env vars, and Kody's design never releases them. Scheduling is already in GitHub Actions, and Kody can't host a Sandbox anyway. Memory would split GitHub's system of record. Operator notifications don't need a new account.
- Any use would make Fabrik bespoke: Kody packages written and run on a young, fast-changing third-party runtime under a source-available licence.
- The repo is still one of the best working examples of a single-maintainer agent factory. Take the gate, friction-loop, PR-door, chore-PR and skill-lock patterns in §4 into the Kit's conventions. Record the `GITHUB_TOKEN`-doesn't-trigger-workflows gotcha wherever the v1 spec defines how an Implementer's branch is pushed.
