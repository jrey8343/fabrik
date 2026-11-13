# Release notes: A Flaky check at the Merge gate is reported

The notes for the minor release that reads the head the Reviewer passed for Flaky checks ([#693](https://github.com/jrey8343/fabrik/issues/693)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Required check that both fails and succeeds on the head the Reviewer passed now gets the Flaky check line on the pull request and the Flaky check issue, and counts in the Weekly summary.

## What changed

- **The hourly tick reads each passed head at the Merge gate.** For each open agent pull request out of draft whose head is still the one its latest pass was given on, the tick reads every check run on that head, every attempt included. A Required check with at least one `success` run and at least one red run there (failure, timed out, cancelled, action required or startup failure), in either order, is a Flaky check. A check that only skipped or reported neutral never succeeded, so it isn't one, though it passes GitHub's merge.
- **What the Operator sees.** One line on the pull request, mentioning nobody, such as "`ci` has both failed and succeeded on abc1234, the head the Reviewer passed: a Flaky check (#88).", and the check's `Flaky required check: <name>` issue, labelled `needs-triage` and `fabrik:flaky-check`, filed, or commented on when it's open. A check flaking on two pull requests in one tick files one issue, which both lines link. The Weekly summary counts it among Flaky checks.
- **Each is said once.** A check already named on that head, by the Kit's re-run line from the Review, a count-back line or an earlier tick's line, isn't reported again.
- **The Required checks are the branch's own.** They're read from the default branch in the same tick, as the Standing reads them, not from the Kit config. Commit statuses from outside services aren't read. When the branch can't be read, nothing is reported that tick.
- **The Loop is unchanged.** No Verdict, label, draft change, Review or Retry count. The pull request stays at the Merge gate, and its Standing is as before. Nothing is counted back, since no Retry was spent there.
- **Why a minor:** new behaviour that needs no caller change, no new App permission (it uses the Fabrik App's existing Checks: read) and no Kit config field. Without Checks: read, the tick reports nothing here, as for the count-back sweep.
