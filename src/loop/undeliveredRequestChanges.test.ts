// An undelivered Request changes (#341): GitHub starts no workflow for a
// review on a PR that conflicts with its base, so the Operator's Request
// changes can reach the Loop through no event. The hourly tick and the push
// check find one no run was started for, say so on the PR once, and start its
// Request-changes run, which merges main in when the PR conflicts. Every
// Request-changes run the Kit starts is marked on the PR by the note that
// started it. These tests replay the PR's history: each plan's comments and
// draft changes land at the time it ran, and the next snapshot reads them
// back as the adapter does.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, repoSnapshot, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import {
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  leftDraftSinceVerdictIn,
  type PullRequestHistoryItem,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  requestChangesSinceRunIn,
  standingIn,
  verdictsIn,
} from "../github/threads.ts";
import { implementJobTimeoutMinutes } from "../evidence/capture.ts";
import { verdictMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const PR_URL = "https://github.com/acme/shop/pull/50";
const MAIN = "9".repeat(40);
const MAIN_2 = "8".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);

const BUILT: BranchChanges = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: true };

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
  main = MAIN;
  now = at(0);
  /** What a mechanical rebase onto main pushes the PR to, when the conflict check plans one. */
  rebasedTo = E;
  /** When set, this action fails as the adapter applies it, and every action after it is never applied. */
  failsAt: Action["kind"] | null = null;

  private comments(): string[] {
    return this.history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
  }

  pullRequest(): PullRequestSnapshot {
    const comments = this.comments();
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
      ...requestChangesSinceRunIn(this.history, standingIn(this.history), "operator"),
      leftDraftSinceVerdict: leftDraftSinceVerdictIn(this.history),
      url: PR_URL,
    });
  }

  /** What the conflict check weighs, now. */
  conflicts(): NonNullable<Snapshot["conflicts"]> {
    return { main: this.main, now: this.now, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: this.mergeable }] };
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

  /** The Operator dismisses a review: GitHub no longer lists it among those requesting changes. */
  dismiss(review: number): void {
    const index = this.history.findIndex((item) => item.kind === "changes-requested" && item.review === review);
    this.history.splice(index, 1);
  }

  /** The Operator takes the PR out of draft at `minutes`. */
  markReady(minutes: number): void {
    this.now = at(minutes);
    this.draft = false;
    this.history.push({ kind: "ready", at: this.now });
  }

  /** Applies these actions to the thread as the adapter would. */
  land(actions: readonly Action[]): void {
    for (const action of actions) {
      if (action.kind === this.failsAt) return;
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
      // The mechanical rebase is clean, and lands.
      if (action.kind === "rebase-onto-main") {
        this.land(action.clean);
        this.headSha = this.rebasedTo;
        this.land(action.pushed);
      }
    }
  }

  /** The review of each Request-changes run a plan started, in order. */
  readonly startedFor: number[] = [];

  plan(event: LoopEvent, snapshot: Snapshot): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    if (plan.kind === "act") this.land(plan.actions);
    const review = startsOn(plan)?.requestChanges?.review;
    if (review !== undefined) this.startedFor.push(review);
    return plan;
  }

  /** The scheduled tick at `minutes`. */
  tick(minutes: number): Plan {
    this.now = at(minutes);
    return this.plan({ kind: "scheduled-tick", now: this.now }, tickSnapshot({ conflicts: this.conflicts() }));
  }

  /** A push to main at `minutes`, to `head`. */
  mainPushed(minutes: number, head = this.main): Plan {
    this.now = at(minutes);
    this.main = head;
    return this.plan({ kind: "main-pushed", head }, repoSnapshot({ conflicts: this.conflicts() }));
  }

  /** GitHub delivers the Operator's review to the Loop at `minutes`: the event path's Request changes. */
  delivered(review: number, minutes: number): Plan {
    this.now = at(minutes);
    return this.plan(
      { kind: "pull-request-changes-requested", pullRequest: 50, review, reviewer: "operator", reviewerIsBot: false },
      snapshotOfPullRequest(this.pullRequest()),
    );
  }

  /** agent:implement added to the Ticket, as a plan adds it. */
  implement(): Plan {
    return this.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, this.ticketSnapshot());
  }

  /**
   * The Request-changes run finishes with these changes; if its plan pushes, the PR is at `to`. It is the run
   * started for `review`, the latest a plan started one for unless named.
   */
  requestChangesRunFinishes(changes: BranchChanges, to: string, minutes: number, review = this.startedFor.at(-1)): Plan {
    this.now = at(minutes);
    const plan = this.plan(implementRunFinished(changes, this.headSha, true, review), this.ticketSnapshot());
    if (actionsOf(plan).some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }

  /** A Retry finishes with these changes; if its plan pushes, the PR is at `to`. It is Retry `retry`, when named. */
  retryFinishes(changes: BranchChanges, to: string, minutes: number, retry?: number, flaw?: string): Plan {
    this.now = at(minutes);
    const plan = this.plan(implementRunFinished(changes, this.headSha, false, undefined, retry, flaw), this.ticketSnapshot());
    if (actionsOf(plan).some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }

  /** Someone pushes `to` to the PR, which starts a Review unless a run is in flight. */
  pushed(to: string, minutes: number): Plan {
    this.now = at(minutes);
    this.headSha = to;
    return this.plan({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(this.pullRequest()));
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

function implementRunFinished(
  changes: BranchChanges,
  headSha: string,
  requestChanges: boolean,
  review?: number,
  retry?: number,
  retryFlaw?: string,
): Extract<LoopEvent, { kind: "implement-run-finished" }> {
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
    fixes: { pullRequest: 50, headSha, runUrl: RUN, requestChanges, ...(review === undefined ? {} : { review }), ...(retry === undefined ? {} : { retry }), ...(retryFlaw === undefined ? {} : { retryFlaw }) },
  };
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function commentsOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : []));
}

function startsOn(plan: Plan): Extract<Action, { kind: "start-agent-run" }> | undefined {
  return actionsOf(plan).find((action): action is Extract<Action, { kind: "start-agent-run" }> => action.kind === "start-agent-run");
}

const addsImplement = (plan: Plan): boolean => actionsOf(plan).some((action) => action.kind === "add-labels" && action.issue === 7);
const reasonOf = (plan: Plan): string => (plan.kind === "nothing" ? plan.reason : "");

describe("An undelivered Request changes", () => {
  it("on a conflicting PR: the tick says so once, naming and linking the review and the conflict, then turns the PR to draft and starts one Request-changes run on the Step-up model", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);

    const tick = thread.tick(60);

    const kinds = actionsOf(tick).map((action) => action.kind);
    // The note goes first, so the run is in flight even if what follows it fails; the run itself turns the PR to
    // draft if the Kit couldn't.
    expect(kinds.slice(0, 3)).toEqual(["comment", "add-labels", "convert-to-draft"]);
    expect(actionsOf(tick)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(kinds).not.toContain("rebase-onto-main");
    const [note, ...more] = commentsOn(tick, 50);
    expect(more).toEqual([]);
    expect(note).toContain(`[review 5810278044](${PR_URL}#pullrequestreview-5810278044)`);
    expect(note).toContain("GitHub started no run");
    expect(note).toContain("conflicts with `main`");
    expect(note).toContain("merging `main` in first");

    const { stepUp, implement } = kitConfig().roles;
    const run = startsOn(thread.implement());
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
  it("on a PR that doesn't conflict: does the same once the run GitHub would have started can't still be working, and the note doesn't mention a conflict", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(5810278044, 14);
    // GitHub delivered it, but its claim failed before noting it: its run may still be working until the Implement job's timeout.
    expect(commentsOn(thread.tick(60), 50)).toEqual([]);

    const tick = thread.tick(14 + implementJobTimeoutMinutes(kitConfig().roles.implement.timeoutMinutes) + 1);

    expect(actionsOf(tick)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(addsImplement(tick)).toBe(true);
    const [note] = commentsOn(tick, 50);
    // A run may have started and come to nothing, as when its claim failed: the note says only that none is under way.
    expect(note).toContain("No Request-changes run is under way for your Request changes");
    expect(note).toContain("#pullrequestreview-5810278044");
    expect(note).not.toContain("conflict");
    expect(note).not.toContain("merging");
  });

  it("on a PR GitHub hadn't worked out a conflict for: the note gives the conflict as the likely reason, and says the run merges main in if it conflicts", () => {
    const thread = new Thread();
    thread.mergeable = null;
    thread.review(5810278044, 14);

    const [note] = commentsOn(thread.tick(60), 50);

    expect(note).toContain("GitHub started no run for your Request changes");
    expect(note).toContain("GitHub doesn't start workflows for reviews while a pull request conflicts with its base");
    expect(note).toContain("merging `main` in first if #50 conflicts with it");
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
    expect(actionsOf(plan).some((action) => action.kind === "convert-to-draft") || addsImplement(plan)).toBe(false);
  });

  it("a review on a PR that's a draft now starts nothing", () => {
    const thread = new Thread();
    thread.review(1, 14);
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(20) });

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(addsImplement(plan)).toBe(false);
  });

  it("a later tick or push check posts nothing more and starts nothing more for the same review, before and after the run lands", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.tick(60);
    thread.implement();

    for (const plan of [thread.tick(120), thread.mainPushed(125)]) {
      expect(commentsOn(plan, 50)).toEqual([]);
      expect(addsImplement(plan) || actionsOf(plan).some((action) => action.kind === "rebase-onto-main")).toBe(false);
    }

    const landed = thread.requestChangesRunFinishes(BUILT, B, 130);
    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(true);
    thread.reviewed("pass", 140);
    thread.mergeable = true;

    const after = thread.tick(180);
    expect(commentsOn(after, 50)).toEqual([]);
    expect(addsImplement(after)).toBe(false);
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
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 102 } });
  });

  it("once one review is past its grace period, the note names a newer one still within it too, and the run is for the newest", () => {
    const thread = new Thread();
    thread.review(101, 14);
    thread.review(102, 52);

    const [note] = commentsOn(thread.tick(60), 50);

    expect(note).toContain("#pullrequestreview-101");
    expect(note).toContain("#pullrequestreview-102");
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 102 } });
    expect(commentsOn(thread.tick(120), 50)).toEqual([]);
  });

  it("the conflict check leaves a conflicting PR alone while it has a Request changes no run has started for, even one still within its grace period", () => {
    const thread = new Thread();
    thread.review(5810278044, 55);

    const plan = thread.mainPushed(58);

    expect(actionsOf(plan).some((action) => action.kind === "rebase-onto-main")).toBe(false);
    expect(reasonOf(plan)).toContain("Request-changes run brings main in");
  });

  it("a review a pass came after is settled: the Reviewer read it as part of the Ticket, so the tick posts nothing", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(15) });
    thread.pushed(B, 16);
    thread.reviewed("pass", 30);

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(addsImplement(plan)).toBe(false);
  });
});

