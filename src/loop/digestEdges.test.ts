// The edges of the wait a pass puts in front of the Merge gate (ADR-0022):
// a Digest run is never a Held run, a failure that stalls the whole repo
// still opens its Kit-owned issue, and a start that is lost opens the gate at
// the stuck-trigger sweep. Each through the Loop rules core.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aLabelledTrigger,
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  NOTHING_UNDER_WAY,
  notificationsOf,
  snapshotOf,
  snapshotOfPullRequest,
  tickSnapshot,
  withoutNotes,
} from "../__fixtures__/snapshots.ts";
import { verdictsIn } from "../github/threads.ts";
import { noDigestLine } from "./digestContract.ts";
import { retryNumber } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { Action, KitConfig, KitIssueSnapshot, LabelledTrigger, LoopEvent, Plan, PullRequestSnapshot, RolesUnderWay, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";

/** Subscription rotation on, over two Subscriptions. */
const ROTATING = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });

/** An open weekly-limit issue for one Subscription, as the Kit opens it with rotation on. */
function usedUp(number: number, subscription: string): KitIssueSnapshot {
  return {
    number,
    labels: ["fabrik:weekly-limit"],
    body: [`The weekly usage limit of the \`${subscription}\` Subscription is reached.`, "", `<!-- fabrik:subscription ${subscription} -->`, "<!-- fabrik:resets-at 2026-11-16T04:00:00.000Z -->"].join("\n"),
    comments: [],
  };
}

/** Every listed Subscription used up: a run due now would be held. */
const NONE_FREE = [usedUp(40, "Claude token"), usedUp(41, "Claude token 2")];

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOn(plan: Plan, issue: number): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === issue ? [action.body] : []));
}

/** The Reviewer's pass on #50 at its head. */
const PASSED: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO };

/** Whether a plan holds a run anywhere: a held run, a held marker on a carrier, or a Held line on the run's own thread. */
function holdsARun(plan: Plan): boolean {
  const held = (text: string): boolean => text.includes("fabrik:held") || text.includes("fabrik:on-hold") || text.includes(" is held ");
  return actionsOf(plan).some(
    (action) =>
      action.kind === "hold-agent-run" ||
      (action.kind === "comment" && held(action.body)) ||
      (action.kind === "comment-linking" && action.body.some((part) => typeof part === "string" && held(part))),
  );
}

