# Release notes: Dispatch passes over a Ticket whose Implement run is under way

The notes for the patch release that stops Dispatch releasing a Ticket a second time while its first Implement run is under way ([#578](https://github.com/jrey8343/fabrik/issues/578)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

Dispatch no longer gives `agent:implement` again to a Ticket whose Implement run is under way, so a second first run can't start on it and have its branch dropped.

## What changed

- **A run under way takes its Ticket.** Between the claim taking `agent:implement` off and the push job opening the draft pull request, the run is the only sign the Ticket is taken. Dispatch now reads which Tickets the Implement runs under way name, from the same runs read it already counts, and passes over each, saying `#12 has an Implement run under way`.
- **It still counts once.** The run takes one slot under `max_in_flight` and one under `caps.merge_gate`, as before; the Ticket isn't counted again as waiting. A free slot goes to the next eligible Ticket.
- **Everything that weighs eligibility agrees.** The Weekly summary's Standing doesn't name such a Ticket as waiting for Dispatch, and Dispatch doesn't stop it for a gone Kept branch while its run is under way.
- **Why a patch:** it fixes Dispatch to do what it already meant to, one Implement run per Dispatch, and needs nothing from a Product repo beyond the bump.

## Not covered

- An Implement job from a Kit release before Ticket-named jobs (#477) names no Ticket, so it takes a slot but not its Ticket.
- A research Decision has the same gap, since a Research job's name doesn't name its Decision. The replay step's spare-capacity gate reads no workflow runs, so it still counts such a Ticket as waiting, which only keeps a replay waiting.
