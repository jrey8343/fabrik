# Fabrik

A software factory: an agent-driven engineering loop that takes work from idea → spec → tickets → shipped code.

Status: building v1. See the Spec in GitHub Issues (#28).

## Layout

- `src/loop/` holds the **Loop rules core**: a pure function, `planFor(event, snapshot, config)`, that returns a plan. It does no I/O, and its tests (`*.test.ts`, next to the code) are the Loop's behaviour, one sentence each.
- `src/__fixtures__/` holds the snapshot builders the core's tests use.
- `src/kit/` holds the **Kit config** loader (`resolveKitConfig`: defaults and validation) and the caller workflow release check (`checkCallerWorkflow`), which `checkKit` makes together. All are pure; every run, the Kit job's included, calls them before anything else, so no agent starts on an invalid Kit. `src/kit/pushJob.ts` decides what the push job applies from how the jobs before it ended.
- `src/github/` holds the thin **GitHub adapter**: `events.ts` maps an Actions event, or what an agent job passed out, to a Loop event; `snapshot.ts` gathers the snapshot, reading the Kit's comment markers back through `threads.ts`; `apply.ts` applies the plan; `client.ts` is the API client.
- `src/main.ts` is what the push, claim and Dispatch jobs run (`node src/main.ts`, Node 24, no build step and no runtime dependencies). In the push job (`FABRIK_NEEDS`), it applies an agent job's output, or its failure notice, instead of the Actions event.
- `src/agent/` holds the **agent job** runner (`node src/agent/run.ts triage`, `design`, `implement` or `review`): Sandcastle with `noSandbox()` on the runner VM, the metered-billing preflight as the last `onSandboxReady` step, the `init` check, the step summary, and the role's output passed out as `agent-result.json`. Only agent jobs install the runtime dependencies (Sandcastle and the Claude Code CLI, pinned exactly).
- `src/review/` holds the Review checks job's step (`node src/review/wait.ts`), which waits for an agent PR's required checks, and the pure rule for how they ended.
- `src/preflight/` holds the metered-billing preflight (pure) and the command the hook runs.
- `src/skills/` and `skills.lock.json` pin Matt Pocock's skills at a commit SHA and install them into a Product checkout's gitignored `.claude/skills/` (ADR-0003).
- `src/skills/bump.ts` decides the weekly skills bump PR (`.github/workflows/skills-bump.yml`), with the upstream diff in its body; `src/skills/bump-main.ts` is its step.
- `src/release/` checks that each release pins Sandcastle and the Claude Code CLI at exact versions, which Dependabot bumps (`.github/dependabot.yml`). See [docs/releasing.md](docs/releasing.md) for the release process.
- `src/kit/jobs.ts` is the Kit job's step: it checks the Kit config and the caller workflow's pins, asks the Loop rules core what the event calls for, and routes it to an agent job (when the plan starts an agent run), to the push job, or nowhere.
- `prompts/` holds the Kit's agent prompts.
- `.github/workflows/loop.yml` is the reusable workflow a Product repo calls. It holds wiring only. The steps its jobs share are composite actions in `.github/actions/`: `prepare-agent` readies an agent job (installs the Kit, fetches the skills, and reads the agent's inputs through `src/agent/inputs.ts`), and `run-loop` runs the Loop as the Fabrik App.
- `.github/workflows/schedule.yml` is the reusable scheduled tick the caller workflow runs hourly, for the Loop's time-based rules (closing the weekly-limit issue after its reset). Like the push job, it never touches Product code.
- `src/loop/kitIssues.ts` holds the Kit-owned issues: the "Rotate the Claude token" issue (label `fabrik:token-rotation`) and the weekly-limit issue (label `fabrik:weekly-limit`), which buzz the Operator once per repo, or once per limit window, instead of once per Ticket.
- `templates/fabrik.yml` is the caller workflow a Product repo installs as `.github/workflows/fabrik.yml`.
- `templates/claude-settings.json` holds the `SessionStart` hook entry a Product repo merges into `.claude/settings.json`, and disables the `mattpocock-skills` plugin there. The entry reads the release from `fabrik.yml`, downloads Fabrik at that tag (public, no credentials) and runs `src/session/start.ts`, which installs the skills that release's `skills.lock.json` pins, the same commit the Kit step installs in Actions, plus Fabrik's own `skills/` (`fabrik-live-design`, `fabrik-pair` and `fabrik-setup`).
- `src/setup/` is the setup program the `fabrik-setup` skill runs: `plan.ts` is the pure planner (what a Product repo holds now in, the steps it's missing out), `shims.ts` merges the Kit-owned files into the Product's own, and `main.ts` gathers the state with `gh` and `op` and applies the plan. `templates/` holds what it installs.

## Developing

```sh
npm install
npm run typecheck
npm test
```

## Adopting the Kit

The Operator adopts the Kit in a Product repo by running the `fabrik-setup` skill from local Claude Code in the repo's checkout (`skills/fabrik-setup/SKILL.md`). The first time, the repo doesn't have Fabrik's skills yet, so copy the skill in from the release:

```sh
v=v1.0.0   # the Fabrik release to adopt
d=$(mktemp -d)
curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/$v" | tar -xzf - -C "$d" --strip-components=1
mkdir -p ~/.claude/skills && cp -R "$d/skills/fabrik-setup" ~/.claude/skills/
```

Then run `/fabrik-setup v1.0.0` in the Product repo. It needs the Operator's `gh` (repo admin, with the `workflow` scope), `op` signed in as the Operator, and Node 24. It shows its plan (`node src/setup/main.ts <checkout> <release>`), and on the Operator's go-ahead applies it (`--apply`) and opens a PR with the files:

- **Kit-owned files**, put back whenever they drift: `.github/workflows/fabrik.yml` with every Fabrik `uses:` line pinned to the release, the `SessionStart` hook entry and the `mattpocock-skills` plugin switched off in `.claude/settings.json`, `.claude/skills/` in `.gitignore`, and a `.github/dependabot.yml` entry that bumps only the Fabrik pin, every pinned Fabrik workflow in one grouped PR, with no cooldown. Each is merged into the Product's own file. A caller pinned to an earlier major is migrated; within a major, Dependabot owns the pin.
- **Starters**, written once and the Product's from then on: `.fabrik/config.json` with every v1 default, `docs/agents/*` with Fabrik's fixed answers (GitHub Issues, the triage labels plus `needs-design`, a single-context glossary and ADRs), and an `## Agent skills` block pointing at them in `CLAUDE.md`, or in `AGENTS.md` when there's no `CLAUDE.md`.
- **Labels**: `needs-triage`, `needs-info`, `needs-design`, `ready-for-agent`, `ready-for-human`, `wontfix`, `agent:implement`, `agent:review`, `bug`, `enhancement`, `fabrik:token-rotation` and `fabrik:weekly-limit`.
- **1Password** (ADR-0004): the `Fabrik`, `Fabrik App` and `Fabrik Sandbox · <repo>` vaults when they're missing, and three read-only service accounts with no expiry, `fabrik-<owner>-<repo>-agent` (reads `Fabrik`), `-implement` (reads `Fabrik` and the Sandbox vault) and `-push` (reads `Fabrik App`), stored as the Actions secrets `FABRIK_OP_AGENT_TOKEN`, `FABRIK_OP_IMPLEMENT_TOKEN` and `FABRIK_OP_PUSH_TOKEN`.
- **Branch protection** on the default branch: a PR, the checks in `sandbox.checks` (plus any already required), and no bypass allowance for anyone. No approving review is required, since the solo Operator can't approve their own PRs.
- **The Merge gate ruleset** (`Fabrik Merge gate`): only repo admins may update the default branch, merging a PR included. The Operator owns the repo, so only they can merge; the Fabrik App, never an admin, can't.

Then the Operator runs the wizard (`skills/fabrik-setup/wizard.sh`, made with the `wizard` skill) in their own terminal, for what only they can do: installing the Fabrik App on the repo (Issues, Pull requests and Contents; no `workflows`) and storing its `client-id` and `private-key` in the `Fabrik App` item; `claude setup-token` into the `Claude token` API Credential in the `Fabrik` vault, with its expiry; GitHub mobile pushing only mentions, assignments and review requests, with Actions off; and watching the repo on All activity.

Re-running `/fabrik-setup` on a working install changes nothing. On a broken one it repairs only what's missing: a missing label is created, and a missing secret gets a new service account (1Password shows a token only once, so delete the old account by hand).

## Design session (async)

Adding `needs-design` to an open issue starts a Design session. Each turn is a fresh run of the Design-session agent job (Opus 5.5, 30 minutes by default, `roles.design` in the Kit config, plus `.fabrik/design.md` when present), one at a time per issue, rebuilding its context from the issue thread, the issue's parent Spec when it has one, and the repo. A turn ends in one of these ways (see [Back to design](#back-to-design) for splitting a Ticket):

- **The next round**: the Fabrik App posts numbered questions with recommended answers, @-mentioning the Operator. The Operator's reply starts the next turn. Comments from anyone else, and from any bot, do nothing.
- **An agent brief**: the issue body is rewritten in place as the brief and its acceptance criteria, a closing comment (no mention) records the decisions, and `needs-design` is swapped for `ready-for-agent`. Finishing the session counts as the Operator approving it.

Only rounds notify: the Kit strips @-mentions from everything the agent writes.

A turn that fails for Infrastructure leaves `needs-design` on the issue, so it stays in its session: the failure notice asks the Operator to reply, and their reply runs the turn again.

## Design session (live)

The Operator can take a Design session live in a claude.ai/code or iOS cloud session, or a local Claude Code session, on the Product repo. The `SessionStart` hook installs the pinned skills into `.claude/skills/` and returns `reloadSkills: true`, because Claude Code discovers skills before `SessionStart` hooks finish. Then `/fabrik-live-design <issue>` runs the session (`skills/fabrik-live-design/SKILL.md`):

- It posts nothing on the issue until it ends, since every Operator comment on a `needs-design` issue starts an async turn.
- It runs with the Operator's own `gh` credentials and publishes the outcome itself: the issue body rewritten as its agent brief, or the Spec and its Tickets (category label and `ready-for-agent`, Tickets as sub-issues with native blocked-by edges).
- Its last act is one comment whose first line is `<!-- fabrik:live-outcome brief -->` or `<!-- fabrik:live-outcome spec -->`. From the Operator, that comment makes the Kit land the outcome as an async finish would: `brief` swaps `needs-design` for `ready-for-agent`, `spec` removes `needs-design` and closes the issue as completed, and both run a Dispatch check. Without the marker, a summary comment is an ordinary answer, and the async session carries on from it.

## Pairing session

The Operator works through a `ready-for-human` issue with an agent beside them by running `/fabrik-pair <issue>` in a cloud or local Claude Code session on the Product repo (`skills/fabrik-pair/SKILL.md`). It runs with the Operator's own `gh` credentials:

- It counts as the Operator, so it may change Trust-root files. It refuses an issue that isn't open and `ready-for-human`, except the weekly-limit issue: there it waits for the reset before restarting the stalled Tickets, and still finishes the restart after the Kit has closed the issue. The issue body's `- [ ]` task list is the plan; with none, the session agrees one with the Operator and writes it in below the original text. A rerun resumes at the first unticked step.
- It talks the Operator through simple steps, and builds a wizard (`.claude/skills/wizard`) in a temp folder, never committed, for dashboards, credentials or a run of commands.
- It ticks each step once a command confirms it (`gh secret list`, `gh api`, `op item get`, reading the file) or, where nothing can, once the Operator does. File changes, Trust-root files included, go out in one pull request whose body has `Closes #<n>`, never pushed to the default branch.
- It ends with a comment saying what was done, and closes the issue, or leaves that to the pull request's merge. Stopping partway, it comments where it stopped and leaves the issue open and assigned. No comment names a secret's value or @-mentions anyone.

The token-rotation and weekly-limit issues the Kit opens write their steps as a task list and point at `/fabrik-pair`.

## Implementation

Dispatch adding `agent:implement` to a Ticket starts its Implementer (Sonnet 5.5, 60 minutes by default, `roles.implement`, plus `.fabrik/implement.md` when present), one run per Ticket at a time. The label comes off as the run starts; the open draft PR shows the Ticket is in progress.

- **The Sandbox** is a fresh clone of `main` on the runner, on the branch `fabrik/ticket-<n>`. The job holds only the implement service account. The Claude token and the test secrets listed in `sandbox.secrets` are resolved from 1Password into the Implement step's env only, so adding a test secret never means editing the caller workflow. `sandbox.setup` runs before the agent starts (daemonise any stubs it starts), and the prompt gives the Implementer the `build` and `test` commands to run.
- **The prompt** carries the Ticket, its parent Spec, `GLOSSARY.md`, the ADRs under `docs/adr/` and the Product's implement instructions, and starts the `implement` skill, which works test-first with `tdd`.
- **The push job** rebuilds the branch from the git bundle the agent job passed out and runs the trust-root guard on every path any of its commits changes:
  - **Allowed**: the Fabrik App pushes the branch and opens one draft PR to `main` with `Closes #<n>`, which starts CI. Nobody is notified.
  - **Refused** (it touches `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`, `.claude/skills/`, the Kit's role prompts `prompts/<role>.md` (a Product's other `prompts/` files are its own), `.fabrik/` or `.github/workflows/`): nothing is pushed. The Ticket moves to `ready-for-human`, is assigned to the Operator, and gets a comment listing the paths. A refused retry or Request-changes run also closes its PR unmerged, keeping its branch, so it no longer holds a `max_in_flight` slot. This uses no retry.
  - **Empty diff**: an Execution flaw, never a pass. The Implementer runs again, silently, up to 2 times (the second a Step-up), and a third empty diff sends the Ticket to `needs-design`.

## Review

Every agent draft PR is reviewed before the Operator sees it. The Fabrik App opening the PR, or pushing to it, starts a Review; adding `agent:review` to the PR resumes one after a failure. One Review runs per PR at a time, within the Review timeout (30 minutes by default, `roles.review`).

- **Required checks** come first. The Review checks job waits for them on the PR's head: the checks named in `sandbox.checks` when it lists any, otherwise the branch protection's required checks. A skipped or cancelled check never counts as passed.
- **Red checks** are an Execution flaw. The Reviewer doesn't run.
- **Green checks** start the read-only Reviewer (Opus 5.5 by default, plus `.fabrik/review.md` when present) in a checkout of the PR's head. It holds only the agent service account and runs none of the PR's code. It judges the PR against its Ticket, the Ticket's Spec, the repo's standards and the review instructions.
- **The Verdict contract**: the Reviewer's reply starts with exactly one line, `verdict: pass`, `verdict: execution-flaw` or `verdict: design-flaw`, then its findings. Anything else, an empty reply or a provider error, is an Infrastructure failure, never a pass.
- **Posting**: the push job posts every Verdict, red checks' included, as a PR comment from the Fabrik App, linking its run. The comment's first line is a marker, `<!-- fabrik:verdict {"verdict":…,"source":"reviewer"|"ci"|"empty-diff","requestChanges":…,"headSha":…} -->`, so a PR's review history can be read from its comments alone. The marker is only read from bot comments. A Verdict is posted once per head commit, and never for a commit the PR has moved on from.
- **A pass** takes the PR out of draft and requests the Operator's review, the event's one notification. A flaw is posted and mentions nobody.

## Execution-flaw retries

An Execution flaw gets fixed without the Operator, silently: no mention, assignment or review request.

- **The trigger**: an Execution-flaw Verdict, from the Reviewer or red CI, adds `agent:implement` to the PR's Ticket. On a Ticket whose agent PR is open, that label resumes the PR's Implement run rather than starting a new branch: the Implementer runs again on the PR's own branch, in a fresh clone checked out at its head, with the latest Verdict's findings in its prompt. The label comes off as the run starts.
- **The count**: retries are counted from the PR's earlier Verdict comments alone, up to 2. Verdicts marked as from a Request-changes run don't count, and an Infrastructure failure posts no Verdict, so it never uses one up: re-adding `agent:implement` on the Ticket runs the same retry again. It resumes a stalled Request-changes run the same way: the PR is still in draft with its pass as the latest Verdict, and the Operator's review requesting changes is on its head.
- **The Step-up**: the first retry runs on the Implementer's model (`roles.implement`), the second on the Step-up model (Opus 5.5 by default, `roles.step_up`), for that PR only. The Kit never drops to a cheaper model or skips a Step-up for any reason.
- **The push**: the push job runs the trust-root guard on the run's own changes and updates the PR's branch, which starts Review again. It also replaces the PR body with the run's `summary`, which describes the whole PR as it now stands, so the next Review never reads a stale one, and posts the run's `fix` (what it was asked to fix and what it changed) as a comment. A retry may merge `main` in when a finding needs work that has since landed there (the Reviewer asks for a merge, never a rebase), and a Request-changes run may merge `main` in or rebase onto it to fix a conflict: the guard then judges only the run's own commits (a merge showing only what was changed by hand) and the paths it changed that don't now match `main`, never what `main` already has, and the push may replace the branch, with a lease, so a branch that moved meanwhile refuses it. Only the agent branch is ever pushed. A retry that commits nothing is posted as an Execution-flaw Verdict with source `empty-diff`, and counts like any other.
- **Used up**: a third Execution flaw is posted, starts no retry, and counts as a Design flaw.

## Back to design

A Ticket that can't be built as designed goes back to the Operator. A Design-flaw Verdict, or a third Execution flaw, closes the PR unmerged (its branch `fabrik/ticket-<n>` stays), and the Fabrik App posts a note on the Ticket linking the closed PR and its Verdict. Its first line is a marker, `<!-- fabrik:back-to-design <pr> <verdict url> -->`, read only from bot comments. Then `ready-for-agent` comes off the Ticket and `needs-design` goes on, which starts a Design session.

- **Round 1** of that session says the Ticket came back from the closed PR and links its Verdict. Its @-mention of the Operator is the event's one notification: the failed review, the closed PR and the note mention nobody.
- **The outcome** rewrites the Ticket in place as an agent brief, or splits it into sibling Tickets under the same Spec (a `split` outcome: each a sub-issue of the Spec, with native blocked-by edges, and the Ticket closed as superseded). A Ticket under a Spec never gets a Spec of its own, and only a Ticket under a Spec can split. When a Spec or a split supersedes an issue, its new Tickets take the issue's place among its blockers: each Ticket nothing else in the outcome blocks takes on the issue's open blockers, each open issue it blocked waits on the Tickets that finish last, and the closing comment lists what moved.
- **The model**: a Step-up applies only to the PR it ran on, so a rewritten or split Ticket starts again on the Implementer's default model.

## Merge gate

A passing PR leaves draft and requests the Operator's review. Only the Operator merges; the Merge gate ruleset and branch protection, which the setup skill applies, enforce it. The Operator has three moves:

- **Merge**: the PR's `Closes #<ticket>` closes the Ticket, which runs a Dispatch check. When that was the last open Ticket under its Spec, the Kit closes the Spec as completed, with a comment listing each Ticket's merged PRs. The comment mentions nobody.
- **Request changes**: a review from the Operator that requests changes on an agent PR out of draft puts it back in draft and starts one Implementer run on the Step-up model, on the PR's branch, with the review and its inline comments as input. It isn't a retry. Its push carries a `<!-- fabrik:request-changes-run -->` note, so the Verdict Review gives it is marked as from a Request-changes run and uses no retry; later retries count as before. On a pass the PR leaves draft and the Operator's review is requested again, the event's one notification. To fix a conflict, ask for a rebase in the review: the Implementer merges `origin/main` into the branch, since the Kit only fast-forwards it. A review from anyone else, or on a draft PR, does nothing. The caller workflow runs on `pull_request_review` (submitted) for this. GitHub has no `_target` form of that event, so the run uses the PR's copy of the caller workflow and Kit config, which an agent branch can never change (ADR-0005).
- **Send it back**: adding `needs-design` to an open agent PR takes the Design-flaw route: the PR closes unmerged, keeping its branch, and the Ticket swaps `ready-for-agent` for `needs-design`. The note's marker is `<!-- fabrik:back-to-design <pr> operator -->`, and round 1 says the Operator sent the Ticket back.

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
- `max_in_flight` caps how many Tickets are in flight at once: open agent draft PRs, Implement runs in progress, and Tickets dispatched but not yet started. Set it to `0` to pause Dispatch: the Kit adds `agent:implement` to no new Ticket, while Intake, Triage, Design, Review, the Merge gate, retries and Request-changes runs carry on. Set it back above `0` and Dispatch resumes at the next Dispatch check, which the Loop runs on events such as an issue closing, a Design session ending or the Fast path; changing the config doesn't start one by itself.
- `operator` is the Operator's GitHub login: the one person whose comments drive a Design session, whom its rounds and failure notices @-mention, and to whom `ready-for-human` work is assigned. `null` means the repo's owner; set it for a repo an organization owns.
- Per-phase instructions are optional Markdown files: `.fabrik/triage.md`, `.fabrik/design.md`, `.fabrik/implement.md` and `.fabrik/review.md`.
