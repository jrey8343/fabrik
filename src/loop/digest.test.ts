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
import { digestCommentOf, noDigestLine } from "./digestContract.ts";
import { planFor } from "./rules.ts";
import type { Action, KitIssueSnapshot, LabelledTrigger, LoopEvent, Plan, PullRequestSnapshot, VerdictRecord } from "./types.ts";

/** A Verdict as the snapshot reads one off the pull request, by default the Reviewer's pass on the head. */
function aVerdict(overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, ...overrides };
}

/** An agent pull request with a pass on its current head and `agent:digest` on, at the Merge gate unless a test says otherwise. */
function aPassedPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({ draft: false, leftDraftSinceVerdict: true, labels: ["agent:digest"], verdicts: [aVerdict()], ...overrides });
}

function labelled(pullRequest: PullRequestSnapshot, config = kitConfig()) {
  return planFor({ kind: "pull-request-labeled", pullRequest: pullRequest.number, label: "agent:digest" }, snapshotOfPullRequest(pullRequest), config);
}

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
const MOVED_ON = "b".repeat(40);

const REPLY = {
  whatItDoes: "A shopper can now save their basket.",
  howItGotHere: "One Review passed it at the first head.",
  walkthrough: "1. The basket page's Save button.",
  decided: "- Prices hold for a day.",
};

type Written = Extract<LoopEvent, { kind: "digest-run-finished" }>;
type Failed = Extract<LoopEvent, { kind: "agent-run-failed" }>;

/** The Digest writer finished on #50 at the head its pass was given on, with a reply that keeps its shape. */
function written(overrides: Partial<Written> = {}): Written {
  const headSha = overrides.headSha ?? HEAD_SHA;
  return {
    kind: "digest-run-finished",
    pullRequest: 50,
    headSha,
    output: JSON.stringify(REPLY),
    given: { repoUrl: REPO, pullRequest: 50, headSha, runUrl: RUN },
    runUrl: RUN,
    ...overrides,
  };
}

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

function landed(event: Written, pullRequest: PullRequestSnapshot | null = aPassedPullRequest()): Plan {
  const snapshot = pullRequest === null ? { ...snapshotOfPullRequest(aPassedPullRequest()), pullRequest: null } : snapshotOfPullRequest(pullRequest);
  return planFor(event, snapshot, kitConfig());
}

