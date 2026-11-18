# Release notes: a blocker in any repo, named by its repo

The notes for the major release that counts a blocker in any repo, including one the Fabrik App can't read, by one rule in every reader, and names it by its repo in a `blocked` Standing ([#771](https://github.com/jrey8343/fabrik/issues/771)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A blocker in another repo now holds work as one in its own repo does, everywhere the Kit reads one, and a `blocked` Standing names it as GitHub writes it, `owner/name#N`. One in a repo the Fabrik App can't read holds it too, counted. A major for the read library: `STANDING_SCHEMA` is `2`, and a `blocked` Standing's `detail.blockers` carries each blocker's repo.

## What changed

- **One rule for a Blocker, in every reader.** A Blocker is an issue, in any repo, that holds another piece of work by a blocked-by edge: one still open, or closed as not planned (ADR-0001, amended in #98 and #771). One closed as completed or duplicate blocks no more. Dispatch's Ticket and research Decision reads, the single-issue snapshot a Design session reads, and the open-issue facts the Standings read (the Kit's own, the read library's gather and home query, and the store's) all go through it. Until now they disagreed: Dispatch counted a blocker in another repo under its bare number, and the Standings and the snapshot dropped it.
- **A research Decision counts a blocker closed as not planned**, as a Ticket does. Dispatch withholds it, and it stands `blocked`.
- **Hidden blockers hold work.** GitHub leaves a blocker in a repo the Fabrik App can't read out of the edges the Kit reads, but counts it among the issue's open blockers. The difference holds the work as any Blocker does: Dispatch withholds the Ticket or research Decision, and the Operator's `ready-for-human` issue, Map or Decision stands `blocked`. A Ticket blocked only by such an issue was dispatched before.
- **The wording.** A blocker in this repo reads `#N`; one in another repo reads `owner/name#N`, after this repo's; hidden ones end the list, counted: "Blocked by #12, jrey8343/fabrik#770 and 1 issue the Fabrik App can't read." Dispatch's reason for skipping a blocked Ticket or research Decision names them the same way.
- **A Design session's split moves edges in any repo.** Its first new Tickets take on every Blocker of the superseded Ticket its snapshot could see, in any repo, ones closed as not planned among them, written by each blocker's database id. Each open issue the superseded Ticket blocked, in any repo, is pointed at the last new Tickets. GitHub writes a blocked-by edge only from the blocked issue's side, so one on an issue in a repo the Fabrik App can't write to is refused: the split goes on, and its closing comment names that edge under "Move by hand", as it does the hidden blockers it couldn't carry. A Ticket closed as not planned, or by a Roll-in, names every issue it blocked, in any repo.
- **Each read asks for up to 50 blockers**, GitHub's most per relationship (up from 20 in the open-issue reads), with each one's repo, and the issue's `issueDependenciesSummary { blockedBy }`.

## For readers of the read library

- **`STANDING_SCHEMA` is `2`.** Every Standing carries `schema: 2`.
- **A `blocked` Standing's detail changed shape:**

  ```ts
  readonly blocked: {
    readonly blockers: readonly { readonly repo: string /* owner/name, set for this repo's too */; readonly number: number }[];
    readonly hiddenBlockers: number;
  };
  ```

  `blockers` is sorted by repo, then number, without duplicates. A `blocked` Standing can have `blockers: []` and `hiddenBlockers` above 0.
- **`OpenIssueFacts.blockers`** carries `{ repo, number }` too, and `OpenIssueFacts` gains `hiddenBlockers`, which every gather fills in; a reader that builds `OpenIssueFacts` itself must give it. `anOpenIssue` defaults it to 0.
- **The fabrik-console** files a Standing by `yours` and shows the Kit's sentence, reading neither field, so it needs only the Kit bump.

## Why a major

The read library's `STANDING_SCHEMA` and what a `blocked` Standing's `detail.blockers` holds changed meaning, which [releasing.md](../releasing.md#choosing-the-version) counts as a major whatever it asks of a Product repo. A Product repo itself needs nothing beyond the release: no caller, shim, Kit config field, secret or permission changes.

## Upgrading

- **A Product repo moves to the release by running Setup again, naming it**, as for any major, since Dependabot opens no bump PR for one. Its setup PR changes only the `uses:` refs.
- **A reader of the read library** that reads `detail.blockers` as numbers reads `blocker.number` instead, and names a blocker in another repo by `blocker.repo`.

## Not covered

- A hidden blocker closed as not planned can't be seen, so it goes uncounted.
- Retro evidence's count of a merged Ticket's `ready-for-human` blockers is as it was: it measures history, not what holds work now.
- The Kit can't write a blocked-by edge from the blocking issue's side: GitHub has no such endpoint.
