# Release notes: A red Required check at the Merge gate is named in its Standing

The notes for the minor release that reads the Required checks on an agent pull request's head at the Merge gate ([#564](https://github.com/jrey8343/fabrik/issues/564)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An agent pull request at the Merge gate whose Required check is failing or never reported is now listed under Waiting on you, naming the check, not as ready to merge. The Loop doesn't react to it any differently.

## What changed

- **Its Standing comes from the Required checks on its head, as a Plain pull request's does.** A check failing stands as `check-failing` (`checkIs: "failing"`), since the failing report. One never reported stands as `check-failing` (`checkIs: "never-reported"`), since the pass. Either one is the Operator's and stops work, since GitHub won't merge it. One still running stands as `waiting-on-checks`, the Kit's move, stopping nothing. Every check passed, none required, or the checks unread: still `yours-to-merge`, since the pass, worded as before. When several apply, a failing check comes first, then a running one, then one never reported.
- **It goes back once the checks pass.** After a re-run passes, the pull request is `yours-to-merge` again, dated from the pass, not from the re-run.
- **The Weekly summary lists it under Waiting on you,** with a sentence such as "`ci` is failing on the head the Reviewer passed 3 hours ago.", in place of "at the Merge gate, Operator wait". To do this, the Weekly summary also reads the Required checks on each agent pull request's head at the Merge gate, with the same token it reads a Plain pull request's with.
- **The read library.** A reader can now see `check-failing` and `waiting-on-checks` with `detail.plain: null` on an agent pull request at the Merge gate. Each carries `detail.passedAt`, when the Reviewer passed its head, and `detail.head`. The join with checks (`joinChecks`) now settles these rows against a fresh checks read as it settles a Plain one, so the read library and the Weekly summary reach the same Standing from the same facts. The Standing schema number is unchanged: no field was removed or changed meaning.
- **The Loop is unchanged.** The Kit doesn't take a red pull request back from the Merge gate, and it posts no Verdict and no comment. The Operator re-runs the check or sends a Request changes, as before. A Plain pull request's Standings and an agent draft's are unchanged.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed.
