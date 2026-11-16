# Why the earlier Review didn't name it

This builds on `docs/research/execution-flaw-findings.md` (branch `research/execution-flaw-findings`). That note found 57 findings on a Retry's push that were already there at the head the Verdict before judged, where that Verdict was the Reviewer's. Its own caveat was "I didn't establish why a Verdict stopped where it did." This note answers that from the Review transcripts. The evidence was read on 2026-11-16 from `jrey8343/fabrik-runs`.

**Question.** For each of the 57, why did the earlier Review not name the flaw? Was the code not read, read but not noticed, noticed but left out of the `<review>` block, or not nameable from what the Review was given? And how long did each earlier Review run, how much of the diff did it read, and did it hit a limit?

## Answer in brief

All 57 findings were classified, not a sample. They come from 28 pairs of Verdicts: 40 findings in gradually-core and 17 in Penrith.

| Category | gradually-core | Penrith | All |
| --- | ---: | ---: | ---: |
| 1. Not read | 10 | 3 | **13** |
| 2. Read, not noticed | 29 | 10 | **39** |
| 3. Noticed, not reported | 1 | 4 | **5** |
| 4. Rule unavailable | 0 | 0 | **0** |

1. **Most misses were read.** In 44 of 57 cases (77%) the code or text the later finding names appeared in what the earlier Review saw.
2. **In about half the "read, not noticed" cases, the earlier Verdict said the opposite.** In 19 of the 39, its own text says the thing was sound. Two examples:
   - "existing policies are unchanged" about a `Sid` rename that changes every one of them;
   - "without weakening what they assert" about tests whose exact assertions became `length > 0`.
   In 5 more of the 39, it flagged the same rule, or the same change, at another site.
3. **"Not read" is mostly prose outside the diff, or the Reviewer's own trimming of its output.**
   - 7 of the 13 are a comment or doc the change made stale. They sat in files outside the diff, or outside the hunks the Review was shown.
   - 4 were hidden by the Review's own `head -220`, `cut -c1-400`, or a saved diff it never opened.
   - 2 are Penrith content entries it checked by script, never by reading them.
4. **Nothing was a rule the Reviewer wasn't given.** Every `CODING_STANDARDS.md` rule the later Verdicts quote was in the earlier Review's prompt. No pair straddles the file's one change in the window (12 Nov 22:06 UTC).
5. **No earlier Review came near a limit.**
   - The 28 earlier Reviews ran 35–118 s (median 58 s) of their 30-minute timeout. The longest used 6.6% of it.
   - They took 6–23 turns (median 11.5) and 5–22 tool calls (median 10.5).
   - Every one ended `completed`, with no error, no permission denial and no API retry. The Kit passes no `--max-turns` (`src/agent/launch.ts`).
   - Across all 175 Review transcripts in the window, the longest ran 196 s.
6. **Most earlier Reviews read the whole diff.**
   - 17 of the 28 saw every changed file's hunks.
   - 5 skipped only small test, fixture or lockfile edits.
   - 6 had real gaps, and 6 of the 13 "not read" findings come from 4 of those 6.
7. **`CODING_STANDARDS.md` was always given in full.** The Kit appends the whole file to the Reviewer's prompt (`src/agent/review.ts`, since a5c51ae on 6 Nov). No earlier Review opened it again; one grepped it. Penrith has no such file.

