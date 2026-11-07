# Fabrik's baseline per role from the run store

Research for Decision [#346](https://github.com/jrey8343/fabrik/issues/346) on the Map [#344](https://github.com/jrey8343/fabrik/issues/344) (Wayfinder: Quick calls with Jev in the Loop). The data was read on 2026-11-08 through the Operator's `gh`. Nothing was written to any of the repos read. Terms follow `GLOSSARY.md`.

This file holds raw counts, durations, costs and issue numbers only. It copies no issue text, comment, transcript or End-user detail from the Pilot. It also draws no conclusions about Jev.

## Answer in brief

- **One week of data, from one Product repo.** All of it falls in the Weekly summary's week of Monday 2026-11-02 (Australia/Sydney, the Operator's time zone). The Pilot (`jrey8343/penrith-physiotherapy-sports-centre`) adopted the Kit on 2026-11-02 and is the only Product repo with any runs. gradually-core has not adopted it: a paused `.fabrik/config.json` landed on 2026-11-07, but there is no `fabrik.yml` caller and it has no records.
- **The run store itself is about 6.5 hours old.** `jrey8343/fabrik-runs` was created when the Pilot moved to v0.6.0. It holds **30 Run records and 5 score files**, all from 2026-11-07, 01:13 to 07:42 UTC. No Weekly summary has been filed yet; the first is due Monday 2026-11-09.
- **Coverage for the rest of the week comes from the Pilot's Actions artifacts.** Before the store existed, each run's stream-json transcript was already uploaded as an Actions artifact, and these are kept for 90 days. Those transcripts back-fill the fields a record takes from the stream (cost, tokens, durations, turns, model). That gives **128 agent runs (126 with a cost figure) costing $43.81 API-equivalent in the week**. The 28 runs present in both the store and Actions agree exactly on cost. The 13 agent jobs from 2026-11-03 09:00 to 2026-11-04 00:17 UTC (Kit v0.1/v0.2) left no transcript and have no cost figure.
- **Where the money went:** Implement 40.7%, Review 25.5%, Design 18.0% plus 6.3% for its one prototype turn, Triage 6.8%, judge (Scorers) 1.5%, Retro 1.2%. The Researcher and the Auditor did not run at all.
- **Weekly-limit share can't be read from the data.** All 126 rate-limit readings carry `rateLimitType: seven_day` with `utilization: null`. Only each role's share of Fabrik's own API-equivalent dollars is known (the line above). An absolute share needs the W calibration that #67 describes.
- **Triage:** 22 outcomes on 21 issues. The states were needs-design 14, ready-for-agent (the Fast path) 3, ready-for-human 3, needs-info 1 and wontfix 1; the categories were enhancement 16 and bug 5. The Operator relabelled **1** (#30) and never re-sent an issue to `needs-design`. Of the 14 issues sent to design, the Operator closed **4** by hand in a way the session did not end with. **1 of the 3** Fast-path issues later needed a Human touch and a Design session: #29, whose breakage came from the Operator's own deliberate pushes. Another **3** Triage runs were Infrastructure failures, and the Operator re-ran each one.
- **Step-up:** 11 of 20 first Implement attempts failed review (or ended with an empty diff). Retry 1 fixed 4 of them, and **7 went on to a Step-up**. Of those 7, 4 passed and 3 went back to design. The default-model work the Step-up replaced cost a median of **$1.08** per chain (Implement plus Review, $7.95 over all 7). The first runs alone cost a median of $0.29 ($2.37 in total).
- **Review:** 37 Verdicts on 19 agent PRs. 18 were pass and 19 Execution flaw (13 from the Reviewer, 5 from red CI, 1 from a Request-changes run). There were 0 Design-flaw Verdicts. **3 of the 18 passes** (on 2 PRs, #59 and #60) were followed by a Human touch at the Merge gate, and every one of those touches was a Request changes. One more pass (#36) was closed unmerged by the Operator.
- **Intake:** 0 issues closed as duplicates.
- **Operator comments:** 1 Operator comment on an agent PR (#39). It was followed by 0 Request changes.
- **needs-info:** 1 case (#28). Re-triage finished **2.8 minutes** after the author replied.
- **Too thin to read as a baseline.** This was the Operator's try-out week ([#300](https://github.com/jrey8343/fabrik/issues/300)), across 12 commits to the Pilot's Kit pin (v0.1.0 to v0.6.0), with deliberate failure injection. No per-week trend, variance or week-over-week comparison exists. Several counts that the keep/cut test turns on are 0 or 1.

## Sources

- **The run store**, `jrey8343/fabrik-runs`, cloned read-only: `runs/<owner>/<repo>/<yyyy-mm>/<runId>-<attempt>-<role>.json` (schema 4, `src/kit/runRecord.ts`), `scores/…/<runId>-<attempt>-<role>-<kitsha>.json` (schema 2) and `transcripts/…`. Layout and rules are in ADR-0009 (`docs/adr/0009-run-records-live-in-a-central-private-repo.md`).
- **The Pilot's Actions history:** every run of the `Fabrik` workflow and its jobs (`GET /repos/{repo}/actions/runs`, `…/runs/{id}/jobs`), plus its `fabrik-transcript-<role>`, `fabrik-agent-result` and `fabrik-judge-result` artifacts. The agent result supplies each run's subject issue, and the transcript's `result`, `system/init` and `rate_limit_event` lines supply the same fields `runRecordFor` reads.
- **The Pilot's GitHub facts:** each issue and PR timeline (`GET /repos/{repo}/issues/{n}/timeline`: label, close, comment, commit and review events), and PR reviews. Verdicts, retries, back-to-design and Request-changes runs were read from the Kit's own comment markers (`<!-- fabrik:verdict {…} -->`, `fabrik:retry-push`, `fabrik:back-to-design`, `fabrik:request-changes-run`, `fabrik:empty-diff`, `fabrik:design-round`), as the README's Review section says a PR's history can be read. Infrastructure failures were read from the first line of the Kit's failure notice ("The <Role> run on #n failed: <reason>").
- **gradually-core:** `.github/workflows/` (no `fabrik.yml`) and the commit history of `.fabrik/`.
- **Scripts:** [`fabrik-baseline-per-role/fetch.sh`](fabrik-baseline-per-role/fetch.sh) does the read-only fetch, and [`fabrik-baseline-per-role/baseline.py`](fabrik-baseline-per-role/baseline.py) prints every count below (`python3 -I baseline.py STORE GH ARTIFACTS`).

Definitions used: "week" is the Weekly summary's (the Monday it began on, in Australia/Sydney). Percentiles are nearest-rank. "Cost" is `total_cost_usd`, which is the API-equivalent list price and not a bill (#67). Durations come from `duration_ms` and `duration_api_ms`, and wall clock from the agent job's start and end.

## 1. How much data there is

| | Window (UTC) | What |
|---|---|---|
| Run store | 2026-11-07 01:13–07:42 | 30 Run records (28 with transcripts), 5 score files, 1 Product repo |
| Actions transcripts | 2026-11-04 00:05 – 2026-11-07 07:42 | 126 transcripts. 98 of them are runs from before the store; 28 duplicate store records exactly |
| Actions jobs | 2026-11-03 09:00 – 2026-11-07 07:42 | 147 agent-job attempts. 13 of them (up to 2026-11-04 00:17: 5 Design turns, 4 Implement, 4 Review) have neither a transcript nor a record |
| GitHub facts | 2026-11-02 – 2026-11-07 | 45 issues and 39 PRs in the Pilot, 19 of them agent PRs (`fabrik/ticket-*`) |

All of this falls in **one Weekly-summary week (2026-11-02)**. Per Sydney day, the runs with a cost were: 11-04 34 runs/$7.80, 11-05 11/$2.71, 11-06 52/$19.52 and 11-07 31/$13.78.

Two things make this a try-out week rather than a steady state. First, 12 commits changed the Pilot's caller workflow and its Kit pin (setups, Dependabot bumps and a revert): v0.1.0 on 11-02, v0.2.0 on 11-03, v0.5.0 on 11-05 and v0.6.0 on 11-07. Second, the Operator injected failures on purpose: the two Operator pushes on PR #33 broke CI deliberately.

## 2. Runs per role, week of 2026-11-02

Store records plus pre-store Actions transcripts. The "store" and "pre-store" columns show where each run came from.

| role | runs | store | pre-store | with cost | median min | p90 min | median API min | p90 API min | median turns | $ total | median $ | p90 $ | output tok | cache write tok | cache read tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Triage | 20 | 3 | 17 | 20 | 0.4 | 0.7 | 0.4 | 0.6 | 3 | 2.99 | 0.14 | 0.22 | 40k | 240k | 1,380k |
| Design turn | 31 | 8 | 23 | 29 | 0.7 | 1.5 | 0.7 | 1.5 | 5 | 7.87 | 0.26 | 0.47 | 112k | 615k | 3,545k |
| Design prototype turn | 1 | 1 | 0 | 1 | 17.9 | 17.9 | 7.6 | 7.6 | 58 | 2.76 | 2.76 | 2.76 | 51k | 113k | 4,217k |
| Implement (all) | 42 | 6 | 36 | 42 | 3.5* | 16.4* | 1.1 | 2.2 | 7.5 | 17.82 | 0.30 | 0.75 | 369k | 1,587k | 35,500k |
| Review | 28 | 6 | 22 | 28 | 0.9 | 1.4 | 0.9 | 1.3 | 8 | 11.18 | 0.37 | 0.64 | 116k | 924k | 7,332k |
| Retro | 1 | 1 | 0 | 1 | 0.2 | 0.2 | 0.2 | 0.2 | 1 | 0.54 | 0.54 | 0.54 | 1k | 65k | 13k |
| judge (`score`) | 5 | 5 | 0 | 5 | 0.1 | 0.1 | 0.1 | 0.1 | 1 | 0.64 | 0.13 | 0.16 | 2k | 155k | 3k |
| Researcher | 0 | | | | | | | | | | | | | | |
| Auditor | 0 | | | | | | | | | | | | | | |
| **All** | **128** | 30 | 98 | 126 | | | | | | **43.81** | | | | | |

Uncached input tokens are negligible in every role (under 2k a role). Both Design turns without a cost are the two crashed turns on #78 (2026-11-07 07:40 and 07:42): `jobResult: failure`, no result and no transcript.

Models: Triage, Design, Review and Retro all ran Opus 5.5. Implement ran Sonnet 5.5 on 33 runs and Opus 5.5 on 9: 8 Step-up runs (one of them cancelled) and 1 Request-changes run, all described below. The judge ran Sonnet 5.5.

\* **Implement's `duration_ms` is unreliable.** In 14 of the 42 Implement runs it is *below* `duration_api_ms`; one store record shows 5.1 s against 77 s of API time. The agent job's wall clock is the better guide:

| agent job (wall clock, every attempt) | jobs | success | failure | cancelled | median min | p90 min |
|---|---|---|---|---|---|---|
| Triage | 26 | 23 | 1 | 2 | 2.1 | 3.5 |
| Design-session turn | 36 | 34 | 2 | 0 | 2.3 | 3.4 |
| Prototype turn | 1 | 1 | 0 | 0 | 21.1 | 21.1 |
| Implement | 46 | 45 | 0 | 1 | 15.6 | 34.0 |
| Review | 32 | 32 | 0 | 0 | 1.5 | 2.2 |
| Retro | 1 | 1 | 0 | 0 | 0.9 | 0.9 |
| Score (judge) | 5 | 5 | 0 | 0 | 0.5 | 0.5 |

Job wall clock includes Sandbox setup and checkout, so it is longer than the agent's own time. The cancelled Implement job is #49's first Step-up, which hit the 60-minute timeout. It is counted in the cost table with its partial transcript: $1.06, Opus.

## 3. Weekly-limit share

**It can't be computed from the data.** Every run that reported a rate-limit event (126 of 128) reported `rateLimitType: seven_day`, `status: allowed` and `utilization: null`; the store records carry the same. All 30 store records show the same `resetsAt` (2026-11-11 21:00 UTC). This confirms what #67 left unverified: on the Kit's `setup-token` credential, the stream's `seven_day` event carries no utilization.

What is known is each role's share of Fabrik's own API-equivalent dollars: Implement 40.7%, Review 25.5%, Design 18.0% + 6.3% prototype, Triage 6.8%, judge 1.5%, Retro 1.2% of $43.81. Under #67's estimate (share ≈ run $ ÷ W), each role's share of the weekly limit is that fraction × $43.81 ÷ W. W is uncalibrated. Calibrating it needs either:
1. two Settings > Usage readings of the Subscription's weekly percentage, taken at known times, with the Operator's own use in between known or nil; or
2. a credential with `user:profile` scope, so the `/usage` report returns `seven_day` (#67's closed path).

All runs used one Subscription (`Claude token`), so no per-Subscription split exists.

## 4. Triage

From the Pilot's label timelines: a Triage outcome is the Fabrik App removing `needs-triage` and adding a state label within 90 s. 21 issues were created by the Operator and went through Intake. 24 issues were made by the Loop's own skills (Design-session Tickets, Specs, the Retro) and are never triaged.

**Spread (22 outcomes on 21 issues; #28 was triaged twice, before and after needs-info):**

| state | n | issues | categories |
|---|---|---|---|
| needs-design | 14 | #5 #6 #7 #28 (2nd) #31 #37 #38 #43 #44 #45 #56 #61 #68 #76 | enhancement 13, none 1 (#28's re-triage added no category) |
| ready-for-agent (Fast path) | 3 | #23 #29 #63 | bug 2, enhancement 1 |
| ready-for-human | 3 | #30 #57 #69 | enhancement 2, bug 1 |
| needs-info | 1 | #28 (1st) | bug |
| wontfix | 1 | #32 | bug |

All but #28's second outcome came with a category: enhancement 16, bug 5.

**Triage runs that failed:** 3 Infrastructure failures (#28: secrets couldn't be loaded from 1Password; #44 and #63: cancelled at the 10-minute timeout). In each case the Operator re-added `needs-triage` within 1–5 minutes. These are retries, not overrides.

**Operator overrides after a successful Triage:**
- **Relabelled: 1 of 22.** #30 went from ready-for-human to ready-for-agent, 38 minutes after Triage. It then ran three empty-diff Implement runs, went to a Design session and was merged on its second agent PR (#55).
- **Re-sent to `needs-design` by the Operator: 0.** Re-triaged after a successful Triage: 0.
- **Closed differently from where the Loop was taking it: 4, all needs-design issues.** #28, #31 and #61 were closed as not planned by the Operator during their Design session (1, 2 and 2 rounds in), without the session's `wontfix` ending. #38 was closed as completed by the Operator after 2 Design rounds and no Operator reply. Whether these count against Triage is a judgment the Map has to make. Triage's alternative for the first three would have been `wontfix`, which it gave only to #32.
- The wontfix (#32) was never reopened. The other two ready-for-human issues went the human route: #69 through a Pairing session, and #57 is still open.

**Fast-path issues that later needed a Human touch or a Design session: 1 of 3.**
- #23: merged on its first pass, with no touch.
- #63: merged on its first pass, with no touch.
- #29: PR #33 got two Operator pushes (Human touches) and three red-CI Execution flaws, then went back to design. One Design round followed, and the second PR (#35) passed and merged. The pushes were the Operator's deliberate CI breaks, so this one is induced, not organic.
- Counting #30, which the Operator moved to ready-for-agent by hand, the Operator-chosen fast path also ended in a Design session.

## 5. Dispatch and Step-up

From the Verdict and retry markers on all 19 agent PRs, plus #30's empty-diff chain, which had no PR. That gives 20 first Implement attempts:

| first attempt | n | Tickets (PR) |
|---|---|---|
| pass on the first Review | 9 | #10 (#18), #12 (#21), #23 (#25), #7 (#27), #29 (#35), #30 (#36), #51 (#59), #56 (#64), #63 (#65) |
| Execution flaw, fixed by retry 1 | 4 | #9 (#14), #37 (#39), #52 (#62), #73 (#75) |
| Execution flaw or empty diff, went on to a **Step-up** | 7 | #29 (#33), #30 (empty diffs), #30 (#55), #44 (#58), #47 (#53), #49 (#60), #78 (#84) |

**Step-up outcomes: 4 passed** (#55, #58, #53, #60) **and 3 went back to design**: #33 (red CI from the Operator's deliberate push), #30's third empty diff, and #84 (a third Reviewer Execution flaw). No Design-flaw Verdict was given all week. #49's Step-up ran twice: the first attempt was cancelled at its 60-minute timeout ($1.06), and the Operator re-added `agent:implement` to run it again.

**What the work before each Step-up cost** (API-equivalent $, from records and transcripts; "before" means the default-model Implement runs and their Reviewer runs, with red-CI Verdicts costing nothing):

| Ticket (PR) | first Implement run | all Implement before Step-up | Reviews before Step-up | total before Step-up | Step-up run(s) | outcome |
|---|---|---|---|---|---|---|
| #29 (#33) | 0.11 | 0.32 | 0 | 0.32 | 0.23 | back to design |
| #30 (empty diffs) | 0.04 | 0.08 | 0 | 0.08 | 0.09 | back to design |
| #30 (#55) | 0.27 | 0.37 | 0.66 | 1.03 | 0.97 | pass |
| #44 (#58) | 0.29 | 0.75 | 0.42 | 1.17 | 0.72 | pass |
| #47 (#53) | 0.59 | 0.85 | 1.23 | 2.08 | 3.31 | pass |
| #49 (#60) | 0.37 | 0.65 | 0.43 | 1.08 | 1.72 (1.06 cancelled + 0.66) | pass |
| #78 (#84) | 0.70 | 1.05 | 1.14 | 2.19 | 1.04 | back to design |
| **sum / median** | **2.37 / 0.29** | **4.07 / 0.65** | **3.88 / 0.43** | **7.95 / 1.08** | **8.08 / 0.97** | |

For #78, the whole chain was spent before the Ticket went back to design: $3.87 of Implement and Review in total, including the Step-up and its final Review ($0.64).

**Other Opus Implement runs:** 1 Request-changes run (#51, $0.39), which runs on the Step-up model.

**Unexplained Implement runs:** 4 times (Tickets #7, #12, #29, #44, on 11-04 to 11-06), a second default-model Implement run started on the same Ticket right after the first ended, with no Verdict or Operator action calling for it. These cost $0.39, $0.75, $0.12 and $0.30. None happened on 11-07 (v0.6.0). They are counted in the tables above.

## 6. Review

**Verdict spread (37 Verdicts, 19 PRs, all in the week of 2026-11-02):**

| Verdict | source | n |
|---|---|---|
| pass | Reviewer | 18 |
| Execution flaw | Reviewer | 13 |
| Execution flaw | red CI (no Reviewer run) | 5 |
| Execution flaw | Reviewer, on a Request-changes run's push | 1 |
| Design flaw | — | 0 |

The store's own 6 Review records (2026-11-07) show 2 pass and 4 Execution flaw. There were 32 Reviewer job runs, one per Reviewer Verdict. There were 2 Review Infrastructure failures: a crash on #60, and a timeout on #14 on 11-03. The Operator restarted both by adding `agent:review`.

**Passes followed by a Human touch at the Merge gate: 3 of 18 passes, on 2 of the 17 PRs that got a pass.**
- PR #59: the 1st pass got a Request changes 3 minutes later. The 2nd pass got an approval, then a Request changes, then an Operator push (a merge of main through GitHub's web UI), then merged.
- PR #60: the pass got an approval, then a Request changes 1 minute later. The PR is still open.
- Every touch was a Request changes, plus the one push on #59. Two of the three Request changes reviews (#59's 2nd and #60's) were not followed by any Implement job in the Actions history.
- Outside the Human-touch definition: PR #36 passed and was closed unmerged by the Operator 37 hours later. Its Ticket (#30) was re-implemented as #55.
- The other 14 passes went straight to merge (median time from pass to merge not computed here; Merge gate wait is the Weekly summary's metric).

**Human touches overall on agent PRs, by the GLOSSARY definition:** 3 Request changes (#59 ×2, #60 ×1) and 3 Operator pushes (#33 ×2, deliberate; #59 ×1). There were 0 Pairing sessions on a Ticket; the three Pairing sessions (#13, #48, #69) were on Operator briefs. Operator label actions that only restarted a run after an Infrastructure failure (`agent:review` on #14 and #60, `agent:implement` on #49) are not counted as touches.

## 7. Intake: duplicates

**0.** No issue was closed with the duplicate reason, labelled `duplicate` or marked as a duplicate. Close reasons in the Pilot: 29 completed, 4 not planned, 12 open.

## 8. Operator comments

**1 Operator comment on an agent PR** (#39, posted between its Execution flaw and its pass). **0** Request changes followed it, since #39 got none. None of the 3 Request changes in the week (#59 ×2, #60) had an Operator comment before it on the same PR. Whether a Request changes "said the same thing" as a comment can't be counted until there is a pair to compare.

## 9. needs-info

**1 case: #28.** Triage asked for information at 02:52:11 UTC on 11-04. The author (the Operator) replied at 02:56:06. The Kit swapped `needs-info` for `needs-triage` at 02:56:32, and re-triage finished at 02:58:51 with needs-design. That is **2.8 minutes from reply to re-triage**, of which 26 s was the label swap.

## 10. Where the store is too thin, and what would be needed

- **Per-week figures:** only one week exists, and only 6.5 hours of it in the store. Medians and p90s are over 1 to 42 runs. A p90 over fewer than 10 runs (Retro, judge, prototype, and every store-only slice) is just the maximum. Several weeks on a stable Kit pin are needed before a trend or a variance means anything.
- **Kit churn:** the week spans v0.1.0 to v0.6.0. Retry, Claim and Review behaviour changed inside the window (see the unexplained Implement runs). A baseline for the keep/cut test should be taken on one pin.
- **Deliberate tests:** PR #33's Human touches and its Step-up were induced by the Operator. Leave them out and the Fast-path and Step-up "back to design" counts each drop by 1.
- **Weekly-limit share:** not readable (see §3). It needs a W calibration or a `user:profile` credential.
- **Roles with no runs:** the Researcher, the Auditor and Replay arms have 0. Retro and judge have 1 and 5. No per-role baseline exists for them.
- **Triage overrides, needs-info, duplicates, Operator comments → Request changes:** 1, 1, 0 and 0 (with a denominator of 1). A rate needs tens of Triage outcomes; this week had 22.
- **Second Product repo:** gradually-core has not adopted the Kit, so nothing can be compared across repos.
- **The 13 jobs up to 2026-11-04 00:17 UTC with no transcript** (Kit v0.1/v0.2) have no cost figure. Their Actions logs might give token counts, but that was not attempted.
- **What the Run record lacks for these questions:** a pre-store Implement run's retry number and Step-up flag (taken here from the Kit's markers and job order). It also lacks any link from a Triage record to the state and category it chose; that comes only from labels, and the Kit's Weekly summary does not count overrides. A Quick-call shadow (#347) would need the Triage outcome recorded alongside the record to be measured against it.
