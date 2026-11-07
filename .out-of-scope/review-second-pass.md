# A second Review pass on high-risk pull requests

Fabrik gives every agent pull request one frontier Reviewer pass before the
Merge gate. It does not mark some pull requests as high-risk and give them a
second pass, whether that's the same Reviewer with a hostile brief, another
model, or a Step-up Reviewer.

## Why this is out of scope

A second pass only pays for itself if passes miss flaws that the Operator then
catches at the Merge gate, and if those misses cluster around something the
Kit can see (diff size, paths touched, Fast path or Spec, UI). The evidence we
have shows no misses at all.

The first baseline (#346) counted 3 of 18 passes, on the Pilot's #59 and #60,
as followed by a Request changes. On reading them, none was a Review miss:

- **#59, "Remove Declan Price as an available provider…"**: a change of mind
  about requirements. The Ticket named Declan as a practitioner and checked for
  his ID in its acceptance criteria, so the pass was right.
- **#59, "rebase"** and **#60, "Rebase for merge conflicts please"**: merge
  conflicts. Conflict-only runs now handle these without a Request changes.

So the real count is 0 of 18. The four-week re-take that was meant to show
whether misses cluster (#360) was closed as not planned. With no misses there
is nothing to key a rule on, and adding a pass to every pull request would add
Review spend (median $0.37 a run on the baseline) for no measured benefit.
ADR-0005 also notes that a hostile pass adds little against a change written
to fool the Reviewer, since the Reviewer is itself steered by a trust-root file.

## When to revisit

Reopen this if Weekly summaries show passes followed by Request changes that
disagree with the Ticket as written, meaning real Review misses, often enough
to see a pattern. Counting those needs Request changes after a pass split into
Review misses and requirement changes (#369).

## Prior requests

- #365: "A rule-based second Review pass on high-risk pull requests"
