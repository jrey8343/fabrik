# Release notes: blocked ready-for-human issues and Maps leave Yours

The notes for the patch release that stands the Operator's own work `blocked` while an issue in its repo blocks it, as a Ticket already stands ([#770](https://github.com/jrey8343/fabrik/issues/770)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A `ready-for-human` issue, a Map or an Operator Decision blocked by an open issue in its repo, or one closed as not planned, now stands `blocked`, nobody's move, so it leaves the Console's Yours and the Weekly summary's Waiting on you until its blockers close.

## What changed

- **Open issues carry their blockers.** Each open issue's blockers are read with it: the Kit's own open-issues read, the read library's gather and the store's read all ask for each blocker's state, why it is in that state and its repo. A blocker counts while it is open, or closed as not planned, as Dispatch counts one (ADR-0001, amended in #98). One closed as completed or duplicate, or one in another repo, doesn't.
- **A blocked `ready-for-human` issue is nobody's move.** It stands `blocked`, with `work: "ready-for-human"`, `yours: false`, `stopsWork: false` and its blockers in `detail.blockers`, lowest first. It reads "Blocked by #…", as a Ticket does. Its `since` is when it got `ready-for-human`, as for `yours-to-do`, so once its last blocker closes it goes back to `yours-to-do` with the same `since`. The store's `ready-for-human` issues stand the same way.
- **So is a blocked Map.** An open Map with a blocker stands `blocked` with `work: "map"`, since it got `wayfinder:map`, and no longer lists its Decisions.
- **A Decision follows its own blockers.** A grilling, prototype or task Decision with no blockers of its own stays yours to read, carrying its Map, even when the Map is blocked, as it can be resolved early. One with a blocker of its own stands `blocked` with `work: "operator-decision"`.
- **A Subscription's issue is unchanged.** A weekly-limit, token-rotation or usage-credits issue stands as before, whatever its blocked-by edges.
- **Why a patch:** no new Standing name and no new field. A `blocked` Standing can now also have `work` set to `ready-for-human`, `map` or `operator-decision`, and a reader that files Standings by `yours`, as the Console does, needs no change.

## Not covered

- A blocker in another repo doesn't count yet ([#771](https://github.com/jrey8343/fabrik/issues/771)).
- The Console still folds a Decision under its Map. Listing an unblocked Decision of a blocked Map in its own row is jrey8343/fabrik-console#50.
- A Ticket's and a research Decision's blocked rules are as they were.
