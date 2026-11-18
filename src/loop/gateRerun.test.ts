// One more re-run at the Merge gate (#783): one hourly Tick after a pass that
// names an Unrelated failure, the Kit asks the Re-run red checks job, through
// agent:rerun-checks, to re-run that check's failed jobs once more on the pull
// request's head, and later Ticks read what came of it.
import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, notificationsOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { gateRerunSpent } from "./gateRerun.ts";
import { gateRerunMarksIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, GateRerunMark, HeadCheckRun, LoopEvent, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const NOW = "2026-11-18T12:17:00Z";
const TICK: LoopEvent = { kind: "scheduled-tick", now: NOW };
const HEAD = "c".repeat(40);
const SHORT = HEAD.slice(0, 7);
const LABEL = "agent:rerun-checks";

/** A Reviewer's pass on HEAD that judged these checks Unrelated failures. */
const passNaming = (...unrelated: string[]): VerdictRecord => ({ verdict: "pass", source: "reviewer", requestChanges: false, ...(unrelated.length === 0 ? {} : { unrelated }), headSha: HEAD });

/** An agent PR out of draft at the Merge gate, its latest pass on HEAD naming `e2e` an Unrelated failure. */
const atGate = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot =>
  aPullRequest({ number: 50, draft: false, headSha: HEAD, verdicts: [passNaming("e2e")], ...overrides });

/** A GitHub Actions check run on HEAD: its job's page in workflow run `run`. */
const actionsRun = (name: string, conclusion: string | null, startedAt: string, run = 7, job = 70): HeadCheckRun => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  startedAt,
  url: `https://github.com/acme/shop/actions/runs/${run}/job/${job}`,
});

const RED_E2E = actionsRun("e2e", "failure", "2026-11-18T10:00:00Z");

const passedHead = (checkRuns: HeadCheckRun[], overrides: Partial<PassedHeadChecks> = {}): PassedHeadChecks => ({
  pullRequest: 50,
  ticket: 7,
  headSha: HEAD,
  required: ["e2e", "gate"],
  checkRuns,
  marks: [],
  excerpts: [],
  redOnMain: [],
  ...overrides,
});

/** The Tick's plan for these PRs at the gate and what it read of their heads. */
function tick(pullRequests: PullRequestSnapshot[], heads: PassedHeadChecks[]): Plan {
  const base = tickSnapshot();
  const snapshot: Snapshot = {
    ...base,
    conflicts: { ...base.conflicts!, now: NOW, pullRequests: pullRequests.map((pullRequest) => ({ pullRequest, mergeable: true })) },
    flakySweep: [],
    passedHeads: heads,
  };
  return planFor(TICK, snapshot, kitConfig());
}

/** The plan's actions on the PR, the Tick's queue checks aside. */
const onPullRequest = (plan: Plan): Action[] =>
  (plan.kind === "act" ? plan.actions : []).filter((action) => action.kind !== "check-dispatch" && action.kind !== "check-design-queue");

const comments = (plan: Plan): string[] => onPullRequest(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));

/** The gate re-run marks the plan's comments carry, as the adapter reads them back off the PR. */
const marksPosted = (plan: Plan): GateRerunMark[] =>
  gateRerunMarksIn(comments(plan).map((body, at) => ({ id: `IC_${at}`, body, createdAt: NOW })));

