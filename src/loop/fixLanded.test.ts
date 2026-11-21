// When a check's issue closes as completed, the fix for the check is on main,
// so the Kit brings up to date each agent PR that check holds at the Merge
// gate (#784): the one exception to ADR-0011's "a PR only behind main is left
// alone", by ADR-0011's own path.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { fixBroughtTo } from "./conflicts.ts";
import { flakyCheckIssueMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, ClosedCheckIssue, ConflictCandidate, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const MAIN = "9".repeat(40);
const PASS_AT = "2026-11-18T08:00:00Z";

/** The Reviewer's pass on the PR's head, naming an Unrelated failure of `e2e`. */
const PASSED: VerdictRecord = { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, unrelated: ["e2e"] };

/** Agent PR #50 for Ticket #7 at the Merge gate, its pass held by an Unrelated failure of `e2e`. */
function heldAtGate(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({ draft: false, verdicts: [PASSED], verdictPostedAt: PASS_AT, ...overrides });
}

/** The check's issue, #12, which the Fabrik App filed for `e2e`, now closed. */
const CHECK_ISSUE = anIssue({ number: 12, open: false, byApp: true, body: `${flakyCheckIssueMarker("e2e")}\nThe required check \`e2e\` …`, labels: ["fabrik:flaky-check"] });

function closedAs(stateReason: "completed" | "not-planned" | "duplicate" | null): LoopEvent {
  return { kind: "issue-closed", issue: 12, stateReason };
}

const COMPLETED = closedAs("completed");

/** The check's issue closing, with every open agent PR as the conflict check reads them. */
function closing(candidates: readonly ConflictCandidate[], overrides: Partial<Snapshot> = {}): Snapshot {
  return snapshotOf(CHECK_ISSUE, { conflicts: { main: MAIN, now: "2026-11-18T10:00:00Z", implementJobUnderWay: null, pullRequests: candidates }, ...overrides });
}

/** PR #50, only behind main. */
const BEHIND: ConflictCandidate = { pullRequest: heldAtGate(), mergeable: true };

function rebasesIn(plan: Plan): Extract<Action, { kind: "rebase-onto-main" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "rebase-onto-main" }> => action.kind === "rebase-onto-main")
    : [];
}

function commentOn(actions: readonly Action[], issue: number): string {
  const comment = actions.find((action) => action.kind === "comment" && action.issue === issue);
  if (comment?.kind !== "comment") throw new Error(`No comment on #${issue}`);
  return comment.body;
}

