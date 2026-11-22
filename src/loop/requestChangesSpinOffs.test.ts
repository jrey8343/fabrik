import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { leftDraftSinceVerdictIn, notDismissedIn, type PullRequestHistoryItem, pushedSinceVerdictIn, requestChangesRunIn, requestChangesSinceRunIn, verdictsIn } from "../github/threads.ts";
import { openedSpinOffsIn, pushedHeadIn, requestChangesAnswersIn, requestChangesRunStartedMarker, stepUpReasonIn, verdictMarker } from "./markers.ts";
import { runInFlight } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, RequestChangesAsks, Snapshot, VerdictRecord } from "./types.ts";

// A Request changes can ask for a Spin-off (#884): the Operator says, in words, that a point is to be its own issue.
// The Request-changes run leaves that point unbuilt and returns it, and the Kit opens it in the plan that lands the run.
const RUN = "https://github.com/acme/shop/actions/runs/1/attempts/1";
const REVIEW_URL = "https://github.com/acme/shop/pull/50#pullrequestreview-900";
const INLINE_URL = "https://github.com/acme/shop/pull/50#discussion_r9";

type Changes = Extract<LoopEvent, { kind: "implement-run-finished" }>["changes"];
const PUSHED: Changes = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] };
const NOTHING: Changes = { net: [], commits: [] };

const spinOff = (extra: Record<string, unknown> = {}) => ({
  title: "Export the waitlist as CSV",
  body: 'On the waitlist pull request the Operator wrote: "Open the CSV export as its own issue."\n\nThe clinic wants the waitlist as a CSV file.',
  from: "inline-9",
  ...extra,
});

/** A Request-changes run's push job, for review 900, whose output returns these Spin-offs. */
function landed(changes: Changes, spinOffs: readonly unknown[] | null = [spinOff()]): LoopEvent {
  return {
    kind: "implement-run-finished",
    runUrl: RUN,
    issue: 7,
    output: JSON.stringify({
      title: "Rename the total",
      summary: "Adds the order total, named as the Operator asked.",
      fix: "Renamed the total, and set the CSV export aside as the Operator asked.",
      reviewMiss: false,
      amendsTicket: true,
      ...(spinOffs === null ? {} : { spinOffs }),
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes,
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, review: 900 },
  };
}

const pass = (overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, ...overrides });

/** Review 900 as the push job reads it: its own words, and one comment on the code. */
const ASKS: readonly RequestChangesAsks[] = [
  {
    review: 900,
    asks: [
      { id: "review-900", url: REVIEW_URL },
      { id: "inline-9", url: INLINE_URL },
    ],
  },
];

