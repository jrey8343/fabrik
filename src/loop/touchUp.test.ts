// Touch-ups (#750): a Reviewer's Execution flaw whose findings are all tagged
// small or missed earlier calls for a Touch-up instead of a Retry, from its own
// pool of two, on the same model as the run whose push it judged.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { lastPushStepUpReasonIn, pushedSinceVerdictIn, verdictsIn } from "../github/threads.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The comment a plan posts, the Verdict when it lands one. */
function commentOf(plan: Plan): string {
  const comment = actionsOf(plan).find((action) => action.kind === "comment");
  if (comment?.kind !== "comment") throw new Error("expected a comment");
  return comment.body;
}

/** An earlier Verdict on an older commit, which judged a head pushed since. */
function earlier(verdict: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict, source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides };
}

/** An earlier Reviewer Execution flaw that called for this Touch-up. */
function touchedUp(touchUp: number): VerdictRecord {
  return earlier("execution-flaw", { tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 0 }, touchUp });
}

/** A Reviewer's Execution flaw on the PR's head whose findings are all tagged. */
const ALL_TAGGED = reviewed(
  [
    "verdict: execution-flaw",
    "",
    "- [small: comment] The doc comment on `total()` still says it rounds down.",
    "- [missed earlier] The empty-cart case throws, in code the last Retry didn't touch.",
  ].join("\n"),
);

/** What starts the Implementer again on the PR: agent:implement on its Ticket. */
const IMPLEMENT_TRIGGER: Action = { kind: "add-labels", issue: 7, labels: ["agent:implement"] };

/** The fingerprint under an earlier Reviewer Verdict, which makes its head the last judged one. */
const CHANGE = { v: 1, all: "a1b2c3d4e5f6", product: "a1b2c3d4e5f6", files: { "src/cart.ts": "f".repeat(12) } } as const;

/** The Verdict markers a plan posts. */
function postedBy(plan: Plan): VerdictRecord[] {
  return verdictsPostedIn(actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []))) as VerdictRecord[];
}

/** A PR the Reviewer has judged before, so the next Review is a later one and `[missed earlier]` reads as a tag. */
function laterReviewOf(overrides: Partial<PullRequestSnapshot> = {}, before: readonly VerdictRecord[] = [earlier("execution-flaw")]): PullRequestSnapshot {
  const judged = before.map((record) => (record.source === "reviewer" && record.change === undefined ? { ...record, change: CHANGE } : record));
  return aPullRequest({ verdicts: judged, pushedSinceVerdict: true, ...overrides });
}

describe("An all-tagged Execution flaw calls for a Touch-up", () => {
  it("calls for Touch-up 1 of 2, adds agent:implement to the Ticket, and its marker carries touchUp 1", () => {
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf()), kitConfig());

    expect(actionsOf(plan)).toContainEqual(IMPLEMENT_TRIGGER);
    expect(commentOf(plan)).toContain(
      "Touch-up 1 of 2 starts now, on the same model: the Implementer fixes these findings on the same branch. It uses none of the Ticket's two Retries.",
    );
    expect(postedBy(plan).at(-1)?.touchUp).toBe(1);
  });
});

describe("Which flaws call for a Touch-up", () => {
  const verdictOn = (output: string, pullRequest = laterReviewOf()) => commentOf(planFor(reviewed(output), snapshotOfPullRequest(pullRequest), kitConfig()));

  it("a flaw with any untagged item calls for a Retry as today", () => {
    const plan = planFor(
      reviewed("verdict: execution-flaw\n\n- [small: comment] A stale comment.\n- The empty-cart case throws."),
      snapshotOfPullRequest(laterReviewOf()),
      kitConfig(),
    );

    expect(commentOf(plan)).toContain("Retry 2 of 2 starts now, stepped up:");
    expect(postedBy(plan).at(-1)).not.toHaveProperty("touchUp");
  });

  it("a flaw whose findings aren't items counts", () => {
    expect(verdictOn("verdict: execution-flaw\n\n[small: comment] The comment on `total()` is stale.")).toContain("Retry 2 of 2 starts now");
  });

  it("on a Full Review, a `[missed earlier]` item reads as untagged, so the flaw counts", () => {
    expect(verdictOn("verdict: execution-flaw\n\n- [missed earlier] The empty-cart case throws.", aPullRequest())).toContain("Retry 1 of 2 starts now:");
  });

  it("on a Full Review, small findings alone still call for a Touch-up", () => {
    expect(verdictOn("verdict: execution-flaw\n\n- [small: body] The body says it adds a flag it doesn't.", aPullRequest())).toContain(
      "Touch-up 1 of 2 starts now, on the same model:",
    );
  });

  it("a flaw from red checks never calls for one", () => {
    const plan = planFor(
      { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN },
      snapshotOfPullRequest(laterReviewOf()),
      kitConfig(),
    );

    expect(commentOf(plan)).toContain("Retry 2 of 2 starts now");
  });
});

