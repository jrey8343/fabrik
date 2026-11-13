import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import {
  anIssue,
  aPullRequest,
  aTicket,
  dispatchSnapshotOf,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOf,
  snapshotOfPullRequest,
  verdictsPostedIn,
} from "../__fixtures__/snapshots.ts";
import { leftDraftSinceVerdictIn, type PullRequestHistoryItem, verdictsIn } from "../github/threads.ts";
import { digestCommentOf, noDigestLine } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
const DIGEST_OFF = kitConfig({ digest: { enabled: false } });

/** The Reviewer's reply on #50 at its head. */
function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: REPO };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("The Digest: a pass", () => {
  it("with the Digest on, a pass posts its Verdict, adds agent:digest, leaves the PR in draft and requests no review", () => {
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }]);
    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("with the Digest off in Kit config, a pass opens the Merge gate itself and adds no label", () => {
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }), DIGEST_OFF);

    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  /** Whether a plan adds `agent:digest` anywhere, or takes the PR out of draft, or requests a review. */
  const startsADigestOrOpensTheGate = (plan: Plan): boolean =>
    actionsOf(plan).some(
      (action) =>
        (action.kind === "add-labels" && action.labels.includes("agent:digest")) || action.kind === "mark-ready-for-review" || action.kind === "request-review",
    );

  it("a pass on a PR that conflicts with main adds no label: it is brought up to date first, and the pass on that head brings the Digest", () => {
    const conflicting = { main: "c".repeat(40), mergeable: false };
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(aPullRequest(), { mergeable: conflicting }), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "rebase-onto-main"]);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });

  it("a pass that gives way to a Request changes deferred during a Retry adds no label", () => {
    const deferred = aPullRequest({
      unbuiltChangesRequests: [{ review: 777, reviewer: "operator", reviewerIsBot: false, submittedAt: "2026-11-08T05:00:00.000Z" }],
      notedChangesRequests: [777],
      deferredChangesRequests: [777],
    });
    const plan = planFor(reviewed("verdict: pass\n\nLooks good."), snapshotOfPullRequest(deferred), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ verdict: "pass", requestChangesFirst: [777] }]);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });

  it.each([
    ["an Execution flaw from the Reviewer", reviewed("verdict: execution-flaw\n\nThe empty-cart case throws.")],
    ["a Design flaw", reviewed("verdict: design-flaw\n\nThe Ticket asks for two contradictory things.")],
    ["an Execution flaw from red required checks", { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN } as const],
  ])("%s adds no label", (_what, event: LoopEvent) => {
    const plan = planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(verdictsPostedIn(commentsOf(plan))).toHaveLength(1);
    expect(startsADigestOrOpensTheGate(plan)).toBe(false);
  });
});

const REPLY = aDigestReply({
  whatItDoes: "A shopper can now save their basket.",
  howItGotHere: "One Review passed it at the first head.",
  walkthrough: "1. The basket page's Save button.",
  decided: "- Prices hold for a day.",
});

type Written = Extract<LoopEvent, { kind: "digest-run-finished" }>;

/** The Digest writer finished on #50 at the head its pass was given on, with a reply that keeps its shape. */
function written(overrides: Partial<Written> = {}): Written {
  return {
    kind: "digest-run-finished",
    pullRequest: 50,
    headSha: HEAD_SHA,
    output: JSON.stringify(REPLY),
    given: aDigestGiven({ repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN }),
    runUrl: RUN,
    ...overrides,
  };
}

type Failed = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** The Digest writer's job on #50 failed, for Ticket #7. */
function failed(overrides: Partial<Failed> = {}): Failed {
  return {
    kind: "agent-run-failed",
    role: "digest",
    issue: 7,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    digest: { pullRequest: 50, headSha: HEAD_SHA },
    ...overrides,
  };
}

/** The plan for a Digest that the writer finished, on this pull request. */
function landedOn(pullRequest: PullRequestSnapshot, event: Written = written()): Plan {
  return planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());
}

/** The plan for a failed Digest run, whose snapshot holds its Ticket and its pull request. */
function failedOn(pullRequest: PullRequestSnapshot, event: Failed = failed()): Plan {
  return planFor(event, snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest, operator: "jrey" }), kitConfig());
}

/** #50 as a pass leaves it with the Digest on: a draft with the pass on its head and `agent:digest` on, not out of draft since. */
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