/** PR 50 for Ticket 7, passed on its head and back in draft, with the Request-changes run for review 900 in flight. */
function snapshot(asks: readonly RequestChangesAsks[] | null = ASKS, pullRequest: Partial<PullRequestSnapshot> = {}): Snapshot {
  return {
    ...snapshotOfPullRequest(
      aPullRequest({ verdicts: [pass()], leftDraftSinceVerdict: true, notedChangesRequests: [900], requestChangesRunInFlight: 900, requestChangesRunReviews: [900], ...pullRequest }),
    ),
    issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
    requestChangesAsks: asks,
  };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

const created = (plan: Plan) => actionsOf(plan).filter((action) => action.kind === "create-issue");

/** The run's outcome note as the adapter posts it, each Spin-off's issue written as its number, counted from 57. */
function note(plan: Plan): string {
  const [action, ...others] = actionsOf(plan).filter((one) => one.kind === "comment" || one.kind === "comment-linking");
  if (action === undefined || others.length > 0) throw new Error("expected one comment");
  if (action.kind === "comment") return action.body;
  return action.body.map((part) => (typeof part === "string" ? part : "created" in part ? `#${56 + Number(part.created.split(":")[1])}` : "")).join("");
}

describe("The plan landing a Request-changes run that returned a Spin-off (#884)", () => {
  it("opens one issue with needs-triage, the Spin-off marker and a From PR line, blocked by the pull request's Ticket", () => {
    const plan = planFor(landed(PUSHED), snapshot(), kitConfig());

    expect(created(plan)).toEqual([
      {
        kind: "create-issue",
        key: "spin-off:1",
        title: "Export the waitlist as CSV",
        body: [
          '<!-- fabrik:spin-off {"from":"request-changes","pullRequest":50,"review":900} -->',
          'On the waitlist pull request the Operator wrote: "Open the CSV export as its own issue."',
          "",
          "The clinic wants the waitlist as a CSV file.",
          "",
          "From PR #50",
        ].join("\n"),
        labels: ["needs-triage"],
        parent: null,
        blockedBy: [{ ticket: 7 }],
      },
    ]);
  });

  it("opens it before the note that names it, and both before the push that starts the Review", () => {
    const kinds = actionsOf(planFor(landed(PUSHED), snapshot(), kitConfig())).map((action) => action.kind);

    expect(kinds).toEqual(["edit-issue-body", "create-issue", "comment-linking", "push-branch"]);
  });

  it("lists it in the fix comment by its number and title, with a link to the Operator's words", () => {
    const fix = note(planFor(landed(PUSHED), snapshot(), kitConfig()));

    expect(fix).toContain(
      [
        "Renamed the total, and set the CSV export aside as the Operator asked.",
        "",
        "The Kit opened 1 Spin-off, work the Operator's Request changes asked to be an issue of its own, which Triage sorts next. It waits on #7, this pull request's Ticket.",
        "",
        "- #57 Export the waitlist as CSV",
        `  Asked for in [the Operator's comment on the code](${INLINE_URL})`,
      ].join("\n"),
    );
  });

  it("names each of several, the one from the review's own words linked to the review", () => {
    const fix = note(planFor(landed(PUSHED, [spinOff(), spinOff({ title: "Text the waitlist", from: "review-900" })]), snapshot(), kitConfig()));

    expect(fix).toContain("The Kit opened 2 Spin-offs, work the Operator's Request changes asked to be issues of their own, which Triage sorts next. Each waits on #7, this pull request's Ticket.");
    expect(fix).toContain(`- #57 Export the waitlist as CSV\n  Asked for in [the Operator's comment on the code](${INLINE_URL})\n- #58 Text the waitlist\n  Asked for in [the Operator's Request changes](${REVIEW_URL})`);
  });

  it("records each on the note, among the marker lines it opens with, right under the run's answers", () => {
    const lines = note(planFor(landed(PUSHED), snapshot(), kitConfig())).split("\n");

    expect(lines.slice(0, 3)).toEqual([
      "<!-- fabrik:request-changes-run -->",
      '<!-- fabrik:request-changes-answers {"review":900,"reviewMiss":false,"amendsTicket":true} -->',
      '<!-- fabrik:spin-off-opened #57 {"from":"inline-9","title":"Export the waitlist as CSV"} -->',
    ]);
    expect(openedSpinOffsIn(lines.join("\n"))).toEqual([{ issue: 57, from: "inline-9", title: "Export the waitlist as CSV" }]);
  });

  it("leaves every other marker line of the note where its reader looks: the answers, the Step-up reason and the pushed head", () => {
    const pushedHead = "c".repeat(40);
    const event = landed({ ...PUSHED, pushedHead }, EVERY_ASK);
    if (event.kind !== "implement-run-finished" || event.fixes === undefined) throw new Error("expected a Request-changes run");
    const posted = note(planFor({ ...event, fixes: { ...event.fixes, stepUpReason: "request-changes" } }, snapshot(), kitConfig()));

    expect(requestChangesAnswersIn(posted)).toEqual({ review: 900, reviewMiss: false, amendsTicket: true });
    expect(stepUpReasonIn(posted)).toBe("request-changes");
    expect(pushedHeadIn(posted)).toBe(pushedHead);
    expect(openedSpinOffsIn(posted)).toHaveLength(2);
  });

  it("notifies nobody: neither the issue nor the note mentions anyone, whatever the run wrote", () => {
    const plan = planFor(landed(PUSHED, [spinOff({ title: "Ask @operator about exports", body: "@operator wrote: open this separately." })]), snapshot(), kitConfig());

    expect(notificationsOf(plan)).toEqual([]);
    expect(JSON.stringify(created(plan))).not.toContain("@operator");
    expect(note(plan)).not.toContain("@operator");
  });

  it("posts the note it always did, as a plain comment, for a run that returned none", () => {
    const withNone = planFor(landed(PUSHED, null), snapshot(null), kitConfig());

    expect(actionsOf(withNone).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(planFor(landed(PUSHED, []), snapshot(), kitConfig())).toEqual(withNone);
  });

  it("refuses one whose from the push job's own read of the pull request doesn't hold, whatever the agent job passed out", () => {
    expect(planFor(landed(PUSHED, [spinOff({ from: "inline-10" })]), snapshot(), kitConfig())).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason:
        "The Implementer's retry on #50 emitted output that breaks its contract: spin-off 1 names `inline-10` in from, which isn't a Request changes, or a comment on the code in one, that this run was given",
    });
  });

  it("fails, opening nothing, when the Request changes' asks weren't read", () => {
    expect(planFor(landed(PUSHED), snapshot(null), kitConfig())).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The snapshot is missing the asks of the Request changes on #50, which the run's Spin-offs name",
    });
  });
});

