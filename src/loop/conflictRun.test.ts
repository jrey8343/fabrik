// A conflict-only run (#304): once main moves under an agent PR at the Merge
// gate and the mechanical rebase conflicts, one Implementer run on the Step-up
// model rebases the branch and resolves the conflicts. It uses no retry, though
// an Execution flaw on its push calls for one (#415), and when it can't push, the PR goes to the Operator, never closed. These tests
// replay the PR's thread: each plan's comments are posted, and the next
// snapshot reads them back as the adapter does.
import { describe, expect, it } from "vitest";
import { aCausedRedCheckReview, anIssue, aPullRequest, kitConfig, NO_TAGS, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
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
import { handBackMarkIn } from "./markers.ts";
import type { Action, BranchChanges, LoopEvent, NamedPullRequestSnapshot, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

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

  ticketSnapshot(namedPullRequests: readonly NamedPullRequestSnapshot[] | null = null): Snapshot {
    return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), {
      pullRequest: this.pullRequest(),
      namedPullRequests,
    });
  }

  conflictsSnapshot(main: string): Snapshot {
    return { ...snapshotOfPullRequest(this.pullRequest()), pullRequest: null, conflicts: { main, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [{ pullRequest: this.pullRequest(), mergeable: false }] } };
  }

  /** The Operator gives a handed-back PR back to the Kit, taking `ready-for-human` off it (#841). */
  giveBack(): void {
    this.labels = this.labels.filter((label) => label !== "ready-for-human");
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
    runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
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
/** A change of the run's own on a branch that holds main neither as the run started nor as it is now. */
const MAIN_NOT_BROUGHT_IN: BranchChanges = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }], updatedFromMain: false };
const STANDS = "#50 is yours while it carries `ready-for-human`: the Kit leaves its branch alone until then, and taking the label off gives it back.";

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

