# Main checks are named apart from Required checks, and each has its own issue

Red main reads only the Required checks `sandbox.checks` lists, when it lists any, so a deploy that fails on the default branch is invisible to the Monitor. In `jrey8343/gradually-core`, `sandbox.checks` is `["gate", "e2e"]`; on `9148e44`, `7654877` and `18a0966` the `gate` check passed, `deploy` failed and `smoke-check` was skipped, and red main read each commit as green.

A Product repo now names its **Main checks** in `monitor.main_checks`: checks the Monitor reads on the default branch that are not Required checks, such as a deploy and the smoke check after it. Each is red or green by itself, read from its own newest run on the same commits red main reads, and each has an issue of its own, keyed by the check's name in its marker. The red-main issue for Required checks is unchanged.

- **A deploy can't be a Required check.** A check in `sandbox.checks` is required on the default branch by Setup and waited on by the Review and the Merge gate, and no pull request runs a deploy, so every agent PR would wait on a check that never reports.
- **Emptying `sandbox.checks` isn't the answer.** Red main would then read every check, the deploy among them, but the Review and the Merge gate would lose the Required checks they hold a pull request to.
- **A separate, additive list.** `monitor.main_checks` adds to what red main reads and never replaces it. A name in both lists is a Kit config error. When `sandbox.checks` lists none, so red main reads every check, the Main checks are left out of that read, so each failure is reported once, in its own issue.
- **A fix that didn't work is filed again.** No pull request can run a Main check, so a fix is only tested once it merges. A Main check's issue that anyone but the Monitor closed as completed, as the Kit does when a fix's pull request merges, is held until the check fails on a commit newer in branch order than the one the issue's details last named; then a new issue says "Still failing after #n". A Required check's fix is tested on its pull request's head before it merges, so red main's issue keeps its rule: held until the default branch is seen green.
- **Other closes hold as red main's do.** A Main check's issue closed as not planned or as a duplicate is held until the check is seen green since the close; the Monitor's own close, after its green-at note, holds nothing.

## Considered options

- **One red-main issue for every check, the deploy among them.** The held close swallows the failures. Replaying that evening with `deploy` read too, red main says "the default branch is red at `9148e44`, but jrey8343/gradually-core#409 stays closed until it's seen green, as someone other than the Monitor closed it": the Kit had closed the `gate` issue when its fix merged, and every later failure, the deploy's included, was held. A slow deploy would also hold back a red `gate`, since a commit is decided only once every check it reads has finished.
- **One issue for all Main checks together.** It ties unrelated checks to each other: a green deploy could close an issue the smoke check still fails, and a close for one holds the other.

## Consequences

- A Main check's issue never counts toward `caps.monitor_issues` and never holds Dispatch, as red main's doesn't.
- `monitor.red_main: false` turns Main checks off too. They need the same Checks: read, and red main's dormant and rate-limit notes cover them.
- A Main check on none of the commits read gets one quiet line in the step summary, and no issue.
- Turning one on is the Operator's change to Kit config, a Trust-root file, so no agent makes it.
- What Triage is given about the failure, the failed step and its log, is [#731](https://github.com/jrey8343/fabrik/issues/731)'s.

Decided in [Red main can't read a default-branch check that isn't a Required check, such as a deploy](https://github.com/jrey8343/fabrik/issues/744).
