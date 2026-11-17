# Release notes: a Replay's scores keyed by rubric

The notes for the minor release that stores a Replay's scores by rubric id, not by Scorer position ([#738](https://github.com/jrey8343/fabrik/issues/738), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- **The results marker's format.** A Replay issue's `<!-- fabrik:replay-results … -->` marker stores each Arm's `scores` as an object keyed by rubric id, `<name>@<version>`, such as `{"efficiency@1":0.8,"ticket-compliance@1":0.9,"test-first@1":null}`, in place of a list in the Kit's Scorer order. A rubric the Arm has no score for is left out, and one that doesn't apply to its run ([#739](https://github.com/jrey8343/fabrik/issues/739)) is `null`.
- The report takes its score columns from those ids, in the order the results first name them, so neither the Kit's Scorers nor their order ever moves a stored score. A rubric an Arm has no score for reads `–`, and two versions of one rubric both in the results get their version in the heading, such as `Ticket compliance v1`.
- **A positional marker from before still reads as it did.** Its list is read as `efficiency@1`, `ticket-compliance@2` and `skill-use@1`, in that order, and kept as a list when the Kit rewrites the issue, so its report always shows the Efficiency, Ticket compliance and Skill use columns, even where no Arm has a score for one, and never the Kit's Scorers now.
- No Run-record or score-file change, no shim change and no Kit config fields.

## Upgrading

Nothing to do beyond the bump PR. A Kit before this release reads a keyed marker as holding no results, so a Replay issue this release has rewritten shows no figures on a Product repo rolled back to an older release.
