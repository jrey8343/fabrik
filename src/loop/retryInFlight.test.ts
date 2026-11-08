// While a Retry is in flight, from the Verdict that calls for it until it
// pushes, ends in an empty diff or is refused, a Review on any other head posts
// no Verdict (ADR-0006). These tests replay a PR's thread: each plan's comments
// are posted, and the next snapshot reads them back as the adapter does.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { type PullRequestHistoryItem, pushedSinceVerdictIn, requestChangesRunIn, requestChangesSinceRunIn, verdictsIn } from "../github/threads.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

/** PR #50 for Ticket #7, whose thread grows as plans post comments on it. */
class Thread {
  readonly comments: string[] = [];
  /** The comments, with the Operator's reviews and the PR's draft changes, in the order they happened. */
  readonly history: PullRequestHistoryItem[] = [];
  headSha: string;
  draft = true;
  private second = 0;

  constructor(headSha: string) {
    this.headSha = headSha;
  }

  /** The next moment in the thread. */
  private next(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.second++)).toISOString();
  }

  /** The Operator requests changes, with the PR out of draft at the Merge gate. */
  changesRequested(review: number): void {
    this.history.push({ kind: "ready", at: this.next() });
    this.history.push({ kind: "changes-requested", at: this.next(), review, reviewer: "operator", reviewerIsBot: false });
  }

  pullRequest(): PullRequestSnapshot {
    return aPullRequest({
      headSha: this.headSha,
      draft: this.draft,
      verdicts: verdictsIn(this.comments),
      requestChangesRun: requestChangesRunIn(this.comments),
      pushedSinceVerdict: pushedSinceVerdictIn(this.comments),
      ...requestChangesSinceRunIn(this.history),
    });
  }

  snapshot(): Snapshot {
    return snapshotOfPullRequest(this.pullRequest());
  }

  /** The snapshot an event on Ticket #7 gets: the Ticket, with this PR open for it. */
  ticketSnapshot(): Snapshot {
    return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: this.pullRequest(),
    });
  }

  /** Plans the event against the thread as it stands, and posts the plan's PR comments to it. */
  plan(event: LoopEvent, snapshot = this.snapshot()): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    if (plan.kind === "act") {
      for (const action of plan.actions) {
        if (action.kind === "comment" && action.issue === 50) {
          this.comments.push(action.body);
          this.history.push({ kind: "bot-comment", at: this.next(), body: action.body });
        }
      }
    }
    return plan;
  }

  /** A push lands, and the Review it starts finishes red, as penrith#33's Operator pushes did. */
  pushRed(headSha: string): { started: Plan; landed: Plan } {
    this.headSha = headSha;
    const started = this.plan({ kind: "pull-request-pushed", pullRequest: 50 });
    const landed = this.plan(redChecks(headSha));
    return { started, landed };
  }

  /** The Implement run built on `fixes` finishes and, if its plan pushes, the PR is at `to`. */
  retryPushes(fixes: string, to: string, requestChanges = false, rebase?: BranchChanges["rebase"]): Plan {
    const event = retried(fixes, requestChanges);
    const plan = this.plan(rebase === undefined ? event : { ...event, changes: { ...event.changes, rebase } }, this.ticketSnapshot());
    if (plan.kind === "act" && plan.actions.some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }
}

function redChecks(headSha: string): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha, failed: ["build"], runUrl: RUN };
}

function reviewed(headSha: string, output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

function retried(headSha: string, requestChanges = false): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
    issue: 7,
    output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Fixed the build.", reviewMiss: false, amendsTicket: false }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] },
    fixes: { pullRequest: 50, headSha, runUrl: RUN, ...(requestChanges ? { review: 9 } : {}) },
  };
}

const RETRY_TRIGGER: Action = { kind: "add-labels", issue: 7, labels: ["agent:implement"] };

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function verdictLines(thread: Thread): string[] {
  return thread.comments.filter((body) => body.startsWith("<!-- fabrik:verdict ")).map((body) => /Retry .*|Back to design.*/.exec(body)?.[0] ?? "");
}

