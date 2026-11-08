// A conflict-only run (#304): once main moves under an agent PR at the Merge
// gate and the mechanical rebase conflicts, one Implementer run on the Step-up
// model rebases the branch and resolves the conflicts. It uses no retry, and
// when it can't push, the PR goes to the Operator, never closed. These tests
// replay the PR's thread: each plan's comments are posted, and the next
// snapshot reads them back as the adapter does.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import {
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  conflictRunOnUnreviewedDraftIn,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  verdictsIn,
} from "../github/threads.ts";
import { verdictMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, BranchChanges, LoopEvent, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const MAIN = "9".repeat(40);
const NEXT_MAIN = "7".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

/** PR #50 for Ticket #7, which passed on A and waits at the Merge gate. */
class Thread {
  readonly comments: string[] = [verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A })];
  headSha = A;
  draft = false;
  labels: string[] = [];
  headPushedAt: string | null = null;

  pullRequest(): PullRequestSnapshot {
    return aPullRequest({
      headSha: this.headSha,
      draft: this.draft,
      labels: this.labels,
      verdicts: verdictsIn(this.comments),
      requestChangesRun: requestChangesRunIn(this.comments),
      conflictRun: conflictRunIn(this.comments),
      conflictAttempts: conflictAttemptsIn(this.comments),
      conflictRunInFlight: conflictRunInFlightIn(this.comments),
      conflictRunOnUnreviewedDraft: conflictRunOnUnreviewedDraftIn(this.comments),
      pushedSinceVerdict: pushedSinceVerdictIn(this.comments),
      headPushedAt: this.headPushedAt,
    });
  }

  ticketSnapshot(): Snapshot {
    return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: this.pullRequest(),
    });
  }

  conflictsSnapshot(main: string): Snapshot {
    return { ...snapshotOfPullRequest(this.pullRequest()), pullRequest: null, conflicts: { main, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: false }] } };
  }

  /** Applies these actions to the thread as the adapter would. */
  land(actions: readonly Action[]): void {
    for (const action of actions) {
      if (action.kind === "comment" && action.issue === 50) this.comments.push(action.body);
      if (action.kind === "convert-to-draft") this.draft = true;
      if (action.kind === "mark-ready-for-review") this.draft = false;
      if (action.kind === "add-labels" && action.issue === 50) this.labels.push(...action.labels);
    }
  }

  plan(event: LoopEvent, snapshot: Snapshot): Plan {
    const plan = planFor(event, snapshot, kitConfig());
    if (plan.kind === "act") this.land(plan.actions);
    return plan;
  }

  /** main moves to `main`, and the mechanical rebase of #50 onto it conflicts. */
  mainMovesAndConflicts(main: string): Plan {
    const plan = planFor({ kind: "main-pushed", head: main }, this.conflictsSnapshot(main), kitConfig());
    const rebase = actionsOf(plan).find((action) => action.kind === "rebase-onto-main");
    if (rebase?.kind === "rebase-onto-main") this.land(rebase.conflicted);
    return plan;
  }

  /** The conflict-only run finishes with these changes; if its plan pushes, the PR is at `to`. */
  conflictRunFinishes(changes: BranchChanges, to: string, main = MAIN): Plan {
    const plan = this.plan(conflictRunFinished(changes, main), this.ticketSnapshot());
    if (actionsOf(plan).some((action) => action.kind === "push-branch")) this.headSha = to;
    return plan;
  }
}

function conflictRunFinished(changes: BranchChanges, main = MAIN): Extract<LoopEvent, { kind: "implement-run-finished" }> {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({
      title: "Handle the empty cart",
      summary: "Handles the empty cart.",
      fix: "Conflicted files:\n- `src/cart.ts`: kept both the empty-cart guard and main's new total.",
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes,
    fixes: { pullRequest: 50, headSha: A, runUrl: RUN, conflict: main },
  };
}

const RESOLVED: BranchChanges = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: true };

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function redChecks(headSha: string): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha, failed: ["build"], runUrl: RUN };
}

