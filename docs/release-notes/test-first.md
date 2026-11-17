# Release notes: Test-first

The notes for the minor release that replaces the Skill use Scorer with Test-first ([#739](https://github.com/jrey8343/fabrik/issues/739), part of [#734](https://github.com/jrey8343/fabrik/issues/734)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- The Scorers are Efficiency, Ticket compliance and **Test-first** (`test-first@1`, pass line 0.8). Test-first scores two practices, named by its rubric alone, the same in every Product repo: a failing test before the code that passes it, one for each finding before its fix on a Retry or Request-changes run, and the cause of a red check the run doesn't understand found before its fix. Calling the Skill tool counts neither way. Its labels are `test-first`, `test-after`, `no-test`, `fix-before-cause` and `not-applicable`.
- The `skill-use` rubric is gone. Its recorded hash stays, so its score files still read as `skill-use@1`, and a week or a Replay holding them still shows them under Skill use.
- A judge may answer `score: null` with the label `not-applicable`, and only for a rubric whose labels list it, as Test-first's do. Score files move to schema 3, where such an entry's `score` and `pass` are null. Schema 1 and 2 files still read.
- The judge's trimmed transcript no longer lists the skills the run had. It still lists the skills the run loaded, and the Retro's trimmed transcripts still list both.
- The Weekly summary's Scores leave not-applicable entries out of each rubric's runs scored, median and passing share, and count them on a `Test-first v1: not applicable` row after `runs scored`.
- A Retro never counts a not-applicable entry as a failing one, and says under its low-scoring runs how many of the window's runs were not applicable to Test-first.
- A Replay leaves a not-applicable Arm out of that rubric's mean, shows the Arm's score as `not applicable`, and says how many each side left out.
- The Glossary gains **Test-first**, and **Scorer** now says a rubric can say it doesn't apply to a run.
- The Implementer's prompt is unchanged: it still tells the run to call `tdd`.

## Upgrading

**Bump the store's pin** in `fabrik-runs` to this release, with the Pilot, so its Weekly summary reads schema 3 score files. Until then it leaves them out. Before adopting the release, re-score the six transcripts in [#741](https://github.com/jrey8343/fabrik/issues/741) under `test-first@1`.