describe("Touch-ups have a pool of their own", () => {
  it("a Touch-up flaw doesn't count toward the Retries: the next untagged flaw is still Retry 1", () => {
    const plan = planFor(
      reviewed("verdict: execution-flaw\n\n- The empty-cart case throws."),
      snapshotOfPullRequest(laterReviewOf({}, [touchedUp(1)])),
      kitConfig(),
    );

    expect(commentOf(plan)).toContain("Retry 1 of 2 starts now:");
  });

  it("the second all-tagged flaw calls for Touch-up 2 of 2", () => {
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({}, [touchedUp(1)])), kitConfig());

    expect(commentOf(plan)).toContain("Touch-up 2 of 2 starts now, on the same model:");
    expect(postedBy(plan).at(-1)?.touchUp).toBe(2);
  });

  it("a third all-tagged flaw carries no touchUp and calls for the next Retry", () => {
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({}, [touchedUp(1), touchedUp(2)])), kitConfig());

    expect(commentOf(plan)).toContain("Retry 1 of 2 starts now:");
    expect(postedBy(plan).at(-1)).not.toHaveProperty("touchUp");
  });

  it("a third all-tagged flaw sends the Ticket Back to design when the Retries are used up", () => {
    const before = [earlier("execution-flaw"), earlier("execution-flaw"), touchedUp(1), touchedUp(2)];
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({}, before)), kitConfig());

    expect(commentOf(plan)).not.toContain("starts now");
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "add-labels", issue: 7, labels: expect.arrayContaining(["needs-design"]) }));
  });

  it("an all-tagged flaw after Retry 2 still calls for a Touch-up while one is left", () => {
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({}, [earlier("execution-flaw"), earlier("execution-flaw")])), kitConfig());

    expect(commentOf(plan)).toContain("Touch-up 1 of 2 starts now, on the same model:");
    expect(actionsOf(plan)).toContainEqual(IMPLEMENT_TRIGGER);
  });

  it("flaws that called for no run don't count toward the Touch-ups", () => {
    const exempt = [
      earlier("execution-flaw", { requestChangesFirst: [900], touchUp: 1 }),
      earlier("execution-flaw", { ticketNotReady: true, touchUp: 1 }),
    ];
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({}, exempt)), kitConfig());

    expect(commentOf(plan)).toContain("Touch-up 1 of 2 starts now");
  });
});

describe("What goes before a Touch-up", () => {
  it("an unbuilt Request changes goes first (#341)", () => {
    const pullRequest = laterReviewOf({
      unbuiltChangesRequests: [{ review: 900, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
    });
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(commentOf(plan)).toContain("hasn't been built, so it goes first");
    expect(postedBy(plan).at(-1)).not.toHaveProperty("touchUp");
  });

  it("a Ticket no longer ready-for-agent starts nothing (#416)", () => {
    const plan = planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf({ ticketLabels: ["enhancement"] })), kitConfig());

    expect(commentOf(plan)).toContain("#7 is no longer `ready-for-agent`, so no Touch-up starts.");
    expect(actionsOf(plan)).not.toContainEqual(IMPLEMENT_TRIGGER);
    expect(postedBy(plan).at(-1)).toMatchObject({ ticketNotReady: true });
    expect(postedBy(plan).at(-1)).not.toHaveProperty("touchUp");
  });

  it.each([
    ["a Request-changes run's", { requestChangesRun: true }],
    ["a conflict-only run's", { conflictRun: true }],
  ])("an all-tagged flaw on %s push calls for a Touch-up too", (_, overrides) => {
    expect(commentOf(planFor(ALL_TAGGED, snapshotOfPullRequest(laterReviewOf(overrides)), kitConfig()))).toContain("Touch-up 1 of 2 starts now");
  });
});