describe("A conflict-only run", () => {
  it("starts on the Step-up model through agent:implement on the Ticket, on the PR's branch, as neither a Retry nor a Request-changes run", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const plan = thread.plan({ kind: "label-added", issue: 7, label: "agent:implement" }, thread.ticketSnapshot());

    const { stepUp, implement } = kitConfig().roles;
    const run = actionsOf(plan).find((action) => action.kind === "start-agent-run");
    expect(run).toMatchObject({
      role: "implement",
      issue: 7,
      pullRequest: 50,
      conflict: { main: MAIN },
      model: stepUp.model,
      effort: stepUp.effort,
      timeoutMinutes: implement.timeoutMinutes,
      stepUp: true,
      stepUpReason: "conflict-only",
    });
    expect(run).not.toHaveProperty("retry");
    expect(run).not.toHaveProperty("requestChanges");
  });

  it("is in flight until it lands: a Review on another head posts no Verdict, and an Operator push starts none", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);
    thread.headSha = B;

    expect(planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(thread.pullRequest()), kitConfig())).toEqual({
      kind: "nothing",
      reason: expect.stringContaining("The conflict-only run on #50 is still in flight"),
    });
    expect(planFor(redChecks(B), snapshotOfPullRequest(thread.pullRequest()), kitConfig())).toMatchObject({ kind: "nothing" });
  });

  it("pushes its resolution with a conflict-run note carrying its fix, which lists the conflicted files and how each was resolved", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const plan = thread.conflictRunFinishes(RESOLVED, B);

    expect(actionsOf(plan)).toContainEqual({ kind: "push-branch", branch: "fabrik/ticket-7" });
    const note = thread.comments.at(-1) ?? "";
    expect(note).toMatch(/^<!-- fabrik:conflict-run -->\n/);
    expect(note).toContain("- `src/cart.ts`: kept both the empty-cart guard and main's new total.");
  });

  it("uses no retry: the Verdict on its push is marked as from it, and the Ticket's two Retries count as before", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);
    thread.conflictRunFinishes(RESOLVED, B);

    // Its push starts a full Review, which finds the combined head red.
    expect(actionsOf(thread.plan({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(thread.pullRequest())))).toContainEqual(
      expect.objectContaining({ kind: "start-agent-run", role: "review" }),
    );
    thread.plan(redChecks(B), snapshotOfPullRequest(thread.pullRequest()));

    const verdict = thread.comments.at(-1) ?? "";
    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "ci", requestChanges: false, conflictRun: true, headSha: B }]);
    expect(verdict).toContain("after a conflict-only run");
    expect(verdict).toMatch(/Retry 1 of 2 starts now:/);

    // That Retry's push is red too: the conflict-only run's flaw counted none, so this is the
    // Ticket's first counted flaw, still Retry 1; the next is Retry 2, and then they're used up.
    const redRetry = (head: string) => {
      thread.comments.push("<!-- fabrik:retry-push -->\nThe Implementer pushed a fix.");
      thread.headSha = head;
      thread.plan(redChecks(head), snapshotOfPullRequest(thread.pullRequest()));
      return thread.comments.at(-1) ?? "";
    };
    expect(redRetry("c".repeat(40))).toMatch(/Retry 1 of 2 starts now:/);
    expect(redRetry("d".repeat(40))).toMatch(/Retry 2 of 2 starts now, stepped up:/);
    expect(redRetry("e".repeat(40))).not.toMatch(/Retry \d of 2 starts now/);
  });

  describe("that can't push", () => {
    it.each<[string, BranchChanges, RegExp]>([
      ["changes nothing", { net: [], commits: [], updatedFromMain: false }, /committed no change/],
      ["doesn't bring main in", { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false }, /didn't rebase onto `main`/],
      ["finds the branch moved under it", { net: [], commits: [], rebase: { onto: B, conflicted: true } }, /moved to bbbbbbb while it ran/],
      [
        "resolves a conflict inside a Trust-root file",
        { net: [{ path: ".github/workflows/ci.yml" }], commits: [{ path: ".github/workflows/ci.yml" }], updatedFromMain: true },
        /`\.github\/workflows\/ci\.yml`/,
      ],
    ])("when it %s, says why on the PR, adds ready-for-human, and brings the PR back to the Merge gate, never closing it", (_, changes, why) => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);

      const actions = actionsOf(thread.conflictRunFinishes(changes, B));

      expect(actions.some((action) => action.kind === "push-branch" || action.kind === "close-pull-request")).toBe(false);
      expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator /);
      expect(thread.comments.at(-1)).toMatch(why);
      expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
      expect(thread.draft).toBe(false);
      // It ends the run's time in flight, and uses no retry: the PR's history holds no new Verdict.
      expect(thread.pullRequest().conflictRunInFlight).toBeNull();
      expect(thread.pullRequest().verdicts).toHaveLength(1);
    });

    it("when its agent job fails, hands the PR to the Operator the same way", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      const failed: LoopEvent = {
        kind: "agent-run-failed",
        role: "implement",
        issue: 7,
        runUrl: RUN,
        jobResult: "failure",
        secretsStep: "success",
        report: null,
        conflict: { pullRequest: 50, main: MAIN },
      };

      const actions = actionsOf(thread.plan(failed, thread.ticketSnapshot()));

      expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator .*it crashed/);
      expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
      expect(actions).toContainEqual({ kind: "mark-ready-for-review", pullRequest: 50 });
      expect(thread.pullRequest().conflictRunInFlight).toBeNull();
    });

    it("when its output breaks the contract, still ends, so it never stays in flight", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);

      const plan = thread.plan({ ...conflictRunFinished(RESOLVED), output: "not JSON" }, thread.ticketSnapshot());

      expect(actionsOf(plan).some((action) => action.kind === "push-branch")).toBe(false);
      expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator .*broke the Implementer's contract/);
      expect(thread.pullRequest().conflictRunInFlight).toBeNull();
      expect(thread.draft).toBe(false);
    });

    it("when the Operator took the PR out of draft while it ran, still ends, leaving the PR where they put it", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      thread.draft = false;

      const actions = actionsOf(thread.conflictRunFinishes(RESOLVED, B));

      expect(actions.some((action) => action.kind === "push-branch" || action.kind === "mark-ready-for-review")).toBe(false);
      expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator .*has left draft/);
      expect(thread.pullRequest().conflictRunInFlight).toBeNull();
    });

    it("isn't tried again against the same main head, but is once main moves", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, B);

      expect(planFor({ kind: "main-pushed", head: MAIN }, thread.conflictsSnapshot(MAIN), kitConfig())).toMatchObject({ kind: "nothing" });
      expect(thread.mainMovesAndConflicts(NEXT_MAIN)).toMatchObject({ kind: "act" });
    });
  });
});

