// One more re-run at the Merge gate (#783): one hourly Tick after a pass that
// names an Unrelated failure, the Kit asks the Re-run red checks job, through
// agent:rerun-checks, to re-run that check's failed jobs once more on the pull
// request's head, and later Ticks read what came of it.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, notificationsOf, snapshotOf, snapshotOfPullRequest, tickSnapshot } from "../__fixtures__/snapshots.ts";
import { gateRerunSpent } from "./gateRerun.ts";
import { TRIGGER_LABELS } from "./labels.ts";
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

describe("agent:rerun-checks on a pull request (#783)", () => {
  const labeled: LoopEvent = { kind: "pull-request-labeled", pullRequest: 50, label: LABEL };
  const asked = (started = false): GateRerunMark => ({
    kind: "asked",
    headSha: HEAD,
    checks: [{ name: "e2e", link: "https://github.com/acme/shop/actions/runs/7/job/70", run: 7 }],
    started,
    node: "IC_ask",
    postedAt: "2026-11-18T11:17:00Z",
  });
  const onLabel = (pullRequest: PullRequestSnapshot) => planFor(labeled, snapshotOfPullRequest({ ...pullRequest, labels: [LABEL] }), kitConfig());

  it("routes to the Re-run red checks job for the checks the Kit's line asked, taking the label off and marking the line started", () => {
    expect(onLabel(atGate({ gateReruns: [asked()] }))).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: LABEL },
        { kind: "mark-gate-rerun-started", pullRequest: 50, node: "IC_ask" },
        { kind: "rerun-checks", pullRequest: 50, headSha: HEAD, checks: [{ name: "e2e", link: "https://github.com/acme/shop/actions/runs/7/job/70", run: 7 }] },
      ],
    });
  });

  it("comes off with one line saying why when added a second time for the head", () => {
    const plan = onLabel(atGate({ gateReruns: [asked(true)] }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: LABEL },
        { kind: "comment", issue: 50, body: `${LABEL} came off and nothing started: the Kit re-runs an Unrelated failure once more on a head, and has on ${SHORT} already.` },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("comes off with one line saying why on a pull request with no such pass", () => {
    expect(onLabel(atGate({ verdicts: [passNaming()] }))).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 50, label: LABEL },
        {
          kind: "comment",
          issue: 50,
          body: `${LABEL} came off and nothing started: no line from the Kit asks for one more re-run on ${SHORT}, which the hourly Tick asks for an Unrelated failure at the Merge gate.`,
        },
      ],
    });
  });

  it("comes off with one line saying why once the head has moved since the ask, or the PR left the Merge gate", () => {
    const moved = onLabel(atGate({ headSha: "d".repeat(40), gateReruns: [asked()] }));
    const draft = onLabel(atGate({ draft: true, gateReruns: [asked()] }));

    for (const plan of [moved, draft]) expect(onPullRequest(plan).map((action) => action.kind)).toEqual(["remove-label", "comment"]);
    expect(comments(draft)[0]).toContain("isn't at the Merge gate");
  });

  it("comes off with one line saying why on a pull request that isn't an agent's", () => {
    expect(comments(onLabel(atGate({ isAgent: false, gateReruns: [asked()] })))[0]).toContain("#50 isn't an agent PR");
  });

  it("comes off an issue, saying it goes on the pull request", () => {
    const issueLabeled: LoopEvent = { kind: "label-added", issue: 7, label: LABEL };
    const plan = planFor(issueLabeled, snapshotOf(anIssue({ number: 7, labels: [LABEL], openPullRequests: [50] })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: LABEL },
        { kind: "comment", issue: 7, body: `\`${LABEL}\` goes on the PR, not the Ticket: add it to #50.` },
      ],
    });
  });
});

