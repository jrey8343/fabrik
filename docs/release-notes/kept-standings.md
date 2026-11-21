# Release notes: A Standing or a row a reader kept reads back at any later release

The notes for the minor release that has the read library read back a Standing, or a row, a reader kept at any earlier release, say when one is from a newer Kit, and refuse a Standing of another schema by name ([#793](https://github.com/jrey8343/fabrik/issues/793), ADR-0020). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

The read library reads back what it gave at an earlier release: `readStanding` and `readRow` bring a kept Standing or row to this release. A reader that keeps rows or Standings must read them back through `readRow` or `readStanding`, since a call with a Standing of another schema is now refused. The Loop is unchanged.

## What changed

- **`readStanding(kept)`** gives a kept Standing at the current schema, as `readRunRecord` does for a Run record. One at `STANDING_SCHEMA` comes back as it is. One of an earlier schema comes back brought forward, with `schema: STANDING_SCHEMA`. Anything else gives null: not an object, no integer `schema`, or a schema newer than the Kit's. It checks the schema and nothing more.
- **The step from schema 1 to 2.** A `blocked` Standing kept at v3.1.0 to v3.4.1 held `detail.blockers` as numbers, its own repo's alone. It reads with each as `{ repo, number }`, with the Standing's own `repo`, sorted as schema 2 keeps them, and `detail.hiddenBlockers` 0. Every other key of its detail stays, a joined Pairing session's `pullRequest` and the `head` among them. A schema 1 Standing of any other name changes only its `schema`.
- **`newerStandingSchemaOf(kept)`** gives a kept Standing's schema when it is newer than `STANDING_SCHEMA`, and null otherwise, so a reader can tell a newer Kit's Standing from one that isn't a Standing.
- **`readRow(kept)`** gives a kept row as a row of this release. Each Standing it holds is read through `readStanding`: its own and, on a Pairing session's row, the issue's own under `plainPullRequest.own`. A row kept before v4.1.0 has no `shots` key and reads with `shots: null`. Every other field is as it was kept. It gives null for something that isn't a row, or a row holding a Standing that doesn't read.
- **A Standing of another schema is refused by name.** Every export that takes a kept Standing or kept rows throws when a Standing it is given, or one a row holds, has a `schema` other than `STANDING_SCHEMA`, or none. Those are `wordStanding`, `standingAt`, `joinRuns`, `joinChecks`, `joinDeployments`, `headsToCheck`, `mergesToRead` and `owedRollInsOf`. The error names the Standing's schema, the Kit's `STANDING_SCHEMA` and `readStanding`. Before, a schema 1 `blocked` Standing given to `wordStanding` threw a `TypeError` from inside the wording, with nothing naming the schema as the cause, and a newer Kit's Standing of a name this Kit doesn't know got no words at all.
- **`Row` was compared at every release from v3.1.0.** `shots` is the only field it has gained, and no type it holds changed in a way a kept row lacks, beyond the Standing's own schema.

## For a reader of the read library

- **Read back what you kept.** A reader that keeps rows or Standings across a move of its pin must read them back through `readRow` or `readStanding` before handing them to anything else, since a call with a Standing of another schema is now refused.
- **A schema 1 Standing that isn't `blocked` is refused too.** It was worded correctly before this release, as only its `schema` differs from schema 2's. It is refused now, so that every kept Standing comes back through the one read.
- **A null is not an error.** `readStanding` and `readRow` give null for a Standing or a row of no schema they know, a newer Kit's among them, and `newerStandingSchemaOf` says when that is the cause. What a reader keeps is a cache, so one that doesn't read is gathered again. Neither validates what it is given beyond the schema.
- **A reader's own step can go.** One that brings kept Standings from schema 1 to 2 itself, or fills `shots` on a row kept before v4.1.0, can drop that for `readStanding` and `readRow`.
- `STANDING_SCHEMA` stays 2. `Standing`, `Row` and every other export are unchanged in shape.

## Upgrading

- **A Product repo merges the bump**, as for any minor, and does nothing else. The Loop, the Weekly summary and the store are unchanged.
- **Why a minor:** it adds three exports and needs nothing from a Product repo beyond the bump. The refusal falls only on a value the `Standing` type never allowed: a Standing whose `schema` isn't `STANDING_SCHEMA`.