/** The Review of `headSha` finishes with its Required check `build` still red, which the Reviewer judged caused: an Execution flaw that counts. */
function redChecks(headSha: string): LoopEvent {
  return aCausedRedCheckReview({ headSha, runUrl: RUN });
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

  it("whose changes say it brought main in lands with its push and a note naming the head it was started for, and no hand-back (#861)", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const actions = actionsOf(thread.conflictRunFinishes(RESOLVED, B));

    expect(actions.map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(thread.comments.at(-1)).toContain("The Implementer rebased `fabrik/ticket-7` onto `main` at 9999999 and resolved its conflicts");
    expect(thread.comments.some((comment) => comment.includes("fabrik:conflict-run-ended") || comment.includes("fabrik:hand-back"))).toBe(false);
    expect(thread.labels).not.toContain("ready-for-human");
  });

  it("uses no retry itself, but a flaw on its push calls for one from the Ticket's pool of two, like any other (#415)", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);
    thread.conflictRunFinishes(RESOLVED, B);

    // Its push starts a full Review, which finds the combined head red.
    expect(actionsOf(thread.plan({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(thread.pullRequest())))).toContainEqual(
      expect.objectContaining({ kind: "start-agent-run", role: "review" }),
    );
    thread.plan(redChecks(B), snapshotOfPullRequest(thread.pullRequest()));

    const verdict = thread.comments.at(-1) ?? "";
    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, conflictRun: true, checks: ["build"], tags: NO_TAGS, headSha: B }]);
    expect(verdict).toContain("after a conflict-only run");
    // The conflict-only run ran on the Step-up model, so the Retry its flaw calls for does too (#464).
    expect(verdict).toMatch(/Retry 1 of 2 starts now, stepped up:/);

    // That Retry's push is red too: the conflict-only run's flaw started Retry 1, so this one is
    // Retry 2, and then they're used up. No Retry number starts twice on one PR (ADR-0006).
    const redRetry = (head: string) => {
      thread.comments.push("<!-- fabrik:retry-push -->\nThe Implementer pushed a fix.");
      thread.headSha = head;
      thread.plan(redChecks(head), snapshotOfPullRequest(thread.pullRequest()));
      return thread.comments.at(-1) ?? "";
    };
    expect(redRetry("c".repeat(40))).toMatch(/Retry 2 of 2 starts now, stepped up:/);
    expect(redRetry("d".repeat(40))).not.toMatch(/Retry \d of 2 starts now/);
  });

  describe("that can't push", () => {
    it.each<[string, BranchChanges, RegExp]>([
      ["changes nothing", { net: [], commits: [], updatedFromMain: false }, /committed no change/],
      ["doesn't bring main in", MAIN_NOT_BROUGHT_IN,/holds `main` neither as the run started nor as it is now/],
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

    it("when its branch holds main neither as it started nor as it is now, says what the push job found, in the same hand-back notice (#861)", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);

      thread.conflictRunFinishes(MAIN_NOT_BROUGHT_IN, B);

      const notice = thread.comments.at(-1) ?? "";
      expect(notice).toBe(
        [
          "<!-- fabrik:conflict-run-ended -->",
          "@operator The conflict-only run on #50 didn't bring it up to date with `main` at 9999999: `fabrik/ticket-7` holds `main` neither as the run started nor as it is now.",
          "",
          `The PR still conflicts with \`main\`, so it's yours to resolve. ${STANDS} No retry was used.`,
          "",
          `[The run](${RUN})`,
          '<!-- fabrik:hand-back {"kind":"conflict-run-unlanded","role":"implement"} -->',
        ].join("\n"),
      );
      expect(notice).not.toContain("didn't rebase");
      expect(handBackMarkIn(notice)).toEqual({ kind: "conflict-run-unlanded", role: "implement" });
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

    it("isn't tried again while it carries ready-for-human, however often main moves (#841)", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, B);

      expect(thread.labels).toContain("ready-for-human");
      expect(thread.mainMovesAndConflicts(NEXT_MAIN)).toEqual({ kind: "nothing", reason: expect.stringContaining("#50 carries `ready-for-human`") });
      expect(thread.draft).toBe(false);
    });

    it("once the Operator takes the label off, waits for main to move from the head it was tried against", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, B);
      thread.giveBack();

      expect(planFor({ kind: "main-pushed", head: MAIN }, thread.conflictsSnapshot(MAIN), kitConfig())).toEqual({ kind: "nothing", reason: expect.stringContaining("already tried against main") });
      expect(thread.mainMovesAndConflicts(NEXT_MAIN)).toMatchObject({ kind: "act" });
    });

    it("once the label is off after main moved while it stood, is tried at the next conflict check", () => {
      const thread = new Thread();
      thread.mainMovesAndConflicts(MAIN);
      thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, B);
      thread.mainMovesAndConflicts(NEXT_MAIN);
      thread.giveBack();

      const tick = planFor({ kind: "scheduled-tick", now: "2026-01-01T01:17:00Z" }, tickSnapshot({ conflicts: thread.conflictsSnapshot(NEXT_MAIN).conflicts }), kitConfig());

      expect(actionsOf(tick)).toContainEqual(expect.objectContaining({ kind: "rebase-onto-main", pullRequest: 50, onto: NEXT_MAIN }));
    });
  });
});

