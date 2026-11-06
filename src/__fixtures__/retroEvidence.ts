// Small builders for the Retro evidence bundle's tests, beside the Weekly
// summary's record and GitHub-facts builders (./weeklySummary.ts) that the
// bundle's tests build its facts with: say only what a test cares about.
import type { CommentFacts, RetroEvidenceInput } from "../kit/retroEvidence.ts";
import { followUpsSection } from "../loop/followUps.ts";
import { verdictActions } from "../loop/review.ts";
import type { Verdict } from "../loop/types.ts";
import type { FollowUp } from "../loop/verdict.ts";
import { aPullRequest } from "./snapshots.ts";
import { aComment, factsOf } from "./weeklySummary.ts";

/**
 * What a Retro reads of `owner/product` for the window from the last Retro's
 * end, Saturday 2026-10-31 00:00 UTC, to this one's a week later: nothing,
 * unless a test says so.
 */
export function aRetroEvidenceInput(overrides: Partial<RetroEvidenceInput> = {}): RetroEvidenceInput {
  return {
    records: [],
    facts: factsOf(),
    operator: "operator",
    lastWindowEnd: "2026-10-31T00:00:00Z",
    windowEnd: "2026-11-07T00:00:00Z",
    ...overrides,
  };
}

/**
 * The Fabrik App's Verdict comment on PR `pullRequest` at `at`, as the Loop
 * posts it (src/loop/review.ts), listing these Follow-ups after its findings
 * whatever the Verdict; a person's quote of one with `{ author, byBot: false }`.
 */
export function aVerdictWithFollowUps(
  verdict: Verdict,
  followUps: readonly FollowUp[],
  at: string,
  pullRequest: number,
  overrides: Partial<CommentFacts> = {},
): CommentFacts {
  const actions = verdictActions(
    { headSha: "a".repeat(40), runUrl: "https://github.com/owner/product/actions/runs/1000/attempts/1" },
    aPullRequest({ number: pullRequest }),
    { verdict, source: "reviewer", findings: "### Checked\n\nThe cart totals its lines.", followUps: followUpsSection(followUps, "https://github.com/owner/product", pullRequest) },
  );
  const comment = actions.find((action) => action.kind === "comment");
  if (comment === undefined) throw new Error("A Verdict always posts its comment");
  return aComment(comment.body, at, overrides);
}
