# Release notes: Yield

The notes for the minor release that measures First-pass, Retry 1 and Retry 2 yield ([#735](https://github.com/jrey8343/fabrik/issues/735), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- Run records move to schema 10, adding `pushed`: the pull request an Implement run's push went to (the one it opened, for a first run) and the head it left there. It is null when the run landed nothing, for every other role and for a Replay arm. A first run's `pullRequest` stays null. Older records read as `pushed: null`, and in the read library's `readRunRecord` they now name the schema they were stored at, as `storedSchema`; a record at schema 10 has none.
- The Weekly summary's Metrics table gains **First-pass yield**, **Retry 1 yield** and **Retry 2 yield**, straight after **Tickets dispatched**: of the Implement runs of each kind whose push got its first Verdict in the week, the share where it was a pass, as `35% (24 of 69)`, then last week's, then the change in points. A week with none judged reads `no judged runs`. An empty diff or a Broken run counts as not passing, but only on a schema 10 record: a record written before `pushed` counts in no Yield, since its passing runs name no push.
- The Glossary gains **Yield**.
- No shim changes and no Kit config fields.

## Upgrading

**Bump the store's pin** in `fabrik-runs` to this release, with the Pilot, so its Weekly summary reads schema 10 records. Until then it leaves them out, and says how many. Last week's records name no push, so the first week on this release shows `no judged runs` for last week, and `–` for the change.