describe("The Digest: never a Held run, on a pass", () => {
  const passedOn = (pullRequest: PullRequestSnapshot, kitIssues: readonly KitIssueSnapshot[], config = ROTATING): Plan =>
    planFor(PASSED, snapshotOfPullRequest(pullRequest, { operator: "jrey", kitIssues }), config);

  it("with rotation on and every Subscription used up, a pass posts the no-Digest line with no-subscription and opens the gate in the same step", () => {
    const plan = passedOn(aPullRequest(), NONE_FREE);

    // The Verdict, then the line, then the gate: no label was added, so none comes off.
    expect(actionsOf(plan).slice(1)).toEqual([
      { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  it("adds no label then, holds nothing, and writes no Held line on the PR nor held marker on a carrier", () => {
    const plan = passedOn(aPullRequest(), NONE_FREE);

    expect(actionsOf(plan).some((action) => action.kind === "add-labels")).toBe(false);
    expect(holdsARun(plan)).toBe(false);
    // Nothing is said on either weekly-limit issue.
    expect(actionsOf(plan).every((action) => !("issue" in action) || action.issue === 50)).toBe(true);
  });

  it("with one Subscription still free, the pass adds agent:digest as ever", () => {
    const plan = passedOn(aPullRequest(), [usedUp(40, "Claude token")]);

    expect(actionsOf(plan).slice(1)).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
  });

  it("with rotation off and its one Subscription used up, the pass adds agent:digest all the same: the run starts, and fails as any run does", () => {
    const plan = passedOn(aPullRequest(), [{ number: 40, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.", comments: [] }], kitConfig());

    expect(actionsOf(plan).slice(1)).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
  });
});

/** An agent PR with a pass on its current head and `agent:digest` on: a passed draft whose gate has yet to open, unless a test says otherwise. */
function aPassedDraft(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    draft: true,
    leftDraftSinceVerdict: false,
    labels: ["agent:digest"],
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    ...overrides,
  });
}

/** The label off, out of draft, the Operator's review requested: the gate opening, in its order. */
const THE_GATE_OPENS: Action[] = [
  { kind: "remove-label", issue: 50, label: "agent:digest" },
  { kind: "mark-ready-for-review", pullRequest: 50 },
  { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
];

describe("The Digest: never a Held run, when agent:digest is added", () => {
  const labelledOn = (pullRequest: PullRequestSnapshot, kitIssues: readonly KitIssueSnapshot[], config = ROTATING): Plan =>
    planFor({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" }, snapshotOfPullRequest(pullRequest, { operator: "jrey", kitIssues }), config);

  it("with every Subscription used up, the label on a passed draft posts the no-Digest line with no-subscription, comes off, and the gate opens", () => {
    const plan = labelledOn(aPassedDraft(), NONE_FREE);

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) }, ...THE_GATE_OPENS] });
    expect(holdsARun(plan)).toBe(false);
  });

  it("on a PR whose gate has opened, the line is posted and the label comes off, and nothing else moves", () => {
    const plan = labelledOn(aPassedDraft({ draft: false, leftDraftSinceVerdict: true }), NONE_FREE);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ],
    });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("a label the rule declines is declined as ever, with no no-Digest line", () => {
    const plan = labelledOn(aPassedDraft({ verdicts: [] }), NONE_FREE);

    expect(commentsOn(plan, 50)).toEqual(["agent:digest came off and nothing started: #50 has no pass on aaaaaaa as its latest Verdict."]);
  });

  it("with one Subscription still free, the label starts the Digest writer on it", () => {
    const plan = labelledOn(aPassedDraft(), [usedUp(40, "Claude token")]);

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "digest", issue: 50, subscription: "Claude token 2" }]);
  });

  it("with rotation off and its one Subscription used up, the run starts", () => {
    const plan = labelledOn(aPassedDraft(), [{ number: 40, labels: ["fabrik:weekly-limit"], body: "The weekly usage limit is reached.", comments: [] }], kitConfig());

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "digest", issue: 50 }]);
  });
});

