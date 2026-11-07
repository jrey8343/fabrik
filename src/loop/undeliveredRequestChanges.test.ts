// An undelivered Request changes (#341): GitHub starts no workflow for a
// review on a PR that conflicts with its base, so the Operator's Request
// changes can reach the Loop through no event. The hourly tick and the push
// check find it, say so on the PR once, and start its Request-changes run,
// which merges main in when the PR conflicts. These tests replay the PR's
// history: each plan's comments are posted at the time it ran, and the next
// snapshot reads them back as the adapter does.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, repoSnapshot, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import {
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  type PullRequestHistoryItem,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  requestChangesSinceRunIn,
  verdictsIn,
} from "../github/threads.ts";
import { verdictMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const MAIN = "9".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** Minutes after 05:00, as an ISO 8601 time. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 10, 7, 5, minutes)).toISOString();
}

/** PR #50 for Ticket #7, which passed on A at 05:00 and waits at the Merge gate. */
class Thread {
  readonly history: PullRequestHistoryItem[] = [
    { kind: "bot-comment", at: at(0), body: verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A }) },
    { kind: "ready", at: at(0) },
  ];
  headSha = A;
  draft = false;
  labels: string[] = [];
  ticketLabels: string[] = [];
  mergeable: boolean | null = false;
  /** The head the Operator's reviews are submitted on. */
  reviewHead = A;
  now = at(0);

  private comments(): string[] {
    return this.history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
  }

  pullRequest(): PullRequestSnapshot {
    const comments = this.comments();
    const latest = [...this.history].reverse().find((item) => item.kind === "changes-requested");
    return aPullRequest({
      headSha: this.headSha,
      draft: this.draft,
      labels: this.labels,
      verdicts: verdictsIn(comments),
      requestChangesRun: requestChangesRunIn(comments),
      conflictRun: conflictRunIn(comments),
      conflictAttempts: conflictAttemptsIn(comments),
      conflictRunInFlight: conflictRunInFlightIn(comments),
      pushedSinceVerdict: pushedSinceVerdictIn(comments),
      changesRequested:
        latest?.kind === "changes-requested"
          ? { review: latest.review, reviewer: latest.reviewer, reviewerIsBot: latest.reviewerIsBot, commitSha: this.reviewHead }
          : null,
      ...requestChangesSinceRunIn(this.history),
    });
  }

  /** What the conflict check weighs, now. */
  conflicts(): NonNullable<Snapshot["conflicts"]> {
    return { main: MAIN, now: this.now, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: this.mergeable }] };
  }

  ticketSnapshot(): Snapshot {
    return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: this.pullRequest(),
    });
  }

  /** The Operator, or someone else, requests changes at `minutes`. */
  review(review: number, minutes: number, reviewer = "operator", reviewerIsBot = false): void {
    this.history.push({ kind: "changes-requested", at: at(minutes), review, reviewer, reviewerIsBot });
  }

  /** Applies these actions to the thread as the adapter would. */
  land(actions: readonly Action[]): void {
    for (const action of actions) {
      if (action.kind === "comment" && action.issue === 50) this.history.push({ kind: "bot-comment", at: this.now, body: action.body });
      if (action.kind === "convert-to-draft") {
        this.draft = true;
        this.history.push({ kind: "draft", at: this.now });
      }
      if (action.kind === "mark-ready-for-review") {
        this.draft = false;
        this.history.push({ kind: "ready", at: this.now });
      }
      if (action.kind === "add-labels" && action.issue === 50) this.labels.push(...action.labels);
      if (action.kind === "add-labels" && action.issue === 7) this.ticketLabels.push(...action.labels);
    }
  }

  plan(event: LoopEvent, snapshot: Snapshot): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    if (plan.kind === "act") this.land(plan.actions);
    return plan;
  }

  /** The scheduled tick at `minutes`. */
  tick(minutes: number): Plan {
    this.now = at(minutes);
    return this.plan({ kind: "scheduled-tick", now: this.now }, tickSnapshot({ conflicts: this.conflicts() }));
  }

  /** A push to main at `minutes`. */
  mainPushed(minutes: number): Plan {
    this.now = at(minutes);
    return this.plan({ kind: "main-pushed", head: MAIN }, repoSnapshot({ conflicts: this.conflicts() }));
  }

  /** agent:implement added to the Ticket, as the tick's plan adds it. */
  implement(): Plan {
    return this.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, this.ticketSnapshot());
  }

  /** The Request-changes run finishes with these changes; if its plan pushes, the PR is at `to`. */
  requestChangesRunFinishes(changes: BranchChanges, to: string, minutes: number): Plan {
    this.now = at(minutes);
    const plan = this.plan(requestChangesRunFinished(changes, this.headSha), this.ticketSnapshot());
    if (actionsOf(plan).some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }

  /** The Reviewer's Verdict on the head the PR is at, at `minutes`. */
  reviewed(verdict: "pass" | "execution-flaw", minutes: number): Plan {
    this.now = at(minutes);
    const output = verdict === "pass" ? "verdict: pass\n\nIt totals the cart." : "verdict: execution-flaw\n\nThe free-shipping banner is missing.";
    return this.plan(
      { kind: "review-run-finished", pullRequest: 50, headSha: this.headSha, runUrl: RUN, output, repoUrl: "https://github.com/acme/shop" },
      snapshotOfPullRequest(this.pullRequest()),
    );
  }
}