describe("Later Ticks read what came of one more re-run at the Merge gate (#783)", () => {
  /** The Tick before asked at 11:17; this one runs at 12:17. */
  const ASKED_AT = "2026-11-18T11:17:00Z";
  const ask = (started: boolean): Extract<GateRerunMark, { kind: "asked" }> => ({
    kind: "asked",
    headSha: HEAD,
    checks: [{ name: "e2e", link: "https://github.com/acme/shop/actions/runs/7/job/70", run: 7 }],
    started,
    node: "IC_ask",
    postedAt: ASKED_AT,
  });
  const after = (overrides: Partial<PullRequestSnapshot> = {}) => atGate({ gateReruns: [ask(true)], ...overrides });
  const doneMarks = (plan: Plan) => marksPosted(plan).filter((mark) => mark.kind === "done");

  it("reports a check green after the re-run as a Flaky check, through the existing read of the passed head, with nothing counted back", () => {
    const plan = tick([after()], [passedHead([RED_E2E, actionsRun("e2e", "success", "2026-11-18T11:19:00Z", 7, 71)])]);

    const flakyLine = onPullRequest(plan).find((action) => action.kind === "comment-linking");
    expect(flakyLine?.kind === "comment-linking" && flakyLine.body.join("")).toContain(`<!-- fabrik:flaky-check {"headSha":"${HEAD}","checks":["e2e"]} -->`);
    expect(flakyLine?.kind === "comment-linking" && flakyLine.body.join("")).not.toContain("countedBack");
    expect(doneMarks(plan)).toEqual([]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reads a check red again, by a run started after the line, as done, said once on the PR", () => {
    const redAgain = [RED_E2E, actionsRun("e2e", "failure", "2026-11-18T11:19:00Z", 7, 71)];
    const plan = tick([after()], [passedHead(redAgain)]);

    expect(doneMarks(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["e2e"], why: "red-again" }]);
    expect(comments(plan)).toEqual([expect.stringContaining(`\`e2e\` failed again when the Kit re-ran it once more on ${SHORT}, so the pull request waits for its fix.`)]);
    expect(onPullRequest(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(notificationsOf(plan)).toEqual([]);
    expect(gateRerunSpent(after({ gateReruns: [ask(true), ...marksPosted(plan)] }), HEAD, "e2e")).toBe(true);
    expect(onPullRequest(tick([after({ gateReruns: [ask(true), ...marksPosted(plan)] })], [passedHead(redAgain)]))).toEqual([]);
  });

  it("waits while the re-run is still running", () => {
    expect(onPullRequest(tick([after()], [passedHead([RED_E2E, actionsRun("e2e", null, "2026-11-18T11:19:00Z", 7, 71)])]))).toEqual([]);
  });

  it("reads a re-run that started no run, as when GitHub refused it, as done at the next Tick, said once", () => {
    const plan = tick([after()], [passedHead([RED_E2E])]);

    expect(doneMarks(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["e2e"], why: "refused" }]);
    expect(comments(plan)[0]).toContain("the Re-run red checks job started no run");
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("reads a label still on at the next Tick with no run behind it as done, said once, and takes it off", () => {
    const plan = tick([atGate({ gateReruns: [ask(false)], labels: [LABEL] })], [passedHead([RED_E2E])]);

    expect(doneMarks(plan)).toEqual([{ kind: "done", headSha: HEAD, checks: ["e2e"], why: "no-run" }]);
    expect(onPullRequest(plan)).toContainEqual({ kind: "remove-label", issue: 50, label: LABEL });
    expect(onPullRequest(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("is left to this rule by the stuck-trigger sweep, which reads only the trigger labels an agent run is behind: never added again, never handed to the Operator", () => {
    expect(TRIGGER_LABELS as readonly string[]).not.toContain(LABEL);
    const plan = tick([atGate({ gateReruns: [ask(false)], labels: [LABEL] })], [passedHead([RED_E2E])]);

    expect(onPullRequest(plan).filter((action) => action.kind === "add-labels")).toEqual([]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("leaves a line the Tick just posted alone until the next Tick", () => {
    const justNow: GateRerunMark = { ...ask(false), postedAt: "2026-11-18T12:10:00Z" };

    expect(onPullRequest(tick([atGate({ gateReruns: [justNow], labels: [LABEL] })], [passedHead([RED_E2E])]))).toEqual([]);
  });

  it("reads nothing back once the head has moved since the line", () => {
    const NEW = "d".repeat(40);
    const moved = atGate({ headSha: NEW, verdicts: [{ ...passNaming(), headSha: NEW }], gateReruns: [ask(true)] });

    expect(onPullRequest(tick([moved], [passedHead([RED_E2E], { headSha: NEW })]))).toEqual([]);
  });
});