describe("The Digest: never a Held run, at a tick that resumes held runs", () => {
  it("a held marker naming a Digest run is dropped, never resumed: agent:digest is not given back to its pull request", () => {
    // A marker no rule writes any more. One Subscription is free, so the tick resumes what is held.
    const carrier: KitIssueSnapshot = { ...usedUp(40, "Claude token 2"), comments: ['The run is held.\n\n<!-- fabrik:held {"issue":50,"role":"digest","label":"agent:digest"} -->'] };
    const on = { number: 50, open: true, labels: [], draft: true, byApp: true, body: "" };

    const plan = planFor({ kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" }, tickSnapshot({ kitIssues: [carrier], held: [on] }), ROTATING);

    expect(actionsOf(plan)).toContainEqual({ kind: "drop-held-run", role: "digest", issue: 50, reason: "The Kit never holds a Digest run, so it starts none on #50" });
    expect(actionsOf(plan).some((action) => action.kind === "add-labels" && action.labels.includes("agent:digest"))).toBe(false);
  });
});

type Failed = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** The Digest writer's job on #50, for Ticket #7, was refused on its Subscription's weekly limit. */
function refused(overrides: Partial<Failed> = {}): Failed {
  return {
    kind: "agent-run-failed",
    role: "digest",
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "weekly-limit", detail: "resets at 2026-11-16T04:00:00.000Z", resetsAt: "2026-11-16T04:00:00.000Z" },
    subscription: "Claude token",
    digest: { pullRequest: 50, headSha: HEAD_SHA },
    ...overrides,
  };
}

/** An Implement run on Ticket #7 that failed the same way, to hold a Digest run's Kit-owned issue against. */
function implementFailed(event: Failed): Failed {
  const { digest: _digest, ...rest } = event;
  return { ...rest, role: "implement" };
}

/** What a plan does on a Kit-owned issue: the one it opens, closes or comments on, never Ticket #7 or PR #50. */
function onKitIssues(plan: Plan): Action[] {
  return actionsOf(plan).filter(
    (action) => action.kind === "open-issue" || action.kind === "close" || ((action.kind === "comment" || action.kind === "comment-linking") && action.issue !== 7 && action.issue !== 50),
  );
}

/** The same actions, with a run named as a Digest run's notice names its own. */
function namingTheDigestRun(actions: readonly Action[]): Action[] {
  return JSON.parse(JSON.stringify(actions).replaceAll("The Implement run on #7", "The Digest run on #7")) as Action[];
}

/** The issue a plan opened, as the adapter would later read it back once GitHub gave it this number. */
function kitIssueOpenedBy(plan: Plan, number: number): KitIssueSnapshot {
  const opened = actionsOf(plan).find((action) => action.kind === "open-issue");
  if (opened === undefined) throw new Error(`expected the plan to open an issue: ${JSON.stringify(plan)}`);
  return { number, labels: opened.labels, body: opened.body, comments: [] };
}

describe("The Digest: a failure that stalls the whole repo", () => {
  const TICKET = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] });
  const failedOn = (event: Failed, kitIssues: readonly KitIssueSnapshot[], config: KitConfig, pullRequest: PullRequestSnapshot = aPassedDraft()): Plan =>
    planFor(event, snapshotOf(TICKET, { pullRequest, operator: "jrey", kitIssues }), config);
  /** An Implement run's refusal with no pull request yet, so what it does on the Ticket is plain. */
  const implementFailedOn = (event: Failed, kitIssues: readonly KitIssueSnapshot[], config: KitConfig): Plan =>
    planFor(implementFailed(event), snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] }), { operator: "jrey", kitIssues }), config);

  const THE_LINE: Action = { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "failed", runUrl: RUN }) };

  it("with rotation off and its one Subscription used up, the run fails as any run does: the line, the gate, and the weekly-limit issue an Implement run's refusal opens", () => {
    const plan = failedOn(refused(), [], kitConfig());

    expect(actionsOf(plan).slice(0, 4)).toEqual([THE_LINE, ...THE_GATE_OPENS]);
    expect(onKitIssues(plan)).toMatchObject([{ kind: "open-issue", labels: ["fabrik:weekly-limit"] }]);
    expect(onKitIssues(plan)).toEqual(namingTheDigestRun(onKitIssues(implementFailedOn(refused(), [], kitConfig()))));
    expect(actionsOf(plan)).toHaveLength(5);
  });

  it("comments on the weekly-limit issue already open, as an Implement run's refusal does", () => {
    const open = kitIssueOpenedBy(failedOn(refused(), [], kitConfig()), 40);
    const plan = failedOn(refused(), [open], kitConfig());

    expect(onKitIssues(plan)).toEqual([{ kind: "comment", issue: 40, body: `The Digest run on #7 stalled on the limit too. [The run](${RUN})` }]);
    expect(onKitIssues(plan)).toEqual(namingTheDigestRun(onKitIssues(implementFailedOn(refused(), [open], kitConfig()))));
  });

  it("with rotation on and another Subscription free, it opens the refused Subscription's weekly-limit issue as an Implement run's does, and is not run again on the other", () => {
    const plan = failedOn(refused(), [], ROTATING);

    expect(actionsOf(plan).slice(0, 4)).toEqual([THE_LINE, ...THE_GATE_OPENS]);
    expect(onKitIssues(plan)).toMatchObject([{ kind: "open-issue", labels: ["fabrik:weekly-limit"] }]);
    expect(onKitIssues(plan)).toEqual(namingTheDigestRun(onKitIssues(implementFailedOn(refused(), [], ROTATING))));
    // An Implement run's refusal adds its trigger label again, to run on the next Subscription. A Digest run's never does.
    expect(actionsOf(implementFailedOn(refused(), [], ROTATING))).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
    expect(actionsOf(plan).some((action) => action.kind === "add-labels" || action.kind === "start-agent-run")).toBe(false);
  });

  it("with rotation on and no other Subscription free, it is not held: the weekly-limit issue tells the Operator and names no held run", () => {
    const plan = failedOn(refused(), [usedUp(41, "Claude token 2")], ROTATING);

    expect(actionsOf(plan).slice(0, 4)).toEqual([THE_LINE, ...THE_GATE_OPENS]);
    expect(holdsARun(plan)).toBe(false);
    expect(onKitIssues(plan)).toMatchObject([{ kind: "open-issue", labels: ["fabrik:weekly-limit"] }]);
    expect(notificationsOf(plan, "jrey")).toEqual([
      "review request on #50",
      'mention in new "The weekly usage limit of the `Claude token` Subscription is reached until 2026-11-16 04:00 UTC"',
    ]);
  });

  it("a Digest run killed for spending usage credits opens the usage-credits issue, and one refused a dead token the token-rotation issue", () => {
    const killed = failedOn(refused({ report: { failure: "usage-credits", detail: "usage credits were being spent" } }), [], ROTATING);
    const dead = failedOn(refused({ report: { failure: "dead-token", detail: "authentication_failed" } }), [], ROTATING);

    expect(onKitIssues(killed)).toMatchObject([{ kind: "open-issue", labels: expect.arrayContaining(["fabrik:usage-credits"]) }]);
    expect(onKitIssues(dead)).toMatchObject([{ kind: "open-issue", labels: expect.arrayContaining(["fabrik:token-rotation"]) }]);
    for (const plan of [killed, dead]) {
      expect(actionsOf(plan).slice(0, 4)).toEqual([THE_LINE, ...THE_GATE_OPENS]);
      expect(holdsARun(plan)).toBe(false);
      expect(actionsOf(plan).some((action) => action.kind === "add-labels")).toBe(false);
    }
  });

  it("a dropped attempt still opens the Kit-owned issue: the Subscription is used up whatever became of the pull request", () => {
    const plan = failedOn(refused(), [], ROTATING, aPassedDraft({ headSha: "b".repeat(40) }));

    expect(actionsOf(plan).filter((action) => !onKitIssues(plan).includes(action))).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    expect(onKitIssues(plan)).toMatchObject([{ kind: "open-issue", labels: ["fabrik:weekly-limit"] }]);
  });

  it("a failure that stalls nothing else opens no issue", () => {
    const plan = failedOn(refused({ report: null }), [], ROTATING);

    expect(actionsOf(plan)).toEqual([THE_LINE, ...THE_GATE_OPENS]);
  });
});