Categories 2 and 3 can only be told apart from visible text. The transcripts redact thinking. Across all 175 Review transcripts, every thinking block is empty except two one-line summaries. One is in an earlier Review here (#323 at 21:03), and it names the gap that Review went on to report. A Review that weighed a problem in its thinking and dropped it would show here as category 2. So category 3 is a floor.

## How it was read

- **The pairs.** For each of the 28 later Verdicts, the Verdict before it is the Review record just before it on the same pull request, matched by time. Its transcript is the one that record names.
- **What the Review saw.** I rebuilt it from each transcript's tool results, which are what the model was shown:
  - a saved ("persisted") output counts only as its 2 KB preview, unless the Review then Read the file;
  - a Read counts only for the lines it returned;
  - a `head`, `sed -n` or `cut` counts only for what it let through.
- **"The diff read"** compares the files `git diff --stat` listed with the files whose hunks reached the Review.
- **Each finding**, from the later Verdict's bullets matched to the prior note's appendix:
  - I searched the earlier Review's seen text for the named lines;
  - I read its visible text (status lines and the final reply, including what it lists as checked);
  - I checked whether the rule or fact the finding rests on was in its prompt. The prompt held the pull request with its body, the Ticket, the Spec, the glossary, the ADRs, `CODING_STANDARDS.md`, and gradually-core's `.fabrik/review.md`.
- **Flags beside category 2**, used in the table:
  - the earlier Verdict asserts the opposite;
  - a tool call searched for exactly this;
  - it named the same rule at another site.
- **One recode.** Four Penrith #116 findings were first read as category 2 and are counted as 3. The 09:55 Verdict's checked list names Hamstring's Assessment and FAI, Osgood-Schlatter and shoulder labral treatment, and calls keeping them in the body "defensible". It saw the very sections and judged them not a flaw.
- **Who read what.** The 57 were split across four parallel readers using one written rubric, and I re-checked a sample of their greps. It is one classification, made once.

## By kind

| Kind | 1 Not read | 2 Read, not noticed | 3 Noticed, not reported | All |
| --- | ---: | ---: | ---: | ---: |
| A comment or doc | 7 | 2 | 0 | 9 |
| A test | 1 | 10 | 1 | 12 |
| Behaviour | 1 | 10 | 0 | 11 |
| `CODING_STANDARDS.md` rule, hard | 1 | 7 | 0 | 8 |
| `CODING_STANDARDS.md` rule, judgement | 1 | 2 | 0 | 3 |
| An acceptance criterion unmet | 2 | 3 | 3 | 8 |
| The pull request's body | 0 | 3 | 1 | 4 |
| Beyond the Ticket | 0 | 1 | 0 | 1 |
| A criterion no run could meet | 0 | 1 | 0 | 1 |

- **Comments and docs are the one kind that is mostly "not read".** Seven of nine: `stack.md`, `identity.md` (twice), `patient-record.md`, a module header above the hunk, and a route comment in a file outside the diff. In one other case the paragraph was in the diff, but the Review's `cut -c1-400` cut it before the defect.
- **Tests and behaviour are almost all "read, not noticed".**
- **Every hard and judgement rule finding except #323's two was on lines the earlier Review saw.** #323's two were behind its own `head -220`.

## The earlier Reviews: time, turns and how much they read

"Thinking" is the sum of the transcript's `thinking_duration_ms`. "Findings it named" counts the bullets in that Review's own Verdict, from the prior note's appendix.

| Pull request | Review (UTC) | Wall time | Turns | Tool calls | Thinking | Diff read | Findings it named |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | 11-14 00:47 | 56 s | 9 | 8 | 41 s | Whole | 1 |
| [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | 11-14 01:04 | 67 s | 12 | 11 | 45 s | Whole | 1 |
| [gradually-core #227](https://github.com/jrey8343/gradually-core/pull/227) | 11-10 03:30 | 35 s | 6 | 5 | 23 s | All but 7 small test and fixture edits | 3 |
| [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | 11-10 06:55 | 59 s | 12 | 11 | 38 s | All but 10 small test and fixture edits | 2 |
| [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | 11-10 07:27 | 81 s | 23 | 22 | 40 s | All but 11 small test, fixture and index edits | 2 |
| [gradually-core #254](https://github.com/jrey8343/gradually-core/pull/254) | 11-12 23:36 | 43 s | 8 | 7 | 29 s | Whole | 3 |
| [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257) | 11-13 05:08 | 40 s | 7 | 6 | 28 s | Whole | 2 |
| [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257) | 11-13 05:23 | 53 s | 11 | 10 | 34 s | Whole (new files by `cat`) | 2 |
| [gradually-core #298](https://github.com/jrey8343/gradually-core/pull/298) | 11-14 05:17 | 54 s | 16 | 15 | 25 s | Whole | 2 |
| [gradually-core #304](https://github.com/jrey8343/gradually-core/pull/304) | 11-14 08:18 | 45 s | 6 | 5 | 33 s | Whole | 3 |
| [gradually-core #322](https://github.com/jrey8343/gradually-core/pull/322) | 11-14 20:53 | 90 s | 18 | 17 | 52 s | All but 7 one-line test edits | 3 |
| [gradually-core #323](https://github.com/jrey8343/gradually-core/pull/323) | 11-14 21:03 | 49 s | 14 | 13 | 27 s | 21 of 35 files; one saved diff never Read, one `head -220` cut | 3 |
| [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | 11-15 11:02 | 59 s | 11 | 10 | 38 s | Whole | 3 |
| [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | 11-15 11:18 | 92 s | 14 | 13 | 68 s | Whole | 3 |
| [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | 11-15 11:05 | 97 s | 13 | 12 | 73 s | 29 of 47 files; one source module and four test files unseen | 5 |
| [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | 11-15 11:24 | 118 s | 21 | 20 | 78 s | 16 of 49 files; source only, tests by name | 2 |
| [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | 11-14 22:16 | 46 s | 10 | 9 | 27 s | Whole (tests diff without context lines) | 4 |
| [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | 11-14 22:41 | 57 s | 14 | 13 | 36 s | Whole | 4 |
| [gradually-core #357](https://github.com/jrey8343/gradually-core/pull/357) | 11-15 08:57 | 52 s | 13 | 12 | 28 s | All source and docs, lines cut at 400 columns; 5 test files unseen | 3 |
| [gradually-core #379](https://github.com/jrey8343/gradually-core/pull/379) | 11-15 22:13 | 62 s | 10 | 9 | 45 s | Whole | 1 |
| [Penrith #84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | 11-07 06:25 | 64 s | 10 | 9 | 39 s | Whole | 4 |
| [Penrith #84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | 11-07 06:59 | 60 s | 12 | 11 | 35 s | All but the lockfile | 2 |
| [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | 11-09 09:55 | 49 s | 9 | 8 | 35 s | Whole | 2 |
| [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | 11-09 11:01 | 61 s | 10 | 9 | 32 s | 10 of 17 files; 7 entries by script | 5 |
| [Penrith #117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | 11-09 20:08 | 63 s | 12 | 11 | 31 s | 2 of 28 files; 26 entries by script and grep | 1 |
| [Penrith #122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | 11-09 19:03 | 57 s | 11 | 10 | 37 s | Whole | 4 |
| [Penrith #122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | 11-09 19:49 | 76 s | 13 | 12 | 50 s | Whole | 2 |
| [Penrith #110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | 11-09 19:37 | 40 s | 9 | 8 | 26 s | Whole | 2 |

"Whole" means the hunks of every file in `git diff --stat` reached the Review, possibly through more than one command. The six with real gaps:

- **gradually-core #323, 21:03.** A 57 KB diff was saved to a file and never opened, and `| head -220` stopped `bucket.ts` before `readPulledAt`.
- **#364, 11:05.** It never saw `send-state.ts` or four domain test files.
- **#364, 11:24.** A 91 KB diff holding every test was saved and never opened. It read the source again, narrowed.
- **#357, 08:57.** Three saved diffs were never opened. Narrower diffs were read with `cut -c1-400`.
- **Penrith #116, 11:01.** Seven entries were checked only by a script that prints removed lines missing from the frontmatter.
- **Penrith #117, 20:08.** Only 2 of 28 files' hunks were shown. The 26 entries were checked by script and grep filters.

## The 57 findings

The time of the Verdict before links its Review's transcript. "Nothing visible" means no status line and no part of the final reply mentions it.

| # | Pull request | Verdict before → later Verdict (UTC) | Kind | The later finding | Category | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | [11-14 00:47](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43535252486-1-review.jsonl.gz) → 11-14 01:04 | comment/doc | `nats-config.ts:35` comment says the test reads stderr; the fixture now writes log files | 2 Read, not noticed | The comment line was in the diff it Read in full; nothing visible mentions it. |
| 2 | [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | [11-14 01:04](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43537125017-1-review.jsonl.gz) → 11-14 01:25 | beyond Ticket | `secrets.ts` renames the policy `Sid`, so every existing secret policy changes | 2 Read, not noticed | Saw the `-`/`+` `Sid` lines; its Verdict says existing policies are unchanged. The Review before it did the same. |
| 3 | [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271) | [11-14 01:04](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43537125017-1-review.jsonl.gz) → 11-14 01:25 | hard rule | [hard] Parse, don't validate: `routePasswordPattern.test` and `secretNamePattern.test` keep the raw string | 2 Read, not noticed | Its own grep for `Pattern.test` returned `nats-config.ts:85`; nothing visible about the rule. |
| 4 | [gradually-core #227](https://github.com/jrey8343/gradually-core/pull/227) | [11-10 03:30](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/42748853799-1-review.jsonl.gz) → 11-10 04:00 | hard rule | [hard] Limits: `run()`'s re-run loop and an unbounded `SELECT` in `sign-in-protection.ts` | 2 Read, not noticed | Saw both. It named the same rule for the `Promise.all` fan-out in the same file. |
| 5 | [gradually-core #227](https://github.com/jrey8343/gradually-core/pull/227) | [11-10 03:30](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/42748853799-1-review.jsonl.gz) → 11-10 04:00 | comment/doc | `docs/agents/stack.md` test-seams table has no row for the new loop | 1 Not read | `stack.md` isn't in the diff, and it never opened it. |
| 6 | [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | [11-10 06:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/42770812748-1-review.jsonl.gz) → 11-10 07:27 | comment/doc | `identity.md:139` Memberships paragraph still lists the old events | 1 Not read | The paragraph sits about 25 lines past the hunk's context, and it never showed. |
| 7 | [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | [11-10 06:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/42770812748-1-review.jsonl.gz) → 11-10 07:27 | behaviour | `callCell` reports a timeout as "unreachable … Nothing was changed" | 2 Read, not noticed | Saw the timeout and the message; its checked list says no answer maps to unreachable, as intended. |
| 8 | [gradually-core #230](https://github.com/jrey8343/gradually-core/pull/230) | [11-10 07:27](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/42774118155-1-review.jsonl.gz) → 11-10 08:04 | comment/doc | `memberships.ts:13-15` header comment omits the clinic role | 1 Not read | The hunk starts at line 44 and its `sed` read began at 30. It reported the same staleness in `identity.md`. |
| 9 | [gradually-core #254](https://github.com/jrey8343/gradually-core/pull/254) | [11-12 23:36](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43329108743-1-review.jsonl.gz) → 11-12 23:58 | comment/doc | `routes/+page.server.ts:19-20` comment says clinic-picker holds the two-step gate | 1 Not read | The file isn't in the diff. It grepped for `pendingRedirectOf`, which the comment doesn't contain. |
| 10 | [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257) | [11-13 05:08](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43368849756-1-review.jsonl.gz) → 11-13 05:23 | hard rule | [hard] Limits: `for (;;)` and literal timeouts in the e2e helpers | 2 Read, not noticed | Saw `for (;;)` (twice) and the literals; its one finding was the function-length rule. |
| 11 | [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257) | [11-13 05:08](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43368849756-1-review.jsonl.gz) → 11-13 05:23 | judgement rule | [judgement] `codeSendTimes` counts any six-digit email as a code send | 2 Read, not noticed | Saw the regex; its checked list says `people.ts` reads the sink the way existing code does. |
| 12 | [gradually-core #257](https://github.com/jrey8343/gradually-core/pull/257) | [11-13 05:23](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43370708179-1-review.jsonl.gz) → 11-13 05:45 | test | `staff-sign-in.spec.ts` accepts `/sign-in|lock`, so a locked live session passes | 2 Read, not noticed | Read the whole spec by `cat`; its checked list says the owner's session ends. |
| 13 | [gradually-core #298](https://github.com/jrey8343/gradually-core/pull/298) | [11-14 05:17](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43559514050-1-review.jsonl.gz) → 11-14 05:45 | hard rule | [hard] `passkey.ts` schemas leave strings and an array without `.max()` | 2 Read, not noticed | Saw the schemas; its checked list says they "cover only the fields the ceremony reads". |
| 14 | [gradually-core #304](https://github.com/jrey8343/gradually-core/pull/304) | [11-14 08:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43568895462-2-review.jsonl.gz) → 11-14 08:29 | hard rule | [hard] `/^[A-Z2-7]+$/` written in three files | 2 Read, not noticed | Saw all three. It reported the same regex under Parse, don't validate, not as a copy. |
| 15 | [gradually-core #304](https://github.com/jrey8343/gradually-core/pull/304) | [11-14 08:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43568895462-2-review.jsonl.gz) → 11-14 08:29 | criterion | Criterion: `setUpTwoStep` copies `confirmTwoStep`'s page steps | 2 Read, not noticed | Saw both. It applied move-not-copy to `authenticatorCode` only, and called that moved. |
| 16 | [gradually-core #304](https://github.com/jrey8343/gradually-core/pull/304) | [11-14 08:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43568895462-2-review.jsonl.gz) → 11-14 08:29 | behaviour | `refuse()` always names the owner, so operator failures say "Signing the owner in" | 2 Read, not noticed | Its grep for `function refuse` returned the line; nothing visible about it. |
| 17 | [gradually-core #304](https://github.com/jrey8343/gradually-core/pull/304) | [11-14 08:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43568895462-2-review.jsonl.gz) → 11-14 08:29 | hard rule | [hard] Limits: `execFile` runs with no timeout | 2 Read, not noticed | Saw the call. It named the same rule elsewhere, and its grep `timeout: [0-9]` can't match a call that has none. |
| 18 | [gradually-core #322](https://github.com/jrey8343/gradually-core/pull/322) | [11-14 20:53](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43639169730-1-review.jsonl.gz) → 11-14 21:18 | comment/doc | `identity.md` and ADR 0019 not updated for the inbox widening | 1 Not read | `identity.md` isn't in the diff and was never opened. ADR 0019 was in its prompt. |
| 19 | [gradually-core #322](https://github.com/jrey8343/gradually-core/pull/322) | [11-14 20:53](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43639169730-1-review.jsonl.gz) → 11-14 21:18 | comment/doc | A new field placed between `adapterFor`'s comment and `adapterFor` in `worker.ts` | 2 Read, not noticed | Saw the three lines in order; nothing visible. |
| 20 | [gradually-core #322](https://github.com/jrey8343/gradually-core/pull/322) | [11-14 20:53](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43639169730-1-review.jsonl.gz) → 11-14 21:18 | behaviour | `pmsConnectionHealthOf` uses `safeParse`, so a malformed row reads as working | 2 Read, not noticed | Saw the function; nothing visible. |
| 21 | [gradually-core #322](https://github.com/jrey8343/gradually-core/pull/322) | [11-14 20:53](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43639169730-1-review.jsonl.gz) → 11-14 21:18 | test | A test named for two cases checks only one | 2 Read, not noticed | Read the whole test file by `cat`; nothing visible. |
| 22 | [gradually-core #323](https://github.com/jrey8343/gradually-core/pull/323) | [11-14 21:03](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43640113276-1-review.jsonl.gz) → 11-14 21:20 | hard rule | [hard] `readPulledAt` checks with `typeof`/`Date.parse` and keeps the string | 1 Not read | Its own `| head -220` stopped `bucket.ts`'s diff just before the function. |
| 23 | [gradually-core #323](https://github.com/jrey8343/gradually-core/pull/323) | [11-14 21:03](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43640113276-1-review.jsonl.gz) → 11-14 21:20 | judgement rule | [judgement] the pulled-at instant is a bare `string` | 1 Not read | The signatures are past the same `head -220` cut. |
| 24 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:02](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43706255282-1-review.jsonl.gz) → 11-15 11:18 | test | The race test opens the competing record too early, so the conflict retry never runs | 2 Read, not noticed | Saw the test; its checked list says the record "wins the race (D15 retry …)". |
| 25 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:02](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43706255282-1-review.jsonl.gz) → 11-15 11:18 | behaviour | `booked-ahead.ts:20` computes 14 days as 14×24 h, wrong across a daylight-saving change | 2 Read, not noticed | Saw the line, and named another flaw in the same function. |
| 26 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:02](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43706255282-1-review.jsonl.gz) → 11-15 11:18 | behaviour | `makeKey`'s result is discarded when Open file wins the race | 2 Read, not noticed | Saw the line; its checked list says "its key is made again". |
| 27 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43707385627-1-review.jsonl.gz) → 11-15 11:46 | test | The cross-site test now uses a patient already opened, so it can't fail | 2 Read, not noticed | Saw the removed and added lines; it wrote the changes "have reasons in the PR body". |
| 28 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43707385627-1-review.jsonl.gz) → 11-15 11:46 | test | The "Avery Synthetic" check was dropped when it could have moved | 3 Noticed, not reported | Grepped for it and wrote that the dropped check "is still covered by the clinic app's own Open file tests". |
| 29 | [gradually-core #363](https://github.com/jrey8343/gradually-core/pull/363) | [11-15 11:18](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43707385627-1-review.jsonl.gz) → 11-15 11:46 | hard rule | [hard] `throw new Error` for an invariant instead of `assert` | 2 Read, not noticed | Saw this and the `assert` in Open file it is compared with; it wrote that it makes the key the way Open file does. |
| 30 | [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | [11-15 11:05](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43706360272-1-review.jsonl.gz) → 11-15 11:24 | body | The body says a broken connection is checked first, but `prepare` reads cases before it | 2 Read, not noticed | Body in the prompt; it `cat`'d the file and saw the order. Its first finding was another body claim about the same block. |
| 31 | [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | [11-15 11:05](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43706360272-1-review.jsonl.gz) → 11-15 11:24 | behaviour | A confirmed send with a null note id writes no AMENDED line later | 2 Read, not noticed | Saw the three domain pieces; the adapter's `noteIdOf` wasn't seen. |
| 32 | [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | [11-15 11:24](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43708025105-1-review.jsonl.gz) → 11-15 11:49 | behaviour | `decideStart` lets a resend through on `isResendAfterReadBack` alone | 2 Read, not noticed | Saw the line; nothing visible. |
| 33 | [gradually-core #364](https://github.com/jrey8343/gradually-core/pull/364) | [11-15 11:24](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43708025105-1-review.jsonl.gz) → 11-15 11:49 | test | The property test accepts any resend of the open revision | 1 Not read | The 91 KB diff holding the tests was saved to a file and never Read; only the test's name surfaced, by grep. |
| 34 | [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | [11-14 22:16](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43646582757-1-review.jsonl.gz) → 11-14 22:41 | behaviour | `open-file.ts:119` turns Nookal not answering into an unknown patient | 2 Read, not noticed | Saw the line; its checked list says Open file works through read-patient. |
| 35 | [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | [11-14 22:16](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43646582757-1-review.jsonl.gz) → 11-14 22:41 | test | No test for an unknown or unavailable non-diary patient | 2 Read, not noticed | Read the whole test hunk; nothing visible. |
| 36 | [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | [11-14 22:16](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43646582757-1-review.jsonl.gz) → 11-14 22:41 | test | The "writes nothing" test checks two subjects for one patient | 2 Read, not noticed | Saw the test; its checked list says "the log-unchanged test covers it". |
| 37 | [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | [11-14 22:16](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43646582757-1-review.jsonl.gz) → 11-14 22:41 | judgement rule | [judgement] `PatientSearchResult.pmsPatientId` typed `string` | 2 Read, not noticed | Saw the field. It named the same rule for another bare `string`. |
| 38 | [gradually-core #328](https://github.com/jrey8343/gradually-core/pull/328) | [11-14 22:41](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43648525383-1-review.jsonl.gz) → 11-14 23:07 | comment/doc | `patient-record.md` workflow 1 still describes the diary-only open | 1 Not read | Not in the diff and never opened, though it saw two pointers to it. |
| 39 | [gradually-core #357](https://github.com/jrey8343/gradually-core/pull/357) | [11-15 08:57](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43695742517-1-review.jsonl.gz) → 11-15 09:16 | comment/doc | `identity.md` workflow 1 has a sentence spliced mid-paragraph | 1 Not read | Its own `cut -c1-400` cut the line before the splice. |
| 40 | [gradually-core #379](https://github.com/jrey8343/gradually-core/pull/379) | [11-15 22:13](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/gradually-core/2026-11/43766288687-1-review.jsonl.gz) → 11-15 22:36 | unmeetable | Criterion 3: pnpm prints banners before the path, so the command can't print "exactly the path" | 2 Read, not noticed | Built a scratch workspace to test this; `pnpm` wasn't on PATH, it didn't retry, and it called the scripts sound. The later Review used `corepack`. |
| 41 | [Penrith #84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | [11-07 06:25](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42345419799-1-review.jsonl.gz) → 11-07 06:59 | test | The booking-link test covers only ankle-sprain; nothing exercises `externalBooking` | 2 Read, not noticed | Saw the test; its result text says "including the `externalBooking` case". |
| 42 | [Penrith #84](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/84) | [11-07 06:59](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42348206248-1-review.jsonl.gz) → 11-07 07:38 | behaviour | The structured page drops ankle-sprain's "Common symptoms" card | 2 Read, not noticed | Saw the `!structured &&` guard and the frontmatter; nothing visible about symptoms. |
| 43 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 09:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42594981942-1-review.jsonl.gz) → 11-09 11:01 | criterion | Hamstring's Assessment left in the body | 3 Noticed, not reported | Its checked list names it and calls keeping it "defensible". |
| 44 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 09:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42594981942-1-review.jsonl.gz) → 11-09 11:01 | criterion | Osgood-Schlatter's Management subsections left in the body | 3 Noticed, not reported | Printed the body to check; called it "defensible". |
| 45 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 09:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42594981942-1-review.jsonl.gz) → 11-09 11:01 | criterion | Shoulder labral tear's treatment sections left in the body | 3 Noticed, not reported | Printed the body to check; called it "defensible". |
| 46 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 09:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42594981942-1-review.jsonl.gz) → 11-09 11:01 | criterion | Piriformis's and FAI's lists left in the body | 2 Read, not noticed | FAI's sections were seen and called defensible. Piriformis's list showed only as three context lines, and it never named it. |
| 47 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 09:55](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42594981942-1-review.jsonl.gz) → 11-09 11:01 | body | The body's account of what moved must follow 1–4 | 3 Noticed, not reported | It accepted the body's reasons along with the sections. |
| 48 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 11:01](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42603269570-1-review.jsonl.gz) → 11-09 13:52 | criterion | ACL's Injury Mechanism list left in the body | 2 Read, not noticed | Printed ACL's body to check what stayed; nothing visible about ACL. |
| 49 | [Penrith #116](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/116) | [11-09 11:01](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42603269570-1-review.jsonl.gz) → 11-09 13:52 | body | The body calls ACL's section prose and omits the list | 2 Read, not noticed | Body in the prompt, section seen; nothing visible. |
| 50 | [Penrith #117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | [11-09 20:08](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42687131268-1-review.jsonl.gz) → 11-09 20:57 | criterion | Whiplash's "Prevention of Chronic Pain" list left in the body | 1 Not read | Saw hunks for 2 of 28 files. The rest it checked by script, which never printed this list. |
| 51 | [Penrith #117](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/117) | [11-09 20:08](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42687131268-1-review.jsonl.gz) → 11-09 20:57 | criterion | Lower back pain's "Our Assessment Approach" list left in the body | 1 Not read | As above. |
| 52 | [Penrith #122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | [11-09 19:03](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42679096674-1-review.jsonl.gz) → 11-09 19:49 | behaviour | The sidebar loses "Online booking takes <60 seconds" | 2 Read, not noticed | Saw the removed ternary and reported its other half. |
| 53 | [Penrith #122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | [11-09 19:49](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42684732141-1-review.jsonl.gz) → 11-09 20:20 | behaviour | `<dl class="svc-faq-list">` around `<details>` is an axe violation on every service page | 1 Not read | Read `[slug].astro` only to line 170; the markup is at 248. The axe result naming it entered the body after this Review. |
| 54 | [Penrith #122](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/122) | [11-09 19:49](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42684732141-1-review.jsonl.gz) → 11-09 20:20 | test | The accessibility suite tests no service page | 2 Read, not noticed | Printed the page list and concluded the failures were on pages the PR doesn't touch. |
| 55 | [Penrith #110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | [11-09 19:37](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42682384939-1-review.jsonl.gz) → 11-09 20:06 | test | A rewritten test asserts only `length > 0` and not-5 | 2 Read, not noticed | Saw the removed exact asserts and the new ones; its checked list says "without weakening what they assert". |
| 56 | [Penrith #110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | [11-09 19:37](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42682384939-1-review.jsonl.gz) → 11-09 20:06 | body | The body says the cases were rewritten "with the same assertions" | 2 Read, not noticed | Its checked list says the body matches the branch. |
| 57 | [Penrith #110](https://github.com/jrey8343/penrith-physiotherapy-sports-centre/pull/110) | [11-09 19:37](https://github.com/jrey8343/fabrik-runs/blob/main/transcripts/jrey8343/penrith-physiotherapy-sports-centre/2026-11/42682384939-1-review.jsonl.gz) → 11-09 20:06 | test | The round-trip test never asserts `pensionApplied` is true | 2 Read, not noticed | Saw the assert, and grepped `pension` in the file; nothing visible. |

## Against the expectation that Reviews stop early

Counted:

- **No earlier Review ran out of anything.** The longest took 118 s of 1,800, none hit an error, and nothing caps turns. Each ended when the model wrote its Verdict.
- **Reading was mostly complete.** 22 of the 28 saw every substantive file's hunks. 44 of the 57 misses were in what the Review saw.
- **About half of the read misses are positive misjudgements, not omissions.** In 19 of the 39 category-2 findings, the earlier Verdict's own checked list says the thing the later Verdict flags is sound. A Review that stopped short would leave such a thing unmentioned; these mention it and call it sound.

Consistent with stopping once the Verdict was a fail, but not shown:

- The earlier Verdicts named 1 to 5 findings each (median 2.5). In 5 category-2 cases, a Review flagged a rule or a change at one site and not at another site it had seen. That could be "one instance is enough to fail it", or it could be a miss. With thinking redacted, the transcripts don't say.

## Three telling examples

1. **It searched for the problem and called it sound.** [gradually-core #379](https://github.com/jrey8343/gradually-core/pull/379), 22:13.
   - The earlier Review built a scratch pnpm workspace to test whether pnpm's banner reaches stdout before the path. That is exactly the later Verdict's criterion finding.
   - It got `pnpm: command not found`, didn't retry, and wrote that the scripts were sound.
   - The next Review used `corepack` on the same runner and found the banner.
2. **It read the rename and wrote the opposite.** [gradually-core #271](https://github.com/jrey8343/gradually-core/pull/271).
   - Both earlier Reviews saw `-Sid: "OnlyItsReaderReadsIt"` / `+Sid: "OnlyItsReadersReadIt"` in diffs they read in full.
   - Both wrote that existing policies were unchanged.
   - The third Verdict named the rename, and the Ticket went back to design.
3. **The Review's own trimming hid the flaw.** [gradually-core #323](https://github.com/jrey8343/gradually-core/pull/323), 21:03.
   - It piped `bucket.ts`'s diff through `| head -220`, which cut just before `readPulledAt`.
   - Both of the next Verdict's standards findings are about that function. The Review had 29 minutes left.

## Readings that would move the counts

- **#379 (row 40), and #271 and #363 (rows 3 and 27), could be read as 3.** Each Review ran a search aimed at the problem, or wrote something close, but its visible text doesn't name the problem. Read that way, category 3 would be 8 and category 2 36.
- **The four Penrith #116 recodes could go back to 2**, if "noticed" is read strictly as "noticed it was a problem". That makes category 3 one.
- **Penrith #122's `<dl>` finding (row 53) could be 4.** The markup was in the file at the earlier head, but past the 170 lines the Review read. The axe result the later Verdict leans on entered the PR body at 20:01 UTC, after the 19:49 Review, by GraphQL `userContentEdits`. A Reviewer can't run axe. Read that way, category 4 would be 1.
- **#322's doc finding (row 18) is mixed.** `identity.md` was never opened, while ADR 0019 was in the prompt. It is counted as 1.

So category 1 is 12 or 13, category 2 is 36 to 43, category 3 is 1 to 8, and category 4 is 0 or 1. The headline holds under every reading: most misses were read, and none were for want of time or turns.

## What is not established

- **Why a Review that saw the code didn't flag it.** Thinking is redacted, so the line between categories 2 and 3 is drawn on visible text alone. A Review that weighed a problem in its thinking and dropped it counts here as 2.
- **Whether the Reviews stop on purpose after enough findings to fail.** Nothing in the visible record says so or rules it out.
- **Whether a slower or longer Review would have found more.** None of these Reviews was cut short, and no run here varied effort or time. The records show `effort: null`: the Kit passed no `--effort`, so the CLI's default applied. I didn't confirm what that default is.
- **Whether the later Verdicts are right.** Each finding is taken as the later Verdict states it, as the prior note did.
- **What was in each prompt.** The transcripts don't hold the prompt. Its contents are inferred from `src/agent/review.ts` and `prompts/review.md` at the Kit's commits in the window, all of which descend from a5c51ae.
- **Body history.** I checked it for only one finding (row 53).
- **One classification, made once**, by four readers on one rubric, with a spot-check of their greps.

## Sources

- **Review records and transcripts:** `jrey8343/fabrik-runs`, `runs/jrey8343/<repo>/2026-11/*-review.json` and the `transcripts/` files they name. Fields used:
  - `durationMs`, `num_turns`, `terminalReason`, `subtype`, `permissionDenials`, `apiRetries`;
  - the tool calls, tool results and `tool_use_result` metadata (`persistedOutputPath`, `numLines`, `totalLines`, `truncatedByTokenCap`);
  - `thinking_duration_ms`.
- **The Actions run of one Review** (gradually-core run 43535252486): "Run the Reviewer" took 60 s, matching the record.
- **The prompt:** `prompts/review.md`; `src/agent/review.ts` (it appends `CODING_STANDARDS.md` in full); `src/agent/launch.ts` (no `--max-turns`, and `--effort` only when set); `src/kit/config.ts` (Reviewer timeout 30 minutes).
- **Repo config:** gradually-core's `.fabrik/config.json` and `.fabrik/review.md`, and Penrith's `.fabrik/config.json` (review: Opus 5.5, `effort: null`, 30 minutes).
- **`CODING_STANDARDS.md` history:** `GET /repos/jrey8343/gradually-core/commits?path=CODING_STANDARDS.md`.
- **The prior note's appendix**, for which findings are (a) and their kinds: `docs/research/execution-flaw-findings.md` on `origin/research/execution-flaw-findings`.
- **Terms:** `GLOSSARY.md`.