describe("A delivered Request changes", () => {
  it("posts the note that starts its run, linking the review, with the PR back to draft and the run on the Step-up model", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(777, 14);

    const plan = thread.delivered(777, 14);

    const [note, ...more] = commentsOn(plan, 50);
    expect(more).toEqual([]);
    expect(note).toContain(`[review 777](${PR_URL}#pullrequestreview-777)`);
    expect(note).not.toContain("@");
    expect(actionsOf(plan)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(startsOn(plan)).toMatchObject({ requestChanges: { review: 777 } });
  });

  it("names an earlier one of the Operator's GitHub never delivered too, which its run reads, so no check notes that one later", () => {
    const thread = new Thread();
    thread.review(101, 5);
    thread.mergeable = true;
    thread.review(102, 8);

    const [note] = commentsOn(thread.delivered(102, 8), 50);
    thread.markReady(30);

    expect(note).toContain("#pullrequestreview-101");
    expect(note).toContain("#pullrequestreview-102");
    expect(commentsOn(thread.tick(60), 50)).toEqual([]);
  });

  it("is never taken for undelivered, even once its run stalled and the Operator took the PR out of draft", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(777, 14);
    thread.delivered(777, 14);
    thread.markReady(30);

    const plan = thread.tick(60);

    expect(commentsOn(plan, 50)).toEqual([]);
    expect(addsImplement(plan) || actionsOf(plan).some((action) => action.kind === "convert-to-draft")).toBe(false);
  });

  it("holds back a Review of a head the Operator pushes meanwhile, whatever head the review was on", () => {
    const thread = new Thread();
    thread.mergeable = true;
    // The Operator pushed C at the Merge gate, then requested changes on it.
    thread.headSha = C;
    thread.review(777, 14);
    thread.delivered(777, 14);

    const review = thread.pushed(D, 20);

    expect(reasonOf(review)).toMatch(/Request-changes run .*in flight/);
    expect(commentsOn(thread.tick(60), 50)).toEqual([]);
  });

  it("whose claim lost the race to the tick's note runs once: the later run to land pushes nothing", () => {
    const thread = new Thread();
    thread.review(777, 14);
    // The tick noted the review before the event path's claim ran; the claim's fresh plan finds the PR in draft.
    thread.tick(60);
    expect(thread.delivered(777, 61).kind).toBe("nothing");
    thread.implement();

    expect(actionsOf(thread.requestChangesRunFinishes(BUILT, B, 90))).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    const second = thread.requestChangesRunFinishes(BUILT, C, 100);

    expect(actionsOf(second).some((action) => action.kind === "push-branch")).toBe(false);
    expect(reasonOf(second)).toContain("no Request-changes run in flight");
  });

  it("whose run lands only as its own: a run left over for an earlier review pushes nothing over the run a later one started", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(201, 14);
    thread.delivered(201, 14);
    // The Operator takes the PR back mid-run, then requests changes again, which starts a second run.
    thread.markReady(20);
    thread.review(202, 22);
    thread.delivered(202, 22);

    const leftOver = thread.requestChangesRunFinishes(BUILT, B, 40, 201);
    const own = thread.requestChangesRunFinishes(BUILT, C, 50, 202);

    expect(actionsOf(leftOver).some((action) => action.kind === "push-branch")).toBe(false);
    expect(reasonOf(leftOver)).toContain("review 201");
    expect(actionsOf(own)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
  });

  it("whose run committed nothing doesn't give way to an earlier review its run read: no run is started for it again", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(201, 14);
    thread.delivered(201, 14);
    // The Operator takes the PR back mid-run, so 201 is noted but never built, then requests changes again.
    thread.markReady(20);
    thread.review(202, 22);
    thread.delivered(202, 22);

    const empty = thread.requestChangesRunFinishes({ net: [], commits: [], updatedFromMain: false }, B, 40, 202);

    expect(commentsOn(empty, 50)[0]).not.toContain("goes first");
    expect(startsOn(thread.implement())?.requestChanges).toBeUndefined();
  });

  it("holds back a Retry that finishes while its run is in flight: even one that committed nothing posts no Verdict", () => {
    const thread = new Thread();
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(1) });
    thread.headSha = B;
    thread.reviewed("execution-flaw", 5);
    expect(startsOn(thread.implement())).toMatchObject({ retry: 1 });
    // Mid-Retry, the Operator takes the PR back and requests changes, which starts their run.
    thread.markReady(10);
    thread.review(201, 11);
    thread.delivered(201, 11);

    for (const changes of [{ net: [], commits: [], updatedFromMain: false }, BUILT]) {
      const retry = thread.retryFinishes(changes, C, 20);
      expect(commentsOn(retry, 50)).toEqual([]);
      expect(reasonOf(retry)).toContain("has a Request-changes run in flight");
    }
  });

  it("whose run still lands for an undelivered note's other review once the Operator dismisses the latest it named", () => {
    const thread = new Thread();
    thread.review(101, 10);
    thread.review(102, 12);
    thread.tick(60);
    thread.implement();
    thread.dismiss(102);

    const landed = thread.requestChangesRunFinishes(BUILT, B, 90, 102);

    expect(actionsOf(landed)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
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
    expect(addsImplement(plan)).toBe(false);
  });

  it("when the landed Verdict calls for a Retry, it gives way: it starts the Request-changes run instead, and no Retry is used", () => {
    const thread = reviewInFlight();

    const verdict = thread.reviewed("execution-flaw", 70);
    const [line] = commentsOn(verdict, 50);
    expect(line).toContain("goes first");
    expect(line).toContain(`${PR_URL}#pullrequestreview-5810278044`);
    expect(line).not.toContain("Retry 1 of 2");
    expect(actionsOf(verdict)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });

    const run = startsOn(thread.implement());
    expect(run).toMatchObject({ requestChanges: { review: 5810278044 } });
    expect(run).not.toHaveProperty("retry");
    // The Verdict started the run, so no check notes the review.
    expect(commentsOn(thread.mainPushed(80), 50)).toEqual([]);

    // An Execution flaw on the Request-changes run's push still has both of the Ticket's Retries left.
    thread.requestChangesRunFinishes(BUILT, D, 90);
    const next = thread.reviewed("execution-flaw", 100);
    expect(commentsOn(next, 50)[0]).toContain("Retry 1 of 2 starts now");
  });

  it("once a Verdict gave way, a Review of a head the Operator pushes waits for the Request-changes run", () => {
    const thread = reviewInFlight();
    thread.reviewed("execution-flaw", 70);

    const review = thread.pushed(D, 72);

    expect(reasonOf(review)).toMatch(/Request-changes run .*in flight/);
    expect(commentsOn(thread.tick(80), 50)).toEqual([]);
  });

  it("once the Operator dismisses the review a Verdict gave way to, its run is over: agent:implement hands the PR back at the Merge gate, and the flaw never costs a Retry", () => {
    const thread = reviewInFlight();
    thread.reviewed("execution-flaw", 70);
    thread.dismiss(5810278044);

    const resumed = thread.implement();

    expect(startsOn(resumed)).toBeUndefined();
    expect(commentsOn(resumed, 50)[0]).toContain("dismissed");
    expect(actionsOf(resumed)).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });
    // A later Request changes, and an Execution flaw on its run's push: the flaw that gave way used none of the two.
    thread.review(6000, 90);
    thread.delivered(6000, 90);
    thread.requestChangesRunFinishes(BUILT, D, 110);
    expect(commentsOn(thread.reviewed("execution-flaw", 120), 50)[0]).toContain("Retry 1 of 2 starts now");
  });

  it("once the Operator dismisses it while the Request-changes run works, the run's work isn't pushed, and the PR goes back to the Merge gate", () => {
    const thread = reviewInFlight();
    thread.reviewed("execution-flaw", 70);
    thread.implement();
    thread.dismiss(5810278044);

    const landed = thread.requestChangesRunFinishes(BUILT, D, 90);

    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(false);
    expect(commentsOn(landed, 50)[0]).toContain("dismissed");
    expect(addsImplement(landed)).toBe(false);
    expect(actionsOf(landed)).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });
  });

  it.each([
    ["before", true],
    ["after", false],
  ] as const)("a Request changes of the Operator's on the draft while that run works, submitted %s they dismiss the one it gave way to, gets its run instead", (_when, first) => {
    const thread = reviewInFlight();
    thread.reviewed("execution-flaw", 70);
    thread.implement();
    if (first) thread.review(5810278099, 80);
    thread.dismiss(5810278044);
    if (!first) thread.review(5810278099, 80);

    const landed = thread.requestChangesRunFinishes(BUILT, D, 90);

    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(false);
    expect(commentsOn(landed, 50)[0]).toContain("#pullrequestreview-5810278099");
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278099 } });
  });

  it("isn't brought back by dismissing its review after its Request-changes run built it: the flaw still uses no Retry", () => {
    const thread = reviewInFlight();
    thread.reviewed("execution-flaw", 70);
    thread.implement();
    thread.requestChangesRunFinishes(BUILT, D, 90);
    thread.reviewed("pass", 100);
    thread.dismiss(5810278044);
    thread.review(6000, 110);
    thread.delivered(6000, 110);
    thread.requestChangesRunFinishes(BUILT, E, 130);

    expect(commentsOn(thread.reviewed("execution-flaw", 140), 50)[0]).toContain("Retry 1 of 2 starts now");
  });

  it("once the Operator dismisses it after its Request-changes run handed the PR over, no Retry is left in flight to hold the PR", () => {
    const thread = reviewInFlight();
    thread.mergeable = false;
    thread.reviewed("execution-flaw", 70);
    thread.implement();
    thread.requestChangesRunFinishes({ net: [], commits: [], updatedFromMain: false, mainMerge: { main: MAIN, resolved: false } }, D, 90);
    thread.dismiss(5810278044);

    const push = thread.mainPushed(120, MAIN_2);

    expect(actionsOf(push).some((action) => action.kind === "rebase-onto-main")).toBe(true);
    // The rebase turns the PR back to draft, which doesn't bring the flaw's Retry back: the rebased head gets its Review.
    expect(startsOn(thread.pushed(thread.headSha, 125))).toMatchObject({ role: "review" });
  });

  it("a Retry the Operator took the PR back from never lands, not even as the outcome of a later flaw's Retry", () => {
    const thread = new Thread();
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(1) });
    thread.headSha = B;
    thread.reviewed("execution-flaw", 5);
    thread.implement();
    thread.markReady(10);
    thread.mainPushed(20, MAIN_2);
    thread.pushed(thread.headSha, 25);
    expect(commentsOn(thread.reviewed("execution-flaw", 40), 50)[0]).toContain("Retry 2 of 2");

    // The abandoned Retry 1's job finishes now, before Retry 2's.
    const abandoned = thread.retryFinishes(BUILT, C, 50, 1);
    expect(actionsOf(abandoned).some((action) => action.kind === "push-branch")).toBe(false);
    expect(actionsOf(thread.retryFinishes(BUILT, D, 60, 2))).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
  });

  it("a Retry the Operator took the PR back from never lands as a later flaw's Retry of the same number", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(6000, 5);
    thread.delivered(6000, 5);
    thread.requestChangesRunFinishes(BUILT, B, 10);
    // A flaw on a Request-changes run's push doesn't count, so this one and the next both call Retry 1.
    expect(commentsOn(thread.reviewed("execution-flaw", 15), 50)[0]).toContain("Retry 1 of 2");
    thread.implement();
    thread.markReady(20);
    thread.mergeable = false;
    thread.mainPushed(30, MAIN_2);
    thread.pushed(thread.headSha, 35);
    expect(commentsOn(thread.reviewed("execution-flaw", 40), 50)[0]).toContain("Retry 1 of 2");

    const abandoned = thread.retryFinishes(BUILT, C, 50, 1, B);
    const own = thread.retryFinishes(BUILT, D, 60, 1, E);

    expect(actionsOf(abandoned).some((action) => action.kind === "push-branch")).toBe(false);
    expect(actionsOf(own)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
  });

  it("a Retry the Operator took the PR back from stays over once the Kit's rebase turns the PR to draft again", () => {
    const thread = new Thread();
    thread.draft = true;
    thread.history.push({ kind: "draft", at: at(1) });
    thread.headSha = B;
    thread.reviewed("execution-flaw", 5);
    thread.implement();
    thread.markReady(10);

    thread.mainPushed(20, MAIN_2);

    expect(startsOn(thread.pushed(thread.headSha, 25))).toMatchObject({ role: "review" });
  });
});