/** Both of review 900's asks, each set aside. */
const EVERY_ASK = [spinOff({ title: "Text the waitlist", from: "review-900" }), spinOff()];

describe("A Request-changes run that committed nothing and returned a Spin-off for every ask (#884)", () => {
  it("opens them and returns the pull request to the Merge gate at the same head: no Review, no Hand-back, no Retry", () => {
    const plan = planFor(landed(NOTHING, EVERY_ASK), snapshot(), kitConfig());
    const actions = actionsOf(plan);

    expect(actions.map((action) => action.kind)).toEqual(["create-issue", "create-issue", "comment-linking", "mark-ready-for-review", "request-review"]);
    expect(actions.slice(-2)).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "operator" },
    ]);
    expect(verdictsPostedIn([note(plan)])).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain("agent:review");
    expect(JSON.stringify(actions)).not.toContain("ready-for-human");
    expect(JSON.stringify(actions)).not.toContain("agent:implement");
  });

  it("notifies the Operator once, by the review request, as any return to the Merge gate does", () => {
    expect(notificationsOf(planFor(landed(NOTHING, EVERY_ASK), snapshot(), kitConfig()))).toEqual(["review request on #50"]);
  });

  it("says so in its note, which is the run's outcome and no Hand-back, and shows what the run said in fix", () => {
    const lines = note(planFor(landed(NOTHING, EVERY_ASK), snapshot(), kitConfig())).split("\n");

    expect(lines[0]).toBe("<!-- fabrik:request-changes-run-empty -->");
    expect(lines[4]).toBe(
      "The Request-changes run on #50 committed nothing to `fabrik/ticket-7` on top of aaaaaaa: every ask of the Operator's Request changes, the review's own words and each comment on the code in it, was set aside as a Spin-off, so nothing was to be built. #50 is back at the Merge gate at aaaaaaa, where its pass stands. No Review runs, and no retry was used.",
    );
    expect(lines).toContain("Renamed the total, and set the CSV export aside as the Operator asked.");
    expect(lines).toContain("- #57 Text the waitlist");
    expect(lines.join("\n")).not.toContain("fabrik:hand-back");
    expect(lines.join("\n")).not.toContain("so your requested changes aren't built");
  });

  it("writes the Digest the pass still owes, in place of opening the gate, when the Request changes came before the gate opened (ADR-0022)", () => {
    const plan = planFor(landed(NOTHING, EVERY_ASK), snapshot(ASKS, { leftDraftSinceVerdict: false }), kitConfig());

    expect(actionsOf(plan).slice(2).map((action) => action.kind)).toEqual(["comment-linking", "add-labels"]);
    expect(actionsOf(plan).at(-1)).toEqual({ kind: "add-labels", issue: 50, labels: ["agent:digest"] });
    expect(note(plan)).toContain("Its pass on aaaaaaa stands, so no Review runs and no retry was used. The Merge gate opens once its Digest is written.");
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("opens the gate at once on such a pull request when the Digest is off", () => {
    const plan = planFor(landed(NOTHING, EVERY_ASK), snapshot(ASKS, { leftDraftSinceVerdict: false }), kitConfig({ digest: { ...kitConfig().digest, enabled: false } }));

    expect(actionsOf(plan).slice(-2).map((action) => action.kind)).toEqual(["mark-ready-for-review", "request-review"]);
  });
});

