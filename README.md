# Fabrik

A software factory: an agent-driven engineering loop that takes work from idea → spec → tickets → shipped code.

Status: building v1. See the Spec in GitHub Issues (#28).

## Layout

- `src/loop/` holds the **Loop rules core**: a pure function, `planFor(event, snapshot, config)`, that returns a plan. It does no I/O, and its tests (`*.test.ts`, next to the code) are the Loop's behaviour, one sentence each.
- `src/__fixtures__/` holds the snapshot builders the core's tests use.
- `src/kit/` holds the **Kit config** loader (`resolveKitConfig`: defaults and validation) and the caller workflow release check (`checkCallerWorkflow`). Both are pure; every run calls them before anything else.
- `src/github/` holds the thin **GitHub adapter**: it maps an Actions event to a Loop event, gathers the snapshot and applies the plan.
- `src/main.ts` is what a push job runs (`node src/main.ts`, Node 24, no build step and no runtime dependencies). Given `FABRIK_AGENT_RESULT`, it applies an agent job's output instead of the Actions event.
- `src/agent/` holds the **agent job** runner (`node src/agent/run.ts triage` or `design`): Sandcastle with `noSandbox()` on the runner VM, the metered-billing preflight as the last `onSandboxReady` step, the `init` check, the step summary, and the role's output passed out as `agent-result.json`. Only agent jobs install the runtime dependencies (Sandcastle and the Claude Code CLI, pinned exactly).
- `src/preflight/` holds the metered-billing preflight (pure) and the command the hook runs.
- `src/skills/` and `skills.lock.json` pin Matt Pocock's skills at a commit SHA and install them into a Product checkout's gitignored `.claude/skills/` (ADR-0003).
- `src/skills/bump.ts` decides the weekly skills bump PR (`.github/workflows/skills-bump.yml`), with the upstream diff in its body; `src/skills/bump-main.ts` is its step.
- `src/release/` checks that each release pins Sandcastle and the Claude Code CLI at exact versions, which Dependabot bumps (`.github/dependabot.yml`). See [docs/releasing.md](docs/releasing.md) for the release process.
- `src/kit/jobs.ts` is the Kit job's step: it validates the Kit config, asks the Loop rules core what the event calls for, and routes it to an agent job (when the plan starts an agent run), to the push job, or nowhere.
- `prompts/` holds the Kit's agent prompts.
- `.github/workflows/loop.yml` is the reusable workflow a Product repo calls. It holds wiring only.
- `.github/workflows/schedule.yml` is the reusable scheduled tick the caller workflow runs hourly, for the Loop's time-based rules (closing the weekly-limit issue after its reset). Like the push job, it never touches Product code.
- `src/loop/kitIssues.ts` holds the Kit-owned issues: the "Rotate the Claude token" issue (label `fabrik:token-rotation`) and the weekly-limit issue (label `fabrik:weekly-limit`), which buzz the Operator once per repo, or once per limit window, instead of once per Ticket.
- `templates/fabrik.yml` is the caller workflow a Product repo installs as `.github/workflows/fabrik.yml`.

## Developing

```sh
npm install
npm run typecheck
npm test
```

## What a Product repo needs today

- The Fabrik GitHub App installed (Issues, Pull requests and Contents; no `workflows`).
- A 1Password item `Fabrik App` in the `Fabrik App` vault, with fields `client-id` and `private-key`.
- The repo's read-only push service account (reads the `Fabrik App` vault) stored as the Actions secret `FABRIK_OP_PUSH_TOKEN`.
- A 1Password API Credential item `Claude token` in the `Fabrik` vault, holding the `claude setup-token` token in its `credential` field, with its expiry date.
- The repo's read-only agent service account (reads the `Fabrik` vault) stored as the Actions secret `FABRIK_OP_AGENT_TOKEN`.
- `.claude/skills/` in the repo's `.gitignore`, and the labels `needs-triage`, `needs-info`, `needs-design`, `ready-for-agent`, `ready-for-human`, `wontfix`, `bug` and `enhancement`.
- `templates/fabrik.yml` installed as `.github/workflows/fabrik.yml`, with every Fabrik `uses:` line pinned to the same exact tag. A run fails if they disagree. It runs on `issues` (opened, labeled) and `issue_comment` (created).

## Design session (async)

Adding `needs-design` to an open issue starts a Design session. Each turn is a fresh run of the Design-session agent job (Opus 5.5, 30 minutes by default, `roles.design` in the Kit config, plus `.fabrik/design.md` when present), one at a time per issue, rebuilding its context from the issue thread and the repo. A turn ends in one of two ways:

- **The next round**: the Fabrik App posts numbered questions with recommended answers, @-mentioning the Operator. The Operator's reply starts the next turn. Comments from anyone else, and from any bot, do nothing.
- **An agent brief**: the issue body is rewritten in place as the brief and its acceptance criteria, a closing comment (no mention) records the decisions, and `needs-design` is swapped for `ready-for-agent`. Finishing the session counts as the Operator approving it.

Only rounds notify: the Kit strips @-mentions from everything the agent writes.

## Kit config

A Product repo's Kit config lives in `.fabrik/`. Every file is optional and every field has a default, so a release never needs a config edit. An invalid config, or an unknown field, fails the run with a message naming the field.

`.fabrik/config.json` (the defaults shown):

```json
{
  "sandbox": {
    "setup": null,
    "build": null,
    "test": null,
    "checks": [],
    "env": {},
    "secrets": {}
  },
  "roles": {
    "triage": { "model": "claude-opus-5-5", "effort": null, "timeout_minutes": 10 },
    "design": { "model": "claude-opus-5-5", "effort": null, "timeout_minutes": 30 },
    "implement": { "model": "claude-sonnet-5-5", "effort": null, "timeout_minutes": 60 },
    "review": { "model": "claude-opus-5-5", "effort": null, "timeout_minutes": 30 },
    "dispatch": { "timeout_minutes": 10 },
    "step_up": { "model": "claude-opus-5-5", "effort": null }
  },
  "max_in_flight": 2,
  "operator": null
}
```

- Leave a field out to take its default. `null` is accepted only where the default is `null` (the Sandbox commands and `effort`). A `null` effort means the Claude Code CLI's default; otherwise set it to `low`, `medium`, `high`, `xhigh` or `max`.
- `sandbox.env` holds non-secret values. `sandbox.secrets` maps an env var name to an `op://` reference; a literal secret is refused.
- A model naming Fable (or the `best` alias) is refused in every role, because Fable can bill metered usage.
- `operator` is the Operator's GitHub login: the one person whose comments drive a Design session, whom its rounds and failure notices @-mention, and to whom `ready-for-human` work is assigned. `null` means the repo's owner; set it for a repo an organization owns.
- Per-phase instructions are optional Markdown files: `.fabrik/triage.md`, `.fabrik/design.md`, `.fabrik/implement.md` and `.fabrik/review.md`.