function requestChangesRunFinished(changes: BranchChanges, headSha: string): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({
      title: "Handle the empty cart",
      summary: "Handles the empty cart, with the free-shipping banner.",
      fix: "Built the requested banner.\n\nConflicted files:\n- `src/cart.ts`: kept main's new total and the empty-cart guard.",
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes,
    fixes: { pullRequest: 50, headSha, runUrl: RUN, requestChanges: true },
  };
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function commentsOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : []));
}

describe("An undelivered Request changes", () => {
  it("on a conflicting PR: the tick converts it to draft, says so once naming the review and the conflict, and starts one Request-changes run on the Step-up model", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);

    const tick = thread.tick(60);

    expect(actionsOf(tick)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(actionsOf(tick)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(actionsOf(tick).some((action) => action.kind === "rebase-onto-main")).toBe(false);
    const [note, ...more] = commentsOn(tick, 50);
    expect(more).toEqual([]);
    expect(note).toContain("#pullrequestreview-5810278044");
    expect(note).toContain("GitHub started no run");
    expect(note).toContain("conflicts with `main`");
    expect(note).toContain("merging `main` in");

    const { stepUp, implement } = kitConfig().roles;
    const run = actionsOf(thread.implement()).find((action) => action.kind === "start-agent-run");
    expect(run).toMatchObject({
      role: "implement",
      issue: 7,
      pullRequest: 50,
      requestChanges: { review: 5810278044 },
      model: stepUp.model,
      effort: stepUp.effort,
      timeoutMinutes: implement.timeoutMinutes,
    });
    expect(run).not.toHaveProperty("retry");
  });
});

describe("An undelivered Request changes, beyond the first tick", () => {
  it("on a PR that doesn't conflict: does the same, and the note doesn't mention a conflict", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(5810278044, 14);

    const tick = thread.tick(60);

    expect(actionsOf(tick)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(actionsOf(tick)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    const [note] = commentsOn(tick, 50);
    expect(note).toContain("#pullrequestreview-5810278044");
    expect(note).not.toContain("conflict");
    expect(note).not.toContain("merging");
  });

  it.each([
    ["younger than 10 minutes", (thread: Thread) => thread.review(1, 55)],
    ["by someone other than the Operator", (thread: Thread) => thread.review(1, 14, "teammate")],
    ["by a bot", (thread: Thread) => thread.review(1, 14, "operator", true)],
    [
      "submitted while the PR was a draft",
      (thread: Thread) => {
        thread.history.push({ kind: "draft", at: at(5) });
        thread.review(1, 14);
        thread.history.push({ kind: "ready", at: at(20) });
      },
    ],
  ])("a review %s starts nothing and posts nothing", (_case, setUp) => {
    const thread = new Thread();
    thread.mergeable = true;
    setUp(thread);

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(actionsOf(plan).some((action) => action.kind === "convert-to-draft" || (action.kind === "add-labels" && action.issue === 7))).toBe(false);
  });

  it("a review on a PR that's a draft now starts nothing", () => {
    const thread = new Thread();
    thread.review(1, 14);
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(20) });

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7)).toBe(false);
  });

  it("a later tick or push check posts nothing more and starts nothing more for the same review, before and after the run lands", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.tick(60);
    thread.implement();

    for (const plan of [thread.tick(120), thread.mainPushed(125)]) {
      expect(commentsOn(plan, 50)).toEqual([]);
      expect(actionsOf(plan).some((action) => (action.kind === "add-labels" && action.issue === 7) || action.kind === "rebase-onto-main")).toBe(false);
    }

    const landed = thread.requestChangesRunFinishes({ net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: true }, B, 130);
    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(true);
    thread.reviewed("pass", 140);
    thread.mergeable = true;

    const after = thread.tick(180);
    expect(commentsOn(after, 50)).toEqual([]);
    expect(actionsOf(after).some((action) => action.kind === "add-labels" && action.issue === 7)).toBe(false);
  });

  it("two undelivered reviews get one note listing both ids, and one run for the latest", () => {
    const thread = new Thread();
    thread.review(101, 14);
    thread.review(102, 20);

    const tick = thread.tick(60);

    const notes = commentsOn(tick, 50);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("#pullrequestreview-101");
    expect(notes[0]).toContain("#pullrequestreview-102");
    expect(actionsOf(tick).filter((action) => action.kind === "add-labels" && action.issue === 7)).toHaveLength(1);
    const runs = actionsOf(thread.implement()).filter((action) => action.kind === "start-agent-run");
    expect(runs).toEqual([expect.objectContaining({ requestChanges: { review: 102 } })]);
  });

  it("the conflict check leaves a conflicting PR alone while it has a Request changes no run has built, even one still within its grace period", () => {
    const thread = new Thread();
    thread.review(5810278044, 55);

    const plan = thread.mainPushed(58);

    expect(actionsOf(plan).some((action) => action.kind === "rebase-onto-main")).toBe(false);
    expect(plan.kind === "nothing" ? plan.reason : "").toContain("Request-changes run brings main in");
  });
});