describe("A conflict-only run on a draft whose push GitHub never reviewed (#389)", () => {
  /**
   * PR #50 for Ticket #7, a draft whose head B was pushed an hour before the check, by
   * the run these comments record, and which GitHub never reviewed because it conflicts with main.
   */
  function stuckAfter(comments: readonly string[]): Thread {
    const thread = new Thread();
    thread.comments.splice(0, thread.comments.length, ...comments);
    thread.draft = true;
    thread.headSha = B;
    thread.headPushedAt = "2025-12-31T23:00:00Z";
    return thread;
  }

  const FLAW_ON_A = verdictMarker({ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: A });
  const PASS_ON_A = verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: A });

  /** The conflict-only run brings the stuck draft up to date, at C, and the Review of its push finds C red. */
  function conflictRunThenRed(thread: Thread): string {
    thread.mainMovesAndConflicts(MAIN);
    thread.conflictRunFinishes(RESOLVED, "c".repeat(40));
    thread.plan(redChecks("c".repeat(40)), snapshotOfPullRequest(thread.pullRequest()));
    return thread.comments.at(-1) ?? "";
  }

  it("starts as for a PR at the Merge gate, and the PR stays in draft", () => {
    const thread = stuckAfter([]);
    thread.mainMovesAndConflicts(MAIN);

    expect(thread.pullRequest().conflictRunInFlight).toBe(MAIN);
    expect(thread.draft).toBe(true);
  });

  it("pushes with a note that doesn't say its Verdict uses no retry", () => {
    const thread = stuckAfter([]);
    thread.mainMovesAndConflicts(MAIN);
    thread.conflictRunFinishes(RESOLVED, "c".repeat(40));

    const note = thread.comments.at(-1) ?? "";
    expect(note).toMatch(/^<!-- fabrik:conflict-run -->\n/);
    expect(note).not.toContain("uses no retry");
  });

  it("after a first Implement run, gets a Verdict that counts toward the two Retries, never exempt", () => {
    const verdict = conflictRunThenRed(stuckAfter([]));

    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: "c".repeat(40) }]);
    expect(verdict).not.toContain("conflict-only run");
    expect(verdict).toMatch(/Retry 1 of 2 starts now:/);
  });

  it("after a Retry, gets a Verdict that counts toward the two Retries, never exempt", () => {
    const verdict = conflictRunThenRed(stuckAfter([FLAW_ON_A, "<!-- fabrik:retry-push -->\nThe Implementer pushed a fix."]));

    expect(verdictsIn([verdict])[0]).not.toHaveProperty("conflictRun");
    expect(verdict).toMatch(/Retry 2 of 2 starts now, stepped up:/);
  });

  it("after a Request-changes run, gets a Verdict marked as a Request-changes one, which costs no retry", () => {
    const verdict = conflictRunThenRed(stuckAfter([PASS_ON_A, "<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes."]));

    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "ci", requestChanges: true, headSha: "c".repeat(40) }]);
    expect(verdict).toMatch(/Retry 1 of 2 starts now:/);
  });

  it("after a clean rebase of a Request-changes run's push, the Verdict is marked as a Request-changes one too", () => {
    const thread = stuckAfter([PASS_ON_A, "<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes."]);
    const plan = planFor({ kind: "main-pushed", head: MAIN }, thread.conflictsSnapshot(MAIN), kitConfig());
    const rebase = actionsOf(plan).find((action) => action.kind === "rebase-onto-main");
    if (rebase?.kind === "rebase-onto-main") thread.land([...rebase.clean, ...rebase.pushed]);
    thread.headSha = "c".repeat(40);

    thread.plan(redChecks("c".repeat(40)), snapshotOfPullRequest(thread.pullRequest()));

    expect(thread.draft).toBe(true);
    expect(verdictsIn([thread.comments.at(-1) ?? ""])).toEqual([{ verdict: "execution-flaw", source: "ci", requestChanges: true, headSha: "c".repeat(40) }]);
  });

  it("that can't push hands the PR to the Operator the same way: says why, adds ready-for-human, out of draft, never closed", () => {
    const thread = stuckAfter([]);
    thread.mainMovesAndConflicts(MAIN);

    const actions = actionsOf(thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, "c".repeat(40)));

    expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator /);
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(actions.some((action) => action.kind === "close-pull-request")).toBe(false);
    expect(thread.draft).toBe(false);
  });
});
