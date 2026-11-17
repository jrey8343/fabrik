# Release notes: Main checks

The notes for the minor release that has the Monitor read a Product repo's Main checks ([#744](https://github.com/jrey8343/fabrik/issues/744), [ADR-0025](../adr/0025-main-checks-are-named-apart-from-required-checks-and-each-has-its-own-issue.md)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Product repo can name its **Main checks** in `monitor.main_checks`: checks the Monitor reads on the default branch that aren't Required checks, such as a deploy. Each gets its own `fabrik:monitor` issue while it fails, so a failed deploy is no longer invisible.

## What changed

- **Why:** red main reads only the Required checks `sandbox.checks` lists, when it lists any, so a deploy that failed on the default branch was read as green. A deploy can't be listed there, since a Required check is required on pull requests and no pull request runs a deploy.
- **`monitor.main_checks`** (default `[]`) is a list of check names. A name `sandbox.checks` also lists is a Kit config error naming `monitor.main_checks`; a name listed twice counts once.
- **One issue per Main check.** Each Main check is red or green by itself: at the newest of the commits red main reads where its newest run finished with a failure or a time-out (red) or a success (green). Another check's result never changes it, so a red `gate` that skips `deploy` leaves `deploy` where it was, and a deploy still running never delays red main. Red files "Red main: `<check>` is failing on the default branch", naming the red commit and linking the failed run; the Monitor keeps its details current, and closes it itself with a "green at" note once the check passes.
- **A fix that didn't work is filed again.** A Main check's issue closed as completed by anyone but the Monitor, as when its fix merges, stays closed until the check fails on a newer commit than the one it named; then a new issue says "Still failing after #n". One closed as not planned or as a duplicate stays closed until the check is seen green.
- **The red-main issue is unchanged** when `sandbox.checks` lists any, and never reads a Main check. When it lists none, red main reads every check but Fabrik's own and the Main checks.
- A Main check's issue never counts toward `caps.monitor_issues`. `monitor.red_main: false` turns Main checks off too. A Main check that no commit read decides is a quiet line in the step summary.
- **Why a minor:** new behaviour behind a new Kit config field with a default. No new App permission (Main checks use red main's Checks: read), secret or shim change, so a Product repo only merges the bump PR.

## To turn it on

Kit config is a Trust-root file, so no agent makes this change: the Operator does.

1. **Pilot first.** Add the Pilot's Main checks to `monitor.main_checks` in its `.fabrik/config.json` and merge it to the default branch. Check that the next hourly tick's Monitor step summary names each one, and that a failure files one issue for that check alone.
2. **Then the other Product repos.** For `jrey8343/gradually-core` that is `"main_checks": ["deploy", "smoke-check"]`, beside its `sandbox.checks` of `["gate", "e2e"]`.