describe("A Review while a Retry is in flight", () => {
  it("replays penrith#33: the Operator's red head gets no Verdict, and the Retry's push is what counts as the next flaw", () => {
    const thread = new Thread(A);
    // The Implementer's head A is red: Retry 1 is owed.
    expect(actionsOf(thread.pushRed(A).landed)).toContainEqual(RETRY_TRIGGER);

    // The Operator pushes a red B while Retry 1 runs: no Review, no Verdict, no retry.
    const operatorPush = thread.pushRed(B);
    expect(operatorPush.started).toEqual({ kind: "nothing", reason: expect.stringMatching(/Retry 1 .*in flight/) });
    expect(operatorPush.landed).toMatchObject({ kind: "nothing", reason: expect.stringMatching(/Retry 1 .*in flight/) });

    // Retry 1, built on A, is rebased onto B and pushed as C.
    expect(actionsOf(thread.retryPushes(A, C, false, { onto: B, conflicted: false }))).toContainEqual({
      kind: "push-branch",
      branch: "fabrik/ticket-7",
    });

    // C is red: that's flaw 2, which steps up.
    const retryHead = thread.pushRed(C);
    expect(actionsOf(retryHead.started)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", role: "review" }));
    expect(actionsOf(retryHead.landed)).toContainEqual(RETRY_TRIGGER);
    expect(verdictLines(thread)).toEqual([
      expect.stringMatching(/^Retry 1 of 2 starts now:/),
      expect.stringMatching(/^Retry 2 of 2 starts now, stepped up:/),
    ]);
  });

  it("a Retry whose rebase over the Operator's head conflicts restarts, still in flight, and its count is unchanged", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.pushRed(B);

    const conflicted = thread.retryPushes(A, A, false, { onto: B, conflicted: true });
    expect(actionsOf(conflicted)).toContainEqual(RETRY_TRIGGER);
    expect(thread.headSha).toBe(B);
    // The restart is Retry 1 again, on the Implementer's model, and B still gets no Verdict.
    const resumed = thread.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, thread.ticketSnapshot());
    expect(actionsOf(resumed)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", model: "claude-sonnet-5-5" }));
    expect(thread.pushRed(B).landed.kind).toBe("nothing");

    // Rebuilt on B, it pushes C, whose flaw is flaw 2.
    thread.retryPushes(B, C);
    thread.pushRed(C);
    expect(verdictLines(thread)).toEqual([
      expect.stringMatching(/^Retry 1 of 2 starts now:/),
      expect.stringMatching(/^Retry 2 of 2 starts now, stepped up:/),
    ]);
  });

  it("a Reviewer's Verdict on another head lands nothing while the Retry is in flight, however its Review started", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.headSha = D;

    expect(thread.plan(reviewed(D, "verdict: execution-flaw\n\nStill broken.")).kind).toBe("nothing");
    expect(verdictsIn(thread.comments)).toHaveLength(1);
  });

  it("posts no Verdict while the Retry is stalled after an Infrastructure failure, which posts no Retry outcome", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.plan(
      {
        kind: "agent-run-failed",
        role: "implement",
        issue: 7,
        runUrl: RUN,
        jobResult: "failure",
        secretsStep: "success",
        report: null,
      },
      thread.ticketSnapshot(),
    );

    const operatorPush = thread.pushRed(B);
    expect(operatorPush.started.kind).toBe("nothing");
    expect(operatorPush.landed.kind).toBe("nothing");
    expect(verdictsIn(thread.comments)).toHaveLength(1);
  });

  it("re-adding agent:implement resumes the stalled Retry on the head the Operator pushed meanwhile, using no retry", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.pushRed(B);

    const plan = thread.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, thread.ticketSnapshot());

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", role: "implement", model: "claude-sonnet-5-5" }));
  });

  it("an empty-diff Retry is an outcome, but its own flaw calls for the next Retry, which is then in flight", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.plan({ ...retried(A), changes: { net: [], commits: [] } } as LoopEvent, thread.ticketSnapshot());

    expect(verdictLines(thread).at(-1)).toMatch(/^Retry 2 of 2 starts now, stepped up:/);
    expect(thread.pushRed(B).landed.kind).toBe("nothing");
  });

  it("once a Retry has pushed, Reviews of later heads post Verdicts as today, the Operator's included", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.retryPushes(A, B);
    thread.plan(reviewed(B, "verdict: pass"));

    // The Operator pushes C after the pass: it's reviewed, and its flaw counts as flaw 2.
    thread.headSha = C;
    expect(actionsOf(thread.plan({ kind: "pull-request-pushed", pullRequest: 50 }))).not.toEqual([]);
    expect(actionsOf(thread.plan(redChecks(C)))).toContainEqual(RETRY_TRIGGER);
    expect(verdictLines(thread).at(-1)).toMatch(/^Retry 2 of 2 starts now, stepped up:/);
  });

  it("with no Retry left, the third flaw is still posted and sends the Ticket back to design, with no Retry in flight", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    thread.retryPushes(A, B);
    thread.pushRed(B);
    thread.retryPushes(B, C);
    const third = thread.pushRed(C).landed;

    expect(thread.comments.at(-1)).toContain("This is the Ticket's third Execution flaw");
    expect(actionsOf(third)).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actionsOf(third)).not.toContainEqual(RETRY_TRIGGER);
    const resumed = thread.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, thread.ticketSnapshot());
    expect(actionsOf(resumed).filter((action) => action.kind === "start-agent-run")).toEqual([]);
  });

  it("a PR whose Retry pushed before push comments were marked reads as no longer in flight", () => {
    const thread = new Thread(A);
    thread.pushRed(A);
    // The note an older Kit posted for a Retry's push, with no marker.
    thread.comments.push("The Implementer pushed a fix for the Execution flaw to `fabrik/ticket-7`; Review runs again on it.\n\nFixed it.");

    expect(actionsOf(thread.pushRed(B).landed)).toContainEqual(RETRY_TRIGGER);
  });
});

