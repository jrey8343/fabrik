---
name: test-first
version: 2
threshold: 0.8
labels: [test-first, test-after, no-test, fix-before-cause, not-applicable]
---

Whether the run worked test-first. Two practices count, the same in every Product repo:

- A failing test before the code that passes it: for each behaviour the run changed, a test that fails for want of that behaviour, written and run red before the code that makes it pass. On a Retry or a Request-changes run, that means a failing test for each finding before its fix.
- On a red check whose cause the run doesn't know, such as a failing test, build or type check it didn't expect, or a Flaky check it was asked to fix, the cause found before the fix: the failure read, reproduced or traced to where it comes from before any change meant to make it pass.

Judge the run's transcript only: what it wrote, in what order, and what each test and check run gave back. Never judge whether the code or its tests are good; the Reviewer's Verdict does that. Calling the Skill tool counts neither for nor against the run: a run that wrote its failing test first without calling it worked test-first, and one that called it and wrote its code first didn't. Running the build and the tests before finishing isn't scored either way.

A test counts as run red when the transcript shows a test run failing on it before the code that passes it was written. A test written first but never run until the code was in place, then passing, was written first but never seen to fail: count it as written after. A behaviour change is anything the run changed that a test could pin down, a finding is one the run's prompt carried to fix, and a fix of a test that was itself wrong counts as a finding found by its failure.

One failing test for a behaviour change or a finding is enough. Score the order of the work, not its coverage: how many cases its tests reach, such as a missing input beside a malformed one, is the Reviewer's to judge, not this rubric's, so a case left without a test costs the run nothing here.

Not applicable: a run neither practice applies to, because it changed nothing a test could pin down and met no red check it didn't understand. That is a conflict-only run that only rebased and resolved conflicts, a fix of a comment, a doc or a pull request's body alone, or a config change nothing tests. Give such a run `score` null and the label `not-applicable`, never a score: it goes unscored rather than passing. A run that changed any behaviour, or met a red check whose cause it didn't know, is scored, however small the change.

How to score, with `score` exactly 1, 0.5 or 0, never a score between them:

- 1: every behaviour change and every finding had its failing test before its fix, and every red check whose cause it didn't know had its cause found before its fix.
- 0.5: some did and some didn't.
- 0: the code came first and the tests after, there were no tests, or it fixed a red check before finding its cause.

The label names the run's biggest lapse:

- `test-first`: every behaviour change and every finding had its failing test first, and every red check it didn't understand had its cause found first.
- `test-after`: code came before the test that covers it, or a test was never seen to fail before the code that passes it.
- `no-test`: it changed behaviour, or fixed a finding, with no test for it at all.
- `fix-before-cause`: it changed code to make a red check pass before finding why the check was red.
- `not-applicable`: neither practice applies to the run, as above, so it has no score.