/** agent:implement added to Ticket #7, whose agent PR is #50. */
const IMPLEMENT_LABELED: LoopEvent = { kind: "label-added", issue: 7, label: "agent:implement" };

/** A PR whose latest Verdict, on its head, called for Touch-up `touchUp`, after these earlier Verdicts. */
function touchUpOwed(overrides: Partial<PullRequestSnapshot> = {}, before: readonly VerdictRecord[] = [], touchUp = 1): PullRequestSnapshot {
  return aPullRequest({ verdicts: [...before, { ...touchedUp(touchUp), headSha: HEAD_SHA }], ...overrides });
}

/** The run agent:implement on the Ticket starts, with these labels on it. */
function startedFor(pullRequest: PullRequestSnapshot, labels: readonly string[] = ["enhancement", "ready-for-agent", "agent:implement"]): Action | undefined {
  const ticket = anIssue({ number: 7, labels: [...labels], openPullRequests: [50] });
  return actionsOf(planFor(IMPLEMENT_LABELED, snapshotOf(ticket, { pullRequest }), kitConfig())).find((action) => action.kind === "start-agent-run");
}

describe("Starting a Touch-up", () => {
  it("agent:implement starts Touch-up 1 on the PR, on the Implementer's model after a first run, and it isn't a Retry", () => {
    const config = kitConfig();

    expect(startedFor(touchUpOwed())).toEqual({
      kind: "start-agent-run",
      role: "implement",
      issue: 7,
      pullRequest: 50,
      model: config.roles.implement.model,
      effort: config.roles.implement.effort,
      timeoutMinutes: config.roles.implement.timeoutMinutes,
      subscription: "Claude token",
      touchUp: 1,
      retryFlaw: HEAD_SHA,
      stepUp: false,
      stepUpReason: null,
    });
  });

  it("after a Retry 1, it runs on the Implementer's model", () => {
    expect(startedFor(touchUpOwed({}, [earlier("execution-flaw")]))).toMatchObject({ model: kitConfig().roles.implement.model, stepUpReason: null });
  });

  it.each([
    ["a Retry 2", "retry"],
    ["a conflict-only run", "conflict-only"],
    ["a Request-changes run", "request-changes"],
    ["a stepped-up Touch-up", "retry"],
  ] as const)("after %s, it runs on the Step-up model with that run's reason", (_, reason) => {
    expect(startedFor(touchUpOwed({ lastPushStepUpReason: reason }))).toMatchObject({
      model: kitConfig().roles.stepUp.model,
      effort: kitConfig().roles.stepUp.effort,
      stepUp: true,
      stepUpReason: reason,
    });
  });

  it("after a Retry 2 that opened the PR, which posted no push note, it still runs on the Step-up model (#464)", () => {
    expect(startedFor(touchUpOwed({ ticketLandedNothing: 2, lastPushStepUpReason: null }))).toMatchObject({
      model: kitConfig().roles.stepUp.model,
      stepUpReason: "retry",
    });
  });

  it("an Operator's push after a stepped-up run's leaves the reason the run's", () => {
    // The snapshot reads the reason from the last run's push note, which an Operator's push doesn't change.
    expect(startedFor(touchUpOwed({ lastPushStepUpReason: "conflict-only", requestChangesRun: false }))).toMatchObject({ stepUpReason: "conflict-only" });
  });

  it("fabrik:step-up on the Ticket steps it up, recorded as marked", () => {
    expect(startedFor(touchUpOwed(), ["enhancement", "ready-for-agent", "agent:implement", "fabrik:step-up"])).toMatchObject({
      model: kitConfig().roles.stepUp.model,
      stepUp: true,
      stepUpReason: "marked",
    });
  });

  it("taking fabrik:step-up off drops it back, though the run whose push it fixes was marked (ADR-0014)", () => {
    expect(startedFor(touchUpOwed({ lastPushStepUpReason: "marked" }))).toMatchObject({ model: kitConfig().roles.implement.model, stepUp: false, stepUpReason: null });
  });

  it("a Touch-up after Retry 2 starts, though the Retries are used up", () => {
    expect(startedFor(touchUpOwed({ lastPushStepUpReason: "retry" }, [earlier("execution-flaw"), earlier("execution-flaw")]))).toMatchObject({
      touchUp: 1,
      stepUpReason: "retry",
    });
  });

  it("Touch-up 2 says which it is", () => {
    expect(startedFor(touchUpOwed({}, [touchedUp(1)], 2))).toMatchObject({ touchUp: 2 });
  });
});