describe("A Request-changes run that committed nothing with some ask left to build (#884)", () => {
  const handedBack = (plan: Plan) => {
    expect(actionsOf(plan).slice(-2)).toEqual([
      { kind: "add-labels", issue: 50, labels: ["ready-for-human"] },
      { kind: "mark-ready-for-review", pullRequest: 50 },
    ]);
    expect(notificationsOf(plan)).toEqual(["mention on #50"]);
    expect(note(plan).split("\n").at(-1)).toBe('<!-- fabrik:hand-back {"kind":"request-changes-empty","role":"implement"} -->');
    expect(note(plan)).toContain("so your requested changes aren't built, and it's yours from here.");
  };

  it("still opens the Spin-off for one ask of two, and hands the pull request back as it does today", () => {
    const plan = planFor(landed(NOTHING), snapshot(), kitConfig());

    expect(created(plan).map((action) => action.kind === "create-issue" && action.title)).toEqual(["Export the waitlist as CSV"]);
    handedBack(plan);
    expect(note(plan)).toContain("- #57 Export the waitlist as CSV");
    expect(openedSpinOffsIn(note(plan))).toEqual([{ issue: 57, from: "inline-9", title: "Export the waitlist as CSV" }]);
  });

  it("hands back when another review the run read has an ask no Spin-off names", () => {
    const two: RequestChangesAsks[] = [{ review: 899, asks: [{ id: "review-899", url: "https://github.com/acme/shop/pull/50#pullrequestreview-899" }] }, ...ASKS];

    handedBack(planFor(landed(NOTHING, EVERY_ASK), snapshot(two, { requestChangesRunReviews: [899, 900] }), kitConfig()));
  });

  it("hands back when a review the run read is not among those read, as one dismissed since: the Kit can't tell what it asked", () => {
    handedBack(planFor(landed(NOTHING, EVERY_ASK), snapshot(ASKS, { requestChangesRunReviews: [899, 900] }), kitConfig()));
  });

  it("hands back when the latest Verdict is no pass on the head, as an Execution flaw that gave way to the run: its findings are unfixed", () => {
    const flaw = pass({ verdict: "execution-flaw", requestChangesFirst: [900] });

    handedBack(planFor(landed(NOTHING, EVERY_ASK), snapshot(ASKS, { verdicts: [flaw] }), kitConfig()));
  });

  it("gets a Review, with no Hand-back, when the head moved while it worked, its Spin-offs opened all the same", () => {
    const plan = planFor(landed(NOTHING, EVERY_ASK), snapshot(ASKS, { headSha: "b".repeat(40) }), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["create-issue", "create-issue", "comment-linking", "add-labels"]);
    expect(actionsOf(plan).at(-1)).toEqual({ kind: "add-labels", issue: 50, labels: ["agent:review"] });
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("hands back as it always did when the run returned no Spin-off", () => {
    const plan = planFor(landed(NOTHING, null), snapshot(null), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["comment", "add-labels", "mark-ready-for-review"]);
    handedBack(plan);
  });
});

describe("A Request-changes run's landing with Spin-offs, read back from the pull request's thread (#884)", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 5, minutes)).toISOString();
  /** PR 50's history: it passed and left draft, the Operator requested changes, and the Kit started the run for review 900. */
  const started: PullRequestHistoryItem[] = [
    { kind: "bot-comment", at: at(0), body: verdictMarker(pass()) },
    { kind: "ready", at: at(0) },
    { kind: "changes-requested", at: at(1), review: 900, reviewer: "operator", reviewerIsBot: false },
    { kind: "bot-comment", at: at(2), body: `${requestChangesRunStartedMarker([900])}\nThe Kit is starting the Request-changes run.` },
    { kind: "draft", at: at(2) },
  ];
  /** The pull request as the snapshot reads it from this history, through the adapter's own readers. */
  const readFrom = (history: readonly PullRequestHistoryItem[], draft: boolean): Snapshot => {
    const comments = history.flatMap((item) => (item.kind === "bot-comment" ? [item.body] : []));
    return snapshot(ASKS, {
      draft,
      verdicts: verdictsIn(comments),
      requestChangesRun: requestChangesRunIn(comments),
      pushedSinceVerdict: pushedSinceVerdictIn(comments),
      ...requestChangesSinceRunIn(history, notDismissedIn(history), "operator", HEAD_SHA),
      leftDraftSinceVerdict: leftDraftSinceVerdictIn(history),
    });
  };
  /** The history once the plan for these changes has landed: its note, then the pull request out of draft if the plan took it out. */
  const landedOn = (changes: Changes): PullRequestHistoryItem[] => {
    const plan = planFor(landed(changes, EVERY_ASK), readFrom(started, true), kitConfig());
    const ready = actionsOf(plan).some((action) => action.kind === "mark-ready-for-review");
    return [...started, { kind: "bot-comment", at: at(30), body: note(plan) }, ...(ready ? [{ kind: "ready" as const, at: at(30) }] : [])];
  };

  it("has the run in flight until it lands", () => {
    expect(runInFlight(readFrom(started, true).pullRequest!)).toEqual({ kind: "request-changes", review: 900 });
  });

  it("is the run's outcome when every ask was set aside: the Request changes is settled and no run is in flight, so no Tick starts it again", () => {
    const { pullRequest } = readFrom(landedOn(NOTHING), false);

    expect(runInFlight(pullRequest!)).toBeNull();
    expect(pullRequest).toMatchObject({ unbuiltChangesRequests: [], notedChangesRequests: [], requestChangesRunReviews: [], orphanedChangesRequests: [] });
  });

  it("leaves the earlier pass standing on the head: the note is no push and no Verdict", () => {
    const { pullRequest } = readFrom(landedOn(NOTHING), false);

    expect(pullRequest).toMatchObject({ draft: false, pushedSinceVerdict: false, verdicts: [pass()] });
  });

  it.each([
    ["pushed, and whose pull request is still a draft with no run in flight", PUSHED, "#50 has no Request-changes run in flight, so the run's branch isn't pushed"],
    ["committed nothing, and whose pull request is back at the Merge gate", NOTHING, "#50 has left draft, so the retry's branch isn't pushed"],
  ])("opens each Spin-off once: the same run, which %s, lands nothing a second time", (_, changes, reason) => {
    const again = planFor(landed(changes, EVERY_ASK), readFrom(landedOn(changes), changes === PUSHED), kitConfig());

    expect(again).toEqual({ kind: "nothing", reason });
  });
});

