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
- `templates/claude-settings.json` holds the `SessionStart` hook entry a Product repo merges into `.claude/settings.json`, and disables the `mattpocock-skills` plugin there. The entry reads the release from `fabrik.yml`, downloads Fabrik at that tag (public, no credentials) and runs `src/session/start.ts`, which installs the skills that release's `skills.lock.json` pins, the same commit the Kit step installs in Actions, plus Fabrik's own `skills/` (the `fabrik-live-design` skill).

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
- A `Fabrik Sandbox · <product>` vault holding the repo's test secrets, and the repo's read-only implement service account (reads the `Fabrik` vault and that one) stored as the Actions secret `FABRIK_OP_IMPLEMENT_TOKEN`.
- `.claude/skills/` in the repo's `.gitignore`, and the labels `needs-triage`, `needs-info`, `needs-design`, `ready-for-agent`, `ready-for-human`, `wontfix`, `agent:implement`, `bug` and `enhancement`.
- `templates/fabrik.yml` installed as `.github/workflows/fabrik.yml`, with every Fabrik `uses:` line pinned to the same exact tag. A run fails if they disagree. It runs on `issues` (opened, labeled) and `issue_comment` (created).

## Design session (async)

Adding `needs-design` to an open issue starts a Design session. Each turn is a fresh run of the Design-session agent job (Opus 5.5, 30 minutes by default, `roles.design` in the Kit config, plus `.fabrik/design.md` when present), one at a time per issue, rebuilding its context from the issue thread and the repo. A turn ends in one of two ways:

- **The next round**: the Fabrik App posts numbered questions with recommended answers, @-mentioning the Operator. The Operator's reply starts the next turn. Comments from anyone else, and from any bot, do nothing.
- **An agent brief**: the issue body is rewritten in place as the brief and its acceptance criteria, a closing comment (no mention) records the decisions, and `needs-design` is swapped for `ready-for-agent`. Finishing the session counts as the Operator approving it.

Only rounds notify: the Kit strips @-mentions from everything the agent writes.

## Design session (live)

The Operator can take a Design session live in a claude.ai/code or iOS cloud session, or a local Claude Code session, on the Product repo. The `SessionStart` hook installs the pinned skills into `.claude/skills/` and returns `reloadSkills: true`, because Claude Code discovers skills before `SessionStart` hooks finish. Then `/fabrik-live-design <issue>` runs the session (`skills/fabrik-live-design/SKILL.md`):

- It posts nothing on the issue until it ends, since every Operator comment on a `needs-design` issue starts an async turn.
- It runs with the Operator's own `gh` credentials and publishes the outcome itself: the issue body rewritten as its agent brief, or the Spec and its Tickets (category label and `ready-for-agent`, Tickets as sub-issues with native blocked-by edges).
- Its last act is one comment whose first line is `<!-- fabrik:live-outcome brief -->` or `<!-- fabrik:live-outcome spec -->`. From the Operator, that comment makes the Kit land the outcome as an async finish would: `brief` swaps `needs-design` for `ready-for-agent`, `spec` removes `needs-design` and closes the issue as completed, and both run a Dispatch check. Without the marker, a summary comment is an ordinary answer, and the async session carries on from it.

## Implementation

Dispatch adding `agent:implement` to a Ticket starts its Implementer (Sonnet 5.5, 60 minutes by default, `roles.implement`, plus `.fabrik/implement.md` when present), one run per Ticket at a time. The label comes off as the run starts; the open draft PR shows the Ticket is in progress.

- **The Sandbox** is a fresh clone of `main` on the runner, on the branch `fabrik/ticket-<n>`. The job holds only the implement service account. The Claude token and the test secrets listed in `sandbox.secrets` are resolved from 1Password into the Implement step's env only, so adding a test secret never means editing the caller workflow. `sandbox.setup` runs before the agent starts (daemonise any stubs it starts), and the prompt gives the Implementer the `build` and `test` commands to run.
- **The prompt** carries the Ticket, its parent Spec, `GLOSSARY.md`, the ADRs under `docs/adr/` and the Product's implement instructions, and starts the `implement` skill, which works test-first with `tdd`.
- **The push job** rebuilds the branch from the git bundle the agent job passed out and runs the trust-root guard on every path any of its commits changes:
  - **Allowed**: the Fabrik App pushes the branch and opens one draft PR to `main` with `Closes #<n>`, which starts CI. Nobody is notified.
  - **Refused** (it touches `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`, `.claude/skills/`, `prompts/`, `.fabrik/` or `.github/workflows/`): nothing is pushed. The Ticket moves to `ready-for-human`, is assigned to the Operator, and gets a comment listing the paths. This uses no retry.
  - **Empty diff**: an Execution flaw, never a pass. The Implementer runs again, silently, up to 2 times (the second a Step-up), and a third empty diff sends the Ticket to `needs-design`.

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
