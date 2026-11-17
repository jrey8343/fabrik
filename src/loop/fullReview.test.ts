// Which kind of Review the Kit starts (#747): a Full Review when the Reviewer
// has judged none of the pull request's earlier heads, else a later Review,
// judged against the last judged head. Read from the Verdict markers alone.
import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import type { ChangeFingerprint } from "./changeFingerprint.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan, PullRequestSnapshot, VerdictRecord } from "./types.ts";

const FIRST_HEAD = "1".repeat(40);
const SECOND_HEAD = "2".repeat(40);

/** The fingerprint a change line under a Verdict carries (#643). */
const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa" } };

/** A Verdict on an earlier head, with the change line every Verdict since #643 carries. */
function earlier(source: VerdictRecord["source"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict: "execution-flaw", source, requestChanges: false, headSha: FIRST_HEAD, change: CHANGE, ...overrides };
}

/** The Review a push to this pull request starts. */
function reviewStartedOn(pullRequest: PullRequestSnapshot): Extract<Action, { kind: "start-agent-run" }> {
  const plan: Plan = planFor({ kind: "pull-request-pushed", pullRequest: pullRequest.number }, snapshotOfPullRequest(pullRequest), kitConfig());
  const started = plan.kind === "act" ? plan.actions.find((action) => action.kind === "start-agent-run") : undefined;
  if (started?.kind !== "start-agent-run" || started.role !== "review") throw new Error(`expected a Review to start, got ${JSON.stringify(plan)}`);
  return started;
}

/** A Retry's push after these Verdicts, which starts the next Review. */
const pushedAfter = (...verdicts: VerdictRecord[]) => aPullRequest({ verdicts, pushedSinceVerdict: true });

describe("A Review is started as a Full Review or a later Review (#747)", () => {
  it("a pull request's first Review is a Full Review", () => {
    expect(reviewStartedOn(aPullRequest()).reviewKind).toEqual({ kind: "full" });
  });

  it("a Review after a Reviewer Verdict with a change line is a later Review, judged against that Verdict's head", () => {
    expect(reviewStartedOn(pushedAfter(earlier("reviewer"))).reviewKind).toEqual({ kind: "later", lastJudged: { headSha: FIRST_HEAD, change: CHANGE } });
  });

  it("the last judged head is the latest Reviewer Verdict's, past any red-check Verdict after it", () => {
    const verdicts = [earlier("reviewer"), earlier("reviewer", { headSha: SECOND_HEAD }), earlier("ci", { headSha: "3".repeat(40) })];

    expect(reviewStartedOn(pushedAfter(...verdicts)).reviewKind).toEqual({ kind: "later", lastJudged: { headSha: SECOND_HEAD, change: CHANGE } });
  });

  it.each([
    ["red required checks", [earlier("ci")]],
    ["an empty diff", [earlier("empty-diff")]],
    ["a Broken run", [earlier("broken-run")]],
    ["red checks, an empty diff and a Broken run", [earlier("ci"), earlier("empty-diff", { headSha: SECOND_HEAD }), earlier("broken-run", { headSha: SECOND_HEAD })]],
  ])("a Review whose only earlier Verdicts are from %s is a Full Review: they judge no head", (_, verdicts) => {
    expect(reviewStartedOn(pushedAfter(...verdicts)).reviewKind).toEqual({ kind: "full" });
  });

  it("a Review whose latest Reviewer Verdict has no change line, one written before #643, falls back to a Full Review", () => {
    const { change: _, ...beforeChangeLines } = earlier("reviewer", { headSha: SECOND_HEAD });

    expect(reviewStartedOn(pushedAfter(earlier("reviewer"), beforeChangeLines)).reviewKind).toEqual({ kind: "full" });
  });

  // A pull request's Verdicts are read from its own comments, so none carries across from the one the Kit closed:
  // the new pull request after Back to design, or from a Kept-branch start on that one's Kept branch, starts with none.
  it("the first Review on a new pull request for a Ticket sent back to design, or from a Kept-branch start, is a Full Review", () => {
    const started = reviewStartedOn(aPullRequest({ number: 61, url: "https://github.com/acme/shop/pull/61" }));

    expect(started.issue).toBe(61);
    expect(started.reviewKind).toEqual({ kind: "full" });
  });

  it("agent:review added to a pull request starts its Review as the same kind a push does", () => {
    const pullRequest = aPullRequest({ labels: ["agent:review"], verdicts: [earlier("reviewer")], pushedSinceVerdict: true });
    const plan = planFor({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:review" }, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "review", reviewKind: { kind: "later", lastJudged: { headSha: FIRST_HEAD } } }] });
  });
});
