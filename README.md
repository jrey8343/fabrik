# Fabrik

A software factory: an agent-driven engineering loop that takes work from idea → spec → tickets → shipped code.

Status: building v1. See the Spec in GitHub Issues (#28).

## Layout

- `src/loop/` holds the **Loop rules core**: a pure function, `planFor(event, snapshot, config)`, that returns a plan. It does no I/O, and its tests (`*.test.ts`, next to the code) are the Loop's behaviour, one sentence each.
- `src/__fixtures__/` holds the snapshot builders the core's tests use.
- `src/kit/` holds the **Kit config** loader (`resolveKitConfig`: defaults and validation) and the caller workflow release check (`checkCallerWorkflow`), which `checkKit` makes together. All are pure; every run, the Kit job's included, calls them before anything else, so no agent starts on an invalid Kit. `src/kit/pushJob.ts` decides what the push job applies from how the jobs before it ended.
- `src/github/` holds the thin **GitHub adapter**: `events.ts` maps an Actions event, or what an agent job passed out, to a Loop event; `snapshot.ts` gathers the snapshot, reading the Kit's comment markers back through `threads.ts`; `apply.ts` applies the plan; `client.ts` is the API client.
- `src/main.ts` is what the push, claim and Dispatch jobs run (`node src/main.ts`, Node 24, no build step and no runtime dependencies). In the push job (`FABRIK_NEEDS`), it applies an agent job's output, or its failure notice, instead of the Actions event.
- `src/agent/` holds the **agent job** runner (`node src/agent/run.ts triage`, `design`, `implement`, `review` or `audit`): Sandcastle with `noSandbox()` on the runner VM, the metered-billing preflight as the last `onSandboxReady` step, the `init` check, the step summary, and the role's output passed out as `agent-result.json`. Only agent jobs install the runtime dependencies (Sandcastle and the Claude Code CLI, pinned exactly).
- `src/review/` holds the Review checks job's step (`node src/review/wait.ts`), which waits for an agent PR's required checks, and the pure rule for how they ended.
- `src/preflight/` holds the metered-billing preflight (pure) and the command the hook runs.
- `src/skills/` and `skills.lock.json` pin Matt Pocock's skills, the Base skills, at a commit SHA and install them into a Product checkout's gitignored `.claude/skills/` (ADR-0003), beside the Extra skills a Product repo picks from its own Skills sources (ADR-0008, see [Extra skills](#extra-skills)). `src/skills/fetch.ts <product checkout> [role]` installs them; `src/skills/pinnedManifests.ts` is the Kit job's check of the picks against each source's manifest at its pin.
- `src/skills/bump.ts` decides the weekly skills bump PR (`.github/workflows/skills-bump.yml`), with the upstream diff in its body; `src/skills/bump-main.ts` is its step. The same planner decides a Product repo's bump PRs for its own Skills sources, which `src/skills/sourceBumps.ts` pushes from the scheduled tick (`src/skills/source-bumps-main.ts`, gated by `src/skills/source-bumps-due.ts`).
- `src/release/` checks that each release pins Sandcastle and the Claude Code CLI at exact versions, which Dependabot bumps (`.github/dependabot.yml`). See [docs/releasing.md](docs/releasing.md) for the release process.
- `src/kit/jobs.ts` is the Kit job's step: it checks the Kit config and the caller workflow's pins, asks the Loop rules core what the event calls for, and routes it to an agent job (when the plan starts an agent run), to the push job, or nowhere.
- `prompts/` holds the Kit's agent prompts, and `prompts/scorers/` the Scorers' versioned rubrics (Efficiency, Ticket compliance and Skill use), which `src/kit/kitFiles.ts` reads and `src/kit/rubrics.ts` parses. A rubric changed without a version bump fails its tests' version guard. The `run-judge` action has the Kit's fixed judge model apply them to a finished Implement run's transcript, with no tools and no write credential (`src/kit/judge-main.ts`), and the `write-score-record` action writes the score file and the judge's own Run record to `fabrik-runs` (`src/kit/score-record-main.ts`), which, like `src/main.ts`, imports no runtime dependency: a test holds every program an action runs without `npm ci` to that. `loop.yml`'s judge job (`score`) and score-record job run them.
- `.github/workflows/loop.yml` is the reusable workflow a Product repo calls. It holds wiring only. The steps its jobs share are composite actions in `.github/actions/`: `prepare-agent` readies an agent job (installs the Kit, fetches the skills, and reads the agent's inputs through `src/agent/inputs.ts`), and `run-loop` runs the Loop as the Fabrik App. After it, the push job's `write-run-record` writes the run's Run record and transcript to the `fabrik-runs` store (`src/kit/runRecord.ts`, `src/kit/recordWriter.ts`, ADR-0009), with the store token its `store-token` action mints, as `write-score-record` does. It never fails the push job, and a Product whose Operator hasn't set up `fabrik-runs` gets one step-summary line saying so. For a record in the store, the same step runs the Scorers' scoring plan (`src/kit/scorer.ts`, `src/kit/scoreRecord.ts`): it writes a skipped run's score file itself, and for a picked run the judge job (`score`) and then the score-record job, the judge run's own push job, run after the push job. Nothing in the Loop waits on them, and Dispatch never counts the judge job as an Implement run.
- `.github/workflows/schedule.yml` is the reusable scheduled tick the caller workflow runs hourly, for the Loop's time-based rules (closing the weekly-limit issue after its reset, and opening the week's pending Audit), once a week the Product repo's skills bumps, and in a job of its own the Monitor. Like the push job, it never touches Product code.
- `src/monitor/` holds the **Monitor**, which the scheduled tick runs hourly in its own job, with no model call and no Run record: `core.ts` is the pure Monitor core (what it files, rewrites, holds and closes, and the step summary's lines), `redMain.ts` its red-main part, `issues.ts` what both parts share of a Monitor issue and its body, `sentry.ts` the pure Sentry translator, `sentryApi.ts` the Sentry API reads, and `main.ts` the thin program that gathers the facts, with the GitHub reads in `src/github/monitorFacts.ts`, and applies the plan. `errors-set.ts` is the job's gate, so the Sentry token loads only when the Kit config sets `monitor.errors`. See `monitor` in the [Kit config](#kit-config).
- `.github/workflows/weekly-summary.yml` is the reusable Weekly summary the `fabrik-runs` store's caller runs each Monday morning. Its `file-weekly-summary` action reads the store's Run records, its score files and every Product repo's GitHub facts (`src/github/facts.ts`), builds the summary (`src/kit/weeklySummary.ts`, its metrics read through the Retro evidence module, `src/kit/retroEvidence.ts`) and files it in `fabrik-runs` (`src/kit/weeklyFiling.ts`). Its **Scores** section, shown only in a week with score files, gives each rubric version's runs scored, median score and share passing against last week, the skips by reason, and what scoring cost as a share of the week's cost, which cost per merged PR and per Spec leave out. It never lists a run's own scores. It never touches Product code either.
- `src/loop/kitIssues.ts` holds the Kit-owned issues: the "Rotate the Claude token" issue (label `fabrik:token-rotation`) and the weekly-limit issue (label `fabrik:weekly-limit`), which buzz the Operator once per repo, or once per limit window, instead of once per Ticket.
- `src/loop/audit*.ts` holds the Audit (label `fabrik:audit`, see [Audit](#audit)): the audit gate the scheduled tick runs (`auditGate.ts`), the pending Audit's Auditor run (`audit.ts`), the Audit output parser (`auditOutput.ts`), and filling the Audit in or failing it (`auditLanding.ts`, `auditFailure.ts`).
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
- **Labels**: `needs-triage`, `needs-info`, `needs-design`, `ready-for-agent`, `ready-for-human`, `wontfix`, `agent:implement`, `agent:design`, `agent:review`, `bug`, `enhancement`, `fabrik:token-rotation`, `fabrik:weekly-limit`, `fabrik:audit`, `fabrik:retro` and `fabrik:monitor`.
- **1Password** (ADR-0004): the `Fabrik`, `Fabrik App` and `Fabrik Sandbox · <repo>` vaults when they're missing, and three read-only service accounts with no expiry, `fabrik-<owner>-<repo>-agent` (reads `Fabrik`), `-implement` (reads `Fabrik` and the Sandbox vault) and `-push` (reads `Fabrik App`), stored as the Actions secrets `FABRIK_OP_AGENT_TOKEN`, `FABRIK_OP_IMPLEMENT_TOKEN` and `FABRIK_OP_PUSH_TOKEN`.
- **Branch protection** on the default branch: a PR, the checks in `sandbox.checks` (plus any already required), and no bypass allowance for anyone. No approving review is required, since the solo Operator can't approve their own PRs.
- **The Merge gate ruleset** (`Fabrik Merge gate`): only repo admins may update the default branch, merging a PR included. The Operator owns the repo, so only they can merge; the Fabrik App, never an admin, can't.

Then the Operator runs the wizard (`skills/fabrik-setup/wizard.sh`, made with the `wizard` skill) in their own terminal, for what only they can do: installing the Fabrik App on the repo (Issues, Pull requests and Contents, plus Checks: read for the Monitor's red main; no `workflows`) and storing its `client-id` and `private-key` in the `Fabrik App` item; `claude setup-token` into the `Claude token` API Credential in the `Fabrik` vault, with its expiry; a Sentry token (`event:read` and `project:read`) into the `Sentry token` API Credential in the `Fabrik App` vault, a stage a repo without Sentry skips; GitHub mobile pushing only mentions, assignments and review requests, with Actions off; and watching the repo on All activity.

Re-running `/fabrik-setup` on a working install changes nothing. On a broken one it repairs only what's missing: a missing label is created, and a missing secret gets a new service account (1Password shows a token only once, so delete the old account by hand).

## Triage

A person's reply on a `needs-info` issue swaps `needs-info` for `needs-triage`, which starts Triage again; a bot's reply does nothing. Deleting the reply doesn't undo the swap: Triage still runs, reads the thread without the reply, and most likely asks its questions again, one more round and one more notification.

## Design session (async)

Adding `needs-design` to an open issue starts a Design session, once a slot is free. Each turn is a fresh run of the Design-session agent job (Opus 5.5, 30 minutes by default, `roles.design` in the Kit config, plus `.fabrik/design.md` when present), one at a time per issue, rebuilding its context from the issue thread, the issue's parent Spec when it has one, and the repo. A turn ends in one of these ways (see [Back to design](#back-to-design) for splitting a Ticket):

- **The next round**: the Fabrik App posts numbered questions with recommended answers, @-mentioning the Operator. The Operator's reply starts the next turn. Comments from anyone else, and from any bot, do nothing. A turn answers the reply as it read it: edit the reply before the turn starts and it sees the edit; to change an answer after that, post a new reply, since an edit never starts a turn. Delete the reply before its turn posts and the turn posts nothing; only a turn that fails still posts its failure notice.
- **An agent brief**: the issue body is rewritten in place as the brief and its acceptance criteria, a closing comment (no mention) records the decisions, and `needs-design` is swapped for `ready-for-agent`. Finishing the session counts as the Operator approving it.
- **Not planned**: when the Operator decides the issue won't be built, the session finishes as not planned (`{ "kind": "not-planned", "comment": … }`). The closing comment (no mention) gives the session's reasoning, `needs-design` is swapped for `wontfix`, and the issue closes with state reason *not planned*. It works the same on a Ticket that came back to design. Its work never lands, so the issues it blocks stay blocked: Dispatch treats a blocker closed as not planned as still blocking until the Operator removes the edge, and the closing comment names those issues. The reasoning lives only in that comment.

Only rounds notify: the Kit strips @-mentions from everything the agent writes.

At most `caps.design_sessions` Design sessions (2 by default) are open in a Product repo at once. A session holds its slot from its first turn until it ends: while a turn runs, after a round, and after a turn fails. Any outcome above, a live outcome, closing the issue or removing `needs-design` frees it. Adding `needs-design` by any route (Triage, the Operator, a Design flaw, Retries used up, an empty diff or the Merge gate) runs a Design queue check, which adds `agent:design` to start round 1 when a slot is free; the label comes off as the turn starts. While both slots are taken the issue just waits: it keeps `needs-design`, gets no comment or label, and nobody is notified. The run's step summary says which issues wait. When a slot frees, re-designs (a Ticket sent back to design) start first, then the oldest by when it got `needs-design`, then the lowest number. A queue check runs whenever a session ends, an issue closes, the Kit config changes and on the hourly tick, so a slot freed by removing `needs-design` by hand is used within the hour. The Operator's comment on a waiting issue starts nothing: round 1 reads the whole thread, so it is context. A live outcome on a waiting issue still lands.

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
  - **Refused** (it touches `AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md` at the repo root, `.claude/settings*`, `.claude/skills/`, the Kit's role prompts `prompts/<role>.md` and its Scorers' rubrics `prompts/scorers/` (a Product's other `prompts/` files are its own), `.fabrik/` or `.github/workflows/`): nothing is pushed. The Ticket moves to `ready-for-human`, is assigned to the Operator, and gets a comment listing the paths. A refused retry or Request-changes run also closes its PR unmerged, keeping its branch, so it no longer holds a `max_in_flight` slot. This uses no retry.
  - **Empty diff**: an Execution flaw, never a pass. The Implementer runs again, silently, up to 2 times (the second a Step-up), and a third empty diff sends the Ticket to `needs-design`.

## Review

Every agent draft PR is reviewed before the Operator sees it. The Fabrik App opening the PR, or pushing to it, starts a Review; adding `agent:review` to the PR resumes one after a failure. One Review runs per PR at a time, within the Review timeout (30 minutes by default, `roles.review`).

- **Required checks** come first. The Review checks job waits for them on the PR's head: the checks named in `sandbox.checks` when it lists any, otherwise the branch protection's required checks. A skipped or cancelled check never counts as passed.
- **Red checks** are an Execution flaw. The Reviewer doesn't run.
- **Green checks** start the read-only Reviewer (Opus 5.5 by default, plus `.fabrik/review.md` when present) in a checkout of the PR's head. It holds only the agent service account and runs none of the PR's code. It judges the PR against its Ticket, the Ticket's Spec, the repo's standards and, when the repo has one at its root, `CODING_STANDARDS.md`, which only the Reviewer is given.
- **The Verdict contract**: the Reviewer's reply starts with exactly one line, `verdict: pass`, `verdict: execution-flaw` or `verdict: design-flaw`, then its findings. Anything else, an empty reply or a provider error, is an Infrastructure failure, never a pass.
- **Follow-ups**: a pass has no nits. Its findings are what the Reviewer checked, and it may end with Follow-ups: work that deserves its own issue but lies outside the Ticket's scope. They come after the findings and before any `operator comments considered:` line, as a `follow-ups:` line, then one `- <title>` item per Follow-up with its Markdown body indented two spaces beneath it. The Verdict comment shows them under `### Follow-ups`, each with an **Open as issue** link to the Product repo's new-issue form, prefilled with its title and its body ending `From PR #<n>`, cut short to fit GitHub's URL limit. The Kit never files one itself. A flaw drops a Follow-ups block, and a malformed block on a pass stays in the findings as plain text, so the Verdict still lands.
- **Posting**: the push job posts every Verdict, red checks' included, as a PR comment from the Fabrik App, linking its run. The comment's first line is a marker, `<!-- fabrik:verdict {"verdict":…,"source":"reviewer"|"ci"|"empty-diff","requestChanges":…,"headSha":…} -->`, so a PR's review history can be read from its comments alone. The marker is only read from bot comments. A Verdict is posted once per head commit, and never for a commit the PR has moved on from.
- **A pass** takes the PR out of draft and requests the Operator's review, the event's one notification. A flaw is posted and mentions nobody.

## Execution-flaw retries

An Execution flaw gets fixed without the Operator, silently: no mention, assignment or review request.

- **The trigger**: an Execution-flaw Verdict, from the Reviewer or red CI, adds `agent:implement` to the PR's Ticket. On a Ticket whose agent PR is open, that label resumes the PR's Implement run rather than starting a new branch: the Implementer runs again on the PR's own branch, in a fresh clone checked out at its head, with the latest Verdict's findings in its prompt. The label comes off as the run starts.
- **The count**: retries are counted from the PR's earlier Verdict comments alone, up to 2. Every Execution flaw counts, whoever pushed the flawed head, the Operator included (ADR-0006). Verdicts marked as from a Request-changes run don't count, and an Infrastructure failure posts no Verdict, so it never uses one up: re-adding `agent:implement` on the Ticket runs the same retry again, on whatever head the PR is at by then. It resumes a stalled Request-changes run the same way: the PR is still in draft with its pass as the latest Verdict, and the Operator's review requesting changes is on the head that passed.
- **In flight**: a retry is in flight from the Verdict that calls for it until it pushes (its note opens `<!-- fabrik:retry-push -->`), ends in an empty diff or is refused, and that includes the stall after an Infrastructure failure. A Request-changes run is in flight from the Operator's review until it pushes. Meanwhile a push to the PR, the Operator's included, starts no Review and gets no Verdict, so it uses no retry: the run's own push starts the next Review, which judges the PR as it then stands.
- **The Step-up**: the first retry runs on the Implementer's model (`roles.implement`), the second on the Step-up model (Opus 5.5 by default, `roles.step_up`), for that PR only. The Kit never drops to a cheaper model or skips a Step-up for any reason.
- **The push**: the push job runs the trust-root guard on the run's own changes and updates the PR's branch, which starts Review again. It also replaces the PR body with the run's `summary`, which describes the whole PR as it now stands, so the next Review never reads a stale one, and posts the run's `fix` (what it was asked to fix and what it changed) as a comment. A retry may merge `main` in when a finding needs work that has since landed there (the Reviewer asks for a merge, never a rebase), and a Request-changes run may merge `main` in or rebase onto it to fix a conflict: the guard then judges only the run's own commits (a merge showing only what was changed by hand) and the paths it changed that don't now match `main`, never what `main` already has, and the push may replace the branch, with a lease. Only the agent branch is ever pushed. A retry that commits nothing is posted as an Execution-flaw Verdict with source `empty-diff`, and counts like any other.
- **A branch that moved**: if the PR's branch moved while the run worked, say because the Operator pushed, the push job rebases the run's own commits onto the new head, without a working tree, and pushes that (ADR-0006). The guard and the empty-diff rule judge only the run's own commits, never the ones it landed on, so the Operator's commits in between may touch trust-root files. If the rebase conflicts, or the run had rewritten the history it built on, nothing is pushed: the Kit comments on the PR that the run's work was discarded and starts the same run again on the new head, with the same findings or review, using no retry. Restarts aren't capped.
- **Used up**: a third Execution flaw is posted, starts no retry, and counts as a Design flaw.

## Back to design

A Ticket that can't be built as designed goes back to the Operator. A Design-flaw Verdict, or a third Execution flaw, closes the PR unmerged (its branch `fabrik/ticket-<n>` stays), and the Fabrik App posts a note on the Ticket linking the closed PR and its Verdict. Its first line is a marker, `<!-- fabrik:back-to-design <pr> <verdict url> -->`, read only from bot comments. Then `ready-for-agent` comes off the Ticket and `needs-design` goes on, which starts a Design session.

- **What the session sees**: every turn of that session gets the closed PR set out after the issue: every Verdict the Fabrik App gave it, oldest first, each with the head commit it judged (or, when the Operator sent it back, the Operator's reviews on it with their inline comments), then its kept branch's commits, changed files and diff against the base branch. A diff over 60,000 characters is cut short with a marker; the file list stays whole. Nobody else's comments on the PR are included. The agent job reads all of it through its read-only token, so the agent itself still holds no GitHub token.
- **Round 1** of that session says the Ticket came back from the closed PR and links its Verdict. Its @-mention of the Operator is the event's one notification: the failed review, the closed PR and the note mention nobody.
- **The outcome** rewrites the Ticket in place as an agent brief, or splits it into sibling Tickets under the same Spec (a `split` outcome: each a sub-issue of the Spec, with native blocked-by edges, and the Ticket closed as superseded). A Ticket under a Spec never gets a Spec of its own, and only a Ticket under a Spec can split. When a Spec or a split supersedes an issue, its new Tickets take the issue's place among its blockers: each Ticket nothing else in the outcome blocks takes on the issue's open blockers, each open issue it blocked waits on the Tickets that finish last, and the closing comment lists what moved.
- **The model**: a Step-up applies only to the PR it ran on, so a rewritten or split Ticket starts again on the Implementer's default model.

## Merge gate

A passing PR leaves draft and requests the Operator's review. Only the Operator merges; the Merge gate ruleset and branch protection, which the setup skill applies, enforce it. The Operator has three moves:

- **Merge**: the PR's `Closes #<ticket>` closes the Ticket, which runs a Dispatch check. When that was the last open Ticket under its Spec, the Kit closes the Spec as completed, with a comment listing each Ticket's merged PRs. The comment mentions nobody.
- **Request changes**: a review from the Operator that requests changes on an agent PR out of draft puts it back in draft and starts one Implementer run on the Step-up model, on the PR's branch, with the review and its inline comments as input. It isn't a retry. Its push carries a `<!-- fabrik:request-changes-run -->` note, so the Verdict Review gives it is marked as from a Request-changes run and uses no retry; later retries count as before. On a pass the PR leaves draft and the Operator's review is requested again, the event's one notification. To fix a conflict, ask for a rebase in the review: the Implementer merges `origin/main` into the branch, since the Kit only fast-forwards it. A review from anyone else, or on a draft PR, does nothing. The caller workflow runs on `pull_request_review` (submitted) for this. GitHub has no `_target` form of that event, so the run uses the PR's copy of the caller workflow and Kit config, which an agent branch can never change (ADR-0005).
- **Send it back**: adding `needs-design` to an open agent PR takes the Design-flaw route: the PR closes unmerged, keeping its branch, and the Ticket swaps `ready-for-agent` for `needs-design`. The note's marker is `<!-- fabrik:back-to-design <pr> operator -->`, and round 1 says the Operator sent the Ticket back.

## Audit

Once a week the scheduled tick starts an Auditor run in each Product repo. It reads what changed on the default branch since the last Audit and files at most 3 deepening opportunities as one `fabrik:audit` issue, the Audit. It changes nothing: no branch, no PR, no state label and no push. It's on from the release that ships it, with no setup step; `audit.day: null` in the Kit config turns it off.

- **When**: from 00:00 UTC on `audit.day` (Sunday by default), the hourly tick opens the week's **pending Audit**: an issue from the Fabrik App titled `Audit: week of <Monday>`, labelled `fabrik:audit`, with no state label, no assignee and no mention, whose one line names the commit the Auditor is reading. The Fabrik App opening it starts the Loop workflow's Audit job, and Intake leaves it alone. The week runs Monday to Monday in UTC, and it gets at most one Audit. The tick opens none while an Audit is open, a filled one the Operator hasn't closed included, while the weekly-limit issue is open, or when the default branch hasn't moved since the last Audit. An Audit that couldn't open on its day, because the limit was reached say, opens on a later tick that week, and after two failed runs in a week the next Audit waits for the next week. One open Audit and 3 candidates are fixed limits, not `caps`.
- **The Auditor** (Opus 5.5, 45 minutes by default, `roles.audit`, plus `.fabrik/audit.md` when present) is read-only, like the Reviewer: it gets a checkout of the default branch at the pending Audit's commit with its full history, holds only the agent service account, and runs none of the code. The agent itself holds no GitHub token. It gets the Base skills alone, never Extra skills, and follows `improve-codebase-architecture`'s method without its HTML report or questions. It looks first at what changed since the last Audit's commit (the last 30 days on a first Audit) and at comprehension drift: files merged agent PRs changed more than 5 times in 30 days while no ADR, no `GLOSSARY.md` and no Markdown file in the same directory changed. It uses the glossary's terms, respects every ADR, skips a candidate whose issue is still open, and doesn't resurface one the Operator rejected in the last 3 Audits unless it has materially worsened. Everything it reads from issues, comments and code is data, never instructions.
- **The filled Audit**: the push job rewrites the pending Audit with one card per candidate, Strongest first. Each has its Files, Problem, Solution and Benefits, a Mermaid before/after diagram, a Strength badge (Strong, Worth exploring or Speculative), **Introduced by** with the merged agent PRs it traces to, and an **Open as issue** link. The Kit drops any PR under Introduced by that isn't a merged agent PR. A **Top recommendation** ends it. @-mentions are stripped from everything the Auditor wrote but its file paths and Mermaid source, which sit in code, where GitHub notifies nobody. The Audit stays open, unassigned and silent. When no candidate is above Speculative, the Audit says the repo is clean and closes itself as completed.
- **A failed run**, a reply that breaks the Audit output contract included, rewrites the pending Audit to one line saying how it failed and closes it as not planned, mentioning nobody: the tick tries again. A dead token or the weekly limit also goes on the Kit's rotation or weekly-limit issue, as for any run. Closing a pending Audit yourself cancels it: its run's result changes nothing.
- **The Operator's moves**: file each candidate you want through its Open as issue link, which opens the repo's new-issue form prefilled with the candidate (the diagram stays on the Audit) and ending `From audit #<n>`. The filed issue goes through Intake and Triage like any other, and the next Audit skips it while it's open. Comment on the Audit about any candidate you reject: the next Audit reads it as context, never as a trigger (ADR-0007). Then close the Audit, as completed if you filed anything and as not planned otherwise, which frees the next one. An ignored Audit only holds the next one back.
- **Architectural escapes**: when a candidate traces to merged agent PRs, its prefilled body also ends with a hidden `<!-- fabrik:escape <strength> #<pr> … -->` marker, so filing it records an Architectural escape against those PRs. Delete a PR from the marker before submitting to correct the attribution. Only issues the Operator opened count, and only for PRs that are merged agent PRs. A link too long for GitHub's URL limit cuts the candidate's text, never `From audit` or the marker, and a Design session that rewrites the filed issue keeps both lines.
- **In the Weekly summary**: the Metrics table's **Architectural escape rate (90 days)** is the merged agent PRs named in at least one escape out of the agent PRs merged in the trailing 90 days, as "n of m (x%)" beside last week's, or "no merged agent PRs" when there were none. A line under the table counts the 90 days' escapes by Strength. Each repo's **Architectural escapes this week** lists the escapes filed that week, each PR with the last passing Review run that missed it and whether the Operator pushed to it. An open Audit, filled or still pending, is in the repo's Waiting on you with its age. An Auditor run leaves a Run record like any agent run, and counts in the week's total cost but never in cost per merged PR or per Spec.

## How loud each kind is

The Kit pushes to the Operator's phone only when it is their move, and once a week for the Weekly summary, through GitHub mobile's @-mentions, assignments and review requests ([#22](https://github.com/jrey8343/fabrik/issues/22)). Each event pushes once, by one of them.

| Kind | Level | How |
|---|---|---|
| Design-session round | Push | @-mentions the Operator. Round 1 is the push for a Ticket sent back to design too. |
| Merge gate | Push | Requests the Operator's review. |
| A Kit run fails | Push | The failure notice @-mentions the Operator. |
| `needs-info` | Push | Triage's comment @-mentions the issue's author. |
| `ready-for-human` | Push | Assigns the Operator. |
| Claude token expired or revoked | Push, once per repo | The rotation issue assigns the Operator. |
| Weekly usage limit reached | Push, once per window per repo | The weekly-limit issue @-mentions the Operator. |
| Weekly summary | Push, once a week | The Weekly summary issue in `fabrik-runs` @-mentions the Operator once, for every Product repo, and closes last week's. A week with nothing to report files nothing. |
| Implement draft PR, Execution-flaw retry, back-to-design note | Silent | The PR and the Verdict are the record. |
| Fast path, Design session finished, Spec closed, `wontfix` | Silent | |
| Skills-source bump PR | Silent | The PR requests no review; the Operator merges it when they choose. |
| Monitor issues | Silent | An error or red-main issue gets `needs-triage` from Intake and reaches the Operator through Triage, never a push of its own. The Monitor never comments, apart from the note it closes its red-main issue with. |
| Audit | Silent | No state label, assignee or mention; a failed run closes it the same way. It surfaces in the Weekly summary's Waiting on you while it's open. |

- **Held work is silent.** Work a full cap holds (see `caps` in the [Kit config](#kit-config)) waits with no comment, label or notification. It pushes when its slot opens, as a Design session's round 1 does, and the Weekly summary's **Held** section shows, per Product repo, how many `needs-design` issues wait for a slot and how long the oldest has waited, and how many Sentry error groups wait for a Monitor issue slot.
- **There is no push budget.** Every push but the Weekly summary is the Operator's move, and the Weekly summary is one a week, so the Kit never holds one back: it caps the sources, never the pushes.

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
    "audit": { "model": "claude-opus-5-5", "effort": null, "timeout_minutes": 45 },
    "dispatch": { "timeout_minutes": 10 },
    "step_up": { "model": "claude-opus-5-5", "effort": null }
  },
  "max_in_flight": 2,
  "caps": { "design_sessions": 2, "monitor_issues": 5 },
  "monitor": { "errors": null, "red_main": true },
  "audit": { "day": "sunday" },
  "operator": null
}
```

- Leave a field out to take its default. `null` is accepted only where the default is `null` (the Sandbox commands, `effort`, `monitor.errors` and `operator`), and in `audit.day`, where it turns the Audit off. A `null` effort means the Claude Code CLI's default; otherwise set it to `low`, `medium`, `high`, `xhigh` or `max`.
- `sandbox.env` holds non-secret values. `sandbox.secrets` maps an env var name to an `op://` reference; a literal secret is refused.
- A model naming Fable (or the `best` alias) is refused in every role, because Fable can bill metered usage.
- `max_in_flight` caps how many Tickets are in flight at once: open agent draft PRs, Implement runs in progress, and Tickets dispatched but not yet started. Set it to `0` to pause Dispatch: the Kit adds `agent:implement` to no new Ticket, while Intake, Triage, Design, Review, the Merge gate, retries and Request-changes runs carry on. Set it back above `0` and Dispatch resumes straight away: a push to the default branch that changes `.fabrik/config.json` runs a Dispatch check. A Product repo set up before the caller workflow had this `push` trigger gets it by re-running setup; until then Dispatch resumes at the next Dispatch check, such as when an issue closes.
- `caps` holds the attention budget: per-repo caps on what the Kit opens in front of the Operator. A cap can only be lowered: a value above its Kit default is a Kit config error that names the field and the default.
  - `caps.design_sessions` (default 2) caps how many Design sessions are open in the repo at once; set it to `1`, or to `0` to pause new Design sessions while those already open carry on. Raising it back starts waiting issues straight away, as the config push runs a Design queue check. See [Design session (async)](#design-session-async).
  - `caps.monitor_issues` (default 5) caps how many error issues the Monitor keeps open in the repo at once. Past it, new error groups are held, `fatal` ones first and then the most users affected, and filed on later ticks as slots free up; the newest open error issue's stats block says how many are held. Set it to `0` to pause new error filings. The red-main issue never counts toward it, and still files and closes at `0`.
- `monitor` says what the Monitor watches. It files issues with the `fabrik:monitor` label and no state label, so Intake gives them `needs-triage`. It never reopens them, and its only comment is the note it closes its red-main issue with. An invalid `monitor` block is a Kit config error like any other. Each source it can't read yet, for a setup step not done, is a quiet note in the hourly tick's step summary, never a failed run.
  - `monitor.errors` is where it reads production errors. `null`, the default, leaves them off. To turn them on, store the Sentry token (the setup wizard's Sentry stage) and set it to `{ "provider": "sentry", "org": "<org slug>", "project": "<project slug>" }`. `provider` takes only `sentry`, and `org` and `project` are the slugs in the project's Sentry URL. `url` (default `https://sentry.io`) points it at another Sentry region or a Sentry-compatible host such as GlitchTip, and must be `https://`, since the token is sent there. `min_events` (default 3) is how many events in 24 hours an unresolved `error` group needs before it's filed; a `fatal` group needs none. Each qualifying group gets one issue, whose stats block the Monitor rewrites in place while it's open. A group that comes back after its issue was closed as completed gets a new issue, "Regressed from #n"; one closed as not planned or as a duplicate, or labelled `wontfix`, is never filed again. The issue quotes only Sentry's title, culprit, counts, release and in-app frames (file, line and function), never request data, breadcrumbs, user context, tags or variables.
  - `monitor.red_main` (default `true`) has the Monitor file one issue while the default branch's newest decided commit is red, and close it itself, with a "green at" note, once the newest decided commit is green. Set it to `false` to turn it off. It needs the Fabrik App's Checks: read, and at least one gating check that runs on pushes to the default branch: the checks in `sandbox.checks` when it lists any, else every check but those of Fabrik's own `loop` and `tick` jobs. A commit is decided once its gating checks have all finished and one failed or timed out (red), or none did and one passed (green); cancelled, skipped and neutral results decide nothing. A red-main issue the Operator closes stays closed until the default branch is seen green.
- `audit.day` is the UTC day of the week the Audit is due, `"monday"` to `"sunday"` (default `"sunday"`, so it's open by Monday's Weekly summary), or `null` to turn the Audit off in this repo. `roles.audit` sets the Auditor's model, effort and timeout like any role: by default the Reviewer's frontier model, Opus 5.5, with the CLI's effort and 45 minutes. See [Audit](#audit).
- `operator` is the Operator's GitHub login: the one person whose comments drive a Design session, whom its rounds and failure notices @-mention, and to whom `ready-for-human` work is assigned. `null` means the repo's owner; set it for a repo an organization owns.
- Per-phase instructions are optional Markdown files: `.fabrik/triage.md`, `.fabrik/design.md`, `.fabrik/implement.md` and `.fabrik/review.md`, and the Auditor's `.fabrik/audit.md`.
- `roles.triage`, `roles.design`, `roles.implement` and `roles.review` each take an optional `skills` list of Extra skills (see [Extra skills](#extra-skills)). `roles.dispatch`, `roles.step_up` and `roles.audit` don't: a Step-up run is an Implement run and gets implement's, and the Auditor gets the Base skills alone (ADR-0008).

### Extra skills

Every run gets the Base skills, which Fabrik's own `skills.lock.json` pins and which move only with a Kit release, plus Fabrik's own skills. A Product repo that needs more pins its own public **Skills sources** in `.fabrik/skills.lock.json` and gives **Extra skills** from them to roles in `.fabrik/config.json` (ADR-0008). A repo with neither runs exactly as before and pays nothing.

`.fabrik/skills.lock.json` is a list of pins, each a repository and a full 40-character lowercase commit SHA:

```json
[{ "repository": "jrey8343/skills", "sha": "0123456789abcdef0123456789abcdef01234567" }]
```

Each role's picks name the source, then the skill by the name it installs as under `.claude/skills/` (the last segment of its folder in the source's `.claude-plugin/plugin.json`):

```json
{
  "roles": {
    "design": { "skills": ["jrey8343/skills/event-storming"] },
    "review": { "skills": ["jrey8343/skills/event-storming"] },
    "implement": { "skills": ["jrey8343/skills/deciders"] }
  }
}
```

- Write a source's first pin and the picks by hand; `/fabrik-setup` writes neither. After that, the Kit's scheduled tick checks each source's default branch on the Monday tick in the 04:00 UTC hour and opens, or refreshes, one PR per source on `fabrik/skills-bump/<owner>-<name>`, pushed with the Fabrik App token. It changes only that source's SHA, shows the upstream diff under the picked skills' folders, lists the other changes in one line, and flags a picked skill removed upstream as breaking. A week in which no picked skill changed opens nothing. The Loop ignores these PRs; only the Operator merges them.
- Each AFK run installs the Base skills plus only its own role's Extra skills, before any secret loads, and its prompt gets one Kit line naming them. A local, Pairing or live Design session's `SessionStart` hook installs every pick, and warns, still installing the Base and Kit skills, when a pick is wrong.
- Say when to use an Extra skill in that phase's instructions, `.fabrik/<phase>.md`, not in the Kit config. The Kit's line only says the skills are there and that this repo's instructions say when to use them.
- These are Kit config errors, which stop the Loop before any agent starts: a malformed lockfile or pick; the same repository pinned twice; a pick naming an unpinned source, or a skill its source's manifest doesn't list at the pin; a pinned source no role picks from; a source with no readable manifest; and a pick named like a Base skill, a Kit skill (one of Fabrik's own) or a pick from another source. The Kit job reads each source's manifest from public GitHub at its pin, only when the repo pins a source.