describe("The Tick asks for one more re-run of an Unrelated failure at the Merge gate (#783)", () => {
  it("posts a quiet line whose marker records the head and the check, and adds agent:rerun-checks", () => {
    const plan = tick([atGate()], [passedHead([RED_E2E])]);

    expect(onPullRequest(plan)).toEqual([
      {
        kind: "comment",
        issue: 50,
        body:
          `<!-- fabrik:gate-rerun {"headSha":"${HEAD}","checks":[{"name":"e2e","link":"https://github.com/acme/shop/actions/runs/7/job/70"}]} -->\n` +
          `\`e2e\` is still red on ${SHORT}, and the Reviewer judged it an Unrelated failure, so the Kit is re-running its failed jobs once more through \`${LABEL}\`.`,
      },
      { kind: "add-labels", issue: 50, labels: [LABEL] },
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("asks nothing more at a later Tick on the same head and check", () => {
    const asked = tick([atGate()], [passedHead([RED_E2E])]);
    const later = tick([atGate({ gateReruns: marksPosted(asked) })], [passedHead([RED_E2E])]);

    expect(onPullRequest(later)).toEqual([]);
  });

  it("asks again for the same check on a new head the Reviewer passed", () => {
    const asked = tick([atGate()], [passedHead([RED_E2E])]);
    const NEW = "d".repeat(40);
    const moved = atGate({ headSha: NEW, verdicts: [{ ...passNaming("e2e"), headSha: NEW }], gateReruns: marksPosted(asked) });

    expect(onPullRequest(tick([moved], [passedHead([RED_E2E], { headSha: NEW })]))).toContainEqual({ kind: "add-labels", issue: 50, labels: [LABEL] });
  });

  it("names every Unrelated failure it can re-run on the head in one line", () => {
    const pullRequest = atGate({ verdicts: [passNaming("e2e", "lint")] });
    const plan = tick([pullRequest], [passedHead([RED_E2E, actionsRun("lint", "failure", "2026-11-18T10:01:00Z", 8, 80)])]);

    expect(marksPosted(plan)).toEqual([
      expect.objectContaining({ kind: "asked", headSha: HEAD, checks: [expect.objectContaining({ name: "e2e", run: 7 }), expect.objectContaining({ name: "lint", run: 8 })] }),
    ]);
    expect(comments(plan)[0]).toContain("`e2e`, `lint` are still red");
  });

  it("skips a check from an outside service, with no label, and records it as done", () => {
    const vercel: HeadCheckRun = { name: "Vercel", status: "completed", conclusion: "failure", startedAt: "2026-11-18T10:00:00Z", url: "https://vercel.com/acme/shop/deploys/1" };
    const plan = tick([atGate({ verdicts: [passNaming("Vercel")] })], [passedHead([vercel])]);

    expect(onPullRequest(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(marksPosted(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["Vercel"], why: "outside" }]);
    expect(comments(plan)[0]).toContain("`Vercel` isn't a GitHub Actions check");
    expect(gateRerunSpent(atGate({ gateReruns: marksPosted(plan) }), HEAD, "Vercel")).toBe(true);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("skips a commit status, which has no check run on the head, as an outside service's", () => {
    const plan = tick([atGate({ verdicts: [passNaming("deploy/preview")] })], [passedHead([])]);

    expect(marksPosted(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["deploy/preview"], why: "outside" }]);
  });

  it("skips a check red on main's head too, with no label, and records it as done", () => {
    const plan = tick([atGate()], [passedHead([RED_E2E], { redOnMain: ["e2e"] })]);

    expect(onPullRequest(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(marksPosted(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["e2e"], why: "red-on-main" }]);
    expect(comments(plan)[0]).toContain("`e2e` is red on main's head too");
  });

  it("asks once main's head couldn't be read, as nothing says it's red there", () => {
    expect(onPullRequest(tick([atGate()], [passedHead([RED_E2E], { redOnMain: "unread" })]))).toContainEqual({ kind: "add-labels", issue: 50, labels: [LABEL] });
  });

  it("asks nothing more for a skipped check at a later Tick", () => {
    const skipped = tick([atGate()], [passedHead([RED_E2E], { redOnMain: ["e2e"] })]);

    expect(onPullRequest(tick([atGate({ gateReruns: marksPosted(skipped) })], [passedHead([RED_E2E], { redOnMain: ["e2e"] })]))).toEqual([]);
  });

  it("gives no label to a PR whose head moved since the pass", () => {
    const moved = atGate({ headSha: "d".repeat(40) });

    expect(onPullRequest(tick([moved], [passedHead([RED_E2E], { headSha: "d".repeat(40) })]))).toEqual([]);
  });

  it("gives no label for a check that has since read green, which the read of the passed head reports as a Flaky check", () => {
    const plan = tick([atGate()], [passedHead([RED_E2E, actionsRun("e2e", "success", "2026-11-18T11:00:00Z", 7, 71)])]);

    expect(onPullRequest(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(marksPosted(plan)).toEqual([]);
  });

  it("gives no label for a check running again, and asks at a later Tick if it ends red", () => {
    expect(onPullRequest(tick([atGate()], [passedHead([RED_E2E, actionsRun("e2e", null, "2026-11-18T12:00:00Z", 7, 71)])]))).toEqual([]);
  });

  it("gives no label for a pass that names no Unrelated failure, nor to a PR in draft", () => {
    expect(onPullRequest(tick([atGate({ verdicts: [passNaming()] })], [passedHead([RED_E2E])]))).toEqual([]);
    expect(onPullRequest(tick([atGate({ draft: true })], [passedHead([RED_E2E])]))).toEqual([]);
  });
});
