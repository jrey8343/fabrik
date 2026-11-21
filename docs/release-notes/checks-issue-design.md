# Release notes: A Design session keeps a Check's issue tied to its check

The notes for the minor release in which a Design session on a Check's issue keeps the tie to its check however it ends, so the Kit brings held pull requests up to date when the fix lands, and not before ([#839](https://github.com/jrey8343/fabrik/issues/839), ADR-0037). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

A Check's issue that Triage sends to `needs-design` now stays tied to its red Required check: a brief keeps the issue's marker, and a Spec takes the issue's place, so the Kit brings the pull requests the check holds up to date when the fix lands, never when the session closes the issue.

## What changed

- **A brief keeps the marker.** A Design session that rewrites a Check's issue as its agent brief or its Operator brief opens the body with the issue's `<!-- fabrik:flaky-check-issue … -->` line, kept only on an issue the Fabrik App opened, and the issue keeps `fabrik:flaky-check`. A red run of the check comments on it while it's open, and its closing as completed brings each held pull request up to date. Before, the brief dropped the line: the fix landing brought nothing in, and the next red run filed a second Check's issue.
- **A Spec takes the Check's issue's place.** The Spec's body opens with the marker line, and the Spec carries `fabrik:flaky-check` beside its category label and `ready-for-agent`. A red run of the check comments on the Spec, and the Spec closing as completed, by the Kit after its last Ticket or by the Operator, brings each held pull request up to date. Before the Check's issue closes as superseded, its marker line and `fabrik:flaky-check` come off it, the rest of its body as it was, so that close brings nothing up to date. Before, it did, before any Ticket had run.
- **The Spec's Tickets are check's fixes.** Each Ticket and Operator step of that Spec carries `fabrik:flaky-check`, as does each sibling when one of its Tickets is split, so each `ready-for-agent` Ticket goes first at Dispatch and past `caps.merge_gate` (ADR-0035). The Spec itself is never released, and no Standing, Dispatch reason or Weekly summary line names it as a fix.
- **A Check's issue never becomes a Map.** The turn's "The Map cap" input says so, the Design prompt asks no Map question there, and a `map` outcome on one is refused as a wrong outcome. A red check whose cause isn't known finishes as a Spec whose first Ticket finds the cause.
- **A live session.** The live Design skill keeps the marker line as a brief's first line, and hands a Spec on a Check's issue to the async session, which lands it as the Fabrik App. A live `spec` or `map` outcome on a Check's issue is refused: the Kit says why on the issue, leaves `needs-design` on and closes nothing, and the Operator's reply starts the async turn.
- **Not restored.** A Check's issue a session rewrote before this release keeps no marker.
- **Why a minor:** it's new behaviour that needs nothing from a Product repo beyond the bump. No new App permission and no new Kit config field is needed, and the read library removes nothing.