/** The plan for a failed Digest run, whose snapshot holds its Ticket and its pull request. */
function failedOn(event: Failed, pullRequest: PullRequestSnapshot | null = aPassedPullRequest()): Plan {
  return planFor(event, snapshotOf(anIssue({ number: 7, openPullRequests: [50] }), { pullRequest }), kitConfig());
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** The label off and nothing else: what every dropped attempt comes to. */
const ONLY_THE_LABEL_OFF: Action[] = [{ kind: "remove-label", issue: 50, label: "agent:digest" }];

describe("The Digest: landing", () => {
  it("a Digest that lands is one comment, rendered from the reply, and then the label comes off", () => {
    const rendered = digestCommentOf(REPLY, { repoUrl: REPO, pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN });

    expect(landed(written())).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 50, body: rendered.ok ? rendered.body : "" },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ],
    });
  });

  it("the comment's first line names the head, and it carries the two sections, the two folds and a link to the run, with no mention", () => {
    const [comment] = actionsOf(landed(written({ output: JSON.stringify({ ...REPLY, decided: "- @operator decided nothing." }) })));
    const body = comment?.kind === "comment" ? comment.body : "";

    expect(body.split("\n")[0]).toBe(`<!-- fabrik:digest {"head":"${HEAD_SHA}"} -->`);
    expect(body).toContain("### What it does");
    expect(body).toContain("### How it got here");
    expect(body).toContain("<summary>Walk me through it</summary>");
    expect(body).toContain("<summary>Decided without you, and left alone</summary>");
    expect(body.endsWith(`[The run](${RUN})`)).toBe(true);
    expect(notificationsOf(landed(written({ output: JSON.stringify({ ...REPLY, decided: "- @operator decided nothing." }) })))).toEqual([]);
  });

  // What landing does on a passed draft, where the Merge gate has yet to open, is src/loop/digestGate.test.ts's.
  it("on a pull request at the Merge gate it changes no draft state and requests no review", () => {
    const kinds = actionsOf(landed(written(), aPassedPullRequest())).map(({ kind }) => kind);

    expect(kinds).toEqual(["comment", "remove-label"]);
  });

  it("a reply that breaks its shape is refused: the no-Digest line says so with Kit code's reason, and the label comes off", () => {
    const plan = landed(written({ output: JSON.stringify({ ...REPLY, walkthrough: "" }) }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 50,
          body: noDigestLine({ head: HEAD_SHA, how: "refused", reason: "walkthrough must be non-empty text", runUrl: RUN }),
        },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("a Digest too long for one comment is refused the same way", () => {
    const [comment] = actionsOf(landed(written({ output: JSON.stringify({ ...REPLY, walkthrough: "x".repeat(70_000) }) })));

    expect(comment).toMatchObject({ kind: "comment", issue: 50, body: expect.stringContaining("`refused`, Kit code refused the Digest writer's reply (the Digest would be") });
  });

  it("a Digest for a head the pull request has moved on from posts nothing and takes the label off", () => {
    const plan = landed(written(), aPassedPullRequest({ headSha: MOVED_ON, verdicts: [aVerdict()] }));

    expect(plan).toEqual({ kind: "act", actions: ONLY_THE_LABEL_OFF, notes: ["The Digest of #50 was dropped: #50 has moved on from aaaaaaa"] });
  });

  it("a Digest for a closed pull request posts nothing and takes the label off", () => {
    const plan = landed(written(), aPassedPullRequest({ open: false }));

    expect(plan).toEqual({ kind: "act", actions: ONLY_THE_LABEL_OFF, notes: ["The Digest of #50 was dropped: #50 is closed"] });
  });

  it("a Digest for a pull request a run is now in flight on posts nothing and takes the label off", () => {
    const plan = landed(written(), aPassedPullRequest({ draft: true, leftDraftSinceVerdict: false, conflictRunInFlight: "c".repeat(40) }));

    expect(plan).toEqual({ kind: "act", actions: ONLY_THE_LABEL_OFF, notes: ["The Digest of #50 was dropped: The conflict-only run on #50 is in flight"] });
  });

  it("a Digest whose pass is no longer the pull request's latest Verdict posts nothing and takes the label off", () => {
    const plan = landed(written(), aPassedPullRequest({ verdicts: [aVerdict(), aVerdict({ verdict: "execution-flaw", source: "ci", ticketNotReady: true })] }));

    expect(plan).toEqual({ kind: "act", actions: ONLY_THE_LABEL_OFF, notes: ["The Digest of #50 was dropped: #50's latest Verdict is no longer the pass on aaaaaaa"] });
  });

  it("a dropped Digest is dropped whatever its reply holds, shape broken or not", () => {
    const plan = landed(written({ output: "not JSON" }), aPassedPullRequest({ open: false }));

    expect(actionsOf(plan)).toEqual(ONLY_THE_LABEL_OFF);
  });

  it("fails, landing nothing, when the snapshot holds no pull request", () => {
    expect(landed(written(), null)).toEqual({ kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" });
  });
});

describe("The Digest: a run that fails", () => {
  it("a failed run posts the no-Digest line saying it failed, mentions nobody, posts no failure notice and takes the label off", () => {
    const plan = failedOn(failed({ report: { failure: "crash", detail: "The agent crashed, said @operator" } }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "failed", runUrl: RUN }) },
        { kind: "remove-label", issue: 50, label: "agent:digest" },
      ],
    });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("a run cancelled at its time limit posts the no-Digest line saying it timed out", () => {
    const plan = failedOn(failed({ jobResult: "cancelled" }));

    expect(actionsOf(plan)[0]).toEqual({ kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "timed-out", runUrl: RUN }) });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("a run whose reply broke its shape in the agent job posts the no-Digest line saying it was refused", () => {
    const plan = failedOn(failed({ report: { failure: "missing-output", detail: "whatItDoes must be non-empty text" } }));

    expect(actionsOf(plan)).toEqual([
      { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "refused", reason: "it broke the reply's shape in the agent job", runUrl: RUN }) },
      { kind: "remove-label", issue: 50, label: "agent:digest" },
    ]);
  });

  it("no outcome of a failed run counts against the Ticket's Retries, hands anything back or touches the Ticket", () => {
    const actions = actionsOf(failedOn(failed({ report: { failure: "weekly-limit", detail: "limit reached" } })));

    // The weekly-limit issue it opens is the Kit's own, as any run's refusal opens it (src/loop/digestEdges.test.ts).
    expect(actions.map(({ kind }) => kind)).toEqual(["comment", "remove-label", "open-issue"]);
    expect(actions.every((action) => !("issue" in action) || action.issue === 50)).toBe(true);
    expect(actions[0]?.kind === "comment" ? actions[0].body : "").not.toContain("fabrik:hand-back");
  });

  it.each([
    ["has moved on from the head", aPassedPullRequest({ headSha: MOVED_ON })],
    ["is closed", aPassedPullRequest({ open: false })],
  ])("a failed run on a pull request that %s posts nothing and takes the label off", (_why, pullRequest) => {
    expect(actionsOf(failedOn(failed(), pullRequest))).toEqual(ONLY_THE_LABEL_OFF);
  });

  it("fails, landing nothing, when the failure names no pull request the snapshot holds", () => {
    expect(failedOn(failed(), null)).toEqual({ kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the pull request" });
  });
});

describe("The Digest: the stuck-trigger sweep", () => {
  /** Monday 04:00 UTC: no Audit or Retro is due, so the tick's own plan is just its queue checks. */
  const tick = { kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" } as const;
  const QUEUE_CHECKS: Action[] = [{ kind: "check-dispatch" }, { kind: "check-design-queue" }];
  const swept = (labelled: readonly LabelledTrigger[]): Plan => withoutNotes(planFor(tick, tickSnapshot({ triggers: { underWay: NOTHING_UNDER_WAY, labelled } }), kitConfig()));

  it.each([
    ["an hour, with no job under way anywhere", aLabelledTrigger({ number: 50, label: "agent:digest", lastAddedAt: "2026-11-09T03:00:00Z" })],
    ["a day, though the Kit's note says it was added again", aLabelledTrigger({ number: 50, label: "agent:digest", lastAddedAt: "2026-11-08T04:00:00Z", readded: true })],
  ])("leaves agent:digest alone when it has sat %s: it neither adds it again nor takes it off", (_how, trigger) => {
    expect(swept([trigger])).toEqual({ kind: "act", actions: QUEUE_CHECKS });
  });

  it("still sweeps another trigger label that sits beside it", () => {
    const plan = swept([aLabelledTrigger({ number: 50, label: "agent:digest" }), aLabelledTrigger({ number: 7, label: "agent:implement" })]);

    expect(actionsOf(plan).slice(0, 1)).toEqual([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]);
    expect(actionsOf(plan).every((action) => !("issue" in action) || action.issue !== 50)).toBe(true);
  });
});

describe("The Digest: agent:digest starting a run", () => {
  it("agent:digest on an agent pull request with a pass on its current head starts a Digest run at that head, on the Digest writer's model and time limit", () => {
    const config = kitConfig();

    expect(labelled(aPassedPullRequest(), config)).toEqual({
      kind: "act",
      actions: [
        {
          kind: "start-agent-run",
          role: "digest",
          issue: 50,
          headSha: HEAD_SHA,
          model: config.roles.review.model,
          effort: config.roles.review.effort,
          timeoutMinutes: 10,
          subscription: "Claude token",
        },
      ],
    });
  });

  it("starts one on a passed draft too, as on a pull request at the Merge gate", () => {
    const plan = labelled(aPassedPullRequest({ draft: true, leftDraftSinceVerdict: false }));

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "digest", issue: 50, headSha: HEAD_SHA }] });
  });

  it("runs on the Digest writer's own model, effort and time limit when the Kit config sets them", () => {
    const config = kitConfig();
    const own = { ...config, roles: { ...config.roles, digest: { model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 4 } } };

    expect(labelled(aPassedPullRequest(), own)).toMatchObject({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "digest", model: "claude-sonnet-5-5", effort: "high", timeoutMinutes: 4 }],
    });
  });
});

