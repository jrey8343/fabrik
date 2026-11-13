# Release notes: A head moved at the Merge gate stays yours to merge

The notes for the minor release that reads an agent pull request at the Merge gate whose head moved since the Reviewer passed it ([#692](https://github.com/jrey8343/fabrik/issues/692)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An agent pull request whose head moved after its pass, by a push or by GitHub's "Update branch", is now listed under Waiting on you, saying its head moved, not as waiting on the Kit. The Loop doesn't react to it any differently.

## What changed

- **The pass that opened the Merge gate still counts once the head moves.** An agent pull request out of draft gets no later Verdict, so its latest Verdict, when it is a pass, is read on whatever head it was given. Before, a head pushed to after the pass fell through to `waiting-on-kit` (`silence: "left-over"`): the Kit's move, when the Kit never acts on a ready pull request.
- **It stands as `yours-to-merge`,** the Operator's and stopping work, since the pass, as when the head hasn't moved. Its sentence says so: "#123's head moved since the Reviewer passed it 3 hours ago; its Digest describes the head it passed." When the head hasn't moved, the sentence is unchanged.
- **A red or running Required check still wins,** as since #564, read on the head the pull request has now. Its sentence names that head, not the one the Reviewer passed: "`ci` is failing on #123's head, pushed since the Reviewer passed it 3 hours ago."
- **A Request changes or a `ready-for-human` hand-back since the pass** reads as it does when the head hasn't moved, not as left over.
- **The read library.** `yours-to-merge` on an agent pull request, and the agent forms of `check-failing` and `waiting-on-checks`, now carry `detail.passedHead`, the head the Reviewer passed, beside `detail.head`. They differ only when the head moved. The Weekly summary and the read library read the Required checks on the moved head, and reach the same Standing from the same facts. A row kept before this release has no `passedHead`; `joinChecks` takes its `head` as the one passed. The Standing schema number is unchanged: no field was removed or changed meaning.
- **The Loop is unchanged.** The Kit doesn't put the pull request back in draft, start a Review or post a line when its head moves. To have the new head reviewed, put the pull request back in draft and push: that starts a Review, as for any draft. An agent pull request marked ready by hand after an Execution flaw or a Design flaw still reads as left over, and drafts read as before.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed.