describe("An undelivered Request changes while a run is in flight on the PR", () => {
  /**
   * The Operator pushed C at the Merge gate and requested changes on it; before
   * the Kit heard of the review, the PR went back to draft and B is up for Review.
   */
  function reviewInFlight(): Thread {
    const thread = new Thread();
    thread.headSha = C;
    thread.reviewHead = C;
    thread.review(5810278044, 14);
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(16) });
    thread.headSha = B;
    return thread;
  }

  it("starts nothing until the run lands", () => {
    const thread = reviewInFlight();

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7)).toBe(false);
  });

  it("when the landed Verdict calls for a Retry, the Request-changes run goes first on the next check, and no Retry is used", () => {
    const thread = reviewInFlight();

    const verdict = thread.reviewed("execution-flaw", 70);
    expect(actionsOf(verdict).some((action) => action.kind === "add-labels" && action.issue === 7)).toBe(false);
    expect(commentsOn(verdict, 50)[0]).toContain("goes first");
    expect(commentsOn(verdict, 50)[0]).not.toContain("Retry 1 of 2");

    const check = thread.mainPushed(80);
    expect(commentsOn(check, 50)[0]).toContain("#pullrequestreview-5810278044");
    expect(actionsOf(check)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(actionsOf(check).some((action) => action.kind === "convert-to-draft")).toBe(false);
    const run = actionsOf(thread.implement()).find((action) => action.kind === "start-agent-run");
    expect(run).toMatchObject({ requestChanges: { review: 5810278044 } });
    expect(run).not.toHaveProperty("retry");

    // An Execution flaw on the Request-changes run's push still has both of the Ticket's Retries left.
    thread.requestChangesRunFinishes({ net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: true }, "d".repeat(40), 90);
    const next = thread.reviewed("execution-flaw", 100);
    expect(commentsOn(next, 50)[0]).toContain("Retry 1 of 2 starts now");
  });
});

describe("A Request-changes run on a PR that conflicts with main", () => {
  /** The tick found the undelivered review on the conflicting PR and started its run. */
  function runStarted(): Thread {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.tick(60);
    thread.implement();
    return thread;
  }

  it.each([
    ["it couldn't bring main in", { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false, conflictsWithMain: MAIN }, "didn't merge `main` in"],
    [
      "the trust-root guard refuses it",
      { net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }], updatedFromMain: true, conflictsWithMain: MAIN },
      "`.github/workflows/ci.yml`",
    ],
  ] as const)("when %s: says why on the PR, adds ready-for-human, takes the PR out of draft, and keeps it open", (_case, changes, why) => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes(changes, B, 120);

    const actions = actionsOf(plan);
    expect(actions.some((action) => action.kind === "push-branch" || action.kind === "close-pull-request")).toBe(false);
    const [note] = commentsOn(plan, 50);
    expect(note).toContain("@operator");
    expect(note).toContain(why);
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(actions).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });

    // The run is over, and main at this head isn't tried again: neither check starts anything more.
    for (const later of [thread.tick(180), thread.mainPushed(185)]) {
      expect(commentsOn(later, 50)).toEqual([]);
      expect(actionsOf(later).some((action) => action.kind === "rebase-onto-main" || (action.kind === "add-labels" && action.issue === 7))).toBe(false);
    }
    expect(actionsOf(thread.implement()).some((action) => action.kind === "start-agent-run")).toBe(false);
  });

  it("that merged main in pushes, and its note says so", () => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes(
      { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: true, conflictsWithMain: MAIN },
      B,
      120,
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(commentsOn(plan, 50)[0]).toContain("merged `main`");
    expect(commentsOn(plan, 50)[0]).toContain("Conflicted files");
  });

  it("a Request-changes run on a PR with no conflict that the trust-root guard refuses still closes it, as before", () => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes({ net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }] }, B, 120);

    expect(actionsOf(plan)).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
  });
});
