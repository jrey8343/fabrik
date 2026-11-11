# Release notes: the Weekly summary says whether each Loop is running

The notes for the minor release that gives the Weekly summary a Loop health line per Product repo ([#460](https://github.com/jrey8343/fabrik/issues/460), ADR-0002's addendum). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **Each Product repo's section gets a Loop line, every week, healthy or not**: `**Loop:** <n> runs never started · <n> failed · the last Tick started at <time> (its run)`.
  - **Never started** counts the runs of the repo's caller workflow, `fabrik.yml`, on every event, that GitHub refused at startup (`startup_failure`) in the summary's week. Such a run has no jobs, so it leaves no Run record, check run or comment: only the Actions API sees it.
  - **Failed** counts the runs that concluded `failure` or `timed_out`, linked to the repo's Actions tab filtered to failures. `cancelled` runs, which concurrency groups make routinely, and `skipped` ones aren't counted.
  - **The last Tick** is read as the daily Tick check reads it (#461): the newest `tick / …` check run on a `main` commit, so the summary and the Dead-tick issue never disagree.
- **A week with an unhealthy Loop is never quiet.** A repo whose Tick hasn't started in 25 hours, or with a run that never started or failed, or whose Loop couldn't be read, files the summary in a week that would otherwise file nothing.
- **A dead Tick leads.** When a repo's Tick hasn't started in 25 hours, its section opens with "The Tick hasn't run since <time>, so the waits below include time the Loop was down", linking its open Dead-tick issue, and then the Loop line, ahead of Waiting on you.
- **The Fabrik App gains Actions: read** (ADR-0002's addendum), the only way to count runs that never started. The Weekly summary mints it in a token of its own, on every installed repo, and a second token with Checks, Contents and Issues read for the last Tick. Each is allowed to fail: until you accept the new permission, the summary still files, and each repo's Loop line says "run counts unread: the Fabrik App lacks Actions: read". The store and products tokens are as they were, and the Loop's own `actions: read` reads still use its job's `GITHUB_TOKEN`.
- **Why a minor:** there's no caller-shim change, no new secret and no Kit config field: the tokens are minted inside Fabrik's own action. An App without Actions: read still files the summary, without the run counts.

## To turn it on

1. **Accept Actions: read.** At `https://github.com/settings/apps/<the App's slug>/permissions`, set Repository permissions → Actions to Read-only and save. Then, on the installation's page, review and accept the request for the new permission. Re-running Setup walks you through this in its wizard.
2. **Bump the store's caller** with its Dependabot PR, or by re-running Setup, so the Weekly summary runs on this release.
3. **Check it on Monday.** Each Product repo's section in the Weekly summary ends with its Loop line, giving run counts, not "run counts unread". To see it lead, disable the Pilot's `fabrik.yml` for a little over a day before the summary runs, then run the Weekly summary by hand from the store's Actions tab.
