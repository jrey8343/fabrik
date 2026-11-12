// The Operator's moves win while a Digest is being written (ADR-0022). The
// later tests replay the PR's history: each plan's comments, labels and draft
// changes land at the time it ran, and the next snapshot reads them back as
// the adapter does.
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import {
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  leftDraftSinceVerdictIn,
  notDismissedIn,
  type PullRequestHistoryItem,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  requestChangesSinceRunIn,
  verdictsIn,
} from "../github/threads.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** #50 as a pass leaves it with the Digest on: a draft with the pass on its head and `agent:digest` on, not out of draft since. */
function aPassedDraft(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    draft: true,
    leftDraftSinceVerdict: false,
    labels: ["agent:digest"],
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    ...overrides,
  });
}

function changesRequested(overrides: Partial<Extract<LoopEvent, { kind: "pull-request-changes-requested" }>> = {}): LoopEvent {
  return { kind: "pull-request-changes-requested", pullRequest: 50, review: 900, reviewer: "operator", reviewerIsBot: false, ...overrides };
}

describe("The Operator's Request changes on a passed draft waiting on its Digest", () => {
  it("is acted on as one at the Merge gate: the started note, the PR kept in draft, the Request-changes run on the Step-up model, and agent:digest off", () => {
    const config = kitConfig();
    const plan = planFor(changesRequested(), snapshotOfPullRequest(aPassedDraft()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 50,
          body: [
            "<!-- fabrik:request-changes-run-started 900 -->",
            "The Kit is starting the Request-changes run for your Request changes on #50 ([review 900](https://github.com/acme/shop/pull/50#pullrequestreview-900)). It runs on the Step-up model and uses no retry. The PR stays in draft, with no Digest for this head, and Review runs again on the run's push.",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
        {
          kind: "start-agent-run",
          role: "implement",
          issue: 7,
          pullRequest: 50,
          requestChanges: { review: 900 },
          model: config.roles.stepUp.model,
          effort: config.roles.stepUp.effort,
          timeoutMinutes: config.roles.implement.timeoutMinutes,
          stepUp: true,
          stepUpReason: "request-changes",
          subscription: "Claude token",
        },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("is acted on in the moment after the Digest attempt ended too, before the gate opened: the label is already off", () => {
    const plan = planFor(changesRequested(), snapshotOfPullRequest(aPassedDraft({ labels: [] })), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "remove-label", "start-agent-run"]);
  });

  it.each([
    ["a draft with no pass on its head, as after a push to it", aPassedDraft({ headSha: "b".repeat(40) })],
    ["a draft whose latest Verdict is an Execution flaw", aPassedDraft({ verdicts: [{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }], pushedSinceVerdict: true })],
    ["a draft no Review has judged yet", aPassedDraft({ verdicts: [] })],
    ["a draft the Operator put back in draft themselves after the gate opened", aPassedDraft({ leftDraftSinceVerdict: true })],
    // A pass kept it in draft to be brought up to date with main.
    ["a passed draft with a conflict-only run in flight", aPassedDraft({ conflictRunInFlight: "c".repeat(40) })],
    // As after a pass that gave way to a Request changes deferred during a Retry.
    [
      "a passed draft with a Request-changes run in flight",
      aPassedDraft({
        unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
        notedChangesRequests: [777],
        requestChangesRunInFlight: 777,
        requestChangesRunReviews: [777],
        requestChangesRunSince: "2026-11-08T05:10:00.000Z",
      }),
    ],
  ])("does what it does today on %s: nothing, as on any draft still in the Loop", (_what, pullRequest) => {
    expect(planFor(changesRequested(), snapshotOfPullRequest(pullRequest), kitConfig())).toEqual({
      kind: "nothing",
      reason: "#50 is still a draft in the Loop, not at the Merge gate",
    });
  });

  it("from anyone but the Operator starts nothing, and says so in one line, as today", () => {
    const plan = planFor(changesRequested({ reviewer: "someone" }), snapshotOfPullRequest(aPassedDraft()), kitConfig());

    expect(actionsOf(plan)).toEqual([
      { kind: "comment", issue: 50, body: "Only the Operator's reviews start runs on an agent PR, so the Request changes from someone on #50 starts nothing." },
    ]);
  });
});

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
const PR_URL = "https://github.com/acme/shop/pull/50";
const MAIN = "9".repeat(40);
const A = HEAD_SHA;
const B = "b".repeat(40);

const BUILT: BranchChanges = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false };

const REPLY = aDigestReply();

/** Minutes after 05:00, as an ISO 8601 time. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 10, 9, 5, minutes)).toISOString();
}

/**
 * PR #50 for Ticket #7, an agent draft at head A that no Review has judged
 * yet. Each plan's comments, labels and draft changes land at the time it
 * ran, and the next snapshot reads them back as the adapter does.
 */
class Thread {
  readonly history: PullRequestHistoryItem[] = [];
  headSha = A;
  draft = true;
  open = true;
  labels: string[] = [];
  ticketLabels: string[] = ["enhancement", "ready-for-agent"];
  mergeable: boolean | null = true;
  now = at(0);
  /** How many times the Operator's review was requested. */
  reviewRequests = 0;
  /** The review of each Request-changes run a plan started, in order. */
  readonly startedFor: number[] = [];
  /** The role of each run a plan started, in order. */
  readonly started: string[] = [];

  /** The Kit's comments on the PR, oldest first. */
  comments(): string[] {
    return this.history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
  }

  pullRequest(): PullRequestSnapshot {
    const comments = this.comments();
    return aPullRequest({
      open: this.open,
      headSha: this.headSha,
      draft: this.draft,
      labels: this.labels,
      ticketLabels: this.ticketLabels,
      verdicts: verdictsIn(comments),
      requestChangesRun: requestChangesRunIn(comments),
      conflictRun: conflictRunIn(comments),
      conflictAttempts: conflictAttemptsIn(comments),
      conflictRunInFlight: conflictRunInFlightIn(comments),
      pushedSinceVerdict: pushedSinceVerdictIn(comments),
      ...requestChangesSinceRunIn(this.history, notDismissedIn(this.history), "operator", this.headSha),
      leftDraftSinceVerdict: leftDraftSinceVerdictIn(this.history),
      url: PR_URL,
    });
  }

  private land(actions: readonly Action[]): void {
    for (const action of actions) {
      if (action.kind === "comment" && action.issue === 50) this.history.push({ kind: "bot-comment", at: this.now, body: action.body });
      if (action.kind === "add-labels" && action.issue === 50) this.labels = [...this.labels, ...action.labels];
      if (action.kind === "add-labels" && action.issue === 7) this.ticketLabels = [...this.ticketLabels, ...action.labels];
      if (action.kind === "remove-label" && action.issue === 50) this.labels = this.labels.filter((label) => label !== action.label);
      if (action.kind === "remove-label" && action.issue === 7) this.ticketLabels = this.ticketLabels.filter((label) => label !== action.label);
      if (action.kind === "convert-to-draft") this.setDraft(true);
      if (action.kind === "mark-ready-for-review") this.setDraft(false);
      if (action.kind === "close-pull-request") this.open = false;
      if (action.kind === "request-review") this.reviewRequests += 1;
      if (action.kind === "start-agent-run") {
        this.started.push(action.role);
        if (action.requestChanges !== undefined) this.startedFor.push(action.requestChanges.review);
      }
    }
  }

  private setDraft(draft: boolean): void {
    this.draft = draft;
    this.history.push({ kind: draft ? "draft" : "ready", at: this.now });
  }

  /** The Loop's plan for this event at `minutes`, on the PR as it stands, landed. */
  plan(event: LoopEvent, minutes: number, snapshot?: Snapshot): Plan {
    this.now = at(minutes);
    const plan = planFor(event, snapshot ?? snapshotOfPullRequest(this.pullRequest()), kitConfig());
    if (plan.kind === "act") this.land(plan.actions);
    return plan;
  }

  /** The Reviewer passes the head the PR is at, and the label the pass adds starts the Digest writer. */
  passes(minutes: number): void {
    const output = "verdict: pass\n\nIt totals the cart.";
    this.plan({ kind: "review-run-finished", pullRequest: 50, headSha: this.headSha, runUrl: RUN, output, repoUrl: REPO }, minutes);
    this.plan({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" }, minutes);
  }

  /** The Digest writer's attempt, started at `head`, ends with a Digest at `minutes`. */
  digestWritten(head: string, minutes: number): Plan {
    const given = aDigestGiven({ repoUrl: REPO, pullRequest: 50, headSha: head, runUrl: RUN });
    return this.plan({ kind: "digest-run-finished", pullRequest: 50, headSha: head, output: JSON.stringify(REPLY), given, runUrl: RUN }, minutes);
  }

  /** The Operator requests changes at `minutes`; the Loop hears of it only through `delivered`. */
  review(review: number, minutes: number): void {
    this.history.push({ kind: "changes-requested", at: at(minutes), review, reviewer: "operator", reviewerIsBot: false });
  }

  /** GitHub delivers the Operator's review to the Loop. */
  delivered(review: number, minutes: number): Plan {
    return this.plan({ kind: "pull-request-changes-requested", pullRequest: 50, review, reviewer: "operator", reviewerIsBot: false }, minutes);
  }

  /** The Operator takes the PR out of draft, or puts it back, by hand. */
  byHand(draft: boolean, minutes: number): void {
    this.now = at(minutes);
    this.setDraft(draft);
  }

  /** Someone pushes `to` to the PR. */
  pushed(to: string, minutes: number): Plan {
    this.headSha = to;
    return this.plan({ kind: "pull-request-pushed", pullRequest: 50 }, minutes);
  }

  /** The scheduled tick, whose conflict check weighs the PR. */
  tick(minutes: number): Plan {
    const conflicts = { main: MAIN, now: at(minutes), implementJobUnderWay: false, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: this.mergeable }] };
    return this.plan({ kind: "scheduled-tick", now: at(minutes) }, minutes, tickSnapshot({ conflicts }));
  }

  /** The Request-changes run a plan started finishes with a change, and its push moves the PR to `to`. */
  requestChangesRunPushes(to: string, minutes: number): Plan {
    const event: LoopEvent = {
      kind: "implement-run-finished",
      runUrl: RUN,
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Built the requested banner.", reviewMiss: false, amendsTicket: true }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: BUILT,
      fixes: { pullRequest: 50, headSha: this.headSha, runUrl: RUN, review: this.startedFor.at(-1) as number },
    };
    const snapshot = snapshotOf(anIssue({ number: 7, labels: this.ticketLabels, openPullRequests: [50] }), { pullRequest: this.pullRequest() });
    const plan = this.plan(event, minutes, snapshot);
    if (actionsOf(plan).some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }
}

/** The reviews a snapshot counts as the Operator's that nothing has settled, those a run was started for, and the run in flight. */
function requestChangesOn(thread: Thread): { unbuilt: number[]; noted: readonly number[]; inFlight: number | null } {
  const pullRequest = thread.pullRequest();
  return {
    unbuilt: pullRequest.unbuiltChangesRequests.map(({ review }) => review),
    noted: pullRequest.notedChangesRequests,
    inFlight: pullRequest.requestChangesRunInFlight,
  };
}

describe("A Request changes on a waiting draft counts as one the Operator gave at the Merge gate", () => {
  it("is unbuilt from the moment it is given, and its Digest is dropped once its run is in flight: nothing posted, no gate opened", () => {
    const thread = new Thread();
    thread.passes(1);
    expect(thread).toMatchObject({ draft: true, labels: ["agent:digest"], started: ["digest"] });

    thread.review(900, 3);
    expect(requestChangesOn(thread)).toEqual({ unbuilt: [900], noted: [], inFlight: null });

    thread.delivered(900, 3);
    expect(thread).toMatchObject({ draft: true, labels: [], startedFor: [900] });
    expect(requestChangesOn(thread)).toEqual({ unbuilt: [900], noted: [900], inFlight: 900 });

    // The attempt that was under way lands on a PR with a run in flight.
    const posted = thread.comments().length;
    const landed = thread.digestWritten(A, 6);
    expect(actionsOf(landed)).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    expect(landed).toMatchObject({ notes: ["The Digest of #50 was dropped: The Operator's Request-changes run on #50 is in flight"] });
    expect(thread.comments()).toHaveLength(posted);
    expect(thread).toMatchObject({ draft: true, reviewRequests: 0 });
  });

  it("is built by its run's push, and the pass on that push brings the next Digest", () => {
    const thread = new Thread();
    thread.passes(1);
    thread.review(900, 3);
    thread.delivered(900, 3);

    thread.requestChangesRunPushes(B, 20);
    expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });

    thread.passes(30);
    expect(thread).toMatchObject({ draft: true, labels: ["agent:digest"], started: ["digest", "implement", "digest"] });
    thread.digestWritten(B, 33);
    expect(thread).toMatchObject({ draft: false, labels: [], reviewRequests: 1 });
  });

  it("that GitHub never delivered is found by the undelivered check once the PR is out of draft, and acted on as any other", () => {
    const thread = new Thread();
    thread.mergeable = false;
    thread.passes(1);
    thread.review(900, 3);

    // In draft the check leaves it: the Digest attempt is still to end.
    const waiting = thread.tick(40);
    expect(actionsOf(waiting).filter(({ kind }) => !kind.startsWith("check-"))).toEqual([]);

    thread.digestWritten(A, 41);
    expect(thread).toMatchObject({ draft: false, reviewRequests: 1 });
    expect(requestChangesOn(thread)).toEqual({ unbuilt: [900], noted: [], inFlight: null });

    const found = thread.tick(60);
    expect(actionsOf(found).map(({ kind }) => kind).slice(0, 3)).toEqual(["comment", "add-labels", "convert-to-draft"]);
    expect(actionsOf(found)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(thread.comments().at(-1)).toContain(`GitHub started no run for your Request changes on #50 ([review 900](${PR_URL}#pullrequestreview-900))`);
    expect(requestChangesOn(thread)).toEqual({ unbuilt: [900], noted: [900], inFlight: 900 });
  });

  it("is settled by a pass, as any Request changes before one is: its Review read it as part of the Ticket", () => {
    const thread = new Thread();
    thread.passes(1);
    thread.review(900, 3);
    thread.digestWritten(A, 5);
    expect(requestChangesOn(thread).unbuilt).toEqual([900]);

    // The Operator's own push at the Merge gate, taken back to draft, is reviewed and passes.
    thread.byHand(true, 8);
    thread.pushed(B, 9);
    thread.passes(15);

    expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
  });

  describe("and no other review on a draft does: each does what it does today", () => {
    it("one on a draft with no pass on its head, as after the Operator's push to it", () => {
      const thread = new Thread();
      thread.passes(1);
      thread.pushed(B, 2);

      thread.review(900, 3);

      expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
      expect(thread.delivered(900, 3)).toEqual({ kind: "nothing", reason: "#50 is still a draft in the Loop, not at the Merge gate" });
    });

    it("one on a draft the Operator put back in draft themselves after the gate opened", () => {
      const thread = new Thread();
      thread.passes(1);
      thread.digestWritten(A, 3);
      thread.byHand(true, 5);

      thread.review(900, 6);

      expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
      expect(thread.delivered(900, 6)).toEqual({ kind: "nothing", reason: "#50 is still a draft in the Loop, not at the Merge gate" });
    });

    it("one on a draft the Operator took out of draft and put back while its Digest was being written", () => {
      const thread = new Thread();
      thread.passes(1);
      thread.byHand(false, 2);
      thread.byHand(true, 3);

      thread.review(900, 4);

      expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
      expect(thread.delivered(900, 4)).toEqual({ kind: "nothing", reason: "#50 is still a draft in the Loop, not at the Merge gate" });
    });

    it("one on a passed draft with a conflict-only run in flight, which a pass kept in draft to be brought up to date with main", () => {
      const thread = new Thread();
      const output = "verdict: pass\n\nIt totals the cart.";
      const conflicting = snapshotOfPullRequest(thread.pullRequest(), { mergeable: { main: MAIN, mergeable: false } });
      const passed = thread.plan({ kind: "review-run-finished", pullRequest: 50, headSha: A, runUrl: RUN, output, repoUrl: REPO }, 1, conflicting);
      // The rebase onto main conflicts too, so the Kit's note starts a conflict-only run.
      const rebase = actionsOf(passed).find((action) => action.kind === "rebase-onto-main");
      for (const action of rebase?.kind === "rebase-onto-main" ? rebase.conflicted : []) {
        if (action.kind === "comment") thread.history.push({ kind: "bot-comment", at: at(1), body: action.body });
      }
      expect(thread.pullRequest().conflictRunInFlight).toBe(MAIN);

      thread.review(900, 3);

      expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
      expect(thread.delivered(900, 3)).toEqual({ kind: "nothing", reason: "#50 is still a draft in the Loop, not at the Merge gate" });
    });

    it("one from anyone but the Operator", () => {
      const thread = new Thread();
      thread.passes(1);

      thread.history.push({ kind: "changes-requested", at: at(3), review: 901, reviewer: "someone", reviewerIsBot: false });

      expect(requestChangesOn(thread)).toEqual({ unbuilt: [], noted: [], inFlight: null });
    });
  });
});

describe("The Operator's other moves while a Digest is being written", () => {
  it("needs-design on the PR closes it and sends its Ticket to a Design session as today, and the Digest that lands afterwards posts nothing", () => {
    const thread = new Thread();
    thread.passes(1);

    const sentBack = thread.plan({ kind: "pull-request-labeled", pullRequest: 50, label: "needs-design" }, 3);

    expect(actionsOf(sentBack).map(({ kind }) => kind)).toEqual(["close-pull-request", "comment", "remove-label", "remove-label", "add-labels"]);
    expect(actionsOf(sentBack)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
    expect(thread).toMatchObject({ open: false });

    const posted = thread.comments().length;
    const landed = thread.digestWritten(A, 6);
    expect(actionsOf(landed)).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    expect(landed).toMatchObject({ notes: ["The Digest of #50 was dropped: #50 is closed"] });
    expect(thread.comments()).toHaveLength(posted);
    expect(thread).toMatchObject({ draft: true, reviewRequests: 0 });
  });

  it("a push to the draft starts a Review of the new head, and the old head's Digest posts nothing", () => {
    const thread = new Thread();
    thread.passes(1);

    const pushed = thread.pushed(B, 3);

    expect(actionsOf(pushed)).toMatchObject([{ kind: "start-agent-run", role: "review", issue: 50 }]);

    const posted = thread.comments().length;
    const landed = thread.digestWritten(A, 6);
    expect(actionsOf(landed)).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    expect(landed).toMatchObject({ notes: ["The Digest of #50 was dropped: #50 has moved on from aaaaaaa"] });
    expect(thread.comments()).toHaveLength(posted);
    expect(thread).toMatchObject({ draft: true, reviewRequests: 0 });
  });

  it("marking the PR ready by hand does not stop the Digest: it lands and the label comes off, nothing else moves and no review is requested", () => {
    const thread = new Thread();
    thread.passes(1);
    thread.byHand(false, 3);

    const landed = thread.digestWritten(A, 6);

    expect(actionsOf(landed).map(({ kind }) => kind)).toEqual(["comment", "remove-label"]);
    expect(thread.comments().at(-1)).toMatch(/^<!-- fabrik:digest \{"head":"a{40}"/);
    expect(thread).toMatchObject({ draft: false, labels: [], reviewRequests: 0 });
    expect(notificationsOf(landed)).toEqual([]);
  });
});