describe("A Review while a Request-changes run is in flight", () => {
  /** A PR that passed on A and went to the Merge gate, where the Operator requested changes. */
  function changesRequestedOnA(): Thread {
    const thread = new Thread(A);
    thread.plan(reviewed(A, "verdict: pass"));
    thread.draft = false;
    thread.changesRequested(9);
    const plan = thread.plan({ kind: "pull-request-changes-requested", pullRequest: 50, review: 9, reviewer: "operator", reviewerIsBot: false });
    expect(actionsOf(plan)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    thread.draft = true;
    return thread;
  }

  it("posts no Verdict on a head the Operator pushes meanwhile", () => {
    const thread = changesRequestedOnA();

    const operatorPush = thread.pushRed(B);
    expect(operatorPush.started).toEqual({ kind: "nothing", reason: expect.stringMatching(/Request-changes run .*in flight/) });
    expect(operatorPush.landed.kind).toBe("nothing");
  });

  it("once it pushes, its head's Verdict is marked as from the run and uses no retry", () => {
    const thread = changesRequestedOnA();
    thread.pushRed(B);
    thread.retryPushes(B, C, true);
    thread.pushRed(C);

    expect(verdictsIn(thread.comments).at(-1)).toEqual({ verdict: "execution-flaw", source: "ci", requestChanges: true, headSha: C });
    expect(verdictLines(thread).at(-1)).toMatch(/^Retry 1 of 2 starts now:/);
  });

  it("a stalled run resumes on the head the Operator pushed meanwhile", () => {
    const thread = changesRequestedOnA();
    thread.pushRed(B);

    const plan = thread.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, thread.ticketSnapshot());

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "start-agent-run", requestChanges: { review: 9 } }));
  });
});
