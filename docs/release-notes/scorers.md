# Release notes: Scorers

The notes for the minor release that ships Scorers ([#149](https://github.com/jrey8343/fabrik/issues/149)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- Fabrik scores a sample of finished Implement runs on how they worked, never on what they built. After the push job writes a run's Run record, it decides whether the run is scored: one in four first Implement runs, picked from the run id, plus every Retry, Step-up and Request-changes run. Triage, Design turns and Reviews are never scored.
- A picked run is scored in the same workflow run by a new judge job, **Score**. The Kit's fixed Sonnet model reads the run's transcript and its Ticket once, and applies three Kit-owned Scorers: Efficiency, Ticket compliance and Skill use. Each gives a score from 0 to 1, a pass against its threshold, a label from its fixed list and a one-line rationale. The judge runs with no tools and holds no write credential (ADR-0002).
- A new **Score record** job writes the scores to `fabrik-runs` as their own append-only score file under `scores/`, beside the run's record. It also writes the judge's own Run record, in role `score`, so what scoring costs is in the store. ADR-0009 has an addendum: the score-record job is the judge run's own push job.
- A picked run isn't scored when its Subscription's last weekly-limit reading is at 0.75 utilization or above, or not `allowed`, when no transcript of it survived, or when it ended in an Infrastructure failure other than a timeout. Its score file says which. A judge that fails, or answers in the wrong shape, leaves a score file saying so. A run that isn't sampled gets no score file.
- The Weekly summary gains a **Scores** section, shown only in a week with score files. Per rubric it gives the runs scored, the median score and the share passing beside last week, then the skips by reason, and what scoring cost as a share of the week's cost. Cost per merged PR and per Spec leave scoring out, and the week's total keeps it. Scores are never posted as issues, notifications or PR comments.
- Scoring never fails, blocks or delays the Loop. The push job plans it inside its record step, which never fails the push job. The judge and score-record jobs run after the push job, beside the Dispatch and Design queue checks, and Dispatch never counts the judge job as an Implement run in flight. A judge that fails shows as a failed Score job in that workflow run, and its score file says so; nothing in the Loop waits on it. The score-record job is `continue-on-error`.
- No shim changes, no Kit config fields and no setup step. Without `fabrik-runs`, no Run record is written, so nothing is scored and no new step-summary line appears.

## No step to take

Scoring needs only the `fabrik-runs` store that Run records already use, so a Product repo only merges the bump PR. As for every release, merge it in the Pilot first ([Validating on the Pilot](../releasing.md#validating-on-the-pilot)), and check there:

- a sampled Implement run and a Retry each get a score file under `scores/` and a `score` record under `runs/` in `fabrik-runs`, and a run that isn't sampled gets neither,
- the next Weekly summary's Scores section: scoring's share of the week's cost against the expected ~3%, and the judge's digest budget against real transcript sizes, noted on [#192](https://github.com/jrey8343/fabrik/issues/192).