describe("The Request-changes run an undelivered Request changes started", () => {
  /** The tick found the undelivered review on the conflicting PR and started its run. */
  function runStarted(): Thread {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.tick(60);
    thread.implement();
    return thread;
  }

  it("is over once the Operator takes the PR out of draft: its push lands nothing, and their next undelivered Request changes is noted", () => {
    const thread = runStarted();
    thread.markReady(70);

    expect(actionsOf(thread.requestChangesRunFinishes(BUILT, B, 90)).some((action) => action.kind === "push-branch")).toBe(false);
    thread.review(5810278099, 95);
    const tick = thread.tick(120);

    expect(commentsOn(tick, 50)[0]).toContain("#pullrequestreview-5810278099");
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278099 } });
  });

  it("is over once the Operator dismisses its review: agent:implement starts nothing, and no check notes it again", () => {
    const thread = runStarted();
    thread.dismiss(5810278044);

    expect(startsOn(thread.implement())).toBeUndefined();
    expect(commentsOn(thread.tick(120), 50)).toEqual([]);
  });

  it("once the Operator dismisses its review, its run's work isn't pushed, and the PR goes back to the Merge gate, saying so", () => {
    const thread = runStarted();
    thread.dismiss(5810278044);

    const landed = thread.requestChangesRunFinishes(BUILT, B, 90);

    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(false);
    expect(commentsOn(landed, 50)[0]).toContain("dismissed");
    expect(actionsOf(landed)).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });
  });

  it("whose review the Operator replaces mid-run pushes nothing of the dismissed one, and starts the replacement's run instead", () => {
    const thread = runStarted();
    thread.dismiss(5810278044);
    thread.review(5810278099, 70);

    const landed = thread.requestChangesRunFinishes(BUILT, B, 90);

    expect(actionsOf(landed).some((action) => action.kind === "push-branch")).toBe(false);
    expect(commentsOn(landed, 50)[0]).toContain("#pullrequestreview-5810278099");
    expect(addsImplement(landed)).toBe(true);
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278099 } });
    expect(actionsOf(thread.requestChangesRunFinishes(BUILT, C, 120))).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
  });

  it("whose review the Operator replaces while no run is working, as after an Infrastructure failure, has the replacement's run started by agent:implement", () => {
    const thread = runStarted();
    // The run failed without an outcome; the Operator dismisses its review and submits a corrected one on the draft.
    thread.dismiss(5810278044);
    thread.review(5810278099, 70);

    const resumed = thread.implement();

    expect(commentsOn(resumed, 50)[0]).toContain("#pullrequestreview-5810278099");
    expect(startsOn(resumed)).toMatchObject({ requestChanges: { review: 5810278099 } });
    expect(actionsOf(thread.requestChangesRunFinishes(BUILT, B, 120))).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
  });

  it("isn't joined by anyone else's review on the draft, which a resumed run is never started for", () => {
    const thread = runStarted();
    // Later, so with the larger ids: a run in flight is for the latest of its reviews.
    thread.review(9810278044, 70, "teammate");
    thread.review(9810278045, 71, "operator", true);

    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278044 } });
  });

  it("a review that joined it is never noted as undelivered once the run hands the PR over", () => {
    const thread = runStarted();
    thread.review(5810278099, 70);
    thread.requestChangesRunFinishes({ net: [], commits: [], updatedFromMain: false, mainMerge: { main: MAIN, resolved: false } }, B, 90);

    expect(commentsOn(thread.tick(180), 50)).toEqual([]);
  });

  it("still starts when the PR never went back to draft after the note: re-adding agent:implement turns it to draft first", () => {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.failsAt = "convert-to-draft";
    thread.tick(60);
    thread.failsAt = null;

    const resumed = thread.implement();

    expect(actionsOf(resumed)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
    expect(startsOn(resumed)).toMatchObject({ requestChanges: { review: 5810278044 } });
    expect(commentsOn(thread.tick(120), 50)).toEqual([]);
  });

  it.each(["add-labels", "convert-to-draft"] as const)(
    "still starts when the note's %s failed: the next check starts the run, quietly, which turns the PR to draft first",
    (failed) => {
      const thread = new Thread();
      thread.review(5810278044, 14);
      thread.failsAt = failed;
      thread.tick(60);
      thread.failsAt = null;
      expect(thread.draft).toBe(false);

      const next = thread.tick(120);

      expect(commentsOn(next, 50)).toEqual([]);
      expect(addsImplement(next)).toBe(true);
      const resumed = thread.implement();
      expect(actionsOf(resumed)).toContainEqual({ kind: "convert-to-draft", pullRequest: 50 });
      expect(startsOn(resumed)).toMatchObject({ requestChanges: { review: 5810278044 } });
    },
  );

  it("isn't started again by a check that reads the PR in the moment between the note and turning the PR to draft", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(777, 14);
    thread.failsAt = "convert-to-draft";
    thread.delivered(777, 14);
    thread.failsAt = null;

    expect(addsImplement(thread.mainPushed(14))).toBe(false);
  });

  it("of a delivered review whose claim failed before turning the PR to draft is started by the next check", () => {
    const thread = new Thread();
    thread.mergeable = true;
    thread.review(777, 14);
    thread.failsAt = "convert-to-draft";
    thread.delivered(777, 14);
    thread.failsAt = null;

    const next = thread.tick(60);

    expect(commentsOn(next, 50)).toEqual([]);
    expect(addsImplement(next)).toBe(true);
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 777 } });
  });
});

