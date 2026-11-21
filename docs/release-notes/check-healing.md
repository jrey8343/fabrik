# Release notes: An Unrelated failure the Kit is healing is the Kit's in its Standing

The notes for the minor release that gives an agent pull request at the Merge gate a Standing of the Kit's while the Kit still has a move of its own on an Unrelated failure ([#795](https://github.com/jrey8343/fabrik/issues/795)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

An agent pull request held at the Merge gate by an Unrelated failure is no longer listed as waiting on you until the Kit mentions you, or until it turns Stuck. The Loop doesn't react to it any differently.

## What changed

- **A new Standing name, `check-healing`.** An agent pull request at the Merge gate whose every failing Required check is one the Kit is healing stands as `check-healing`: `place: "merge-gate"`, `move: "kit"`, `yours: false`, `stopsWork: false`, since the failing report. A check is healing when the pull request's latest Verdict is a pass on its current head that names the check an Unrelated failure, the check is failing there, and none of the Kit's Operator-mention markers on the pull request names it. Before, such a pull request stood as `check-failing`, yours and stopping work, from the moment the pass landed.
- **It becomes yours when the Kit mentions you** (ADR-0031). Once the mention names the check, on any head, the Standing is `check-failing` again, yours and stopping work, and its sentence ends "The Reviewer judged it an Unrelated failure, and the Kit has nothing left to try." A failing check the pass didn't name, or one never reported, makes it `check-failing` at once, naming that check, whatever else is still running. A pull request whose head moved since its pass, a Plain pull request and an agent draft read as before.
- **It turns Stuck like any row waiting on the Kit.** `stuckAt` is the repo's Stuck bar after the pass, or after the Kit's latest sign on the pull request or its Ticket. It is `null` while the check's fix is under way: the check's issue is open and `ready-for-agent`, or an open agent pull request closes it. The clock restarts when the fix stops being under way, so the row doesn't read Stuck at the moment a fix lands: when the check's issue closes, or loses `ready-for-agent`. A pull request for the fix closing unmerged is not dated, so where that alone ended the fix the clock isn't restarted. Past `stuckAt` it reads `stuck` with `detail.was: "check-healing"`, the Kit's move still, yours and stopping work. This is how a check the mention can't reach still gets to you: one from an outside service, or one whose issue closed more than a week ago.
- **What it says.** The sentence says the check is failing on the passed head, that the Reviewer judged it an Unrelated failure, and what the Kit does next: "the Kit re-runs it at its next hourly check", "the Kit has asked for one more re-run of it", or "the Kit's one more re-run of it is done or skipped, so #50 waits for the check's fix on #91".
- **The Weekly summary.** A `check-healing` pull request is not under Waiting on you. It is listed there once the Kit has mentioned you, and under Stuck once it is Stuck. To read this, the Weekly summary now asks for each open issue's body and for the Check's issues closed in the last week.

## For a reader of the read library

- `STANDING_NAMES` has one more name, `check-healing`. A reader that files rows by `yours` and `stopsWork` needs no change: the row moves out of what is yours while the Kit is healing the check, and back when the Kit mentions the Operator or the row turns Stuck.
- Its `detail` is `{ plain: null, check, rerun, issue, passedAt, passedHead, healing }`. `rerun` is `"to-come"`, `"asked"` or `"done"`, and `issue` is the open Check's issue's number or `null`. `stuck`'s `detail.was` can now be `"check-healing"`, carrying the same keys.
- Every agent row at the Merge gate named by its checks (`yours-to-merge`, `waiting-on-checks`, `check-failing`, `check-healing`) can carry two new `detail` keys: `healing`, the checks the Kit is still healing, each a `HealingCheck` (`check`, `rerun`, `issue`, `stuckAt`), and `mentioned`, the Unrelated failures the Kit has mentioned the Operator over. Either is left out when empty. `HealingCheck` is a new exported type.
- `joinChecks` settles these rows with what they keep, with no gather: a healing check that runs again and fails again goes back to `check-healing`, and takes the `stuckAt` its `healing` entry holds. A row kept before this release carries neither key and settles as it did.
- The facts a gather returns hold two more things: `github.openIssues[].body`, and `github.closedCheckIssues`, the Check's issues closed in the last week. The gather makes one more query for the second, of one page. Facts gathered by an earlier release hold neither, and still read: no Check's issue is named and no close is dated.
- The Standing schema number is unchanged: no field was removed or changed meaning.

## Upgrading

- **The Loop is unchanged.** The re-run at the gate, bringing a held pull request up to date and when the Operator is mentioned stay as ADR-0031 has them. The Standing reads what they leave on the pull request and decides nothing for them.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed.
