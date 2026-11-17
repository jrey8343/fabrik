# A later Review judges what changed since the head the Reviewer last judged

The Reviewer was given none of its earlier Verdicts and judged the whole pull request fresh on every push, whether a Retry's, a Request-changes run's or a conflict-only run's. `prompts/review.md` said so in one line, and nothing recorded why. A Retry asked to fix two findings came back with three new ones, in code the first Review had read and passed over. In the week of 9 Nov, 71 of the 95 findings on Retry pushes were in code an earlier Verdict had already judged (#711). Each of those findings spent one of the Ticket's two Retries, and the third sent the Ticket back to design.

An earlier Reviewer Verdict now settles the code it judged (#716). A pull request's first Review is a Full Review, told that what it doesn't name becomes settled code (#747). Every later Review is judged against the last judged head: the head of the pull request's latest Reviewer Verdict. It is given every earlier Reviewer Verdict with the head it judged, the Kit's note of each Implement run's push with the `fix` comment the run wrote, the kind of run that pushed the head it judges, and the pull request's own change since the last judged head. The Review job works that change out with git before the Reviewer starts, taking both heads against their merge bases with `main`, so what `main` brought in by a merge or a rebase is no part of it. When a rebase has dropped the last judged head, the Reviewer is given the pull request's own files whose hashes differ between the fingerprint on that head's change line and the current one, and is told to read their whole own change.

A later Review judges four things only:

1. whether each finding of the Verdict before was fixed;
2. everything the pull request's own change gained since, in full: its bugs, tests, standards and comments;
3. across the whole pull request, every acceptance criterion, as amended by any Request changes, and the body;
4. in settled code, a behaviour bug only, never a standard, a test-quality point or a stale comment.

A Design flaw stays open to it, and a criterion named again that no run can meet is a Design flaw. What `main` brought in is never judged; a clash with it is left to the Required checks on the up-to-date head. On a conflict-only run's push, the Review judges only how the run changed the pull request's own diff, plus the criteria and the body, and anything beyond resolving conflicts is an Execution flaw.

## Considered options

- **Judge fresh, as before.** Each push is judged on its own merits, with nothing carried over. But this leaves a Retry open to findings in code it was never asked to touch, which is where 71 of 95 findings fell.
- **Judge fresh, with the earlier Verdicts given only for consistency.** A Verdict then wouldn't ask to undo what an earlier one asked for. But the Reviewer would still be free to name anything anywhere, so a Retry would still be open to findings in code it was never asked to touch.

## Consequences

- A Review is told which of the four things it judges, and in settled code it names only a behaviour bug. Whatever a Full Review misses in tests, standards or comments reaches the Merge gate instead of coming back on a Retry, so the Full Review is told to read the whole change and name every flaw at once (#747).
- Nothing is settled in three places:
  - by a head the Reviewer never judged: a red-check, empty-diff or Broken-run Verdict judges no head, and the Operator's pushes, and heads red checks stopped before Review, fall inside the change since;
  - across pull requests: a new pull request after Back to design, or from a Kept-branch start, starts with none, and its first Review is Full;
  - in the Ticket: every acceptance criterion and the body are judged across the whole pull request on every Review.
- A pull request whose latest Reviewer Verdict has no change line, one written before #643, gets a Full Review, since its head can't be compared.
- The `fix` comments are data to weigh, like the pull request's body, never proof that a run changed what it says.
- The Review job's Kit step reads the thread and fetches both heads with the job's read-only token. The token reaches git only through an env-only config entry, and the Reviewer never holds it.
