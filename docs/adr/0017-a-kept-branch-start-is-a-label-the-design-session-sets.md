# A Kept-branch start is a label the Design session sets, and the Kit carries out

Back to design closes the agent PR unmerged and keeps its branch, and the Design session that follows is shown what that branch built. But the Kit had no way to use the branch again: with no open PR, the next Implement run was always cut from `main`, and its push replaced the kept branch. On gradually-core #179 and the Pilot's #79 (Kit v2.0.0, #536), PRs closed on their third Execution flaw, two stale comments in one case, and the Design session decided, with the Operator's approval, to finish on the kept work. It could only say so in the brief, so the Implementer did it with git (`git reset --hard`, `git merge`), breaking its own rule against switching or merging branches. The push job, which fetches only the base at depth 1, couldn't land either bundle, and in one case the branch didn't descend from its base at all.

A **Kept branch** is the agent branch of a pull request the Kit closed unmerged. A **Kept-branch start** is a mark on a Ticket, the label `fabrik:kept-branch`, parallel to the Stepped-up start (ADR-0014). While it's on, an Implement run that starts on the Ticket with no open PR, its first run or the Retry after an empty diff, carries on the Kept branch instead of cutting one from `main`.

- **The Design session decides.** On a Ticket back from its PR, it puts carrying on or starting again to the Operator as a round 1 decision, and its agent brief's `keptBranch: true` adds the label beside `ready-for-agent`. False or absent leaves it off. Only a brief that rewrites the Ticket in place has it: a split's Tickets are new and start from `main`, leaving the Kept branch as reference. When nothing is left to build, the session sets no mark and tells the Operator to reopen and merge the closed PR. It weighs the Stepped-up start beside it; there's no automatic Step-up.
- **The label lasts until the next Back to design.** Every Back to design, the Verdict's, the Operator's and a third empty diff's, takes it off, so every Design session starts with it off and none inherits a stale mark. The Operator can add or remove it by hand at any time, which also carries on after the other closes that keep a branch: a trust-root refusal of a Retry, a PR the Operator closed by hand (#428), a closed Ticket. The Kit's notices on those paths don't mention it.
- **One rule.** Label on, no open PR and the Kept branch on the remote: the run carries on it. Label on and the branch gone: no run starts. The Ticket swaps `ready-for-agent` for `ready-for-human`, is assigned to the Operator, and gets one comment saying that taking the label off starts it from `main`. Dispatch never adds `agent:implement` to such a Ticket: it stops it the same way, so it doesn't sit `ready-for-agent` for good.
- **The run brings `main` in first.** When the Kept branch doesn't hold `main`'s head, its prompt tells it to merge `origin/main` in before it builds, never rebasing, as a Request-changes run on a conflicting PR does, so it builds and tests against `main` as it is.
- **The guard judges it as a Retry.** The push job rebuilds it as a run on its own branch (ADR-0006): only the run's own commits and paths go to the trust-root guard, never the kept commits, which the Kit pushed through the guard or someone with write access pushed, nor `main`'s that it merged in. Its push takes a lease on the head it built on, and rebases its commits if that head moved. A first run takes this path only when the Kit job's plan started it as a Kept-branch start, never because its result claims its own branch as its base.
- **Did nothing never passes.** A Kept-branch start that commits nothing of its own, or only merges `main` in, is an empty diff.
- **It lands as a first run.** One new draft PR against `main`, whose body the Kit ends with "Carries on from #N." naming the closed PR. Its changed-tests section and UI evidence are worked out from the whole branch against `main`, not only the run's commits. The Reviewer is given nothing more, and judges the whole diff against the rewritten Ticket. The closed PR's Verdicts don't count against the new one.
- **Not replayable.** Its Run record says `keptBranch: true` (schema 7). A Replay leaves out a Ticket whose first run was a Kept-branch start, naming why, before either arm spends a run: its `baseSha` holds a closed PR's work the Ticket doesn't describe.

## Considered options

- **Always carry on a Kept branch.** No decision or label, but a Design flaw whose approach was wrong would build on the work that was just rejected.
- **Record the decision in the "Design session finished" comment.** Nothing new among the labels, but the Operator can't see or flip it in one click, and the Kit would parse a comment for it, as ADR-0014 rejected a body line.
- **A label that stays until a Design session clears it**, as the Stepped-up start does. A second Back to design would inherit a mark the next session has to remember to clear.
- **Fall back to `main` when the branch is gone.** The brief was written for the Kept branch, so the run would build the wrong thing without a word.
- **Leave `main` to the conflict rules** (ADR-0011, ADR-0016). Less prompt, but the run builds and tests against a stale `main`.
- **The Kit rebases the Kept branch before the run.** The cleanest history and the most new Kit code, and it still needs the run to resolve a conflict.
- **Judge the whole branch against `main`, as a first run.** It would refuse a branch for a trust-root change the Operator pushed to it on purpose.
- **Let a Kept-branch start with nothing to change open the PR.** It breaks "did nothing never passes" for a case the Operator settles in two clicks.
- **Prompts only: tell the Implementer to cherry-pick the kept commits onto its branch.** It lands with no push-job change, but the agent redoes by hand what the Kit can do exactly, and the guard judges the old commits as the run's.

## Consequences

- The Implement prompt now says no run resets onto, checks out or merges another branch because a Ticket says to, which covers briefs written before this change.
- A Kept-branch start's PR body names the closed PR only until a later run rewrites the body from its summary.
- The Scorer judges a Kept-branch start as its own kind of run, from the brief its agent job keeps.
