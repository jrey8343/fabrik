# Release notes: A check's fix goes first, past the Merge gate

The notes for the minor release that has Dispatch release a Check's issue's Ticket first and past `caps.merge_gate` ([#838](https://github.com/jrey8343/fabrik/issues/838), ADR-0035). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A `ready-for-agent` Ticket carrying `fabrik:flaky-check` now goes ahead of every other Ticket and research Decision at Dispatch, and past a full Merge gate, so the fix for a red Required check is never stuck behind the pull requests that check holds.

## What changed

- **A check's fix goes first.** Dispatch weighs every open `ready-for-agent` Ticket carrying `fabrik:flaky-check` ahead of every other candidate, lowest issue number first among them. Everything else is still lowest issue number first.
- **It passes `caps.merge_gate`, at any value, `0` included.** Once released, its work counts toward the Gate load like any Ticket's, so the Tickets behind it wait until the load is back under the cap.
- **Everything else still holds it.** `max_in_flight` holds it and `0` pauses it; Blockers, an open pull request, a failed last run and a held run hold it as before.
- **The Operator is told.** While a Ticket waits for room at the Merge gate and a check's fix is open, its Standing says so ("Waiting for room at the Merge gate for 7 hours: `caps.merge_gate` is 3. #50 fixes a red check and goes first."), as do Dispatch's step summary and the Weekly summary's Merge-gate line. The fix itself never waits for the Merge gate.
- **The read library.** A `waiting-for-slot` Standing with `slot: "merge-gate"` carries `detail.checksFixes`, the open check's fixes lowest first, while one is open, and leaves it out otherwise. The Standing schema number is unchanged: no field was removed or changed meaning.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed.
