# The Kit re-runs red required checks once, with a job-scoped `actions: write`

Red required checks are an Execution flaw (`src/loop/review.ts`), and the Retry it starts counts like any other. Nothing told a check that failed because the PR was wrong from one that would pass on a re-run, so a flaky suite could spend a Ticket's two Retries and send it back to design, with Verdicts that never said the checks were flaky (#462). Telling them apart needs a re-run, and a re-run needs a write credential the Review path didn't hold: the Review checks job only reads, and the Fabrik App can't touch workflow runs.

A **Flaky check** is a required check that has reported both failure and success on the same head commit, in any order and whoever re-ran it (GLOSSARY.md).

- **One re-run, GitHub Actions checks only.** When the Review checks job finds red required checks, the **Re-run red checks** job re-runs the *failed jobs* of the workflow runs behind the red GitHub Actions checks, never whole workflows, once on the same head. A second wait, with the Review timeout of its own, reads the checks again: once the re-run checks have reported anew, and then every gating check. All green: each re-run check is a Flaky check, the Reviewer runs as usual, and no Verdict comes from CI. Anything still red: the Execution flaw lands as before, saying each re-run check failed again on a re-run of the same head, so the Retry needn't wonder whether the check is flaky. Giving up on the second wait is an Infrastructure failure naming why, as the first's is.
- **Outside checks aren't re-run.** A required check from an outside service (Vercel, Buildkite, a commit status) only its owner can re-run. The Verdict lists it under its own heading, apart from the checks that failed twice.
- **One round per head.** A workflow run past its first attempt has been re-run on this head already, by the Kit or by hand, so the Kit re-runs nothing and the checks are read as they stand.
- **Its own job, job-scoped `actions: write`.** The Review checks job stays read-only. The Re-run red checks job holds `actions: write` on the caller's `GITHUB_TOKEN` and nothing else: no secret, no Fabrik App token, no checkout of Product code. It's the first job on the Review path that holds a write credential.
- **A refusal re-runs nothing.** When GitHub refuses (a run too old, a token without the permission), the flaw lands as before and the Verdict says the checks couldn't be re-run and why, naming the line to add when the token lacked `actions: write`.
- **A later green counts the Verdict back.** The hourly tick reads, with the Fabrik App's Checks: read, the check runs on the head of each ci-sourced Execution flaw on an open agent PR. Once every check that Verdict named reads green there, by its latest result, the Kit posts one line on the PR, mentioning nobody, whose `<!-- fabrik:flaky-check {…, "countedBack": true} -->` marker marks the Verdict: it no longer counts toward the Ticket's Retries. A Retry already in flight keeps running. The marker makes the sweep idempotent.
- **A passed head at the Merge gate is read too** ([#693](https://github.com/jrey8343/fabrik/issues/693)). The hourly tick also reads the check runs on the head the Reviewer passed of each open agent PR at the Merge gate, out of draft and with its head unmoved since that pass. Any Required check with both a failed run and a successful one there, in either order, is reported as a Flaky check: the PR line, mentioning nobody, with a `<!-- fabrik:flaky-check {…} -->` marker and no `countedBack`, and the check's Flaky check issue. Nothing is counted back, since no Retry was spent at the gate, and the pull request stays where it is. A check a Flaky check line already names on that head isn't reported again.
- **The Operator hears of each Flaky check.** The Kit's own re-run going green and a later green both get the PR line, mentioning nobody, and the check's Flaky check issue in the Product repo, `Flaky required check: <name>`, labelled `needs-triage` and `fabrik:flaky-check`, its marker naming the check. A later Flaky check of the same name comments on the open issue; once the Operator closes it, the Kit files a fresh one. The Weekly summary counts them, and the Retro sees a counted-back Verdict marked `flaky`.

## The caller must grant `actions: write`

GitHub starts no run of a caller workflow whose `uses:` job grants a called job less than that job's `permissions:` asks, and it checks every `uses:` job before any job's `if:` (#422). The Re-run red checks job asking for `actions: write` therefore needs the caller's `loop` job to grant it, or every run of the caller fails at startup, whatever the event. The grilling's wish that a caller without it fall back quietly, the Kit's caller check not refusing, can't hold: no job in the called workflow can ask for a permission conditionally. So:

- The caller template grants `actions: write` in place of `actions: read`, and that's a caller change, so the release holding this is a major (docs/releasing.md). Dependabot proposes no major, so an existing install stays on its pin until Setup is run again for the new release, and never breaks unseen.
- A caller edited by hand that misses the line is caught by the Kit job's caller-permission check on the pull request that changes it, which names the line to add before the merge.
- The Verdict's "couldn't re-run them" fallback stays, for a token GitHub still refuses at runtime, as under an organization policy.

## Considered options

- **Never re-run.** No write credential anywhere on the Review path, but a flaky suite keeps spending Retries, and Tickets go back to design for the suite's failures.
- **Give the Fabrik App `actions: write`.** One more App permission on every Product repo, held by every push job that mints its token, when only one job needs it, for one call.
- **Re-run inside the Review checks job.** One job, but its write credential would sit beside the long read-only wait, for the whole Review timeout.
- **Leave the Verdict standing and only note a later green.** Simpler, but the Retry it called for still counts, and the Ticket can still go back to design for Flaky checks alone.
- **Edit the Verdict comment to mark it.** The marker would sit in the Verdict itself, but it needs a new edit action, and the PR line is posted anyway; the line's marker names the Verdict's head, and a Verdict is given once per head.

## Consequences

- A Ticket's Retries count Verdicts that weren't counted back (`src/loop/retry.ts`).
- A Back to design that already happened isn't undone. Back to design closes the PR in the same plan as the Verdict, and the tick sweeps open agent PRs, so a flaw on a closed PR is never counted back; the Operator can bring the Ticket back by hand.
- Statuses from outside services can't be read by the Fabrik App without another permission, so a Verdict naming one is counted back only once a check run of that name reads green.
- The read of a passed head at the Merge gate is likewise of check runs only, and of the default branch's own list of Required checks, read from the branch in the same tick, not the Kit config's list. A branch that can't be read reports nothing that tick.
