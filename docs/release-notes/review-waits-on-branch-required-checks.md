# Release notes: a Review waits on every Required check

The notes for the minor release that has the Review wait on the Required checks as `GLOSSARY.md` defines them, those `sandbox.checks` lists plus any the default branch requires ([#565](https://github.com/jrey8343/fabrik/issues/565)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Review now also waits on checks the default branch requires beyond `sandbox.checks`, so a pull request can no longer pass the Review and reach the Merge gate with one of them red, running or never reported.

## What changed

- **The Review waits on the union.** When its wait starts, the Review checks job reads the default branch's own required list from the branch itself, the same read the Required checks read makes (#622), and waits on it together with `sandbox.checks`. Before, when `sandbox.checks` listed any checks, it judged only those, though GitHub refuses the merge on the branch's list too.
- **A branch-only check is handled as a listed one.** Red, it's an Execution flaw, and an Actions check gets one re-run first under the flaky-check rule (#462). Running, the wait waits. Never reported, the wait gives up naming it, an Infrastructure failure that costs no Retry. A check in neither list, such as `loop / Kit`, still never gates the Review.
- **The `--required` path is gone.** The wait always reads every check on the head, so a branch-required check that never registered there is now named as never reported, rather than missed.
- **A branch that can't be read fails the wait** with the unread-checks notice, never falling back to `sandbox.checks` alone. The job's token already has `contents: read`, which is enough.
- **The never-reported notice gives new advice.** Setup never takes a check off the branch, so dropping one from `sandbox.checks` alone no longer stops the Review waiting on it. The notice now says to fix the check's workflow name or `paths:` filter, or take it off the default branch's required list on github.com, and out of `sandbox.checks` too if it's listed there.
- **Why a minor:** it's new behaviour, as a Review can now fail or wait on a check the Kit config doesn't list, but it needs nothing from a Product repo beyond the bump. Nothing changes for a Product repo whose branch requires nothing beyond `sandbox.checks`, which at triage was both of them.

## Not covered

Required checks that come from a ruleset (`/rules/branches/{branch}`) are not read, by this wait or by the Required checks read; a follow-up issue covers both.
