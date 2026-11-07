# Release notes: Stepped-up starts

The notes for the release that ships Stepped-up starts ([#364](https://github.com/jrey8343/fabrik/issues/364), ADR-0014). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- A new label, `fabrik:step-up`, marks a Ticket for a Stepped-up start. While it's on, every Implement run that starts on the Ticket, whether a first run, a Retry or a Request-changes run, runs on `roles.step_up`. Adding it mid-chain steps up the next run, and removing it drops back to `roles.implement`. A marked Ticket still gets 2 Retries before a third Execution flaw is a Design flaw.
- A Design session's Ticket JSON takes an optional `"stepUp": true`, and the Kit creates that Ticket with `fabrik:step-up`. Operator steps ignore it. The Design prompt starts setting it in a separate release.
- Each Implement run's Run record gains `stepUpReason`: `retry`, `marked`, `request-changes` or `conflict-only` when `stepUp` is true, else null. Request-changes and conflict-only runs, which always ran on the Step-up model, now record `stepUp: true`, so the Scorer now scores every one of them and every marked first run. A record written before this release reads with a null reason, or `retry` if it Stepped up.
- The Weekly summary breaks Step-ups down by reason, so the count doesn't jump unexplained, and adds a Stepped-up starts merged row: the marked Tickets merged that week and how many needed no Retry.
- A Replay takes a Ticket's first run by its place in the chain, so a marked Ticket can be replayed. Its baseline runs Implement on the Step-up model and effort, as it was built, unless the variable sets `implement.model` or `implement.effort`.
- No shim changes and no Kit config fields.

## To turn it on

1. **Re-run Setup** at this release in each Product repo (the Setup command in the README's [Adopting the Kit](../../README.md#adopting-the-kit), naming this release): its plan creates `fabrik:step-up` on a repo that lacks it. Until then, nothing marks a Ticket, and the Loop runs as before.
2. **Check it on the Pilot first**: add `fabrik:step-up` to a ready Ticket before Dispatch, and check that its Implement run's record has `"stepUp": true, "stepUpReason": "marked"` and the Step-up model.