describe("The Digest: never against the Ticket's Retries", () => {
  it.each<[string, Failed["report"]]>([
    ["a crash", null],
    ["the weekly limit", { failure: "weekly-limit", detail: "limit reached" }],
    ["a reply that breaks its shape", { failure: "missing-output", detail: "whatItDoes must be non-empty text" }],
  ])("a Digest run that failed on %s posts no Verdict, starts no Retry and leaves the Ticket alone, so its Retry count stays where it was", (_what, report) => {
    const flawed: VerdictRecord = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "c".repeat(40) };
    const passed: VerdictRecord = { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA };
    const pullRequest = aPassedDraft({ verdicts: [flawed, passed] });
    const plan = planFor(refused({ report }), snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest, operator: "jrey" }), kitConfig());

    // The Retry count is read from the Verdicts on the thread: the next Execution flaw calls for the second Retry, before and after.
    const after = [...pullRequest.verdicts, ...verdictsIn(commentsOn(plan, 50))];
    expect(retryNumber(after, 0)).toBe(retryNumber(pullRequest.verdicts, 0));
    expect(retryNumber(after, 0)).toBe(2);
    expect(actionsOf(plan).some((action) => action.kind === "start-agent-run" || action.kind === "add-labels")).toBe(false);
    // Nothing lands on the Ticket, and nothing is handed to the Operator.
    expect(actionsOf(plan).every((action) => !("issue" in action) || action.issue !== 7)).toBe(true);
    expect(JSON.stringify(actionsOf(plan))).not.toContain("fabrik:hand-back");
  });
});

