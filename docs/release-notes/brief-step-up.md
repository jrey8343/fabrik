# Release notes: Stepped-up start on an agent brief

The notes for the release that lets a Design session's agent brief set or clear a Ticket's Stepped-up start ([#376](https://github.com/jrey8343/fabrik/issues/376), ADR-0014). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The agent brief in a Design session's `brief` outcome takes an optional `stepUp`. With `true`, the Kit adds `fabrik:step-up` as it moves the issue to `ready-for-agent`. With `false`, it takes the label off if the issue has it. Left out, the label stays as it stands, so a mark the Operator added by hand is kept.
- A `stepUp` that isn't `true` or `false` breaks the Design session's contract, as the Ticket JSON's does.
- An Operator brief ignores `stepUp`, and Triage's Fast-path brief has no such field: the Fast path never marks a Ticket.
- The Design prompt starts setting it in a separate release (#371). Until then, no brief carries `stepUp`, and the Loop runs as before.
- No shim changes, no Setup changes and no Kit config fields.
