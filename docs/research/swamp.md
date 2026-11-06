# How is Swamp built, and could it serve as part of Fabrik?

Research for [#14](https://github.com/jrey8343/fabrik/issues/14). Date: 2026-11-02.

**Question.** How is Swamp built as an agent-driven project, and could Swamp itself do one of Fabrik's jobs?

**Method.** Static reading of the local clone `../swamp` at `c94227f6` (2026-11-01). Nothing was installed, built or run. No sign-in was attempted. Two swamp-club.com pages were read: [pricing](https://swamp-club.com/pricing) and [the manual index](https://swamp-club.com/manual). Paths below are relative to the Swamp repo root unless a URL is given.

## Answer

**Borrow patterns only. Do not adopt Swamp as a component.**

Swamp is the most mature agent-driven repo we have looked at. Its gates are worth copying. But Swamp the product is a hosted-account platform for automating external systems. It is not a software-factory component. Every job it could do for Fabrik either duplicates Sandcastle or GitHub, or works against a standing decision on the map.

---

## Angle 1: Swamp as a factory example

### Who builds it, and how fast

- Four engineers at Elder Swamp Club, Inc. account for nearly every commit since August: 891, 395, 126 and 19 commits (`git shortlog -sn --since=2026-08-01`).
- 776 squash-merged PRs landed in October 2026, about 25 a day. The repo started on 2026-01-28 and has about 2,975 commits (`git log`).
- 196 of the last 200 commits are co-authored by Claude. PR bodies link a `claude.ai/code/session_…` URL. So implementation happens in Claude Code sessions driven by an engineer, not in AFK Sandboxes.
- Outside code is never accepted. "Only employees of Elder Swamp Club, Inc. are allowed to contribute code." The stated reason is that agent-scale changes can't be reviewed for supply-chain safety (`CONTRIBUTING.md`).

### How work enters

- **Issues live in swamp-club.com, not GitHub.** A workflow moves every new GitHub issue into the swamp-club "lab" and closes it on GitHub (`.github/workflows/auto-response.yml`).
- The `issue-lifecycle` skill says "Never use `gh` to fetch issue data" and "swamp-club is the source of truth" (`.claude/skills/issue-lifecycle/SKILL.md`, Key Rules 1 and 5).
- Lifecycle state lives in a Swamp extension model with explicit phase transitions: `triaging → classified → plan_generated → approved → implementing → verifying → pr_open → notify → summarizing → done` (`extensions/models/_lib/schemas.ts`, `TRANSITIONS`; `extensions/models/issue_lifecycle.ts`). Every transition posts a record to swamp-club.

### How the agent works through an issue (HITL throughout)

The `issue-lifecycle` skill drives each phase from a reference file (`.claude/skills/issue-lifecycle/references/*.md`). A generic skill reads repo-specific rules from `agent-constraints/`:

| Phase | Repo rule file | What it requires |
|---|---|---|
| Triage | `agent-constraints/triage-conventions.md` | Read `CLAUDE.md`, `design/` and the `ddd` skill. Use `git log` to spot regressions. For bugs, build a minimal repro in `/tmp/swamp-repro-issue-<N>` and keep it for verification |
| Plan | `agent-constraints/planning-conventions.md` | A DDD analysis, a docs-impact check (`design/`, skills), a UAT gap check against the separate `swamp-uat` repo, and a user-manual gap check |
| Plan review | `agent-constraints/adversarial-dimensions.md` | An adversarial review of the plan after every `plan`/`iterate`: architecture, scope, risk, testing, complexity, security (trust boundaries) |
| Implement | `agent-constraints/implementation-conventions.md` | Re-run the repo's repro against a freshly compiled binary |
| Conformance | `agent-constraints/code-conformance-dimensions.md` | Compare the code to the approved plan. Deviations are allowed but must be justified |
| Verify | `agent-constraints/verification-conventions.md` | Three host workflows, a checklist, an attestation (below) |

The human approves at several points. "Never auto-approve… Only call `approve` when the human explicitly says to proceed" (SKILL.md, Core Principles). "Never open a PR without asking first" (Key Rule 8). Before the attestation is posted, the user must confirm a green checklist (`verification-conventions.md`, step 8). Triage is interactive: "the human steers, you execute."

### How designs, evals and verification gate changes

- **Design docs are a fixed taxonomy.** Six primitives, plus "enablers" that must name the primitive they serve, plus "surfaces". Each doc has a `last-verified: <date> @ <sha>` header that a person bumps after checking it against the code (`design/README.md`). There is no `decisions/` folder. Rationale lives in a short _Why_ section inside the doc.
- **The `ddd` skill** is a short TypeScript/Deno guide. It picks a building block (value object, entity, aggregate, domain service, repository, application service) and lists the test types each one requires beyond unit tests (`.claude/skills/ddd/SKILL.md`). Planning and code review both invoke it (`CLAUDE.md` "Planning"; `verification/review-prompts/code-review.md`). Architecture fitness tests enforce the layer rule `cli → libswamp → domain ← infrastructure` (`integration/ddd_layer_rules_test.ts`).
- **Skill evals.** Bundled skills are scored with `tessl review` (≥ 90% average) and promptfoo trigger, routing and sufficiency evals. The evals run through `claude -p` on a claude.ai login with no API key (`contributing/skills-pipeline.md`; `.claude/skills/swamp/evals/*.json`; `evals/promptfoo/claude_cli_provider.mjs`).
- **Verification runs on the host, as Swamp workflows, each in a fresh `git worktree` at the exact commit** (`verification/workflow-verify-{build,reviews,skills}.yaml`):
  - `verify-build`: lint, fmt, type check, tests, deps audit, compile, smoke test.
  - `verify-reviews`: code, adversarial, UX and CI-security reviews in parallel, each guarded by file path. They default to `claude-opus-5-5` via `claude -p`, or Codex with a read-only permission profile. Prompts live in `verification/review-prompts/`.
  - `verify-skills`: tessl review plus trigger evals, guarded by skill paths.
- **A review passes only on an explicit verdict.** It passes only if a line starts with `VERDICT: pass`. A missing marker, empty output or provider error (rate limit, auth) fails the step. "A reviewer that does not answer in the required format is precisely when a human should look" (`scripts/check_review_verdict.ts`). The same file notes that earlier inference had recorded a review with two blocking findings as a pass.
- **Silent-skip hazard, documented.** A diff taken from the wrong checkout yields an empty file list. Every guard then skips and the workflow "reports success" without having examined the code. The fix: pin `repoPath`, use a merge-base three-dot diff, and check that each guard really fires (`verification-conventions.md`, "Guards").
- **Attestation.** `deno run build-attestation` builds a JSON document from the recorded runs. It holds step statuses, durations, review models and SHA-256 hashes of every verification config file at the commit. It is posted to swamp-club through the lifecycle model. The docs admit it checks shape, not provenance: "nothing yet stops a document being posted that it did not write" (`verification-conventions.md`, step 4).

### How review and merge happen

- **CI does not re-run the local checks.** It fetches the attestation for the head SHA from `swamp-club.com/api/v1/admin/attestations` and validates the commit, gate, freshness and config hashes. Then it approves the PR (`.github/workflows/ci.yml`, `validate-attestation`).
- **Three CI reviews still run with `ANTHROPIC_API_KEY`** through `anthropics/claude-code-action`. Each is gated by path: an adversarial review on core `src/` changes, a CI-security review on workflow changes, and a **review-integrity check** on "trust-root" files (`CLAUDE.md`, `AGENTS.md`, `verification/**`, `agent-constraints/**`, lifecycle references, verdict and attestation scripts). The integrity reviewer is told to treat those files as untrusted and audit them, not follow them (`ci.yml`, `changes` and `claude-review-integrity`).
- **PRs auto-merge with no human merge step.** CI squash-merges with `--match-head-commit` once every required job succeeds. The gate fails closed: a skipped review counts only if change detection succeeded and said it wasn't needed. A `hold` label blocks the merge, and fork PRs never auto-merge (`ci.yml`, `auto-merge`; `CLAUDE.md` "Source Control").

### Conventions worth noting

- **Commits** follow `type(scope): <a sentence stating the behaviour now> (swamp-club#N) (#PR)`. PR bodies have **Summary** and **Test Plan** sections. The Test Plan includes "red checks": the new test fails on `main`, and named mutations are caught. Sometimes it has a before/after table from the compiled binary. PR bodies end with `Co-authored-by: Claude…` and a session link (`git log -3`).
- A "Session Learnings" rule: before finishing, propose an AGENTS.md or skill update for anything that tripped the session (`AGENTS.md`, last section).
- `.claude/settings.json` only enables one plugin (`code-simplifier`). There are no repo hooks. Skills live in `.claude/skills/` (mirrored in `.agents/skills/` for other harnesses).

---

## Angle 2: Swamp as a component

### What Swamp is

"An AI-native automation tool." A user or agent models an external system as a **behavior** (a TypeScript type plus a YAML definition), runs its methods to produce versioned **data**, wires them into **workflows**, keeps credentials in **vaults**, and shares them through **serve** (`design/architecture.md`). "It runs no MCP server, never calls an LLM API, and knows nothing about CI platforms. Agents drive swamp; swamp does not host one" (same file, final section).

### Job by job

| Fabrik job | What Swamp offers | Fit |
|---|---|---|
| **Orchestrating the Loop** (label → Implementer → Reviewer → retries) | Workflows are DAGs of model-method steps. They support `manual_approval`, `wait_for_signal`, retries and resume, `forEach`, and concurrency caps. Serve adds cron triggers and signed webhooks (GitHub, Linear, Stripe…) mapped to workflow inputs (`design/primitives/workflows.md`, "Workflow Triggers", "Webhook Payload Extraction") | **Poor.** It is technically capable: a GitHub `issues.labeled` webhook could start a workflow whose `command/shell` step runs Sandcastle. But that rebuilds orchestration Sandcastle and GitHub Actions already own, in a third DSL. Fabrik's glue would then be Swamp workflows plus Swamp-specific skills, not the thinnest glue |
| **Keeping production secrets out of Sandboxes** | `vault.get()` resolves a secret at run time. Swamp passes it to the step as a sentinel and scrubs it from saved logs and data (`***`) through `SecretRedactor` (`design/primitives/vaults.md`, "Expression Security", "Sensitive Method Arguments") | **Wrong direction.** Redaction hides a secret from *Swamp's own records* once it has been **injected** into a step. Fabrik needs the secret never to reach the Sandbox. An agent step given a vault value still holds the plaintext. Swamp is not a sandbox either: it removed its `docker`/custom execution drivers, and isolation is now "a deployment property" of where a worker runs (`design/enablers/remote-execution.md`, "No execution drivers") |
| **Sandbox runtime** | Remote workers, leases and runners (`design/enablers/remote-execution.md`) | **None.** It runs a step wherever a worker is deployed. Sandcastle owns this job |
| **Observability** (what ran, why it failed, cost) | Recorded workflow runs and a run tracker (`design/enablers/run-tracker.md`). An audit hook log of agent tool calls (`design/surfaces/audit.md`). Chain-hashed serve audit (`design/enablers/serve-audit.md`). An **agent-sessions** extension that imports Claude Code transcripts into per-session records with turns, tool calls and token counts (`design/surfaces/agent-sessions.md`). A local dashboard and OTel export | **Partial and early.** It only records work run *through* Swamp. The agent-sessions piece, the closest to Fabrik's need, is a "prototype" behind a "Preview" chip (`agent-sessions.md`). It reports tokens, not cost against a Max x20 subscription |
| **Hosting with the laptop shut** | `swamp serve` is a long-running server with HA through a shared control-plane store and daemon units (`design/primitives/serve.md`) | **Adds a service.** Fabrik is a Kit, not a service. Serve would be one more server for the Operator to run and secure |
| **HITL step** | `manual_approval` pauses a run until someone approves through the CLI or dashboard (`workflows.md`) | **Redundant.** GitHub labels and comments already carry this, and GitHub is the system of record |

### Blocking constraints

- **A Swamp Club account gates every command.** "Every swamp subcommand needs a swamp-club.com account." It is checked before any work, using an Ed25519-signed proof cached locally. It fails open for only 24 hours when swamp-club is down. CI needs `SWAMP_API_KEY` plus `SWAMP_SIGNIN_TOKEN` from a collective token page (`design/surfaces/auth-gate.md`; `README.md` "Quick Start": "swamp needs one to run"). Each Sandbox or runner that called `swamp` would carry a third-party credential and depend on a third-party service.
- **Licensing.** The code is AGPLv3, with an exception covering extensions and definitions that use only the public extension API (`LICENSE`, `COPYING-EXCEPTION`). The binary is a separate commercial product under its own software license agreement. A self-built distribution must strip the trademarks and may not use Swamp Club services, the extension registry included (`OSS-FAQ.md`). Pricing: Personal $0; Team $9/user/month; "AGPL exemption" and on-prem Swamp Club are Enterprise-only ([pricing](https://swamp-club.com/pricing)). Calling the binary from Fabrik does not by itself put AGPL on Fabrik. But embedding or modifying Swamp code would, and the free path depends on the hosted service.
- **Maturity and churn.** The project is nine months old and has **2,724 release tags**, one per merge (`v20261101.220815.0-sha.c94227f6`). Large subsystems are still moving. Datastore format v3, serve team leader election and agent sessions all changed in the last week of commits. Design docs carry "to be split" and "to fold" notes (`design/README.md` index). Outside contributions are refused (`CONTRIBUTING.md`), so Fabrik could not upstream a fix.
- **Invasive repo setup.** `swamp repo init` installs skills into the user's global `~/.claude/skills`, registers audit hooks, and prepends a managed section to `CLAUDE.md` and `.gitignore` (`design/architecture.md` "The main way in"; the comment in `verification/workflow-verify-reviews.yaml` setup step; `CLAUDE.md` Testing notes). Swamp's own `CLAUDE.md` also redefines the word "workflow" for the agent. In a Product repo that is a lot of surface for an agent to trip on.

---

## Patterns worth borrowing

Each of these is a convention or a few lines of glue, not a dependency.

1. **A generic upstream skill plus repo-local constraint files.** `issue-lifecycle` reads `agent-constraints/<phase>-conventions.md` when present and falls back to defaults otherwise. This is exactly "extend Matt's skills through repo-local config, never fork." A Product repo could carry `agent-constraints/` files for triage, review and implementation that Fabrik's prompts point at.
2. **An explicit verdict marker, fail closed.** The Reviewer's output must start with a structured marker, for example `VERDICT: pass | execution-flaw | design-flaw`. A missing marker, empty output or provider error is never a pass (`scripts/check_review_verdict.ts`). This fits the map's execution-flaw/design-flaw split directly.
3. **Trust-root protection.** Any change to `AGENTS.md`, `CLAUDE.md`, skills, review prompts or constraint files gets its own review that treats those files as hostile (`ci.yml`, `claude-review-integrity`). An Implementer that edits the Reviewer's instructions in its own PR is a real risk for Fabrik. The cheap version is CODEOWNERS or a required check on those paths, plus a note in the Operator's merge view.
4. **Guards that must fire.** An empty diff makes every path-guarded check skip and the run "pass". Swamp pins the repo path, diffs against the merge base and checks that guards fire. This is the same hazard the map already lists ("checks that skip with exit 0 must never count as a pass").
5. **Subscription auth for headless reviews.** Swamp runs reviews and evals with `claude -p` on the claude.ai login. It warns that an exported `ANTHROPIC_API_KEY` silently takes over every review (`verification-conventions.md`, "Authentication"). This is evidence that a Max-subscription Reviewer works headless, and a gotcha to guard against so the Kit never falls back to metered spend without anyone noticing.
6. **Plan, adversarial plan review, then conformance review.** The plan is challenged before code is written. Afterwards the code is compared to the plan, and deviations need a justification (`agent-constraints/adversarial-dimensions.md`, `code-conformance-dimensions.md`). Fabrik's Reviewer could do the same against the ticket.
7. **Repro first.** For bugs, reproduce in a scratch environment during triage and reuse the repro to verify the fix (`triage-conventions.md`, `implementation-conventions.md`).
8. **PR evidence conventions.** Summary plus Test Plan with red checks: the test fails on `main`, and mutations are caught. Commit subjects say what the behaviour is now and reference the issue.
9. **Session Learnings.** Each session ends by proposing an AGENTS.md or skill update for anything that cost it time.
10. **`last-verified: <date> @ <sha>` on design docs and ADRs**, so stale docs are visible.

Not worth borrowing as-is: the attestation flow. It exists so CI can skip re-running checks done on a laptop, it needs an external store (swamp-club), and by Swamp's own account it doesn't prove provenance. Fabrik's checks can simply run in CI and report as GitHub checks.

---

## Where this touches the map's standing decisions

- **GitHub is the system of record.** Swamp moves issues *out* of GitHub into its own service. Adopting its lifecycle tooling would break this decision. The findings support the decision; they don't challenge it.
- **Merge gate.** Swamp auto-merges once its gates pass, with a `hold` label as the human override. At about 25 PRs a day across four engineers, a human merge step would be the bottleneck. That is a data point for a future "fast-track auto-merge" question, not a reason to reopen the decision for v1: on the Pilot, merge means production deploy.
- **Triage is AFK.** Swamp's own team keeps triage and plan approval HITL: "never auto-approve," the human steers. It is a team with a strong review stack, and it still has a person approve every plan before code is written. That is a soft challenge to fast-tracking `ready-for-agent` straight from AFK Triage without a plan check. The Merge gate still catches mistakes, but only after the work is done.
- **Sandboxes hold no production secrets.** Unaffected. Swamp's vault redaction doesn't help here, and Swamp has no sandbox.
- **Max x20, no metered spend.** Swamp runs local reviews on the subscription but uses `ANTHROPIC_API_KEY` for its GitHub Actions reviews (`ci.yml`). If Fabrik's Reviewer runs in GitHub Actions, the same pressure toward an API key will appear. Not checked here: whether `claude-code-action` can run on a subscription token. That belongs to the hosting and Max x20 research.