describe("The Digest: the Merge gate opens when the attempt ends", () => {
  it("a Digest that lands on a passed draft is posted, then the label comes off, the PR leaves draft and the Operator's review is requested", () => {
    const rendered = digestCommentOf(REPLY, aDigestGiven({ repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN }));
    const plan = landedOn(aPassedDraft());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: rendered.ok ? rendered.body : "" }, ...THE_GATE_OPENS] });
    // The Digest mentions nobody: the review request is the one notification.
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  it.each([
    ["a run that fails", () => failedOn(aPassedDraft()), noDigestLine({ head: HEAD_SHA, how: "failed", runUrl: RUN })],
    [
      "a run that runs past its time limit",
      () => failedOn(aPassedDraft(), failed({ jobResult: "cancelled" })),
      noDigestLine({ head: HEAD_SHA, how: "timed-out", runUrl: RUN }),
    ],
    [
      "a reply that breaks its shape in the agent job",
      () => failedOn(aPassedDraft(), failed({ report: { failure: "missing-output", detail: "whatItDoes must be non-empty text" } })),
      noDigestLine({ head: HEAD_SHA, how: "refused", reason: "it broke the reply's shape in the agent job", runUrl: RUN }),
    ],
    [
      "a reply that breaks its shape in the push job",
      () => landedOn(aPassedDraft(), written({ output: JSON.stringify({ ...REPLY, walkthrough: "" }) })),
      noDigestLine({ head: HEAD_SHA, how: "refused", reason: "walkthrough must be non-empty text", runUrl: RUN }),
    ],
  ])("%s posts the no-Digest line and then opens the gate the same way: the Loop waits for the attempt, never for its success", (_what, planOf, line) => {
    const plan = planOf();

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "comment", issue: 50, body: line }, ...THE_GATE_OPENS] });
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
  });

  describe("dropped: nothing is posted, the label comes off and the gate stays closed", () => {
    const dropped = [
      // It gets a Review of its own, whose pass brings the next Digest.
      ["a head the PR has moved on from", aPassedDraft({ headSha: "b".repeat(40) })],
      // That run lands first.
      ["a PR with a run now in flight", aPassedDraft({ conflictRunInFlight: "c".repeat(40) })],
      // It has no gate.
      ["a closed PR", aPassedDraft({ open: false })],
    ] as const;

    it.each(dropped)("a Digest for %s", (_what, pullRequest) => {
      expect(actionsOf(landedOn(pullRequest))).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    });

    it.each(dropped)("a failed attempt for %s", (_what, pullRequest) => {
      expect(actionsOf(failedOn(pullRequest))).toEqual([{ kind: "remove-label", issue: 50, label: "agent:digest" }]);
    });
  });

  describe("only once for a pass", () => {
    const opened = [
      // As when the Operator added the label by hand.
      ["a PR already at the Merge gate", aPassedDraft({ draft: false, leftDraftSinceVerdict: true })],
      ["a PR the Operator put back in draft after the gate opened", aPassedDraft({ draft: true, leftDraftSinceVerdict: true })],
    ] as const;

    it.each(opened)("on %s a Digest is posted and the label comes off, and nothing else moves: no second review request", (_what, pullRequest) => {
      const plan = landedOn(pullRequest);

      expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "remove-label"]);
      expect(notificationsOf(plan, "jrey")).toEqual([]);
    });

    it.each(opened)("on %s the no-Digest line is posted and the label comes off, and nothing else moves", (_what, pullRequest) => {
      const plan = failedOn(pullRequest);

      expect(actionsOf(plan)).toEqual([
        { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "failed", runUrl: RUN }) },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ]);
      expect(notificationsOf(plan, "jrey")).toEqual([]);
    });
  });
});

/** PR #50 for Ticket #7 from its first Review on, each plan landed on it as the adapter would, and read back as the snapshot reads it. */
class Thread {
  readonly history: PullRequestHistoryItem[] = [];
  draft = true;
  labels: string[] = [];
  /** How many times the Operator's review was requested. */
  reviewRequests = 0;
  private minute = 0;

  private at(): string {
    this.minute += 1;
    return new Date(Date.UTC(2026, 10, 9, 5, this.minute)).toISOString();
  }

  pullRequest(): PullRequestSnapshot {
    const comments = this.history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
    return aPullRequest({ draft: this.draft, labels: this.labels, verdicts: verdictsIn(comments), leftDraftSinceVerdict: leftDraftSinceVerdictIn(this.history) });
  }

  /** The Loop's plan for this event on the PR as it stands, landed. */
  plan(event: LoopEvent): Plan {
    const plan = planFor(event, snapshotOfPullRequest(this.pullRequest(), { operator: "jrey" }), kitConfig());
    for (const action of actionsOf(plan)) {
      if (action.kind === "comment" && action.issue === 50) this.history.push({ kind: "bot-comment", at: this.at(), body: action.body });
      if (action.kind === "add-labels" && action.issue === 50) this.labels = [...this.labels, ...action.labels];
      if (action.kind === "remove-label" && action.issue === 50) this.labels = this.labels.filter((label) => label !== action.label);
      if (action.kind === "mark-ready-for-review") this.setDraft(false);
      if (action.kind === "request-review") this.reviewRequests += 1;
    }
    return plan;
  }