describe("A conflict-only run that finds main already holds the PR's work (#845)", () => {
  const COMPARED = "Compared #50's diff with #49's: #49 adds the same empty-cart guard to `src/cart.ts`, so nothing of #50's own is left.";
  const UNCHANGED: BranchChanges = { net: [], commits: [], updatedFromMain: false };

  /** The run finishes naming #49 in `supersededBy`, which the snapshot holds as `named`. */
  function supersededRun(thread: Thread, named: readonly NamedPullRequestSnapshot[] | null, supersededBy: number = 49, changes: BranchChanges = UNCHANGED): Plan {
    const event = conflictRunFinished(changes);
    const output = { title: "Handle the empty cart", summary: "Handles the empty cart.", fix: COMPARED, supersededBy };
    return thread.plan({ ...event, output: JSON.stringify(output) }, thread.ticketSnapshot(named));
  }

  /** #49, as GitHub has it: merged into main after #50's merge base, closing Ticket #6, unless a test says otherwise. */
  function pr49(overrides: Partial<NamedPullRequestSnapshot> = {}, superseding: Partial<NonNullable<NamedPullRequestSnapshot["superseding"]>> = {}): NamedPullRequestSnapshot {
    return { number: 49, open: false, merged: true, headRef: "fabrik/ticket-6", isAgent: true, superseding: { intoMain: true, sinceMergeBase: true, ticket: 6, ...superseding }, ...overrides };
  }

  it("hands the PR back as probably superseded by the merged PR it names, naming that PR's Ticket, and points to closing the PR and its Ticket", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const actions = actionsOf(supersededRun(thread, [pr49()]));

    expect(thread.comments.at(-1)).toBe(
      [
        "<!-- fabrik:conflict-run-ended -->",
        "@operator The conflict-only run on #50 didn't bring it up to date with `main` at 9999999: it found that `main` already holds the whole of its change, merged in #49.",
        "",
        `#50 is probably superseded by #49, which closed #6. Check #49 first; if it does hold this PR's work, close #50 and its Ticket #7 as duplicates. ${STANDS} No retry was used.`,
        "",
        "**What the Implementer said:**",
        "",
        COMPARED,
        "",
        `[The run](${RUN})`,
        '<!-- fabrik:hand-back {"kind":"conflict-run-superseded","role":"implement"} -->',
      ].join("\n"),
    );
    expect(thread.comments.at(-1)).not.toContain("yours to resolve");
    // As every conflict-only run that can't push: ready-for-human, out of draft, ended, no retry used, nothing closed.
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(thread.draft).toBe(false);
    expect(actions.some((action) => action.kind === "push-branch" || action.kind === "close-pull-request" || action.kind === "close" || action.kind === "close-as-superseded")).toBe(false);
    expect(thread.pullRequest().conflictRunInFlight).toBeNull();
    expect(thread.pullRequest().verdicts).toHaveLength(1);
  });

  it("names no Ticket of the superseding PR when it closed none", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    supersededRun(thread, [pr49({}, { ticket: null })]);

    expect(thread.comments.at(-1)).toContain("#50 is probably superseded by #49. Check #49 first;");
  });

  it("still pushes nothing when the run rebased anyway, since it says nothing of the PR's own is left", () => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const actions = actionsOf(supersededRun(thread, [pr49()], 49, RESOLVED));

    expect(actions.some((action) => action.kind === "push-branch")).toBe(false);
    expect(handBackMarkIn(thread.comments.at(-1) ?? "")).toEqual({ kind: "conflict-run-superseded", role: "implement" });
  });

  it.each<[string, readonly NamedPullRequestSnapshot[] | null, number, RegExp]>([
    ["an open PR", [pr49({ open: true, merged: false }, { intoMain: false })], 49, /#49 isn't merged/],
    ["a PR closed unmerged", [pr49({ merged: false }, { intoMain: false })], 49, /#49 isn't merged/],
    ["a PR merged into another branch", [pr49({}, { intoMain: false })], 49, /#49 didn't merge into `main`/],
    ["a PR merged before the merge base", [pr49({}, { sinceMergeBase: false })], 49, /#49 merged into `main` before #50's merge base with it/],
    ["the PR itself", [pr49({ number: 50 })], 50, /names #50 itself/],
    ["a number that isn't a PR", [], 49, /#49 is no pull request/],
  ])("ignores a run that names %s, handing the PR back as it always has, and says why in the run's log", (_, named, supersededBy, why) => {
    const thread = new Thread();
    thread.mainMovesAndConflicts(MAIN);

    const plan = supersededRun(thread, named, supersededBy);

    expect(thread.comments.at(-1)).toBe(
      [
        "<!-- fabrik:conflict-run-ended -->",
        "@operator The conflict-only run on #50 didn't bring it up to date with `main` at 9999999: it committed no change to `fabrik/ticket-7`.",
        "",
        `The PR still conflicts with \`main\`, so it's yours to resolve. ${STANDS} No retry was used.`,
        "",
        `[The run](${RUN})`,
        '<!-- fabrik:hand-back {"kind":"conflict-run-unlanded","role":"implement"} -->',
      ].join("\n"),
    );
    expect(plan.kind === "act" ? plan.notes : undefined).toEqual([expect.stringMatching(why)]);
  });
});

describe("supersededBy on a run that isn't conflict-only (#845)", () => {
  it("is ignored: a retry that names a merged PR lands as any retry does", () => {
    const thread = new Thread();
    const retry: LoopEvent = {
      kind: "implement-run-finished",
      runUrl: RUN,
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Fixed the guard.", supersededBy: 49 }),
      branch: "fabrik/ticket-7",
      base: "fabrik/ticket-7",
      changes: RESOLVED,
      fixes: { pullRequest: 50, headSha: A, runUrl: RUN },
    };
    const named: NamedPullRequestSnapshot[] = [{ number: 49, open: false, merged: true, headRef: "fabrik/ticket-6", isAgent: true, superseding: { intoMain: true, sinceMergeBase: true, ticket: 6 } }];

    const withField = planFor(retry, thread.ticketSnapshot(named), kitConfig());
    const without = planFor({ ...retry, output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Fixed the guard." }) }, thread.ticketSnapshot(null), kitConfig());

    expect(withField).toEqual(without);
  });
});

describe("A conflict-only run on a draft whose push GitHub never reviewed (#389)", () => {
  /**
   * PR #50 for Ticket #7, a draft whose head B was pushed an hour before the check, by
   * the run these comments record, and which GitHub never reviewed because it conflicts with main.
   */
  function unreviewedAfter(comments: readonly string[]): Thread {
    const thread = new Thread();
    thread.comments.splice(0, thread.comments.length, ...comments);
    thread.draft = true;
    thread.headSha = B;
    thread.headPushedAt = "2025-12-31T22:50:00Z";
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
    const thread = unreviewedAfter([]);
    thread.mainMovesAndConflicts(MAIN);

    expect(thread.pullRequest().conflictRunInFlight).toBe(MAIN);
    expect(thread.draft).toBe(true);
  });

  it("pushes with a note that doesn't say its Verdict uses no retry", () => {
    const thread = unreviewedAfter([]);
    thread.mainMovesAndConflicts(MAIN);
    thread.conflictRunFinishes(RESOLVED, "c".repeat(40));

    const note = thread.comments.at(-1) ?? "";
    expect(note).toMatch(/^<!-- fabrik:conflict-run -->\n/);
    expect(note).not.toContain("uses no retry");
  });

  it("after a first Implement run, gets a Verdict that counts toward the two Retries, never exempt", () => {
    const verdict = conflictRunThenRed(unreviewedAfter([]));

    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "reviewer", requestChanges: false, checks: ["build"], tags: NO_TAGS, headSha: "c".repeat(40) }]);
    expect(verdict).not.toContain("conflict-only run");
    expect(verdict).toMatch(/Retry 1 of 2 starts now:/);
  });

  it("after a Retry, gets a Verdict that counts toward the two Retries, never exempt", () => {
    const verdict = conflictRunThenRed(unreviewedAfter([FLAW_ON_A, "<!-- fabrik:retry-push -->\nThe Implementer pushed a fix."]));

    expect(verdictsIn([verdict])[0]).not.toHaveProperty("conflictRun");
    expect(verdict).toMatch(/Retry 2 of 2 starts now, stepped up:/);
  });

  it("after a Request-changes run, gets a Verdict marked as a Request-changes one, whose flaw counts as one on that run's push would (#393)", () => {
    const verdict = conflictRunThenRed(unreviewedAfter([PASS_ON_A, "<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes."]));

    expect(verdictsIn([verdict])).toEqual([{ verdict: "execution-flaw", source: "reviewer", requestChanges: true, checks: ["build"], tags: NO_TAGS, headSha: "c".repeat(40) }]);
    expect(verdict).toMatch(/Retry 1 of 2 starts now, stepped up:/);
  });

  it("after a clean rebase of a Request-changes run's push, the Verdict is marked as a Request-changes one too", () => {
    const thread = unreviewedAfter([PASS_ON_A, "<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes."]);
    const plan = planFor({ kind: "main-pushed", head: MAIN }, thread.conflictsSnapshot(MAIN), kitConfig());
    const rebase = actionsOf(plan).find((action) => action.kind === "rebase-onto-main");
    if (rebase?.kind === "rebase-onto-main") thread.land([...rebase.clean, ...rebase.pushed]);
    thread.headSha = "c".repeat(40);

    thread.plan(redChecks("c".repeat(40)), snapshotOfPullRequest(thread.pullRequest()));

    expect(thread.draft).toBe(true);
    expect(verdictsIn([thread.comments.at(-1) ?? ""])).toEqual([{ verdict: "execution-flaw", source: "reviewer", requestChanges: true, checks: ["build"], tags: NO_TAGS, headSha: "c".repeat(40) }]);
  });

  it("that can't push hands the PR to the Operator the same way: says why, adds ready-for-human, out of draft, never closed", () => {
    const thread = unreviewedAfter([]);
    thread.mainMovesAndConflicts(MAIN);

    const actions = actionsOf(thread.conflictRunFinishes({ net: [], commits: [], updatedFromMain: false }, "c".repeat(40)));

    expect(thread.comments.at(-1)).toMatch(/^<!-- fabrik:conflict-run-ended -->\n@operator /);
    expect(actions).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(actions.some((action) => action.kind === "close-pull-request")).toBe(false);
    expect(thread.draft).toBe(false);
  });
});
