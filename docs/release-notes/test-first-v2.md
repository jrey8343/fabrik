# Release notes: Test-first version 2

The notes for the patch release that moves the Test-first Scorer to version 2 ([#741](https://github.com/jrey8343/fabrik/issues/741)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

Test-first scores a run only 1, 0.5 or 0, and counts one failing test per behaviour change or finding as enough, so its scores mean what the rubric says.

## What changed

- **Why:** re-scoring #741's six transcripts under `test-first@1` gave every expected label and pass or fail, but scores of 0.9 and 0.1 where the rubric names only 1, 0.5 and 0. One Retry, which wrote its finding's failing test and ran it red before the fix, lost 0.1 for a case its tests didn't cover. In-between scores move the Weekly summary's medians and a Replay's means.
- **`test-first@2`** (`prompts/scorers/test-first.md`) says the score is exactly 1, 0.5 or 0, never a score between them. It also says one failing test for a behaviour change or a finding is enough: the rubric scores the order of the work, and how many cases the tests reach is the Reviewer's to judge. The labels and the pass line (0.8) are unchanged.
- Under version 2, all six #741 transcripts get exactly the answer #741 lists.
- `test-first@1` stays recorded, so score files written under it still read, and the Weekly summary and a Replay show the two versions apart, as `Test-first v1` and `Test-first v2`.
- **Why a patch:** no Kit config field, shim, setup step, Run-record or score-file schema changes. A Product repo merges the bump PR.

## Upgrading

Take this release in place of v3.4.0: a Product repo still on v3.3.0 merges this bump PR, and the Pilot first. The `fabrik-runs` store's caller moves to this release with the Pilot, as v3.4.0's notes say. A store already on v3.4.0 needs only its pin bumped.