describe("A Touch-up in flight", () => {
  it("leaves a push to the PR without a Review, naming it", () => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(touchUpOwed()), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: `Touch-up 1 of 2 on #50 is still in flight, so ${HEAD_SHA.slice(0, 7)} gets no Verdict: the run's push starts the next Review`,
    });
  });

  it("leaves a Verdict on another head, as one the Operator pushed meanwhile, landing nothing", () => {
    const onB: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: B, output: "verdict: pass", runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
    const plan = planFor(onB, snapshotOfPullRequest(touchUpOwed({ headSha: B })), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "Touch-up 1 of 2 on #50 is still in flight, so bbbbbbb gets no Verdict: the run's push starts the next Review" });
  });

  it("is no longer in flight once its push note lands", () => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(touchUpOwed({ pushedSinceVerdict: true })), kitConfig());

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", role: "review" }));
  });
});

/** The Ticket's agent PR #50, whose thread grows as plans post comments on it, read back as the adapter reads them. */
class Thread {
  readonly comments: string[] = [];
  headSha = HEAD_SHA;

  pullRequest(): PullRequestSnapshot {
    return aPullRequest({
      headSha: this.headSha,
      ticketLabels: ["enhancement", "ready-for-agent"],
      verdicts: verdictsIn(this.comments),
      pushedSinceVerdict: pushedSinceVerdictIn(this.comments),
      lastPushStepUpReason: lastPushStepUpReasonIn(this.comments),
      change: CHANGE,
    });
  }

  plan(event: LoopEvent, snapshot: Snapshot = snapshotOfPullRequest(this.pullRequest())): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    for (const action of plan.kind === "act" ? plan.actions : []) {
      if (action.kind === "comment" && action.issue === 50) this.comments.push(action.body);
    }
    return plan;
  }

  /** The Reviewer's Verdict on the PR's head. */
  reviewed(output: string): Plan {
    return this.plan({ kind: "review-run-finished", pullRequest: 50, headSha: this.headSha, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" });
  }

  /** agent:implement on the Ticket: the run it starts. */
  implement(): Extract<Action, { kind: "start-agent-run" }> {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"], openPullRequests: [50] });
    const started = actionsOf(this.plan(IMPLEMENT_LABELED, snapshotOf(ticket, { pullRequest: this.pullRequest() }))).find((action) => action.kind === "start-agent-run");
    if (started?.kind !== "start-agent-run") throw new Error("expected agent:implement to start a run");
    return started;
  }

  /** The run `started` finishes with these changes; if its plan pushes, the PR is at `to`. */
  finished(started: Extract<Action, { kind: "start-agent-run" }>, changes: BranchChanges, to: string): Plan {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
    const event: LoopEvent = {
      kind: "implement-run-finished",
      runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Fixed the stale comment." }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes,
      fixes: {
        pullRequest: 50,
        headSha: this.headSha,
        runUrl: RUN,
        ...(started.retry === undefined ? {} : { retry: started.retry }),
        ...(started.touchUp === undefined ? {} : { touchUp: started.touchUp }),
        ...(started.retryFlaw === undefined ? {} : { retryFlaw: started.retryFlaw }),
        ...(started.stepUpReason == null ? {} : { stepUpReason: started.stepUpReason }),
      },
    };
    const plan = this.plan(event, snapshotOf(ticket, { pullRequest: this.pullRequest() }));
    if (plan.kind === "act" && plan.actions.some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }
}

const BUILT: BranchChanges = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] };
const NOTHING: BranchChanges = { net: [], commits: [] };
const UNTAGGED = "verdict: execution-flaw\n\n- The empty-cart case throws.";
const SMALL = "verdict: execution-flaw\n\n- [small: comment] The doc comment on `total()` is stale.";