describe("a check's issue closing as completed", () => {
  it("rebases an agent PR its check holds at the Merge gate, though it is only behind main, back in draft first so the push starts a Review", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([BEHIND]), kitConfig()));

    expect(rebase).toMatchObject({ pullRequest: 50, branch: "fabrik/ticket-7", onto: MAIN });
    expect(rebase?.clean).toEqual([{ kind: "convert-to-draft", pullRequest: 50 }]);
  });

  it("says on the PR that the fix for the check landed, naming the check and its issue, under the attempt marker for main's head", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([BEHIND]), kitConfig()));

    const note = commentOn(rebase?.pushed ?? [], 50);
    expect(note).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} rebased -->\n`));
    expect(note).toContain(
      "The fix for `e2e` landed: #12 closed as completed. #50 was held at the Merge gate by an Unrelated failure of it, and `main` is at 9999999, so the Kit rebased `fabrik/ticket-7` onto it. The rebase was clean, so no agent ran and no retry was used.",
    );
    expect(note).toContain("Review runs again on the rebased head");
  });

  it("when the rebase conflicts, starts one conflict-only run, as at the Merge gate, its note naming the check and its issue under the attempt marker", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([BEHIND]), kitConfig()));

    const note = commentOn(rebase?.conflicted ?? [], 50);
    expect(note).toMatch(new RegExp(`^<!-- fabrik:conflict-attempt ${MAIN} conflict-run -->\n`));
    expect(note).toContain("The fix for `e2e` landed: #12 closed as completed.");
    expect(note).toContain("A conflict-only Implementer run starts now, on the Step-up model");
    expect(rebase?.conflicted.slice(1)).toEqual([
      { kind: "convert-to-draft", pullRequest: 50 },
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
    ]);
  });

  it("rebases one that conflicts with main as well the same way, its notes saying the fix landed", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([{ pullRequest: heldAtGate(), mergeable: false }]), kitConfig()));

    expect(commentOn(rebase?.pushed ?? [], 50)).toContain("The fix for `e2e` landed: #12 closed as completed.");
  });

  it("still closes what any closed issue closes, and checks the queues", () => {
    const plan = planFor(COMPLETED, closing([BEHIND]), kitConfig());

    expect(plan.kind === "act" ? plan.actions.map(({ kind }) => kind) : []).toEqual(["check-dispatch", "check-design-queue", "rebase-onto-main"]);
  });
});

describe("what a check's issue closing leaves alone", () => {
  it.each([["not-planned" as const], ["duplicate" as const], [null]])("brings nothing up to date when it closed as %s", (reason) => {
    expect(rebasesIn(planFor(closedAs(reason), closing([BEHIND]), kitConfig()))).toEqual([]);
  });

  it("brings nothing up to date for an issue that isn't a check's", () => {
    const plain = anIssue({ number: 12, open: false, byApp: true, body: "Some other issue" });

    expect(rebasesIn(planFor(COMPLETED, snapshotOf(plain, { conflicts: closing([BEHIND]).conflicts }), kitConfig()))).toEqual([]);
  });

  it("leaves a PR alone whose pass names an Unrelated failure of another check", () => {
    const other = heldAtGate({ verdicts: [{ ...PASSED, unrelated: ["lint"] }] });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: other, mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("leaves a Plain pull request alone", () => {
    const plain = heldAtGate({ isAgent: false, ticket: null });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: plain, mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("leaves an agent PR alone whose pass names no Unrelated failure", () => {
    const { unrelated: _, ...clean } = PASSED;

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: heldAtGate({ verdicts: [clean] }), mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("leaves a PR alone whose head moved since its pass", () => {
    const moved = heldAtGate({ headSha: "b".repeat(40) });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: moved, mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("leaves a PR alone whose check has since read green on its head, by a Flaky check line", () => {
    const green = heldAtGate({ flakyCheckMarks: [{ headSha: HEAD_SHA, checks: ["e2e"] }] });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: green, mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("leaves a PR alone with a run in flight", () => {
    const inFlight = heldAtGate({ requestChangesRunInFlight: 9, notedChangesRequests: [9], requestChangesRunReviews: [9], requestChangesRunSince: "2026-11-18T09:00:00Z" });

    const plan = planFor(COMPLETED, closing([{ pullRequest: inFlight, mergeable: true }]), kitConfig());

    expect(rebasesIn(plan)).toEqual([]);
    expect(plan.kind === "act" ? plan.notes : []).toEqual([expect.stringContaining("still in flight")]);
  });

  it("leaves a PR alone with a Request changes from the Operator no run has started for, whose run brings main in", () => {
    const unbuilt = heldAtGate({ unbuiltChangesRequests: [{ review: 9, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-18T09:00:00Z" }] });

    const plan = planFor(COMPLETED, closing([{ pullRequest: unbuilt, mergeable: true }]), kitConfig());

    expect(rebasesIn(plan)).toEqual([]);
    expect(plan.kind === "act" ? plan.notes : []).toEqual([expect.stringContaining("Request changes from the Operator that no run has started for")]);
  });
});

describe("a PR the check holds that carries ready-for-human, whose Hand-back stands (#841)", () => {
  const handedBack: ConflictCandidate = { pullRequest: heldAtGate({ labels: ["ready-for-human"] }), mergeable: true };
  const other: ConflictCandidate = { pullRequest: heldAtGate({ number: 51, ticket: 8 }), mergeable: true };
  const CLOSED_SINCE: ClosedCheckIssue = { number: 12, check: "e2e", closedAt: "2026-11-18T09:00:00Z", stateReason: "completed" };
  const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-18T11:17:00Z" };
  const ticking = (candidates: readonly ConflictCandidate[]) =>
    tickSnapshot({ conflicts: { main: MAIN, now: "2026-11-18T11:17:00Z", implementJobUnderWay: false, pullRequests: candidates }, closedCheckIssues: [CLOSED_SINCE] });
  /** Every check-fix record a plan would write, on whichever outcome. */
  const checkFixRecords = (plan: Plan) =>
    rebasesIn(plan)
      .flatMap((rebase) => [...rebase.pushed, ...rebase.conflicted, ...(rebase.upToDate ?? [])])
      .filter((action) => action.kind === "comment" && action.body.includes("fabrik:check-fix"));

  it("brings it no fix when the check's issue closes, writes no check-fix record, and says why", () => {
    const plan = planFor(COMPLETED, closing([handedBack]), kitConfig());

    expect(rebasesIn(plan)).toEqual([]);
    expect(checkFixRecords(plan)).toEqual([]);
    expect(plan.kind === "act" ? plan.notes : []).toEqual([expect.stringContaining("#50 carries `ready-for-human`")]);
  });

  it("still brings up to date the other PRs the check holds", () => {
    const plan = planFor(COMPLETED, closing([handedBack, other]), kitConfig());

    expect(rebasesIn(plan).map(({ pullRequest }) => pullRequest)).toEqual([51]);
    // #51's rebase carries one record on each outcome (pushed, conflicted, already up to date), and #50 none.
    expect(checkFixRecords(plan).map((action) => action.kind === "comment" && action.issue)).toEqual([51, 51, 51]);
  });

  it("brings it no fix on the tick's catch-up either", () => {
    expect(rebasesIn(planFor(TICK, ticking([handedBack]), kitConfig()))).toEqual([]);
  });

  it("brings the fix in on the tick once the label is off", () => {
    const [rebase] = rebasesIn(planFor(TICK, ticking([BEHIND]), kitConfig()));

    expect(commentOn(rebase?.pushed ?? [], 50)).toContain("The fix for `e2e` landed: #12 closed as completed.");
  });
});

describe("a second close, or a later one, on the same main head", () => {
  it("tries nothing more once the PR was tried against main's head", () => {
    const tried = heldAtGate({ conflictAttempts: [MAIN] });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: tried, mergeable: true }]), kitConfig()))).toEqual([]);
  });

  it("tries nothing more once the Kit brought the fix in on this head, as when its conflict-only run ended without a push", () => {
    const spent = heldAtGate({ checkFixMarks: [{ headSha: HEAD_SHA, main: "8".repeat(40), outcome: "conflict-run", fixes: [{ check: "e2e", issue: 12 }] }] });

    expect(rebasesIn(planFor(COMPLETED, closing([{ pullRequest: spent, mergeable: true }]), kitConfig()))).toEqual([]);
  });
});

describe("the tick's conflict check, catching a close the issue-closed event missed", () => {
  const TICK: LoopEvent = { kind: "scheduled-tick", now: "2026-11-18T11:17:00Z" };

  function ticking(candidates: readonly ConflictCandidate[], closed: readonly ClosedCheckIssue[], overrides: Partial<Snapshot> = {}): Snapshot {
    return tickSnapshot({
      conflicts: { main: MAIN, now: TICK.kind === "scheduled-tick" ? TICK.now : "", implementJobUnderWay: false, pullRequests: candidates },
      closedCheckIssues: closed,
      ...overrides,
    });
  }

  const CLOSED_SINCE: ClosedCheckIssue = { number: 12, check: "e2e", closedAt: "2026-11-18T09:00:00Z", stateReason: "completed" };

  it("brings up to date a held PR whose check's issue closed as completed since its pass", () => {
    const [rebase] = rebasesIn(planFor(TICK, ticking([BEHIND], [CLOSED_SINCE]), kitConfig()));

    expect(rebase).toMatchObject({ pullRequest: 50, onto: MAIN });
    expect(commentOn(rebase?.pushed ?? [], 50)).toContain("The fix for `e2e` landed: #12 closed as completed.");
  });

  it("leaves it alone when the issue closed before its pass, whose Review already ran with the fix", () => {
    const before = { ...CLOSED_SINCE, closedAt: "2026-11-18T07:00:00Z" };

    expect(rebasesIn(planFor(TICK, ticking([BEHIND], [before]), kitConfig()))).toEqual([]);
  });

  it.each([["not-planned" as const], ["duplicate" as const]])("leaves it alone when the issue closed as %s", (stateReason) => {
    expect(rebasesIn(planFor(TICK, ticking([BEHIND], [{ ...CLOSED_SINCE, stateReason }]), kitConfig()))).toEqual([]);
  });

  it("leaves it alone when the check has since read green on its head, as the tick's own read finds", () => {
    const passedHeads = [
      {
        pullRequest: 50,
        ticket: 7,
        headSha: HEAD_SHA,
        required: ["e2e"],
        checkRuns: [
          { name: "e2e", status: "completed", conclusion: "failure", startedAt: "2026-11-18T07:00:00Z", url: "https://example.test/red" },
          { name: "e2e", status: "completed", conclusion: "success", startedAt: "2026-11-18T10:00:00Z", url: "https://example.test/green" },
        ],
        marks: [],
        excerpts: [],
      },
    ];

    expect(rebasesIn(planFor(TICK, ticking([BEHIND], [CLOSED_SINCE], { passedHeads }), kitConfig()))).toEqual([]);
  });

  it("records once a PR that already holds main's head, and then tries nothing more", () => {
    const [first] = rebasesIn(planFor(TICK, ticking([BEHIND], [CLOSED_SINCE]), kitConfig()));
    const recorded: ConflictCandidate = { ...BEHIND, pullRequest: heldAtGate({ checkFixMarks: [{ headSha: HEAD_SHA, main: MAIN, outcome: "held-main", fixes: [{ check: "e2e", issue: 12 }] }] }) };

    const later = planFor(TICK, ticking([recorded], [CLOSED_SINCE]), kitConfig());

    expect(first?.upToDate).toHaveLength(1);
    expect(rebasesIn(later)).toEqual([]);
    expect(later.kind === "act" ? later.actions.filter((action) => action.kind === "comment" && action.issue === 50) : []).toEqual([]);
  });

  it("tries nothing more on main's head once the PR was tried there", () => {
    const tried: ConflictCandidate = { ...BEHIND, pullRequest: heldAtGate({ conflictAttempts: [MAIN] }) };

    expect(rebasesIn(planFor(TICK, ticking([tried], [CLOSED_SINCE]), kitConfig()))).toEqual([]);
  });

  it("names every check whose fix landed in one rebase", () => {
    const both: ConflictCandidate = { ...BEHIND, pullRequest: heldAtGate({ verdicts: [{ ...PASSED, unrelated: ["e2e", "lint"] }] }) };
    const lint: ClosedCheckIssue = { number: 13, check: "lint", closedAt: "2026-11-18T09:30:00Z", stateReason: "completed" };

    const rebases = rebasesIn(planFor(TICK, ticking([both], [lint, CLOSED_SINCE]), kitConfig()));

    expect(rebases).toHaveLength(1);
    expect(commentOn(rebases[0]?.pushed ?? [], 50)).toContain("The fix for `lint` and `e2e` landed: #13 and #12 closed as completed. #50 was held at the Merge gate by an Unrelated failure of them");
  });

  it("leaves a PR that's only behind main alone on a push to main, as ADR-0011 says", () => {
    const pushed: LoopEvent = { kind: "main-pushed", head: MAIN };

    expect(rebasesIn(planFor(pushed, ticking([BEHIND], [CLOSED_SINCE], { closedCheckIssues: null }), kitConfig()))).toEqual([]);
  });
});

describe("the record a later rule reads of this move (#785)", () => {
  const mark = (outcome: "rebased" | "conflict-run" | "held-main", headSha = HEAD_SHA) => ({ headSha, main: MAIN, outcome, fixes: [{ check: "e2e", issue: 12 }] });

  it("says a head is the one the Kit brought the fix to, once the head moved past a rebase or a conflict-only run", () => {
    const old = "b".repeat(40);

    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("rebased", old)] }), "e2e")).toEqual({ issue: 12, outcome: "rebased" });
    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("conflict-run", old)] }), "e2e")).toEqual({ issue: 12, outcome: "conflict-run" });
  });

  it("says so of a head that already held main's head when the issue closed", () => {
    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("held-main")] }), "e2e")).toEqual({ issue: 12, outcome: "held-main" });
  });

  it("says nothing of a head the fix wasn't brought to: none recorded, another check's, or a conflict-only run that never pushed", () => {
    expect(fixBroughtTo(heldAtGate(), "e2e")).toBeNull();
    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("held-main")] }), "lint")).toBeNull();
    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("conflict-run")] }), "e2e")).toBeNull();
    expect(fixBroughtTo(heldAtGate({ checkFixMarks: [mark("held-main", "b".repeat(40))] }), "e2e")).toBeNull();
  });
});

describe("a PR that already holds main's head", () => {
  it("gets no push, and, as the rebase finds nothing to bring in, one note recording so, with no draft and no attempt marker", () => {
    const [rebase] = rebasesIn(planFor(COMPLETED, closing([BEHIND]), kitConfig()));

    expect(rebase?.upToDate).toEqual([
      {
        kind: "comment",
        issue: 50,
        body: [
          `<!-- fabrik:check-fix {"headSha":"${HEAD_SHA}","main":"${MAIN}","outcome":"held-main","fixes":[{"check":"e2e","issue":12}]} -->`,
          "The fix for `e2e` landed: #12 closed as completed. #50 was held at the Merge gate by an Unrelated failure of it, but its head aaaaaaa already holds `main` at 9999999, so there was nothing to bring in and nothing was pushed.",
        ].join("\n"),
      },
    ]);
  });

  it("records it once: a second close tries nothing more on that head", () => {
    const recorded: ConflictCandidate = { ...BEHIND, pullRequest: heldAtGate({ checkFixMarks: [{ headSha: HEAD_SHA, main: MAIN, outcome: "held-main", fixes: [{ check: "e2e", issue: 12 }] }] }) };

    const plan = planFor(COMPLETED, closing([recorded]), kitConfig());

    expect(rebasesIn(plan)).toEqual([]);
    expect(plan.kind === "act" ? plan.actions.filter((action) => action.kind === "comment") : []).toEqual([]);
  });

  it("is the only rebase that records an up-to-date branch: a PR main moved under leaves it unrecorded, as before", () => {
    const pushed: LoopEvent = { kind: "main-pushed", head: MAIN };
    const conflicting: ConflictCandidate = { pullRequest: heldAtGate({ verdicts: [{ ...PASSED, unrelated: [] }] }), mergeable: false };

    const [rebase] = rebasesIn(planFor(pushed, closing([conflicting]), kitConfig()));

    expect(rebase?.upToDate).toBeUndefined();
  });
});
