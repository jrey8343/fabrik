# Sandcastle: how it orchestrates agents, and how Matt Pocock runs it

Research for [#4](https://github.com/jrey8343/fabrik/issues/4). Date: 2026-11-02.

**Sources.** The local clone of `mattpocock/sandcastle` at commit `85e8e6d` (package `@ai-hero/sandcastle` 0.12.0), read-only. Paths below are relative to that repo unless they start with `https://`. The public docs at https://www.aihero.dev/sandcastle are rendered from `docs/guide/` (`AGENTS.md`, "User docs"), and the landing page adds nothing beyond `README.md`.

Fabrik terms (Operator, Implementer, Reviewer, Sandbox, Merge gate, Loop, AFK, HITL) follow `GLOSSARY.md`. Sandcastle has its own glossary in `CONTEXT.md`. Where its terms differ (host, iteration, branch strategy, sandbox provider), they are marked as Sandcastle's.

---

## TL;DR

- **Sandcastle is a library, not a service.** You write a TypeScript script that calls `run()` / `createSandbox()`, and something else has to execute that script: a person, cron, or CI. It has no daemon, scheduler, webhook listener, queue, or GitHub integration. It never pushes a branch and never opens a PR (`grep` over `src/` and `docs/guide/` finds no `git push` or `gh pr`).
- **Matt's factory runs on GitHub Actions, not on his laptop.** Issue and PR labels (`agent:implement`, `agent:review`, `agent:update-branch`, `agent:explore`) trigger workflows on `ubuntu-latest`. Each workflow checks out the repo, installs Claude Code, and runs a Sandcastle script with **`noSandbox()`**, so the throwaway runner VM is the isolation boundary. The YAML pushes the branch, opens a draft PR and moves labels. The agent is told not to (`.github/workflows/agent-*.yml`, `.sandcastle/agent-workflows/`).
- **Auth in CI uses the Claude subscription.** Every agent workflow passes `secrets.CLAUDE_CODE_OAUTH_TOKEN` (made with `claude setup-token`) into `claudeCode("claude-opus-4-8", { env: { CLAUDE_CODE_OAUTH_TOKEN } })` (`.sandcastle/agent-workflows/shared/common.ts`). `sandcastle init` scaffolds the OAuth token as the default and an API key as the commented-out alternative (`src/InitService.ts:449-453`).
- **The model is chosen per `run()` call.** `claudeCode(model, { effort })` becomes `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> [--effort <e>] -p -`, with the prompt sent on stdin (`src/AgentProvider.ts:1614-1650`). So one pipeline can run a lighter Implementer and a frontier Reviewer.
- **Review is a second `run()` on the same branch.** The scaffolded templates' reviewer is a *refiner*: it commits clean-ups and does not judge the work. Matt's CI reviewer also refines, then posts a GitHub `COMMENT` review from structured output and marks the PR ready. Neither one classifies failures.

---

## 1. The `run()` model

`run(options)` takes three required things and returns a result (`docs/guide/api.md`):

| Input                      | What it is                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                    | An **agent provider** such as `claudeCode("claude-opus-4-8", { effort: "high" })`. It builds the CLI command and parses its stream. |
| `sandbox`                  | A **sandbox provider** such as `docker()`, `bwrap()`, `vercel()` or `noSandbox()`, with provider config inside the factory call.    |
| `prompt` \| `promptFile`   | An inline prompt, passed literally, or a prompt template with `{{KEY}}` args and `` !`cmd` `` shell expressions run inside the sandbox (`docs/guide/prompts.md`). |

Optional inputs include `branchStrategy`, `maxIterations` (default 1), `hooks`, `copyToWorktree`, `completionSignal` (default `<promise>COMPLETE</promise>`), `idleTimeoutSeconds` (600), `completionTimeoutSeconds` (60), `output` (structured output, schema-validated), `resumeSession`, `signal` and `logging` (file or stdout, plus `onAgentStreamEvent` for observability).

**Lifecycle of one `run()`** (`docs/guide/configuration.md` "Hooks", `src/SandboxLifecycle.ts`, `src/Orchestrator.ts`):

1. Create a worktree under `.sandcastle/worktrees/` on the host, unless the branch strategy is `head`.
2. Copy `copyToWorktree` files in, then run `host.onWorktreeReady` hooks.
3. Create the sandbox. Run `host.onSandboxReady` and `sandbox.onSandboxReady` hooks in parallel (e.g. `npm install`).
4. Expand the prompt (shell expressions run inside the sandbox).
5. Loop up to `maxIterations` times. Each **iteration** is one agent invocation. The loop stops early when the completion signal appears in the output.
6. Collect commits, merge back according to the branch strategy, then tear down.

**`createSandbox()`** keeps one sandbox warm for several `sandbox.run()` calls on the same branch, which is the implement-then-review pattern. **`sandbox.exec()`** runs shell commands such as `npm test` between runs, as a verification gate (`docs/guide/api.md` "createSandbox()"; CHANGELOG 0.12.0). **`createWorktree()`** separates worktree lifetime from sandbox lifetime.

**Sessions.** `RunResult.resume(prompt)` continues the agent session for one more iteration (`claude --resume`). `.fork(prompt)` branches it (`--fork-session`). `Output.object({ maxRetries })` re-prompts the same session when structured output fails validation (`docs/guide/prompts.md` "Structured output"; ADRs 0011, 0018, 0021).

---

## 2. How Claude Code is invoked and authenticated inside a sandbox

**Invocation.** For AFK runs, the `claudeCode` provider builds this command (`src/AgentProvider.ts:1647`):

```
claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <model> [--effort <level>] [--resume <id> [--fork-session]] -p -
```

The prompt goes in on stdin. Passing `permissionMode` replaces `--dangerously-skip-permissions` with `--permission-mode <mode>` (`ClaudeCodeOptions`, same file). The sandbox is meant to be the containment layer, so Sandcastle runs agents with their permission prompts skipped and tells you to turn off the agent's own sandboxing (`docs/guide/sandbox-providers.md` "Agents' own sandboxes").

**Authentication: subscription or API key.**

- `sandcastle init` writes `.sandcastle/.env.example` with `CLAUDE_CODE_OAUTH_TOKEN=` as the default and `# ANTHROPIC_API_KEY=` commented out. The comment says the token "Lets the agent use your Claude subscription instead of an API key" (`src/InitService.ts:449-453`, `:914`; `docs/guide/getting-started.md` step 3).
- Native sandboxes give each sandbox a fresh private home, so the host's `~/.claude` login is hidden. **The agent can log in only through env vars** (`docs/guide/sandbox-providers.md` "Logins"; ADR 0024). The same applies to `gh`: put a `GH_TOKEN` in `.sandcastle/.env`.
- Docker and Podman inject the merged env as `-e` flags (`src/DockerLifecycle.ts:124`). Vercel and Daytona pass it to the cloud SDK's create call (`src/sandboxes/daytona.ts:113-121`).
- **Env resolution** (`src/EnvResolver.ts`): only keys *declared* in `.sandcastle/.env` are read, and an empty value falls back to `process.env`. A repo-root `.env` is ignored. That result is merged with the agent provider's `env` and the sandbox provider's `env`. Provider env wins, and an agent/sandbox key overlap throws (`src/mergeProviderEnv.ts`). So in CI, without a `.sandcastle/.env`, secrets have to be passed explicitly, which is what Matt does with `claudeCode(model, { env: { CLAUDE_CODE_OAUTH_TOKEN } })`.
- **Exception: `noSandbox()` passes the whole host `process.env` to the agent** (`src/sandboxes/no-sandbox.ts:53`). In Matt's CI that includes `GH_TOKEN` (a `GITHUB_TOKEN` with `contents: write`, `pull-requests: write`).
- *Not verified in the Sandcastle sources; check against Claude Code's auth docs:* Claude Code is believed to prefer `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN` when both are set. If that's true, an API key that leaks into the sandbox env would quietly switch a run to metered billing. Matt's own repo-local `.sandcastle/.env.example` lists `ANTHROPIC_API_KEY=` and `GH_TOKEN=`, but his CI uses only the OAuth token.

**Usage visibility.** The Claude stream parser pulls token usage per iteration (`parseSessionUsage`, `src/AgentProvider.ts`) and context-window size (ADR 0023). A fixture shows that Claude Code emits `rate_limit_event` lines with `rateLimitType: "five_hour"` (`src/__fixtures__/context-window/claude-code.stream.jsonl:2`). Sandcastle doesn't act on them: no back-off, queueing or limit awareness.

## 3. Per-run model selection

The model is the first argument of every agent provider factory, and `effort` (`low|medium|high|xhigh|max`) is an option. Both are set per `run()` / `sandbox.run()` call, so every phase of a pipeline can differ (`docs/guide/api.md` "All options"). What the shipped code actually uses:

| Where                                                            | Planner  | Implementer         | Reviewer            | Merger     |
| ---------------------------------------------------------------- | -------- | ------------------- | ------------------- | ---------- |
| `src/templates/parallel-planner-with-review/main.mts`            | opus-4-8 | sonnet-4-6          | sonnet-4-6          | sonnet-4-6 |
| `src/templates/sequential-reviewer/main.mts`                     | n/a      | sonnet-4-6          | sonnet-4-6          | n/a        |
| Matt's local `.sandcastle/run.ts`                                | opus-4-8 | opus-4-8            | opus-4-8            | (agent)    |
| Matt's CI (`.sandcastle/agent-workflows/shared/common.ts`)       | n/a      | opus-4-8            | opus-4-8            | n/a        |

Matt runs his own factory on Opus for every role. The init default for Claude Code is `claude-opus-4-8` (`src/InitService.ts:447`).

## 4. Branch strategies and merge-back

Set with `branchStrategy` on `run()` (`docs/guide/how-it-works.md`; `CONTEXT.md` "Branching"):

| Strategy                         | Behaviour                                                                                                                                                                                                                                 | Default for                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `head`                           | The agent writes straight into the host working directory. No worktree.                                                                                                                                                                   | bind-mount providers             |
| `merge-to-head`                  | Creates a temp branch in a worktree, then `git merge`s it into the host's current branch. If the merge fails, it is aborted so HEAD is untouched, and the temp branch is kept with recovery instructions (`src/SandboxLifecycle.ts:99-136`, `:487`). | isolated providers               |
| `branch` (`{ branch: "foo" }`)   | Commits land on a named branch in a worktree. A re-run reuses the worktree and fast-forwards it from `origin` when safe (ADR 0003).                                                                                                        | n/a                              |

- **Bind-mount providers** (native, Docker, Podman) mount the worktree and `.git` into the sandbox, so commits go directly to the host repo. The git control files (`.git/config`, `hooks`, `info`) are mounted read-only, and host-side git ignores repo hooks and program-naming config (`docs/guide/how-it-works.md`).
- **Isolated providers** (Vercel, Daytona, custom isolated) have their own filesystem. Sync-in creates a **git bundle** of the host repo and clones it inside the sandbox (`src/syncIn.ts`). Sync-out runs `git format-patch` in the sandbox and `git am --3way` on the host, plus a diff for uncommitted work and file copies for untracked files. Patches are saved to `.sandcastle/patches/<ts>/` first so a failure can be recovered (`src/syncOut.ts`). Host commits therefore get **new SHAs**, and a sandbox-owned ref `refs/sandcastle/sync-base` tracks the base (ADR 0017).
- **Sandcastle merges only locally.** "Merge back" means a local `git merge` into the host's checked-out branch. In the planner templates, a **merger agent** merges every completed branch into the current branch and closes the issues (`src/templates/parallel-planner-with-review/merge-prompt.md`). Getting the work to a PR is left to the caller. Matt's CI does it with `git push --force` and `gh pr create --draft` in YAML.

## 5. Review pipelines

- **Templates** (`src/templates/sequential-reviewer`, `parallel-planner-with-review`): when the Implementer made commits, a reviewer `sandbox.run()` runs in the **same warm sandbox on the same branch**. Its prompt diffs `{{TARGET_BRANCH}}...{{BRANCH}}`, loads `@.sandcastle/CODING_STANDARDS.md` (kept out of the implement prompt to save tokens), checks correctness, test coverage and security, and **commits improvements** while preserving behaviour. If the code is already clean, it does nothing (`review-prompt.md`). It returns no pass/fail verdict.
- **Matt's CI reviewer** (`.github/workflows/agent-review.yml`, `.sandcastle/agent-workflows/review/`):
  - Triggered by the `agent:review` PR label, which the implement workflow adds automatically.
  - Feeds the agent the linked issue, the diff to main and the existing PR comments as JSON.
  - The agent may commit improvements and answer human review threads (address, decline or defer). A second *extraction* run resumes the same session and emits `<output>` JSON (summary, inline comments, replies), validated with `Output.object` and up to 2 retries (`shared/run-with-extraction.ts`).
  - The workflow, not the agent, then pushes with `--force-with-lease`, posts a GitHub review with `event: "COMMENT"`, posts the thread replies and runs `gh pr ready`.
  - On failure it adds `agent:blocked` and comments the reason.
  - The verdict is only `improved` or `clean` (`review.ts`). The PR is never approved or merged by an agent.
- **Other agent roles in Matt's CI:**
  - `agent-implement-pr.yml` implements on an existing PR.
  - `agent-update-branch.yml` resolves merge conflicts. It uses `pull_request_target`, because `pull_request` won't fire on a conflicted PR, and only runs for same-repo PRs.
  - `agent-explore.yml` does batch triage: it groups duplicates, explores with subagents and posts per-issue assessments.

## 6. Parallelism

- **In-process:** `Promise.allSettled(issues.map(...))`, one `createSandbox()` per issue on its own branch (`sandcastle/issue-{id}`, deterministic so re-planning keeps progress). A failed pipeline doesn't cancel the others (`parallel-planner-with-review/main.mts`). Matt's local `run.ts` adds a hand-rolled semaphore, `MAX_PARALLEL = 4`. Sandcastle has no built-in concurrency limit.
- **Planner first:** an Opus planner emits a `<plan>` JSON of *unblocked* issues, using a dependency graph that treats overlapping files as blocking to avoid merge conflicts (`plan-prompt.md`). An outer loop repeats plan, execute and merge up to `MAX_ITERATIONS` times.
- **Safety rule:** `head` and `merge-to-head` are **not** safe under concurrency. Parallel work needs a distinct `branch` per child (`docs/guide/cli-commands.md` "Session fork"; ADR 0018). Git refuses to check out one branch in two worktrees (CHANGELOG 595e21e). Worktrees are locked (ADR 0007).
- **In CI:** each labelled issue or PR is its own Actions job. `concurrency` groups (`agent-implement-issue-<n>`, `agent-mutate-pr-<n>`) serialise runs per issue or PR, and nothing limits how many issues run at once. A preflight refuses an issue that already has an open collaborator PR, as well as sub-issues and PRD-shaped issues (`agent-implement.yml`).

## 7. Sandbox providers: what each needs from the host, and the trade-offs

Built-ins are in `docs/guide/sandbox-providers.md` (Daytona is missing from that table but ships: `src/sandboxes/daytona.ts`, `package.json` exports and optional peer dep `@daytona/sdk`, CHANGELOG 16315da). Background research is in `research/sandbox-provider-research.md`.

| Provider                         | Kind                 | Host must provide                                                                                                                                       | Strengths                                                                                                                    | Weaknesses                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `noSandbox()`                    | none                 | All tools (`claude`, `gh`, node…) on the host                                                                                                           | Zero setup; supports `interactive()`; fine when the host itself is disposable (Matt's CI runner)                             | No isolation; agent sees full host `process.env` and home                                                                                                                                                                                        |
| `bwrap()`                        | native, bind-mount   | Linux/WSL2 + `bubblewrap`; agent CLI on host `PATH`; on Ubuntu ≥ 24.04 an AppArmor profile allowing unprivileged userns (`sudo`)                         | No image, no daemon; ~runc-grade isolation; host home, logins and other repos hidden; private home; processes killed on close | Shared kernel; network open incl. host localhost; no root / `sudo` hooks; no `interactive()`; toolchain = whatever host has (ADR 0024)                                                                                                            |
| `seatbelt()`                     | native, bind-mount   | macOS ≥ 14 (uses `/usr/bin/sandbox-exec`); agent CLI on `PATH`                                                                                          | Nothing to install                                                                                                           | Weaker than Docker Desktop's VM; Keychain not guaranteed hidden; no PID namespace; `setsid` processes survive close; can't nest                                                                                                                  |
| `docker()`                       | image, bind-mount    | Docker daemon; image built via `sandcastle docker build-image` from `.sandcastle/Dockerfile` (needs non-root `agent` user, git, gh, Claude Code CLI)      | Reproducible image; VM boundary on macOS/Windows; root hooks; `interactive()`; networks, devices, cap-drop, cpus options      | Daemon + image to maintain (toolchain installed twice); container start per run; history of UID/permission bugs (`docs/research/permissions-systemic-fix.md`, ADR 0014)                                                                         |
| `podman()`                       | image, bind-mount    | Podman (rootless); `Containerfile`; `sandcastle podman build-image`                                                                                     | Daemonless, rootless; SELinux labels; `--userns=keep-id`                                                                     | Same image upkeep as Docker; Podman Machine VM off Linux                                                                                                                                                                                         |
| `vercel()`                       | isolated (cloud)     | `@vercel/sandbox`; `VERCEL_TOKEN` + team + project id, or OIDC; **still a host process running Sandcastle with the git repo**                           | Firecracker microVM per run (strongest isolation); default image ships `claude`; network policy, ports, vCPU, timeout options | Metered cloud cost; bundle/patch sync (new SHAs, sync failure modes); default branch strategy `merge-to-head`; a named runtime ships no agent CLI (`src/sandboxes/vercel.ts`)                                                                     |
| `daytona()`                      | isolated (cloud)     | `@daytona/sdk`; `DAYTONA_API_KEY` (+ optional URL/target); host process as above                                                                        | Ephemeral sandboxes, fast start, image or snapshot creation, `sudo` hooks; self-hostable (AGPL)                              | Metered; same sync semantics; undocumented in `docs/guide` (code only)                                                                                                                                                                           |
| custom                           | either               | Implement `createBindMountSandboxProvider` (`exec`, `close`, `copyFileIn`, `copyFileOut`, `worktreePath`) or `createIsolatedSandboxProvider` (`exec`, `close`, `copyIn`, `copyFileOut`, `worktreePath`) | Wrap any runtime (E2B, Fly, Modal…)                                                                                          | You own lifecycle, streaming and output bounding (`docs/guide/custom-sandbox-providers.md`)                                                                                                                                                      |

Sandcastle's own research names the key divide: "Bind-mounting local directories is only possible with local tools. Every cloud service requires file syncing" (`research/sandbox-provider-research.md` "Key architectural insight"). **Even with a cloud provider, a host still runs the Node orchestrator and owns the git repo.** Vercel and Daytona move the agent's *execution* off the host. They don't remove the need for an always-on host.

Native providers **never fall back** to running unsandboxed. A missing tool throws `NativeSandboxUnavailableError` with a `fixCommand` (ADR 0024). ADR 0024 also says "`interactive()` is removed in v1 (#1058)". The current docs still list it, so treat it as on the way out.

## 8. What a host must provide to run unattended (laptop shut)

Taken together from the sections above:

1. **Something always on that executes the script and triggers it.** Sandcastle has no trigger of its own. Matt uses GitHub Actions `issues: labeled`, `pull_request: labeled` and `workflow_dispatch` events.
2. **Node 22 + `tsx`**, the repo checked out with full history (`fetch-depth: 0`), and `npm ci` for the Product repo's deps. A hook can install them inside the sandbox instead.
3. **The agent CLI** in the right place: on the host `PATH` for `noSandbox`/native providers (Matt runs `npm install -g @anthropic-ai/claude-code`), baked into the image for Docker/Podman, or in the cloud image for Vercel's default.
4. **Credentials as env vars, not stored logins:** `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and a `GH_TOKEN` if the agent should read issues. Pass them through `.sandcastle/.env` keys or explicitly through `claudeCode({ env })`.
5. **The sandbox runtime**: a Docker/Podman daemon, `bwrap` plus AppArmor userns on Ubuntu 24.04, or cloud API keys.
6. **Git identity and push rights *outside* the agent.** Matt sets `user.name "sandcastle-agent[bot]"`, and the workflow pushes and opens PRs with `GITHUB_TOKEN` or an optional `AGENT_PAT`. A PAT is needed so a PR label added by the workflow can trigger the next workflow.
7. **Timeouts and failure reporting**: a job `timeout-minutes: 60`, Sandcastle's `idleTimeoutSeconds`/`completionTimeoutSeconds`, a `failure_reason.txt` turned into an issue comment, plus `agent:blocked` and `agent:in-progress` labels always cleaned up.

---

## Implications for Fabrik

- **Where Fabrik runs.** Matt's working answer to "laptop shut, least ops" is **GitHub Actions on the Product repo**. Labels are the trigger, the hosted runner is a fresh VM per job, and there is no server to keep alive. It lines up with Fabrik's standing decisions: GitHub as system of record, `ready-for-agent` as the trigger, and the least-ongoing-ops preference. Cloud sandboxes (Vercel, Daytona) don't remove the need for a host, so on their own they don't answer the hosting question.
- **Sandbox choice inside Actions.**
  - *Matt's choice:* `noSandbox()` on the ephemeral runner, so the runner VM is the GLOSSARY's Sandbox. Simplest.
  - *Defence in depth:* `bwrap()` on the runner, which needs the AppArmor step on `ubuntu-latest` (24.04). It keeps the agent away from the runner's env and `GH_TOKEN`, and passes only what's in `.sandcastle/.env` or `claudeCode({ env })`.
  - *Rebuilt image:* `docker()` gives a reproducible image, but it must be rebuilt per job or pulled from a registry.
- **Implementer wiring.**
  - One Actions job per `ready-for-agent` issue. The job checks out a branch, then runs `run({ agent: claudeCode(<lighter model>), sandbox, promptFile })` with the agent forbidden to push, label or open PRs.
  - The job (Fabrik glue) pushes and opens the PR. Use `branchStrategy: { type: "branch" }` or a pre-created branch. Don't use `merge-to-head` and don't use the template merger agent: both merge locally, which bypasses the PR and Merge gate model.
- **Reviewer wiring.**
  - A second job triggered by a PR label, running a frontier model (`claudeCode("claude-opus-4-8", { effort: "high" })`).
  - Unlike Sandcastle's reviewers, Fabrik's Reviewer must **judge and classify**. Use structured output (`Output.object` with `maxRetries`, or Matt's produce-then-extract pattern) and a schema such as `{ verdict: "pass" | "execution_flaw" | "design_flaw", summary, comments[] }`.
  - The workflow maps the verdict to labels: re-trigger the Implementer (count retries ≤ 2 through labels or comments) or apply `needs-design`. `RunResult.resume()` or a fresh run can carry the Reviewer's findings back to the Implementer.
- **Parallelism and limits.** Every concurrent job shares one subscription token and its five-hour limit. Sandcastle doesn't notice rate limits, so the "Concurrency and queueing" frontier item belongs to Fabrik: Actions `concurrency` groups or a cap on how many `ready-for-agent` jobs run at once. Merge conflicts between parallel PRs map to Matt's `agent:update-branch` pattern, not the merger agent.
- **Reusable upstream pieces (no fork needed):** `run`, `createSandbox`, `sandbox.exec` as a test gate before review, `Output.object`, `resume`, `onAgentStreamEvent` for observability, and per-iteration `usage`. Matt's `.github/workflows/agent-*.yml` and `.sandcastle/agent-workflows/` are **repo-local examples, not part of the npm package**. Fabrik writes its own equivalents as Kit glue rather than vendoring them.

## Where the findings press on the map's standing decisions

1. **"Max x20, no metered API spend; never a quiet fallback."** *Supported but fragile.* Sandcastle and Matt's CI both run Claude Code on the subscription through `CLAUDE_CODE_OAUTH_TOKEN`. However, the token has to live inside every Sandbox, where an AFK agent with open network could exfiltrate it through prompt injection. And if Claude Code does prefer `ANTHROPIC_API_KEY` when both are present (to verify), any stray API key in the env would quietly switch to metered billing. The Kit should assert that `ANTHROPIC_API_KEY` is absent. Usage also isn't throttled: N parallel Implementers drain one shared five-hour window.
2. **"Sandboxes hold no production secrets."** *Holds, but scope it.* In Matt's model the Sandbox also holds a GitHub token with `contents: write` (with `noSandbox()` the agent inherits it) and the Operator's subscription token. Neither is a production secret, but the Merge gate then rests entirely on **branch protection**, and the decision should name these two credentials explicitly.
3. **"Hosting judged on laptop-shut, then least ops."** *Strongly suggests an answer.* GitHub Actions, as Matt uses it. Cloud sandbox providers don't qualify on their own because they still need a host process. Open costs: Actions minutes on a private Pilot repo, and the 6-hour hosted-job cap (Matt uses 60-minute timeouts).
4. **"Reviewer classifies execution versus design flaw, with retries."** *Not provided upstream.* Sandcastle's reviewers refine and comment. Classification, retry counting and label routing are new Fabrik glue (prompt plus schema plus workflow), which is small but real.
5. **"Sandcastle consumed upstream, never forked."** *Holds.* Everything Fabrik needs is configuration, prompts and a thin script plus workflows. One caveat: `interactive()` is slated for removal (ADR 0024), so HITL Design sessions shouldn't be built on Sandcastle. They belong in a normal Claude Code session.
