# What the week's Execution-flaw Verdicts asked for

Research for Decision #711 on the Wayfinder Map #709. The evidence was read on 2026-11-16: the Run records and Review transcripts of 7 to 15 Nov 2026 (UTC) in `jrey8343/fabrik-runs`, and the Verdict comments, commits and check runs on the agent pull requests in `jrey8343/gradually-core` and `jrey8343/penrith-physiotherapy-sports-centre` (Penrith below).

**Question.** What did the Execution-flaw Verdicts of that week ask for, by kind, and could each finding on a Retry's push have been named by an earlier Verdict on the same pull request?

## Answer in brief

1. **The week held 101 Execution-flaw Verdicts: 89 from the Reviewer, 8 from red Required checks and 4 from empty diffs.** The Reviewer's 89 held 207 findings. Tests (47) and wrong behaviour (43) lead, at 23% and 21%. Unmet criteria, stale comments and docs, the pull request's body and `CODING_STANDARDS.md` rules each hold about a tenth to a sixth.
2. **Three in four findings on a Retry's push were about code that was already there at the head the Verdict before judged.** Of 95 findings on Retry pushes, 71 were already there, 13 came in with the Retry's own fix and 11 repeated a finding the Retry hadn't fixed. For 59 of the 71, a Reviewer had already read that code and named something else.
3. **Ten of the 89 Reviewer Verdicts held only comment, doc or body findings.** They cost ten Implement runs, five of them Step-ups, and two were the third Execution flaw that sent a Ticket back to design.
4. **Of the 16 Tickets that went back to design on a third Execution flaw, 6 had such a Verdict or a red check the pull request didn't cause among their three.** Three had a comment-or-doc-only Verdict and three had a red check the pull request didn't cause.
5. **Seven of the 8 red checks were not caused by the pull request**, one of them with less certainty. All 4 empty diffs followed a Verdict that asked for no code change.

## What was counted, and how

- **The Verdicts.** Every Review record with `verdict: execution-flaw` in the two repos' `2026-11` Run records (89: 60 in gradually-core, 29 in Penrith), plus every Kit-given Verdict comment in the window whose marker says `"source":"ci"` (8) or `"source":"empty-diff"` (4). Each Review record was matched to its Verdict comment by pull request and time, which gives its `headSha`.
- **The findings.** I read each of the 89 Verdicts in full and classified every top-level bullet under the Verdict that asks for a change. The lists of what the Reviewer checked and found sound are not findings. A bullet that only tells the Implementer how to fix the bullet above it is not counted on its own.
- **One kind per finding**, chosen by what the Implementer has to change:
  - code that behaves wrongly is *behaviour*;
  - a test to add or strengthen is *a test*, even when the Reviewer grounds it in a criterion;
  - a deliverable that isn't on the branch is *a criterion unmet*;
  - a comment or doc to correct is *a comment or doc*;
  - the pull request's body to correct is *the body*;
  - structure, naming or duplication to bring in line with a quoted rule is *a `CODING_STANDARDS.md` rule*, hard or judgement by the tag the Verdict quotes.
- **Two flags beside the kind**, because the kinds overlap: whether the finding cites a `CODING_STANDARDS.md` rule, and whether it cites an acceptance criterion.
- **The run kind** of a Verdict is the kind of the last Implement run that pushed before it, from the Implement records' `retry`, `stepUpReason` and `requestChanges`.
- **The origin** of a finding on a later push, in three steps:
  1. I took GitHub's compare between the head the Verdict before judged and the head this Verdict judged, which lists the files that push changed.
  2. A finding about a file the push didn't touch was already there.
  3. For 45 findings I also read the named file at the earlier head. Where the push did touch the file, I read the patch.

The classification is one reader's, made once. The table it was counted from is in the appendix.

## 1. Counts per kind

Counted. Each cell is a number of findings. The last row counts Verdicts.

| Kind | gradually-core | Penrith | All | First run | Retry 1 | Retry 2 | Conflict-only | Request changes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Behaviour wrong | 29 | 14 | 43 | 18 | 17 | 4 | 4 | 0 |
| A test missing, or not testing what it names | 30 | 17 | 47 | 26 | 11 | 7 | 3 | 0 |
| An acceptance criterion unmet | 3 | 20 | 23 | 10 | 6 | 5 | 2 | 0 |
| A criterion no run could meet or prove | 5 | 7 | 12 | 5 | 3 | 4 | 0 | 0 |
| `CODING_STANDARDS.md` rule, hard | 18 | 0 | 18 | 7 | 6 | 4 | 1 | 0 |
| `CODING_STANDARDS.md` rule, judgement | 16 | 0 | 16 | 8 | 6 | 1 | 1 | 0 |
| A comment or doc left stale | 23 | 0 | 23 | 10 | 9 | 4 | 0 | 0 |
| The pull request's body out of date | 9 | 11 | 20 | 12 | 3 | 3 | 2 | 0 |
| Work beyond the Ticket | 2 | 0 | 2 | 0 | 1 | 1 | 0 | 0 |
| None of the above | 3 | 0 | 3 | 1 | 0 | 0 | 2 | 0 |
| A red check | 8 | 0 | 8 | 6 | 0 | 1 | 1 | 0 |
| An empty diff (not a kind the question lists) | 2 | 2 | 4 | 0 | 4 | 0 | 0 | 0 |
| **All findings** | **148** | **71** | **219** | **103** | **66** | **34** | **16** | **0** |
| Execution-flaw Verdicts | 70 | 31 | 101 | 49 | 30 | 16 | 6 | 0 |