// What the label does with every Subscription used up, where a run started now would be held, is src/loop/digestEdges.test.ts's.

describe("The Digest: agent:digest declined", () => {
  /** The label off, and one line saying why nothing started. */
  const declined = (why: string) => ({
    kind: "act",
    actions: [
      { kind: "remove-label", issue: 50, label: "agent:digest" },
      { kind: "comment", issue: 50, body: `agent:digest came off and nothing started: ${why}.` },
    ],
  });

  it("comes off a pull request with no Verdict, saying it has no pass on its current head", () => {
    expect(labelled(aPassedPullRequest({ verdicts: [] }))).toEqual(declined("#50 has no pass on its current head, aaaaaaa"));
  });

  it("comes off one whose latest Verdict is a flaw, though an earlier one was a pass", () => {
    const flawed = aPassedPullRequest({ draft: true, leftDraftSinceVerdict: false, verdicts: [aVerdict(), aVerdict({ verdict: "design-flaw" })] });

    expect(labelled(flawed)).toEqual(declined("#50 has no pass on its current head, aaaaaaa"));
  });

  it("comes off one whose pass was given on an earlier head", () => {
    const moved = aPassedPullRequest({ verdicts: [aVerdict({ headSha: "b".repeat(40) })] });

    expect(labelled(moved)).toEqual(declined("#50 has no pass on its current head, aaaaaaa"));
  });

  it("comes off one with a run in flight on it, naming the run", () => {
    const building = aPassedPullRequest({ draft: true, leftDraftSinceVerdict: false, requestChangesRunInFlight: 901 });

    expect(labelled(building)).toEqual(declined("The Operator's Request-changes run on #50 is still in flight"));
  });

  it("comes off a pull request that is not an agent's", () => {
    expect(labelled(aPassedPullRequest({ isAgent: false, ticket: null }))).toEqual(declined("#50 isn't an agent PR"));
  });

  it("comes off a closed pull request", () => {
    expect(labelled(aPassedPullRequest({ open: false }))).toEqual(declined("#50 is closed"));
  });

  it("comes off when the Kit config turns the Digest off", () => {
    const off = { ...kitConfig(), digest: { enabled: false } };

    expect(labelled(aPassedPullRequest(), off)).toEqual(declined("the Digest is off in this repo's Kit config (`digest.enabled`)"));
  });

  it("comes off an issue with one line saying where it goes: the Ticket's pull request", () => {
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:digest" }, snapshotOf(anIssue({ number: 7, labels: ["agent:digest"], openPullRequests: [50] })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:digest" },
        { kind: "comment", issue: 7, body: "`agent:digest` goes on the PR, not the Ticket: add it to #50." },
      ],
    });
  });

  it("comes off an issue with no open pull request, saying it goes on an agent PR", () => {
    const plan = planFor({ kind: "label-added", issue: 7, label: "agent:digest" }, snapshotOf(anIssue({ number: 7, labels: ["agent:digest"] })), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:digest" },
        { kind: "comment", issue: 7, body: "`agent:digest` goes on an agent PR, not an issue, and #7 has no open PR." },
      ],
    });
  });
});