describe("A Touch-up's landing", () => {
  it("one that commits lands as a Retry's push does, its note saying which Touch-up it was", () => {
    const thread = new Thread();
    thread.reviewed(SMALL);

    const plan = thread.finished(thread.implement(), BUILT, B);

    expect(actionsOf(plan)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "edit-issue-body", issue: 50 }));
    const note = thread.comments.at(-1) ?? "";
    expect(note.split("\n")[0]).toBe("<!-- fabrik:touch-up-push 1 -->");
    expect(note).toContain("The Implementer pushed Touch-up 1 of 2 to `fabrik/ticket-7`");
  });

  it("its push gets a later Review, whose Verdict lands", () => {
    const thread = new Thread();
    thread.reviewed(SMALL);
    thread.finished(thread.implement(), BUILT, B);

    const review = actionsOf(thread.plan({ kind: "pull-request-pushed", pullRequest: 50 })).find((action) => action.kind === "start-agent-run");

    expect(review).toMatchObject({ role: "review", reviewKind: { kind: "later" } });
    expect(commentOf(thread.reviewed("verdict: pass\n\nIt handles the empty cart."))).toContain("## Verdict: Pass");
  });

  it("a Touch-up after a stepped-up Touch-up keeps its Step-up reason, read from that one's push note", () => {
    const thread = new Thread();
    // Two flaws spend both Retries; Retry 2 pushes on the Step-up model.
    thread.reviewed(UNTAGGED);
    thread.finished(thread.implement(), BUILT, B);
    thread.reviewed(UNTAGGED);
    expect(thread.finished(thread.implement(), BUILT, C)).toMatchObject({ kind: "act" });
    thread.reviewed(SMALL);
    const first = thread.implement();
    expect(first).toMatchObject({ touchUp: 1, stepUpReason: "retry" });
    thread.finished(first, BUILT, D);
    expect(thread.comments.at(-1)).toContain("<!-- fabrik:step-up-reason retry -->");

    thread.reviewed(SMALL);

    expect(thread.implement()).toMatchObject({ touchUp: 2, stepUpReason: "retry", model: kitConfig().roles.stepUp.model });
  });

  it("one that commits nothing gets today's empty-diff Verdict, which counts", () => {
    const thread = new Thread();
    thread.reviewed(SMALL);

    const plan = thread.finished(thread.implement(), NOTHING, B);

    expect(commentOf(plan)).toContain("The Implementer's Touch-up 1 of 2 on `fabrik/ticket-7` committed no change");
    expect(commentOf(plan)).toContain("Retry 1 of 2 starts now");
    expect(postedBy(plan).at(-1)).toMatchObject({ source: "empty-diff", verdict: "execution-flaw" });
    expect(postedBy(plan).at(-1)).not.toHaveProperty("touchUp");
  });

  it("a Touch-up left over from an earlier flaw pushes nothing over the one in flight", () => {
    const thread = new Thread();
    thread.reviewed(SMALL);
    const first = thread.implement();
    thread.finished(first, BUILT, B);
    thread.reviewed(SMALL);

    const plan = thread.finished(first, BUILT, C);

    expect(plan).toEqual({ kind: "nothing", reason: "Touch-up 1 of 2 on #50 isn't the run in flight, so the retry's branch isn't pushed" });
  });

  it("a Retry left over pushes nothing over a Touch-up in flight", () => {
    const thread = new Thread();
    thread.reviewed(UNTAGGED);
    const retry = thread.implement();
    thread.finished(retry, BUILT, B);
    thread.reviewed(SMALL);

    expect(thread.finished(retry, BUILT, C)).toEqual({ kind: "nothing", reason: "Retry 1 of 2 on #50 isn't the run in flight, so the retry's branch isn't pushed" });
  });
});
