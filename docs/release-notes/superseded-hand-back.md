# Release notes: A conflict-only run says when `main` already holds the pull request's work

The notes for the minor release that has a conflict-only run name the merged pull request that already makes the whole of its pull request's change ([#845](https://github.com/jrey8343/fabrik/issues/845)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

When a conflict-only run finds that a pull request already merged into `main` makes the whole of its pull request's change, the Kit's hand-back now says the pull request is probably superseded by that one, and points you to closing it and its Ticket, instead of handing it back as an ordinary conflict for you to resolve.

## What changed

- **The run says so.** A conflict-only run that, while it rebases, finds a merged pull request making the whole of its pull request's change stops without pushing and names that pull request in a new optional output field, `supersededBy`, saying in its `fix` what it compared. It judges the overlap from the two diffs. If even part of its pull request's own change is left, it resolves the conflict as before and leaves the field out.
- **The Kit checks the number.** It trusts `supersededBy` only when it names a pull request merged into the default branch after the head the run started on last met `main`. Any other number, the run's own pull request included, is ignored as if the run named none, with a line in the run's log saying why. It never fails the run. On any run that isn't conflict-only, the field is ignored.
- **The hand-back says so.** The notice says the pull request is probably superseded by the merged one, names the Ticket that one closed when it closed one, quotes what the run compared, and asks you to check the merged pull request first, then close this one and its Ticket as duplicates. It still mentions you, adds `ready-for-human`, takes the pull request out of draft, says the pull request is yours while it carries the label, and says no retry was used. The Kit closes neither the pull request nor its Ticket.
- **The Standing tells them apart.** The notice's hidden line names a new hand-back, `conflict-run-superseded`, so the Standing says the pull request is probably superseded, not that the run didn't bring it up to date. The Weekly summary's Waiting on you lists it as a handed-back pull request, as before. Every other conflict-only run's notice is unchanged, word for word.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed, and the read library is unchanged.