describe("The Digest: a lost start, at the stuck-trigger sweep", () => {
  /** Monday 04:00 UTC: no Audit or Retro is due, so the tick's own plan is just its queue checks. */
  const tick = { kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" } as const;
  const QUEUE_CHECKS: Action[] = [{ kind: "check-dispatch" }, { kind: "check-design-queue" }];
  /** `agent:digest` on #50, added an hour before the tick unless a test says otherwise. */
  const onFifty = (overrides: Partial<LabelledTrigger> = {}): LabelledTrigger => aLabelledTrigger({ number: 50, label: "agent:digest", lastAddedAt: "2026-11-09T03:00:00Z", ...overrides });

  /** The tick's plan with these trigger labels on, and these open agent PRs as it read them. */
  function swept(labelled: readonly LabelledTrigger[], pullRequests: readonly PullRequestSnapshot[] = [aPassedDraft()], underWay: RolesUnderWay | null = NOTHING_UNDER_WAY): Plan {
    const conflicts = { main: HEAD_SHA, now: tick.now, implementJobUnderWay: null, pullRequests: pullRequests.map((pullRequest) => ({ pullRequest, mergeable: true })) };
    return planFor(tick, tickSnapshot({ operator: "jrey", triggers: { underWay, labelled }, conflicts }), kitConfig());
  }

  const NEVER_STARTED: Action = { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "never-started" }) };

  it("agent:digest on for 30 minutes with no Digest job under way: the no-Digest line says never-started, the label comes off and the gate opens", () => {
    const plan = swept([onFifty({ lastAddedAt: "2026-11-09T03:30:00Z" })]);

    expect(actionsOf(withoutNotes(plan))).toEqual([NEVER_STARTED, ...THE_GATE_OPENS, ...QUEUE_CHECKS]);
    // The review request is the one notification: no comment mentions the Operator, and nothing is handed back.
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
    expect(JSON.stringify(actionsOf(plan))).not.toContain("fabrik:hand-back");
  });

  it("is never added again nor given up on, whatever the thread says of an earlier re-add", () => {
    const plan = swept([onFifty({ readded: true })]);

    expect(actionsOf(withoutNotes(plan))).toEqual([NEVER_STARTED, ...THE_GATE_OPENS, ...QUEUE_CHECKS]);
    expect(JSON.stringify(actionsOf(plan))).not.toContain("fabrik:stuck-trigger");
  });

  it("leaves the label alone under 30 minutes: its run may still be starting", () => {
    expect(actionsOf(withoutNotes(swept([onFifty({ lastAddedAt: "2026-11-09T03:31:00Z" })])))).toEqual(QUEUE_CHECKS);
  });

  it("leaves the label alone while a Digest job is under way on that pull request", () => {
    const plan = swept([onFifty()], [aPassedDraft()], { ...NOTHING_UNDER_WAY, digests: [50] });

    expect(actionsOf(withoutNotes(plan))).toEqual(QUEUE_CHECKS);
  });

  it("a Digest job on another pull request does not count, nor does any other role's job", () => {
    const plan = swept([onFifty()], [aPassedDraft()], { implement: true, research: true, review: true, claim: true, designTurns: [50], digests: [51] });

    expect(actionsOf(withoutNotes(plan))).toEqual([NEVER_STARTED, ...THE_GATE_OPENS, ...QUEUE_CHECKS]);
  });

  it("leaves the label alone with the Actions API unread, as it leaves every label", () => {
    expect(actionsOf(withoutNotes(swept([onFifty()], [aPassedDraft()], null)))).toEqual(QUEUE_CHECKS);
  });

  it("on a pull request whose gate has opened, as when the label was added by hand, the line is posted and the label comes off, and nothing else moves", () => {
    const plan = swept([onFifty()], [aPassedDraft({ draft: false, leftDraftSinceVerdict: true })]);

    expect(actionsOf(withoutNotes(plan))).toEqual([NEVER_STARTED, { kind: "remove-label", issue: 50, label: "agent:digest" }, ...QUEUE_CHECKS]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it.each([
    ["a run is now in flight on it", aPassedDraft({ conflictRunInFlight: "c".repeat(40) }), "The conflict-only run on #50 is in flight"],
    ["its head has no pass on it", aPassedDraft({ headSha: "b".repeat(40) }), "#50 has no pass on bbbbbbb as its latest Verdict"],
  ])("a lost start on a pull request overtaken since, where %s, is dropped as any attempt is: the label comes off, nothing is posted and the gate stays closed", (_what, pullRequest, why) => {
    const plan = swept([onFifty()], [pullRequest]);

    expect(actionsOf(plan)).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }, ...QUEUE_CHECKS]);
    expect(plan.kind === "act" ? plan.notes : []).toContain(`The Digest run of #50 never started, and it was dropped: ${why}`);
  });

  it("on anything but an open agent PR, where no Digest is written, the label comes off with one line saying why", () => {
    const plan = swept([onFifty({ number: 7 })], [aPassedDraft()]);

    expect(actionsOf(withoutNotes(plan))).toEqual([
      { kind: "remove-label", issue: 7, label: "agent:digest" },
      { kind: "comment", issue: 7, body: "agent:digest came off and nothing started: #7 isn't an open agent PR." },
      ...QUEUE_CHECKS,
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("still sweeps another trigger label that sits beside it, by that label's own rule", () => {
    const plan = swept([onFifty(), aLabelledTrigger({ number: 7, label: "agent:implement" })]);

    expect(actionsOf(withoutNotes(plan))).toEqual([
      NEVER_STARTED,
      ...THE_GATE_OPENS,
      { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
      { kind: "comment", issue: 7, body: "<!-- fabrik:stuck-trigger-readded agent:implement -->\n`agent:implement` sat 60 minutes with no run behind it, so the Kit added it again." },
      ...QUEUE_CHECKS,
    ]);
  });
});

describe("The README on a Digest run's edges", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const sectionOf = (heading: string): string => readme.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
  const bulletOf = (section: string, name: string): string => section.split("\n").find((line) => line.startsWith(`- **${name}**`)) ?? "";
  const digest = sectionOf("Digest");

  it("the Digest's section has Never held, A lost start and Spend, in that order after The gate", () => {
    const at = ["The gate", "Never held", "A lost start", "Spend"].map((name) => digest.indexOf(`- **${name}**`));

    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("Never held says what a pass and the label do with every Subscription used up, and that a refusal still opens its Kit-owned issue", () => {
    const neverHeld = bulletOf(digest, "Never held");

    expect(neverHeld).toContain("A Digest run is never a Held run");
    expect(neverHeld).toContain("a pass adds no label: it posts the no-Digest line with `no-subscription` and opens the gate in the same step");
    expect(neverHeld).toContain("No Held line is written on the pull request and no held marker on a Kit-owned issue");
    expect(neverHeld).toContain("With rotation off, the run starts and fails as any run does");
    expect(neverHeld).toContain("still opens or comments on that Kit-owned issue");
    expect(neverHeld).toContain("is not run again on another Subscription");
  });

  it("A lost start says the sweep neither adds the label again nor hands it to the Operator, and opens the gate after its 30 minutes", () => {
    const lostStart = bulletOf(digest, "A lost start");

    expect(lostStart).toContain("neither adds `agent:digest` again nor hands it to you");
    expect(lostStart).toContain("on for 30 minutes with no `Digest PR #<that pull request>` job unfinished");
    expect(lostStart).toContain("posts the no-Digest line with `never-started`, takes the label off and opens the gate");
    expect(lostStart).toContain("A Digest job on another pull request doesn't count");
    expect(lostStart).toContain("ADR-0015");
  });

  it("Spend says a Digest run's Run record is in role digest, that its cost counts toward the Ticket, and that no Scorer judges it", () => {
    const spend = bulletOf(digest, "Spend");

    expect(spend).toContain("a Run record in role `digest`, on its Ticket, naming its pull request");
    expect(spend).toContain("The Run-record schema is unchanged");
    expect(spend).toContain("A run that never started writes none");
    expect(spend).toContain("count a Ticket's Digest runs beside its Implement and Review runs");
    expect(spend).toContain("No Scorer judges a Digest run");
  });

  it("the Layout's line on the Weekly summary says which runs cost per merged PR and spend that never merged count", () => {
    const summary = readme.split("\n").find((line) => line.startsWith("- `.github/workflows/weekly-summary.yml`")) ?? "";

    expect(summary).toContain("Cost per merged PR and spend that never merged each sum a Ticket's Implement, Review and Digest runs");
  });

  it("the stuck-trigger paragraph points agent:digest at its own rule", () => {
    const sweep = readme.split("\n").find((line) => line.startsWith("A trigger label (`agent:implement`")) ?? "";

    expect(sweep).toContain("`agent:digest` is the one trigger label the tick never adds again or hands to you");
    expect(sweep).toContain("[Digest](#digest)");
  });
});