describe("A Request-changes run told to merge main in", () => {
  /** The tick found the undelivered review on the conflicting PR and started its run. */
  function runStarted(): Thread {
    const thread = new Thread();
    thread.review(5810278044, 14);
    thread.tick(60);
    thread.implement();
    return thread;
  }

  it.each([
    [
      "what it built still conflicts with main",
      { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false, mainMerge: { main: MAIN, resolved: false } },
      "still conflicts with `main`",
    ],
    ["it committed nothing", { net: [], commits: [], updatedFromMain: false, mainMerge: { main: MAIN, resolved: false } }, "it committed nothing"],
    [
      "the trust-root guard refuses it",
      { net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }], updatedFromMain: true, mainMerge: { main: MAIN, resolved: true } },
      "`.github/workflows/ci.yml`",
    ],
  ] as const)("when %s: says why on the PR, adds ready-for-human, takes the PR out of draft, keeps it open, and uses no Retry", (_case, changes, why) => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes(changes, B, 120);

    const actions = actionsOf(plan);
    expect(actions.some((action) => action.kind === "push-branch" || action.kind === "close-pull-request")).toBe(false);
    expect(addsImplement(plan)).toBe(false);
    const [note, ...more] = commentsOn(plan, 50);
    expect(more).toEqual([]);
    expect(note).toContain("@operator");
    expect(note).toContain(why);
    expect(note).not.toContain("Retry 1");
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(actions).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });

    // The run is over, and main at this head isn't tried again: neither check starts anything more.
    for (const later of [thread.tick(180), thread.mainPushed(185)]) {
      expect(commentsOn(later, 50)).toEqual([]);
      expect(actionsOf(later).some((action) => action.kind === "rebase-onto-main") || addsImplement(later)).toBe(false);
    }
    expect(startsOn(thread.implement())).toBeUndefined();
  });

  it("that handed off still has its Request changes go first once main moves: an Execution flaw on the rebased head uses no Retry", () => {
    const thread = runStarted();
    thread.requestChangesRunFinishes({ net: [], commits: [], updatedFromMain: false, mainMerge: { main: MAIN, resolved: false } }, B, 120);

    const check = thread.mainPushed(200, MAIN_2);
    expect(actionsOf(check).some((action) => action.kind === "rebase-onto-main")).toBe(true);
    const verdict = thread.reviewed("execution-flaw", 220);

    expect(commentsOn(verdict, 50)[0]).toContain("goes first");
    expect(commentsOn(verdict, 50)[0]).not.toContain("Retry 1 of 2");
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278044 } });
  });

  it("that resolved the conflict pushes, and its note says so, even when main has moved on since", () => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes(
      { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false, mainMerge: { main: MAIN, resolved: true } },
      B,
      120,
    );

    expect(actionsOf(plan)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    // It says what the push job saw, not who brought main in: the Operator may have, while the run worked.
    expect(commentsOn(plan, 50)[0]).toContain("which no longer conflicts with `main` at 9999999");
    expect(commentsOn(plan, 50)[0]).toContain("Conflicted files");
  });

  it("a Request-changes run that wasn't told to merge main in pushes as ever, though it didn't bring main in", () => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes({ net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false }, B, 120);

    expect(actionsOf(plan)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    expect(commentsOn(plan, 50)[0]).not.toContain("conflict with `main`");
  });

  it("a Request-changes run that wasn't told to merge main in, and that the trust-root guard refuses, still closes the PR, as before", () => {
    const thread = runStarted();

    const plan = thread.requestChangesRunFinishes({ net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }] }, B, 120);

    expect(actionsOf(plan)).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
  });
});

describe("A Request changes submitted while the Kit's mechanical rebase was under way", () => {
  it("doesn't hold back the rebased head's Review: an Execution flaw on it gives way and starts the Request-changes run", () => {
    const thread = new Thread();
    // The check read the PR before the review, which came in on the passed head just before the rebase turned it to draft.
    thread.mainPushed(50);
    thread.review(5810278044, 49);

    const verdict = thread.reviewed("execution-flaw", 70);

    expect(commentsOn(verdict, 50)[0]).toContain("goes first");
    expect(startsOn(thread.implement())).toMatchObject({ requestChanges: { review: 5810278044 } });
  });
});