describe("spinOffs on a run that isn't a Request-changes run (#884)", () => {
  const MAIN = "9".repeat(40);
  const flaw = (overrides: Partial<VerdictRecord> = {}): VerdictRecord => pass({ verdict: "execution-flaw", ...overrides });
  const ticket = (openPullRequests: number[]) => anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests });
  const onPullRequest = (pullRequest: Partial<PullRequestSnapshot>): Snapshot => ({ ...snapshotOfPullRequest(aPullRequest(pullRequest)), issue: ticket([50]), requestChangesAsks: ASKS });
  /** An Implement run's push job whose output returns a Spin-off, or the same output without it. */
  const run = (fixes: Extract<LoopEvent, { kind: "implement-run-finished" }>["fixes"], changes: Changes, withSpinOffs: boolean): LoopEvent => ({
    kind: "implement-run-finished",
    runUrl: RUN,
    issue: 7,
    output: JSON.stringify({ title: "Handle the empty cart", summary: "Handles the empty cart.", fix: "Fixed the guard.", ...(withSpinOffs ? { spinOffs: [spinOff()] } : {}) }),
    branch: "fabrik/ticket-7",
    base: fixes === undefined ? "main" : "fabrik/ticket-7",
    changes,
    ...(fixes === undefined ? {} : { fixes }),
  });
  const onto = { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN };

  it.each([
    ["a first run", undefined, PUSHED, { ...snapshotOfPullRequest(aPullRequest()), pullRequest: null, issue: ticket([]), requestChangesAsks: ASKS }, "open-pull-request"],
    ["a Retry", onto, PUSHED, onPullRequest({ verdicts: [flaw()] }), "push-branch"],
    ["a Touch-up", { ...onto, touchUp: 1 }, PUSHED, onPullRequest({ verdicts: [flaw({ tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 0 }, touchUp: 1 })] }), "push-branch"],
    ["a conflict-only run", { ...onto, conflict: MAIN }, { ...PUSHED, updatedFromMain: true }, onPullRequest({ verdicts: [pass()], conflictRunInFlight: MAIN }), "push-branch"],
  ] as const)("opens nothing on %s: it lands as it would without them", (_, fixes, changes, read, lands) => {
    const withThem = planFor(run(fixes, changes, true), read, kitConfig());

    expect(withThem).toEqual(planFor(run(fixes, changes, false), read, kitConfig()));
    expect(actionsOf(withThem).map((action) => action.kind)).toContain(lands);
    expect(created(withThem)).toEqual([]);
    expect(JSON.stringify(withThem)).not.toContain("Spin-off");
  });
});
