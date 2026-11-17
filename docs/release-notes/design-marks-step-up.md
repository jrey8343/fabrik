# Release notes: The Design session marks a Stepped-up start

The notes for the release in which the Design prompt starts marking Tickets for a Stepped-up start ([#371](https://github.com/jrey8343/fabrik/issues/371), ADR-0014). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The Design prompt now sets `stepUp`, which the Kit has read since [#364](https://github.com/jrey8343/fabrik/issues/364) and [#376](https://github.com/jrey8343/fabrik/issues/376). A Design session marks a Ticket it writes, in a Spec, a split or an agent brief, when it judges the work heavy: the change crosses several modules, involves concurrency or a state machine, sits next to a Trust-root area, or has no nearby tests to copy. Unmarked is the default, and it never asks the Operator about a mark in a round.
- The closing comment carries one line for each Ticket it marks, saying why.
- On a redesign, the session sets or clears the mark again on every Ticket it writes or rewrites. An agent brief that rewrites the Ticket in place always carries `stepUp`, `true` or `false`, and the closing comment says why for each mark it clears. A chain that already failed on the Step-up model is marked again only if the redesigned work is still heavy. One that failed on the default model first leans toward a mark.
- Operator steps, Operator briefs and Roll-ins are never marked.
- No Kit code, shim, Setup or Kit config changes.

## To turn it on

Nothing to do beyond taking the release: the `fabrik:step-up` label already exists in every Product repo that re-ran Setup for #364. After about 10 marked Tickets or 4 weeks, whichever comes first, request a Replay over the marked Tickets with `implement.model` set to the default model. The share that passes is the false-positive rate, and over about 50% means the prompt's signals need tightening.