  /** The PR goes to draft or comes out of it, as the Operator or a plan has it. */
  setDraft(draft: boolean): void {
    this.draft = draft;
    this.history.push({ kind: draft ? "draft" : "ready", at: this.at() });
  }

  /** The Operator adds `agent:digest` by hand, and the Loop hears of it. */
  labelledByHand(): Plan {
    this.labels = [...this.labels, "agent:digest"];
    return this.plan({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" });
  }
}

describe("The Digest: a pass, its Digest and the gate, on one PR", () => {
  it("the pass leaves a labelled draft with no review asked, and the Digest opens the gate with the one review request", () => {
    const thread = new Thread();

    thread.plan(reviewed("verdict: pass\n\nLooks good."));
    expect(thread).toMatchObject({ draft: true, labels: ["agent:digest"], reviewRequests: 0 });

    // The label the pass added starts the Digest writer at the head the pass was given on.
    expect(actionsOf(thread.plan({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" }))).toMatchObject([
      { kind: "start-agent-run", role: "digest", issue: 50, headSha: HEAD_SHA },
    ]);

    thread.plan(written());
    expect(thread).toMatchObject({ draft: false, labels: [], reviewRequests: 1 });
  });

  it("a second Digest for the same pass, asked for by hand at the gate or after the Operator put the PR back in draft, requests no second review", () => {
    const thread = new Thread();
    thread.plan(reviewed("verdict: pass\n\nLooks good."));
    thread.plan(written());

    expect(actionsOf(thread.labelledByHand())).toMatchObject([{ kind: "start-agent-run", role: "digest" }]);
    thread.plan(written());
    expect(thread).toMatchObject({ draft: false, labels: [], reviewRequests: 1 });

    thread.setDraft(true);
    expect(actionsOf(thread.labelledByHand())).toMatchObject([{ kind: "start-agent-run", role: "digest" }]);
    thread.plan(written());
    expect(thread).toMatchObject({ draft: true, labels: [], reviewRequests: 1 });
  });

  it("a passed draft waiting on its Digest holds its max_in_flight slot, as every agent draft does, until the gate opens", () => {
    const oneAtATime = kitConfig({ maxInFlight: 1 });
    /** A Dispatch check with Ticket #12 ready, counting #50 while it is a draft. */
    const dispatch = (thread: Thread): Plan =>
      planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 12 })], { openAgentDraftPullRequests: thread.draft ? [50] : [], openAgentPullRequestsAtMergeGate: thread.draft ? [] : [50] }), oneAtATime);
    const thread = new Thread();

    thread.plan(reviewed("verdict: pass\n\nLooks good."));
    expect(dispatch(thread)).toEqual({
      kind: "nothing",
      reason: "max_in_flight is 1 and 1 are in flight (1 open agent draft PR, 0 Implement runs in progress, 0 dispatched and waiting), so #12 wait",
    });

    thread.plan(written());
    expect(dispatch(thread)).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 12, labels: ["agent:implement"] }] });
  });
});

describe("The README on a pass, the Digest and the gate", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const sectionOf = (heading: string): string => readme.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
  const bulletOf = (section: string, name: string): string => section.split("\n").find((line) => line.startsWith(`- **${name}**`)) ?? "";

  it("Review's section says a pass starts the Digest writer, that the review is requested when its attempt ends, and what a pass does with the Digest off", () => {
    const pass = bulletOf(sectionOf("Review"), "A pass");

    expect(pass).toContain("starts the Digest writer");
    expect(pass).toContain("adds `agent:digest` to the PR, which stays in draft with no review requested");
    expect(pass).toContain("The Operator's review is requested when that attempt ends");
    expect(pass).toContain("With `digest.enabled` false, the pass itself takes the PR out of draft and requests the Operator's review");
  });

  it("the Digest's section says the gate never waits on a Digest's success, in a bullet after No Digest's", () => {
    const digest = sectionOf("Digest");
    const gate = bulletOf(digest, "The gate");

    expect(digest.indexOf("- **The gate**")).toBeGreaterThan(digest.indexOf("- **No Digest**"));
    expect(gate).toContain("waits for the Digest writer's attempt, never for its success");
    expect(gate).toContain("`agent:digest` comes off, the pull request leaves draft and the Operator's review is requested, in that order");
    expect(gate).toContain("A dropped attempt opens no gate");
    expect(gate).toContain("no second review request");
    expect(gate).toContain("keeps its `max_in_flight` slot until the gate opens");
  });

  it("How loud each kind is has a row for the Digest and the no-Digest line, straight under the Merge gate's: silent, the review request being the notification", () => {
    const rows = sectionOf("How loud each kind is").split("\n");
    const row = rows[rows.findIndex((line) => line.startsWith("| Merge gate |")) + 1];

    expect(row).toBe("| Digest, no-Digest line | Silent | Both mention nobody. The review request that follows, when the Merge gate opens, is the notification. |");
  });
});
