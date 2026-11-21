# Release notes: Test-first version 3

The notes for the patch release that has the Implementer see each new test fail before its code, and moves the Test-first Scorer to version 3 ([#852](https://github.com/jrey8343/fabrik/issues/852)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## Release-note line

The Implementer is asked to run each new test and see it fail before writing its code, and to show that a test of behaviour already in the code can fail by breaking that behaviour briefly. Test-first, now version 3, counts that mutation check as run red.

## What changed

- **Why:** Test-first failed most scored runs on v4.0.0 and v4.1.0, which both carry [#702](https://github.com/jrey8343/fabrik/issues/702)'s retry bullet. #852 cites twelve score files, all `test-first@2`, labelled `test-after` and below the pass line:
  - Seven runs wrote a test and its code in one step, or ran the test only once the code was in place.
  - Three runs were asked only for a test of behaviour already in the code, or to strengthen a weak one, and never showed it failing.
  - Two runs broke the behaviour briefly to show their tests fail. The judge credited that in run 44817041678 and refused it in run 44656334632, since a run asked only for a test has no code to write after it. The same practice was scored two ways.
- **The Implementer prompt** (`prompts/implement.md`): the "Work test-first" bullet under "How to work" still asks for `tdd`, and now also says:
  - Run each new test and see it fail before writing the code it covers, and never write a test and its code in the same step.
  - When the Ticket, a finding or a requested change asks only for a test of behaviour already in the code, whether a new test or a stronger one, show the test can fail: break that behaviour briefly, run the test red, then restore it.
  - No other section of the prompt changes, the retry, Touch-up and Request-changes sections included.
- **`test-first@3`** (`prompts/scorers/test-first.md`) gains one sentence: a test added or strengthened for behaviour already in the code, where the run was asked only for the test, counts as run red when the transcript shows it failing with that behaviour briefly broken (a mutation check) before the behaviour is restored. The labels, the pass line (0.8) and the scoring steps are unchanged.
- **Two wording changes from #852's body**, which the Operator agreed in triage:
  - Both texts cover a strengthened test as well as an added one.
  - The prompt names the Ticket beside a finding and a requested change, so a first run on a test-only Ticket is covered, as the rubric's "the run was asked only for the test" already covers it.
- `test-first@2` stays recorded, so score files written under it still read, and the Weekly summary and a Replay show the two versions apart, as `Test-first v2` and `Test-first v3`.
- The Kit neither enforces nor detects a red run. This changes what the prompt asks and what the rubric credits, and nothing else.
- **Why a patch:** it changes only one bullet of the Implementer prompt and the Test-first rubric. No Kit config field, shim, setup step, permission, Run-record schema or score-file schema changes, and the read library is as it was. A Product repo merges the bump PR.

## Upgrading

**[#875](https://github.com/jrey8343/fabrik/issues/875)'s re-score comes before this release reaches the Pilot.** Re-score #875's seven transcripts under `test-first@3` and check each gets the answer #875 lists. A judge model's answer can't be held in CI, so it is checked by hand, as [#741](https://github.com/jrey8343/fabrik/issues/741) did for `test-first@2`. If any run gets a different answer, hold the bump and change the rubric, as a new version, until all seven get theirs.

Then a Product repo merges the bump PR, the Pilot first. No schema changes, so the `fabrik-runs` store's caller needs no bump for this release.
