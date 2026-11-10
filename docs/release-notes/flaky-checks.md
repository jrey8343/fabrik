# Release notes: A flaky required check no longer costs a Retry unmarked

The notes for the change that re-runs red required checks once before a Verdict, and counts back a Verdict whose checks later pass on the same head ([#462](https://github.com/jrey8343/fabrik/issues/462), ADR-0018). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Red GitHub Actions checks are re-run once on the same head.** A new job on the Review path, **Re-run red checks**, re-runs the failed jobs of the workflow runs behind them, and a second wait reads them again. All green: each is a Flaky check, and the Reviewer runs as usual. Still red: the Execution flaw lands, saying each check failed again on a re-run of the same head. A run already re-run on that head isn't re-run again. A required check from an outside service is listed under its own heading, as only its owner can re-run it. When GitHub refuses the re-run, the Verdict says why.
- **A later green counts the Verdict back.** The hourly tick reads the check runs on the head of each red-check Verdict on an open agent PR. Once every check it named reads green there, one line on the PR, mentioning nobody, marks it, and it stops counting toward the Ticket's two Retries.
- **Each Flaky check is reported.** One line on the PR, mentioning nobody, and the check's `Flaky required check: <name>` issue, labelled `needs-triage` and the new `fabrik:flaky-check`, or a comment on it while it's open. The Weekly summary's Metrics table gets a **Flaky checks** row, and the Retro sees a counted-back Verdict marked `flaky`.
- **Why a major:** the caller workflow's `loop` job must grant `actions: write` in place of `actions: read`, for the Re-run red checks job. GitHub starts no run of a caller that grants less than a called job asks, whatever the event (#422), so this is a caller change.

## Upgrading

In each Product repo, run Setup again, naming the new release (see [Adopting the Kit](../../README.md#adopting-the-kit)). Its plan rewrites the caller workflow with `actions: write` under the `loop` job and creates the `fabrik:flaky-check` label. On a caller edited by hand, change the `loop` job's `actions: read` to:

```yaml
      actions: write
```

The hourly count-back reads check runs with the Fabrik App's Checks: read, which red main already asks for. Without it the tick notes that nothing is counted back, and the rest works.

## To check it on the Pilot

1. Add a required check that fails on its first attempt and passes on a re-run (one that reads `${{ github.run_attempt }}`, say). Open an agent PR, and check that **Re-run red checks** re-runs it, that the Reviewer then runs, and that the PR gets one Flaky check line and the check its `Flaky required check:` issue.
2. Make the check fail on every attempt. Check that the Verdict says it failed again when the Kit re-ran it on the same head, and that re-adding `agent:review` on that head doesn't re-run it again.
3. With a red-check Verdict on an open draft, re-run the check by hand until it passes. Check that within the hour the PR gets a line saying the Verdict no longer counts toward the Ticket's Retries, and that the next flaw says Retry 1 of 2, not 2 of 2.
