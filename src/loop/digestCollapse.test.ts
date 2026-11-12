import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { digestCommentOf, digestMarkIn, noDigestIn } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
const EARLIER_HEAD = "b".repeat(40);

/** A reply that keeps its shape. */
const REPLY = {
  whatItDoes: "Shoppers can save a cart and come back to it.",
  howItGotHere: "One Review, which passed.",
  walkthrough: "Start at `src/cart.ts`.",
  decided: "- Prices hold for a day.",
};

type Written = Extract<LoopEvent, { kind: "digest-run-finished" }>;

/** The Digest writer finished on #50 at the head its pass was given on. */
function written(overrides: Partial<Written> = {}): Written {
  return {
    kind: "digest-run-finished",
    pullRequest: 50,
    headSha: HEAD_SHA,
    output: JSON.stringify(REPLY),
    given: { repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
    runUrl: RUN,
    ...overrides,
  };
}

type DigestOnThread = PullRequestSnapshot["digests"][number];

/** A Digest already on #50's thread, written as of `head`, not yet collapsed unless a test says so. */
function aDigestOnThread(node: string, overrides: Partial<DigestOnThread> = {}, head: string = EARLIER_HEAD): DigestOnThread {
  const rendered = digestCommentOf(REPLY, { repoUrl: REPO, pullRequest: 50, headSha: head, runUrl: RUN });
  if (!rendered.ok) throw new Error(rendered.refused);
  return { node, minimized: false, body: rendered.body, postedAt: "2026-11-10T09:00:00Z", ...overrides };
}

/** #50 as a pass leaves it with the Digest on, with these Digests already on its thread. */
function aPassedDraft(digests: readonly DigestOnThread[], overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    draft: true,
    leftDraftSinceVerdict: false,
    labels: ["agent:digest"],
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    digests,
    ...overrides,
  });
}

function landedOn(pullRequest: PullRequestSnapshot, event: Written = written()): Plan {
  return planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** What the plan does, in order: each comment by what it is, each other action by its kind. */
function stepsOf(plan: Plan): string[] {
  return actionsOf(plan).map((action) => {
    if (action.kind !== "comment") return action.kind;
    if (digestMarkIn(action.body) !== null) return "post the Digest";
    return noDigestIn(action.body) !== null ? "post the no-Digest line" : "comment";
  });
}

function collapsedBy(plan: Plan): Action[] {
  return actionsOf(plan).filter((action) => action.kind === "minimize-comment");
}

describe("The Digest: older Digests are collapsed as outdated", () => {
  it("a second Digest collapses the first as outdated, after it is posted and before the gate opens", () => {
    const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first")]));

    expect(collapsedBy(plan)).toEqual([{ kind: "minimize-comment", pullRequest: 50, node: "IC_first", classifier: "OUTDATED" }]);
    expect(stepsOf(plan)).toEqual(["post the Digest", "minimize-comment", "remove-label", "mark-ready-for-review", "request-review"]);
  });

  it("with two older Digests, one collapsed already, only the other is collapsed", () => {
    const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first", { minimized: true }), aDigestOnThread("IC_second")]));

    expect(collapsedBy(plan)).toEqual([{ kind: "minimize-comment", pullRequest: 50, node: "IC_second", classifier: "OUTDATED" }]);
  });

  it("every older Digest not yet collapsed gets its own call, oldest first", () => {
    const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first"), aDigestOnThread("IC_second"), aDigestOnThread("IC_third")]));

    expect(collapsedBy(plan).map((action) => (action.kind === "minimize-comment" ? action.node : null))).toEqual(["IC_first", "IC_second", "IC_third"]);
    expect(stepsOf(plan).slice(0, 5)).toEqual(["post the Digest", "minimize-comment", "minimize-comment", "minimize-comment", "remove-label"]);
  });

  // The label on a head that has a Digest writes a second one for it: the newest wins.
  it("an earlier Digest for the same head is collapsed too", () => {
    const plan = landedOn(aPassedDraft([aDigestOnThread("IC_same_head", {}, HEAD_SHA)]));

    expect(collapsedBy(plan)).toEqual([{ kind: "minimize-comment", pullRequest: 50, node: "IC_same_head", classifier: "OUTDATED" }]);
  });

  it("the first Digest on a pull request collapses nothing", () => {
    expect(stepsOf(landedOn(aPassedDraft([])))).toEqual(["post the Digest", "remove-label", "mark-ready-for-review", "request-review"]);
  });

  // The Operator added the label at the Merge gate: the Digest is posted, the older one is collapsed, and nothing else moves.
  it("a Digest that lands on a pull request already at the Merge gate still collapses the older one", () => {
    const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first")], { draft: false, leftDraftSinceVerdict: true }));

    expect(stepsOf(plan)).toEqual(["post the Digest", "minimize-comment", "remove-label"]);
  });

  describe("nothing is collapsed when no Digest is posted", () => {
    it("a reply Kit code refuses posts the no-Digest line and leaves the older Digest as it is", () => {
      const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first")]), written({ output: JSON.stringify({ ...REPLY, walkthrough: "" }) }));

      expect(stepsOf(plan)).toEqual(["post the no-Digest line", "remove-label", "mark-ready-for-review", "request-review"]);
    });

    it("a failed Digest run posts the no-Digest line and leaves the older Digest as it is", () => {
      const failed: LoopEvent = {
        kind: "agent-run-failed",
        role: "digest",
        issue: 7,
        runUrl: RUN,
        jobResult: "failure",
        secretsStep: "success",
        report: null,
        digest: { pullRequest: 50, headSha: HEAD_SHA },
      };
      const pullRequest = aPassedDraft([aDigestOnThread("IC_first")]);
      const plan = planFor(failed, snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest, operator: "jrey" }), kitConfig());

      expect(stepsOf(plan)).toEqual(["post the no-Digest line", "remove-label", "mark-ready-for-review", "request-review"]);
    });

    it("a dropped Digest, for a head the pull request has moved on from, collapses nothing", () => {
      const plan = landedOn(aPassedDraft([aDigestOnThread("IC_first")], { headSha: "c".repeat(40) }));

      expect(stepsOf(plan)).toEqual(["remove-label"]);
    });
  });
});
