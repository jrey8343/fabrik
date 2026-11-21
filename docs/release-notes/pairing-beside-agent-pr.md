# Release notes: a Pairing session's pull request beside an agent PR it doesn't take over

The notes for the patch release that stops a Pairing session's pull request taking over the row of a Ticket whose agent PR isn't handed to the Operator ([#851](https://github.com/jrey8343/fabrik/issues/851)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Pairing session's pull request on a Ticket whose agent PR is at the Merge gate, or anywhere else on the Loop, now has a row of its own, named for its own checks. The agent PR's row is as it would be with no Pairing session, so "Yours to merge" no longer names the wrong pull request.

## What changed

- **The join holds only for work handed to you.** A Pairing session's pull request takes over its issue's row only when that row carries no pull request, or carries the agent PR while it is handed to you, `yours-to-do`: a `ready-for-human` issue or a Hand-back on the pull request ([#611](https://github.com/jrey8343/fabrik/issues/611)). Those rows read as before.
- **Otherwise each pull request has its own row.** Beside an agent PR at implement, review, the Merge gate or a Retry, the Pairing session's pull request stands as a Plain pull request of the `pairing` kind, carrying the issue's number, named for the Required checks on its own head. The agent PR's row keeps its own number, name and checks. Before, the joined row put the Pairing session's number beside the agent PR's name and checks, and the agent PR's number was on no row.
- **A second Pairing session's pull request on the same issue** now carries the issue's number too, where before it stood with none.
- **A blocked `ready-for-human` issue's agent PR is not joined either.** It stands `blocked`, nobody's move, not `yours-to-do`, so a Pairing session's pull request beside it has its own row.
- **A kept row settles the same way.** The read library's join with checks settles each of these rows to what the rule gives from the same facts.
- **The Console:** it draws the rows as given and needs no change. It shows two rows where it showed one, each leading to its own pull request's screen.
- **Why a patch:** it fixes rows that named the wrong pull request. No Kit config field, shim or setup step changes, and the read library is unchanged: nothing it exports is removed, a row's and a Standing's shape stay as they were, and every name means what it meant. A Product repo merges the bump PR.

## Not covered

- How the Console words or links these rows is [fabrik-console#53](https://github.com/jrey8343/fabrik-console/issues/53).
- One row naming both pull requests was considered and rejected.
- A row a reader kept from an earlier release with the two joined stays joined through a later checks read, until the reader's next gather gives the rows afresh.
