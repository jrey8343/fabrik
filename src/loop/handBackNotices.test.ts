// Every notice by which the Kit hands work back ends with one hidden line
// naming which hand-back it is (src/loop/markers.ts), so the Standing reads
// it from GitHub (src/kit/standingHandBacks.ts). Each notice's visible text is
// held word for word by its own module's tests, which end with that line now.
import { describe, expect, it } from "vitest";
import { aLabelledTrigger, anIssue, aPullRequest, kitConfig, NOTHING_UNDER_WAY, snapshotOf, snapshotOfPullRequest, tickSnapshot, withoutNotes } from "../__fixtures__/snapshots.ts";
import { claimLanding, landingFailureReport, pushLanding } from "../kit/landingFailure.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { conflictRunEnded, requestChangesRunEnded } from "./conflicts.ts";
import { prototypeTurnRefused } from "./failures.ts";
import { type HandBackMark, handBackMarkIn } from "./markers.ts";
import { stopForGoneKeptBranch } from "./keptBranch.ts";
import { unstartedRetry } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function commentsOf(planOrActions: Plan | readonly Action[]): string[] {
  const actions = Array.isArray(planOrActions) ? planOrActions : (planOrActions as Plan).kind === "act" ? (planOrActions as Extract<Plan, { kind: "act" }>).actions : [];
  return (actions as readonly Action[]).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

/** The one comment's hand-back, read from its last line, which is the hidden line and nothing else. */
function handBackOf(body: string | undefined): HandBackMark | null {
  const last = body?.split("\n").at(-1) ?? "";
  expect(last).toMatch(/^<!-- fabrik:hand-back \{.*\} -->$/);
  return handBackMarkIn(last);
}

function failed(overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent {
  return { kind: "agent-run-failed", role: "triage", issue: 7, runUrl: RUN, jobResult: "failure", secretsStep: "success", report: null, ...overrides };
}

describe("The hidden hand-back line", () => {
  describe("on a failure notice", () => {
    it("names an Infrastructure failure, its role and which failure", () => {
      const plan = planFor(failed({ jobResult: "cancelled", secretsStep: null }), snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), kitConfig());
      expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "infrastructure-failure", role: "triage", failure: "timeout" });
    });

    it("names a Review's on its PR, which carries no marker of its own", () => {
      const plan = planFor(failed({ role: "review", report: { failure: "missing-output", detail: "" } }), snapshotOf(anIssue({ number: 7, openPullRequests: [12] })), kitConfig());
      expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "infrastructure-failure", role: "review", failure: "missing-output" });
    });

    it("names a Broken run that used no retry, and which", () => {
      const plan = planFor(
        failed({ role: "implement", report: { failure: "left-branch", detail: "" } }),
        snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] }), { pullRequest: aPullRequest({ number: 50, ticket: 7, requestChangesRunInFlight: 9001 }) }),
        kitConfig(),
      );
      expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "broken-run-no-retry", role: "implement", failure: "left-branch" });
    });

    it("names a failed Research run and a failed Design-session turn as their own hand-backs", () => {
      const research = planFor(failed({ role: "research", issue: 12 }), snapshotOf(anIssue({ number: 12, labels: ["wayfinder:research"] })), kitConfig());
      const design = planFor(failed({ role: "design" }), snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());
      expect(handBackOf(commentsOf(research)[0])).toEqual({ kind: "research-failed", role: "research", failure: "crash" });
      expect(handBackOf(commentsOf(design)[0])).toEqual({ kind: "design-turn-failed", role: "design", failure: "crash", run: 42 });
    });

    it("names a prototype turn the Kit couldn't land as a failed Design-session turn", () => {
      expect(handBackOf(commentsOf(prototypeTurnRefused(7, "operator", "its output broke the contract", RUN))[0])).toEqual({ kind: "design-turn-failed", role: "design", run: 42 });
    });

    it("names a failed Design-session turn's run, a prototype turn's included, and only theirs (#640)", () => {
      const design = (prototype: boolean) => planFor(failed({ role: "design", prototype }), snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());
      const implement = planFor(failed({ role: "implement" }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig());
      expect(handBackOf(commentsOf(design(false))[0])?.run).toBe(42);
      expect(handBackOf(commentsOf(design(true))[0])?.run).toBe(42);
      expect(handBackOf(commentsOf(implement)[0])).not.toHaveProperty("run");
    });

    it("names no run where the run's address isn't an Actions run's, and the notice still hands the turn back", () => {
      const plan = planFor(failed({ role: "design", runUrl: "https://example.com/somewhere" }), snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());
      expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "design-turn-failed", role: "design", failure: "crash" });
    });

    it("is on no counted Broken run, which is an Execution flaw the Kit re-runs itself", () => {
      const plan = planFor(failed({ role: "implement", report: { failure: "left-branch", detail: "" } }), snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig());
      expect(commentsOf(plan).map(handBackMarkIn)).toEqual([null]);
    });
  });

  it("names a conflict-only run and a Request-changes run that didn't land", () => {
    expect(handBackOf(commentsOf(conflictRunEnded(50, "d".repeat(40), "operator", "it changed nothing", RUN))[0])).toEqual({ kind: "conflict-run-unlanded", role: "implement" });
    expect(handBackOf(commentsOf(requestChangesRunEnded(50, "d".repeat(40), "operator", "it still conflicts", RUN))[0])).toEqual({
      kind: "request-changes-unlanded",
      role: "implement",
    });
  });

  it("names a Retry that never started on a Ticket no longer ready-for-agent", () => {
    const flaw = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) } as const;
    const pullRequest = aPullRequest({ number: 50, ticket: 7, ticketLabels: ["enhancement"], verdicts: [flaw], verdictPostedAt: "2026-11-07T05:00:00Z", headSha: "a".repeat(40) });
    const actions = unstartedRetry(pullRequest, "operator", "2026-11-07T09:00:00Z", 90, false);
    expect(handBackOf(commentsOf(actions ?? [])[0])).toEqual({ kind: "retry-never-started", role: "implement" });
  });

  it.each([
    ["agent:implement", "implement"],
    ["agent:review", "review"],
    ["agent:research", "research"],
    ["agent:design", "design"],
  ] as const)("names a trigger label the sweep took off, %s, with its role", (label, role) => {
    const plan = withoutNotes(
      planFor({ kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" }, tickSnapshot({ triggers: { underWay: NOTHING_UNDER_WAY, labelled: [aLabelledTrigger({ number: 7, label, readded: true })] } }), kitConfig()),
    );
    expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "trigger-swept", role });
  });

  it("names a Replay's trigger label the sweep took off with no role, as no one role's run is behind it", () => {
    const plan = withoutNotes(
      planFor(
        { kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" },
        tickSnapshot({ triggers: { underWay: NOTHING_UNDER_WAY, labelled: [aLabelledTrigger({ number: 7, label: "agent:replay", readded: true })] } }),
        kitConfig(),
      ),
    );
    expect(handBackOf(commentsOf(plan).find((body) => body.includes("came off")))).toEqual({ kind: "trigger-swept" });
  });

  it("names a push or claim job that failed, with the role whose run it was landing where it knows it", () => {
    const push = pushLanding({ kind: "agent-result", role: "implement", issue: 7, pullRequest: null } as Parameters<typeof pushLanding>[0], RUN);
    const pushed = landingFailureReport(push!, { kind: "error", error: new Error("boom") }, "operator");
    const claimed = landingFailureReport(claimLanding(7, RUN), { kind: "error", error: new Error("boom") }, "operator");
    expect(handBackOf(pushed.comment?.body)).toEqual({ kind: "landing-failed", role: "implement" });
    expect(handBackOf(claimed.comment?.body)).toEqual({ kind: "landing-failed" });
  });

  it("names a Research run whose branch the Kit refused apart from one that failed", () => {
    const plan = planFor(
      {
        kind: "research-run-finished",
        issue: 12,
        runUrl: RUN,
        repoUrl: "https://github.com/acme/shop",
        branch: "research/12-which-payment-provider-fits-group-classes",
        output: JSON.stringify({ gist: "Stripe.", keyFacts: ["Stripe Connect splits charges"] }),
        changes: { net: [], commits: [] },
      },
      snapshotOf(
        anIssue({
          number: 12,
          title: "Which payment provider fits group classes?",
          labels: ["wayfinder:research"],
          parent: 3,
          parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
        }),
      ),
      kitConfig(),
    );
    const refusal = commentsOf(plan).find((body) => body.startsWith("<!-- fabrik:research-run-failed -->"));
    expect(handBackOf(refusal)).toEqual({ kind: "research-branch-refused", role: "research" });
  });

  it("names a Map the Map cap refused", () => {
    const output = {
      kind: "map",
      comment: "Too foggy for one session, so it's a Map.",
      destination: "Patients book group classes online.",
      notes: "",
      notYetSpecified: "",
      outOfScope: "",
      decisions: [{ key: "provider", title: "Which provider?", body: "## Question\n\nWhich one?", type: "research", blockedBy: [] }],
    };
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), { operator: "jrey", openMaps: [12] }),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, maps: 1 } }),
    );
    expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "map-cap-refused", role: "design" });
  });

  it("names an agent PR closed by hand, on the Ticket it stops", () => {
    const plan = planFor(
      { kind: "pull-request-closed", pullRequest: 50, merged: false, closedByBot: false },
      snapshotOfPullRequest(aPullRequest({ number: 50, ticket: 7, open: false, ticketLabels: ["enhancement", "ready-for-agent"] })),
      kitConfig(),
    );
    expect(handBackOf(commentsOf(plan)[0])).toEqual({ kind: "closed-by-hand", role: "implement" });
  });

  it("names a Kept-branch start whose Kept branch is gone, on the Ticket it stops", () => {
    expect(handBackOf(commentsOf(stopForGoneKeptBranch(7, "operator"))[0])).toEqual({ kind: "kept-branch-gone", role: "implement" });
  });
});
