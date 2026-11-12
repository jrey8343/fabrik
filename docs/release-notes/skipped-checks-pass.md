# Release notes: A skipped or neutral Required check passes the Review

The notes for the change that judges a pull request's Required checks as GitHub judges a merge ([#456](https://github.com/jrey8343/fabrik/issues/456)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A skipped or neutral Required check now passes the Review, as it passes GitHub's merge, so a job skipped by its `if:` no longer spends a Ticket's Retries. The Reviewer and the Digest are told which checks ran nothing. A cancelled check is still red.

## What changed

- **One rule for a pull request's head.** A Required check that succeeded, was skipped or reported neutral has passed; cancelled or any other result is failing; one still running is pending; a check the Kit config lists that never reported still fails the Review. The Review's wait, the Weekly summary's head checks and the Required checks read now all judge a head this way.
- **Why it mattered:** a Product CI job such as `e2e` with `if: github.event.pull_request.draft == false` is skipped on every agent PR, which is a draft. The Review read the skip as red, gave an Execution flaw from CI that no Retry could change, and every PR in that repo went back to design twice while its checks box was green.
- **A pass where a check ran nothing says so.** When a Required check the Review waited on was skipped or neutral and the checks are green, Kit code names those checks to the Reviewer, as a fact, and to the Digest writer, among Kit code's facts (`requiredChecksRanNothing`), so neither can lean on a check that ran nothing; the Review checks job's step summary names them in one line. The pass's Verdict records them in its marker.
- **The skipped headings are gone.** No Verdict from CI names a skipped or neutral check any more.
- **The Monitor's red-main rule is unchanged:** on the default branch, cancelled, skipped and neutral results still decide nothing.
- **Why a minor:** new behaviour, and nothing for a Product repo to do beyond the bump. The read library's meaning is unchanged.

## Not migrated

Existing Execution flaws from CI on open agent PRs that named only skipped checks stay as they are and keep counting. Re-add `agent:review` on such a PR for a fresh Review under the new rule.