Notes on the columns:

- **No Request-changes run drew an Execution flaw.** The three Verdicts on a Request-changes run's push in the window were passes.
- **"First run" includes seven first runs on a Ticket's second pull request**, after a Back to design. Three of those seven Verdicts held only comment, doc or body findings.
- **"Conflict-only" is two different things.** Three of its five Reviewer Verdicts were the first Review of a push no Reviewer had read: that push's Review had ended on an infrastructure failure or never started, and a conflict-only run then moved the head. The other two were on pull requests that had already passed.
- **One Retry 2 Verdict is a second Review of the same head** (gradually-core #272, 01:49). It has a Review record and no Verdict comment.

Notes on the kinds:

- **Tests.** 34 of the 89 Reviewer Verdicts ask for a test. On first runs it is 19 of 43 Verdicts, with 26 findings. 29 of the 47 test findings cite an acceptance criterion.
- **`CODING_STANDARDS.md`.** Penrith has no such file, so every count is gradually-core's.
  - 34 findings are a rule and nothing else, in 27 Verdicts.
  - 15 more findings of other kinds quote a rule as their ground: 6 tests, 6 comments or docs, 3 behaviour.
  - Together that is 49 findings in 37 Verdicts: 37 of gradually-core's 60, or 42% of the 89. The Map's keyword count of "about 4 in 10" holds at the Verdict level.
  - Five Verdicts held standards findings only. One of those was a single judgement call ([gradually-core #355](https://github.com/jrey8343/gradually-core/pull/355)).
- **A criterion no run could meet or prove: 12 findings on 6 Tickets.**
  - Four are a journey file under the Trust root (gradually-core #183).
  - Three are "continue from commit 617e790" on a run that was given a fresh branch without it (Penrith #80).
  - One is a command that must print "exactly that path" when pnpm prints its banner first (gradually-core #377). A Design-flaw Verdict followed it.
  - Four are an accessibility suite CI doesn't run (Penrith #78, #82 twice, #83). On #82 the suite also fails on `main` for pages the Ticket doesn't touch. On #78 and #83 a Retry ran it and reported the result in the body, and no later Verdict raised it.
- **The body.** 20 findings in 19 Verdicts.
  - 9 only ask that the body follow the fix of another finding in the same Verdict.
  - 11 stand alone.
  - One of those is a body saying "CI's `gate` and `e2e` have not run yet", which was true when the Implementer wrote it ([gradually-core #289](https://github.com/jrey8343/gradually-core/pull/289)).
- **Penrith's unmet criteria** are 17 of 20 about content migration: sections the Ticket says to move into fields that stayed in the markdown body.
- **None of the above:** two findings that Visual evidence showed a 404 because the captured route had no seeded patient, and one cosmetic line layout.

### Red checks and empty diffs

Counted from the check runs on each head and the failed jobs' logs.

| Pull request | Push | Check | What failed | Caused by the pull request? |
| --- | --- | --- | --- | --- |
| [gradually-core #227](https://github.com/jrey8343/gradually-core/pull/227) | First run | `e2e` | The sign-in journey stayed on choose-password | No. Retry 1 changed two lines of a comment and `e2e` passed. |
| [gradually-core #228](https://github.com/jrey8343/gradually-core/pull/228) | First run | `gate` | A timing assertion in `today.test.ts` (35 against a limit of 30) | No. The Ticket is the idle lock. |
| [gradually-core #228](https://github.com/jrey8343/gradually-core/pull/228) | Retry 2 | `gate` | A 5 s timeout in `memberships.test.ts` and an assertion in `today.test.ts` | No. |
| [gradually-core #239](https://github.com/jrey8343/gradually-core/pull/239) | Conflict-only | `gate` | `provision.test.ts`: JetStream found no suitable peers | No. |
| [gradually-core #288](https://github.com/jrey8343/gradually-core/pull/288) | First run | `gate` | Lint ran out of memory, twice on the same head | Probably not. See below. |
| [gradually-core #296](https://github.com/jrey8343/gradually-core/pull/296) | First run | `gate` | Lint ran out of memory, twice on the same head | No. Retry 2's head holds the same files as the first push, and it passed. |
| [gradually-core #353](https://github.com/jrey8343/gradually-core/pull/353) | First run | `e2e` | A different journey on each of two attempts | No. The pull request changes a deploy script and a gate test. |
| [gradually-core #375](https://github.com/jrey8343/gradually-core/pull/375) | First run | `gate` | Typecheck: a test stub lacked the adapter's new `activateFile` | Yes. |

- **Lint.** #296 changed types only and was cut from `main` after #288 had merged. Its Retry 1 raised lint's heap and its Retry 2 took that back out, so the head that passed has the first push's files exactly. That points at the suite's heap limit, not at either diff. #288's Retry did take a new config file out of the lint project before `gate` went green, so its case is the less certain.
- **None of the eight was recorded as a Flaky check.** The Kit re-ran the four from 14 Nov on, and each failed again on the same head. The four of 10 Nov were not re-run. On #353 the two attempts failed on different journeys.
- **All six Tickets whose push drew a red check it didn't cause went the long way** (counting #288's). Three went back to design: Tickets #176, #177 and #232. Three passed only on Retry 2, the Step-up: Tickets #281, #285 and #343.
- **Empty diffs.** Two were Retries sent to fix a red check the pull request didn't cause (pull requests #239 and #353). Two were Retries sent to fix a Verdict that asked only for changes to the pull request's body ([Penrith #132](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/132), [Penrith #136](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/136)). Each used one of the Ticket's two Retries, and each was followed by a Step-up that passed.

## 2. Verdicts that held only comment, doc or body findings

Counted: **10 of the 89 Reviewer Verdicts.** Eight held only stale comments or docs, all in gradually-core. Two held only body findings, both in Penrith.

| Pull request | Push judged | What it asked for | What it cost |
| --- | --- | --- | --- |
| [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | Retry 1 | One stale comment | Retry 2, a Step-up, whose Verdict was the third flaw |
| [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | Retry 2 | Two stale comments | Back to design |
| [gradually-core #237](https://github.com/jrey8343/gradually-core/pull/237) | First run | One stale comment | Retry 1 |
| [gradually-core #254](https://github.com/jrey8343/gradually-core/pull/254) | Retry 1 | Two comments and a context doc | Retry 2, a Step-up |
| [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | Retry 2 | A context doc's workflow | Back to design |
| [gradually-core #357](https://github.com/jrey8343/gradually-core/pull/357) | Retry 1 | One sentence of a context doc | Retry 2, a Step-up |
| [gradually-core #361](https://github.com/jrey8343/gradually-core/pull/361) | First run | A comment line wrapped at 102 characters | Retry 1 |
| [gradually-core #369](https://github.com/jrey8343/gradually-core/pull/369) | First run | Three comments | Retry 1 |
| [Penrith #132](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/132) | First run | Two additions to the body | Retry 1 (an empty diff), then a Step-up |
| [Penrith #136](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/136) | First run | A test result added to the body | Retry 1 (an empty diff), then a Step-up |

That is ten Implement runs, five of them Step-ups, and two Tickets sent back to design. Two of the ten are on Tickets whose whole subject is comments (#237, #361). Five of the ten are on Retry pushes. In four of those five, all the stale text was already there at the head the Verdict before judged. In the fifth (#230), one of the two comments was.

## 3. Findings on a Retry's push: where each came from

Counted. 41 Reviewer Verdicts judged a Retry's push (26 on Retry 1, 15 on Retry 2) and held 95 findings. The Verdict before was the Reviewer's for 35 of them, a red check for 5 and an empty diff for 1.

| Origin | Retry 1 | Retry 2 | All | Share |
| --- | ---: | ---: | ---: | ---: |
| Already there at the head the Verdict before judged | 50 | 21 | 71 | 75% |
| Came in with the Retry's own fix | 7 | 6 | 13 | 14% |
| Repeats a finding the Retry didn't fix | 5 | 6 | 11 | 12% |
| All | 62 | 33 | 95 | |

The 71 that were already there split three ways, by what the Verdict before was:

- **57: the Verdict before was the Reviewer's.** It read the same code and named other things.
- **12: the Verdict before was a red check**, so no Reviewer had run. These sit on four Retry 1 pushes whose Retry changed one to three files in answer to the check. The Reviewer's first read of the Ticket's work landed on Retry 1's push, with one Retry left.
- **2: the Verdict before was an empty diff**, and the code had passed Review two heads earlier ([gradually-core #239](https://github.com/jrey8343/gradually-core/pull/239)).

So a Reviewer had already read the code under 59 of the 95 findings (62%).

By repo:

| Origin | gradually-core | Penrith |
| --- | ---: | ---: |
| Already there | 54 (81%) | 17 (61%) |
| The Retry's own fix | 6 (9%) | 7 (25%) |
| A repeat | 7 (10%) | 4 (14%) |
| All | 67 | 28 |

More that was counted:

- **24 of the 41 Verdicts held nothing but findings that were already there.** For 19 of those 24, the Verdict before was the Reviewer's.
- **On Retry 2, at least 15 of the 21 "already there" findings were already at the first run's head.** Two Reviewer Verdicts had read past them.
- **Six of the 11 repeats are a criterion no run could meet**, said again. Two more are judgement calls said again. Three are a fix asked for and not made, or made wrongly.
- **Four of the 13 "own fix" findings follow a fix the Verdict before suggested:**
  - a unit test added because the Verdict said to pin a bound with a test, then called a break of the seam rule;
  - a shell test deleted as asked, leaving a criterion "only checked by pure functions";
  - subsection titles joined into one heading as suggested, then called lost structure;
  - sections moved back to the body as suggested, two of them then called unmet criteria.
- **One of the 13 is the Retry's answer to a red check it didn't cause**: a larger lint heap, called work beyond the Ticket.
- **In six pull requests, an earlier Verdict's own list of what it checked names as sound the thing a later Verdict calls a flaw**: gradually-core #271, #328 and #363, and Penrith #110, #116 and #122.

Conflict-only pushes with a Verdict before them are 4 Verdicts and 11 findings. Eight were already there, four of those at a head that had passed Review ([gradually-core #352](https://github.com/jrey8343/gradually-core/pull/352), [Penrith #110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110)). Two came from the push itself, and one was a repeat.

## 4. Back to design

Counted from the Kit's Back to design comments. In the window, a third Execution flaw sent a Ticket back to design 17 times, on 16 Tickets (Penrith #80 went twice). Five more Tickets went back on a Design-flaw Verdict.

**6 of the 16 Tickets had, among their three Execution flaws, a Verdict holding only comment, doc or body findings, or a red check the pull request didn't cause:**

| Ticket | The three Execution flaws | Which one |
| --- | --- | --- |
| gradually-core #68 ([#271](https://github.com/jrey8343/gradually-core/pull/271)) | Reviewer, Reviewer, Reviewer | The second: one stale comment |
| gradually-core #179 ([#230](https://github.com/jrey8343/gradually-core/pull/230)) | Reviewer, Reviewer, Reviewer | The third: two stale comments |
| gradually-core #317 ([#328](https://github.com/jrey8343/gradually-core/pull/328)) | Reviewer, Reviewer, Reviewer | The third: one context doc |
| gradually-core #176 ([#227](https://github.com/jrey8343/gradually-core/pull/227)) | red `e2e`, Reviewer, Reviewer | The first |
| gradually-core #177 ([#228](https://github.com/jrey8343/gradually-core/pull/228)) | red `gate`, Reviewer, red `gate` | The first and the third |
| gradually-core #232 ([#239](https://github.com/jrey8343/gradually-core/pull/239)) | red `gate`, empty diff, Reviewer | The first, and the empty diff it led to |

No Ticket went back with a body-only Verdict among its three.

Two more of the 17 had a criterion no run could meet in all three Verdicts (gradually-core #183, and Penrith #80 the second time), and Penrith #82 had one in two of its three. The question doesn't ask for these, so they are outside the 6.

## Worked examples

1. **A stale comment costs a Step-up, then the first run's own rename is found on the third read.** [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271).
   - The first Verdict names a copied pattern. The second names one comment the first run had made untrue. The third names a `Sid` rename that changes every existing secret policy.
   - The rename was at the first head. Both earlier Verdicts had written that existing policies were unchanged.
   - Back to design on findings that were all in the first push.
2. **Back to design on two comments.** [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230). The third Verdict is two stale comments. One came in with Retry 2's fix (a comment saying "one of three" answers after the fix added a fourth). The other was a module header the first run left behind, which two Verdicts had read past.
3. **A red check the pull request didn't cause uses a Retry, and the Reviewer starts one behind.** [gradually-core #227](https://github.com/jrey8343/gradually-core/pull/227).
   - `e2e` fails on the first push. Retry 1 changes two lines of a comment and `e2e` passes.
   - The Reviewer then reads the work for the first time and names an unbounded fan-out, asking for a test that pins the bound.
   - Retry 2 adds a unit test, and the next Verdict calls that test a break of the seam rule and names two more unbounded loops that were there all along.
   - Back to design.
4. **The Retry's fix for a red check becomes the flaw.** [gradually-core #296](https://github.com/jrey8343/gradually-core/pull/296). Lint runs out of memory on a change that only retypes a time zone. Retry 1 raises lint's heap. The Reviewer calls that work beyond the Ticket. Retry 2, a Step-up, takes it out, and the pull request passes: three Implement runs for a diff that was sound at the first.
5. **Code that passed Review fails it two heads later.** [gradually-core #239](https://github.com/jrey8343/gradually-core/pull/239).
   - The first run passes.
   - A conflict-only run brings it up to date and `gate` goes red on a JetStream placement error.
   - Retry 1 has nothing to fix and commits nothing, which is the second flaw.
   - Retry 2 moves a test clock. The Reviewer then finds that `lock.ts` sends an unlocked session to the wrong page and has no tests. Its redirect was the same at the head that passed.
   - Back to design.
6. **Three Verdicts, three subjects, one push.** [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257). The first Verdict names a function length and a missing passkey test. The second names unbounded loops in the e2e helpers. The third names one assertion's regex. Everything in the second and third was at the first head. Back to design.
7. **What one Verdict calls defensible, the next calls unmet.** [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116).
   - The first Verdict lists sections kept in the markdown body in four entries as "defensible". The second names sections in those same four entries, and a fifth, as the first criterion unmet.
   - The third finds one more list, in an entry untouched since the first push.
   - Back to design. On the next pull request ([#132](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/132)) the Verdict opens "The code and content meet the Ticket" and is an Execution flaw for the body. The Retry commits nothing, and a Step-up passes.
8. **The Reviewer's suggested fix is the next Verdict's flaw, twice.** [Penrith #117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117).
   - The first Verdict says subsections "can go into the flat lists with their titles kept in `headings`". Retry 1 does that across 18 entries.
   - The second Verdict calls the joined titles lost structure and says to leave those groups in the body. Retry 2 moves them back.
   - The third Verdict names two of the moved-back sections as unmet criteria.
   - Back to design.
9. **A criterion no run could meet, said four times.** [gradually-core #272](https://github.com/jrey8343/gradually-core/pull/272). The Ticket asks for an edit to a journey file under the Trust root. Each of four Verdicts is an Execution flaw for it. The first says nothing in the repo forbids the edit. The fourth says the Operator has to make it.
10. **Accepted, then not.** [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328). The first Verdict says the log-unchanged test covers "writes nothing". The second calls the same test weak evidence, and names a wrong message at a line of `open-file.ts` that was identical at the first head. The third is one context doc. Back to design.

## What is counted and what is inferred

Counted: everything in sections 1 to 4.

Inferred, and not tested here:

- **Most Retries after a Reviewer's Verdict are spent on the Reviewer's second and third reads of the same push, not on the Implementer's mistakes in fixing.** 14% of Retry-push findings came from the fix and 12% were repeats, six of those eleven unmeetable. The rest were there to be found the first time.
- **A first Verdict that named everything it later named would have removed the cause of up to 19 of the 41 Retry-push Verdicts**, the ones that held only findings a Reviewer had already read past. This is an upper bound, since a longer first Verdict gives a Retry more to get wrong.
- **A finding's size doesn't change its cost.** A stale comment calls for the same Retry, and counts toward the same three, as wrong behaviour.
- **A red check the pull request didn't cause costs more than its one Retry.** The Retry guesses at a fix (a comment, a test tidy, a lint heap), and the Reviewer's first read arrives with one Retry left. That none of the six Tickets passed before Retry 2 is counted. That the red check is why is inferred.
- **An empty diff is what a Retry does when the Verdict asked for no code**: all four cases are that.

## Limits, and what this could not establish

- **One reader, one pass.** No second classification was made, and the kinds overlap: a test a criterion asks for could be "a test" or "a criterion unmet", and a standards rule about tests could be either. The flag counts in section 1 show how far a different rule would move the rows: 29 of the 47 test findings could be read as criteria, and 15 findings of other kinds as standards rules. None of that changes the origin split, which doesn't depend on kind.
- **Findings are the Reviewer's bullets.** A Reviewer that splits one problem into four bullets counts four (Penrith #116's second Verdict). One that folds two asks into a bullet counts one.
- **"Already there" means the code was there, not that the Reviewer would have found it.** I didn't establish why a Verdict stopped where it did. The Review transcripts would show how much of the diff each run read, and I didn't read them for that.
- **Bodies have no history in git.** For the four body findings on Retry pushes classed as already there, I checked the code they describe, not when the sentence entered the body.
- **Some origins rest on the compare alone.** A few "already there" calls rest on the file not being in the Retry's diff, plus the earlier Verdict's own text, without reading the file at the earlier head. One finding is mixed: the doc finding on gradually-core #328's third Verdict was two parts already there and one part from the fix. I counted it as already there.
- **Whether #288's lint failure was caused by its pull request** is a judgement from #296's case. I didn't re-run its head.
- **Whether the six Tickets in section 4 would have merged without that Verdict or red check** can't be told from the records. Each had other flaws among its three.
- **One Verdict is left out**: an Execution flaw on gradually-core #386 at 22:52 on 15 Nov has a comment and no Review record in the clone.
- **Nothing here measures the Implementer.** How many flaws a first run leaves is a different question from how many Verdicts it takes to name them.

## Sources

- Run records and Review transcripts: `jrey8343/fabrik-runs`, `runs/jrey8343/<repo>/2026-11/*-review.json`, `*-implement.json` and the transcripts they name. 165 Reviewer Verdicts, 89 of them Execution flaws.
- Verdict, flaky-check and Back to design comments: `GET /repos/jrey8343/<repo>/issues/comments?since=2026-11-06`, read on 2026-11-16 (566 comments in gradually-core, 235 in Penrith). The markers are `fabrik:verdict`, `fabrik:flaky-check` and `fabrik:back-to-design`.
- What each push added: `GET /repos/jrey8343/<repo>/compare/<earlier head>...<head>` for the 44 later heads with a Verdict before them, and `GET /repos/.../contents/<path>?ref=<earlier head>` for the files read at earlier heads.
- Red checks: `GET /repos/jrey8343/gradually-core/commits/<head>/check-runs` for the eight heads, and the failed jobs' logs.
- `CODING_STANDARDS.md` in gradually-core, for the hard and judgement tags.
- Terms: `GLOSSARY.md`.

## Appendix: every Reviewer Execution-flaw Verdict

One row per Verdict, findings in the order the Verdict gives them.

- **Kinds:** "unmeetable" is a criterion no run could meet or prove. "hard rule" and "judgement rule" are `CODING_STANDARDS.md` rules. "other" is none of the question's kinds.
- **Origins**, after a finding on a later push: (a) already there at the head the Verdict before judged, (f) came in with this push's own fix, (r) repeats a finding the push didn't fix.
- "red check before" means the Verdict before was a red check, so no Reviewer had read the code. "passed before" means the code was at a head that had passed Review.

| Ticket | Pull request | Verdict (UTC) | Push judged | Findings |
| --- | --- | --- | --- | --- |
| gradually-core #60 | [#277](https://github.com/jrey8343/gradually-core/pull/277) | 11-14 01:57 | First run | body; test; comment/doc |
| gradually-core #68 | [#271](https://github.com/jrey8343/gradually-core/pull/271) | 11-14 00:47 | First run | hard rule |
| gradually-core #68 | [#271](https://github.com/jrey8343/gradually-core/pull/271) | 11-14 01:04 | Retry 1 | comment/doc (a) |
| gradually-core #68 | [#271](https://github.com/jrey8343/gradually-core/pull/271) | 11-14 01:25 | Retry 2 | beyond Ticket (a); hard rule (a) |
| gradually-core #176 | [#227](https://github.com/jrey8343/gradually-core/pull/227) | 11-10 03:30 | Retry 1 | hard rule (a, red check before); judgement rule (a, red check before); comment/doc (a, red check before) |
| gradually-core #176 | [#227](https://github.com/jrey8343/gradually-core/pull/227) | 11-10 04:00 | Retry 2 | hard rule (f); hard rule (a); comment/doc (a) |
| gradually-core #177 | [#228](https://github.com/jrey8343/gradually-core/pull/228) | 11-10 04:53 | Retry 1 | behaviour (a, red check before); comment/doc (a, red check before); behaviour (a, red check before); judgement rule (a, red check before) |
| gradually-core #178 | [#219](https://github.com/jrey8343/gradually-core/pull/219) | 11-09 01:05 | First run | comment/doc; test; behaviour |
| gradually-core #179 | [#230](https://github.com/jrey8343/gradually-core/pull/230) | 11-10 06:55 | First run | test; test |
| gradually-core #179 | [#230](https://github.com/jrey8343/gradually-core/pull/230) | 11-10 07:27 | Retry 1 | comment/doc (a); behaviour (a) |
| gradually-core #179 | [#230](https://github.com/jrey8343/gradually-core/pull/230) | 11-10 08:04 | Retry 2 | comment/doc (f); comment/doc (a) |
| gradually-core #179 | [#237](https://github.com/jrey8343/gradually-core/pull/237) | 11-10 20:05 | First run | comment/doc |
| gradually-core #183 | [#272](https://github.com/jrey8343/gradually-core/pull/272) | 11-14 00:49 | First run | unmeetable; judgement rule |
| gradually-core #183 | [#272](https://github.com/jrey8343/gradually-core/pull/272) | 11-14 01:09 | Retry 1 | unmeetable (r); judgement rule (r) |
| gradually-core #183 | [#272](https://github.com/jrey8343/gradually-core/pull/272) | 11-14 01:34 | Retry 2 | unmeetable (r) |
| gradually-core #183 | [#272](https://github.com/jrey8343/gradually-core/pull/272) | 11-14 01:49 | Retry 2 | unmeetable (r); body (r) |
| gradually-core #232 | [#239](https://github.com/jrey8343/gradually-core/pull/239) | 11-10 23:01 | Retry 2 | behaviour (a, passed before); test (a, passed before) |
| gradually-core #245 | [#253](https://github.com/jrey8343/gradually-core/pull/253) | 11-12 22:50 | First run | test; comment/doc |
| gradually-core #250 | [#254](https://github.com/jrey8343/gradually-core/pull/254) | 11-12 23:36 | First run | test; test; judgement rule |
| gradually-core #250 | [#254](https://github.com/jrey8343/gradually-core/pull/254) | 11-12 23:58 | Retry 1 | comment/doc (a) |
| gradually-core #256 | [#257](https://github.com/jrey8343/gradually-core/pull/257) | 11-13 05:08 | First run | hard rule; test |
| gradually-core #256 | [#257](https://github.com/jrey8343/gradually-core/pull/257) | 11-13 05:23 | Retry 1 | hard rule (a); judgement rule (a) |
| gradually-core #256 | [#257](https://github.com/jrey8343/gradually-core/pull/257) | 11-13 05:45 | Retry 2 | test (a) |
| gradually-core #281 | [#288](https://github.com/jrey8343/gradually-core/pull/288) | 11-14 03:49 | Retry 1 | behaviour (a, red check before) |
| gradually-core #283 | [#289](https://github.com/jrey8343/gradually-core/pull/289) | 11-14 03:24 | First run | hard rule; comment/doc; body |
| gradually-core #284 | [#290](https://github.com/jrey8343/gradually-core/pull/290) | 11-14 03:27 | First run | judgement rule; comment/doc |
| gradually-core #285 | [#296](https://github.com/jrey8343/gradually-core/pull/296) | 11-14 05:27 | Retry 1 | beyond Ticket (f) |
| gradually-core #286 | [#298](https://github.com/jrey8343/gradually-core/pull/298) | 11-14 05:17 | First run | test; test |
| gradually-core #286 | [#298](https://github.com/jrey8343/gradually-core/pull/298) | 11-14 05:45 | Retry 1 | hard rule (a) |
| gradually-core #287 | [#302](https://github.com/jrey8343/gradually-core/pull/302) | 11-14 06:30 | First run | behaviour; test |
| gradually-core #287 | [#302](https://github.com/jrey8343/gradually-core/pull/302) | 11-14 06:42 | Retry 1 | behaviour (f); test (f) |
| gradually-core #294 | [#304](https://github.com/jrey8343/gradually-core/pull/304) | 11-14 08:18 | First run | behaviour; hard rule; judgement rule |
| gradually-core #294 | [#304](https://github.com/jrey8343/gradually-core/pull/304) | 11-14 08:29 | Retry 1 | hard rule (a); criterion (a); behaviour (a); hard rule (a) |
| gradually-core #309 | [#322](https://github.com/jrey8343/gradually-core/pull/322) | 11-14 20:53 | First run | behaviour; behaviour; hard rule |
| gradually-core #309 | [#322](https://github.com/jrey8343/gradually-core/pull/322) | 11-14 21:18 | Retry 1 | test (r); test (f); comment/doc (a); comment/doc (a); behaviour (a); test (a) |
| gradually-core #309 | [#322](https://github.com/jrey8343/gradually-core/pull/322) | 11-14 23:09 | Conflict-only | behaviour (f); body (f); judgement rule (a); other (a) |
| gradually-core #310 | [#323](https://github.com/jrey8343/gradually-core/pull/323) | 11-14 21:03 | First run | behaviour; body; other |
| gradually-core #310 | [#323](https://github.com/jrey8343/gradually-core/pull/323) | 11-14 21:20 | Retry 1 | hard rule (a); judgement rule (a) |
| gradually-core #310 | [#323](https://github.com/jrey8343/gradually-core/pull/323) | 11-14 23:05 | Conflict-only | hard rule (a); behaviour (a); other (r) |
| gradually-core #310 | [#352](https://github.com/jrey8343/gradually-core/pull/352) | 11-15 08:23 | Conflict-only | behaviour (a, passed before); test (a, passed before) |
| gradually-core #311 | [#363](https://github.com/jrey8343/gradually-core/pull/363) | 11-15 11:02 | First run | behaviour; hard rule; test |
| gradually-core #311 | [#363](https://github.com/jrey8343/gradually-core/pull/363) | 11-15 11:18 | Retry 1 | test (a); behaviour (a); behaviour (a) |
| gradually-core #311 | [#363](https://github.com/jrey8343/gradually-core/pull/363) | 11-15 11:45 | Retry 2 | test (a); test (a); hard rule (a) |
| gradually-core #311 | [#366](https://github.com/jrey8343/gradually-core/pull/366) | 11-15 19:25 | First run | test; body |
| gradually-core #312 | [#321](https://github.com/jrey8343/gradually-core/pull/321) | 11-14 20:51 | First run | test; judgement rule |
| gradually-core #313 | [#364](https://github.com/jrey8343/gradually-core/pull/364) | 11-15 11:05 | First run | body; comment/doc; test; behaviour; judgement rule |
| gradually-core #313 | [#364](https://github.com/jrey8343/gradually-core/pull/364) | 11-15 11:24 | Retry 1 | body (a); behaviour (a) |
| gradually-core #313 | [#364](https://github.com/jrey8343/gradually-core/pull/364) | 11-15 11:49 | Retry 2 | behaviour (a); test (a); judgement rule (r) |
| gradually-core #313 | [#367](https://github.com/jrey8343/gradually-core/pull/367) | 11-15 19:37 | First run | behaviour; behaviour |
| gradually-core #314 | [#375](https://github.com/jrey8343/gradually-core/pull/375) | 11-15 22:11 | Retry 1 | test (a, red check before); behaviour (a, red check before); comment/doc (a, red check before); behaviour (a, red check before) |
| gradually-core #317 | [#328](https://github.com/jrey8343/gradually-core/pull/328) | 11-14 22:16 | First run | behaviour; hard rule; judgement rule; comment/doc |
| gradually-core #317 | [#328](https://github.com/jrey8343/gradually-core/pull/328) | 11-14 22:40 | Retry 1 | behaviour (a); test (a); test (a); judgement rule (a) |
| gradually-core #317 | [#328](https://github.com/jrey8343/gradually-core/pull/328) | 11-14 23:07 | Retry 2 | comment/doc (a) |
| gradually-core #336 | [#355](https://github.com/jrey8343/gradually-core/pull/355) | 11-15 06:06 | First run | judgement rule |
| gradually-core #347 | [#357](https://github.com/jrey8343/gradually-core/pull/357) | 11-15 08:57 | First run | criterion; body; criterion |
| gradually-core #347 | [#357](https://github.com/jrey8343/gradually-core/pull/357) | 11-15 09:16 | Retry 1 | comment/doc (a) |
| gradually-core #349 | [#361](https://github.com/jrey8343/gradually-core/pull/361) | 11-15 09:24 | First run | comment/doc |
| gradually-core #368 | [#369](https://github.com/jrey8343/gradually-core/pull/369) | 11-15 21:37 | First run | comment/doc |
| gradually-core #377 | [#379](https://github.com/jrey8343/gradually-core/pull/379) | 11-15 22:13 | First run | test |
| gradually-core #377 | [#379](https://github.com/jrey8343/gradually-core/pull/379) | 11-15 22:36 | Retry 1 | unmeetable (a) |
| Penrith #73 | [#75](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/75) | 11-07 02:14 | First run | behaviour; behaviour |
| Penrith #78 | [#84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | 11-07 06:25 | First run | unmeetable; test; test; test |
| Penrith #78 | [#84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | 11-07 06:58 | Retry 1 | behaviour (r); test (a) |
| Penrith #78 | [#84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | 11-07 07:38 | Retry 2 | behaviour (a) |
| Penrith #78 | [#108](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/108) | 11-09 01:46 | First run | test |
| Penrith #79 | [#116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | 11-09 09:55 | First run | criterion; body |
| Penrith #79 | [#116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | 11-09 11:01 | Retry 1 | criterion (a); criterion (a); criterion (a); criterion (a); body (a) |
| Penrith #79 | [#116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | 11-09 13:52 | Retry 2 | criterion (a); body (a); test (f) |
| Penrith #79 | [#132](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/132) | 11-10 20:27 | First run | body; body |
| Penrith #80 | [#117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | 11-09 19:33 | Conflict-only | criterion; behaviour; criterion; body |
| Penrith #80 | [#117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | 11-09 20:08 | Retry 1 | behaviour (f) |
| Penrith #80 | [#117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | 11-09 20:57 | Retry 2 | criterion (a); criterion (a); criterion (f); criterion (f); body (f) |
| Penrith #80 | [#144](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/144) | 11-11 22:50 | First run | unmeetable; criterion; criterion; body |
| Penrith #80 | [#144](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/144) | 11-11 23:32 | Retry 1 | unmeetable (r); criterion (f) |
| Penrith #80 | [#144](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/144) | 11-12 00:10 | Retry 2 | unmeetable (r) |
| Penrith #81 | [#121](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/121) | 11-09 14:35 | First run | body; criterion; behaviour |
| Penrith #82 | [#122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | 11-09 19:03 | First run | unmeetable; criterion; behaviour; behaviour |
| Penrith #82 | [#122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | 11-09 19:49 | Retry 1 | behaviour (f); behaviour (a) |
| Penrith #82 | [#122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | 11-09 20:19 | Retry 2 | unmeetable (r); behaviour (a); test (a) |
| Penrith #82 | [#136](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/136) | 11-11 02:27 | First run | body |
| Penrith #83 | [#123](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/123) | 11-09 21:15 | First run | unmeetable; behaviour |
| Penrith #93 | [#102](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/102) | 11-09 00:22 | First run | test; test |
| Penrith #94 | [#111](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/111) | 11-09 03:29 | First run | test; behaviour; test |
| Penrith #97 | [#107](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/107) | 11-09 01:42 | First run | criterion |
| Penrith #98 | [#110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | 11-09 19:37 | Conflict-only | test (a, passed before); test (a, passed before) |
| Penrith #98 | [#110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | 11-09 20:06 | Retry 1 | test (a); body (a); test (a) |
| Penrith #99 | [#112](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/112) | 11-09 04:34 | First run | criterion; test |
| Penrith #100 | [#113](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/113) | 11-09 05:41 | First run | criterion |
| Penrith #115 | [#125](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/125) | 11-09 22:44 | First run | test |
