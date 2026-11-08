// The adapter reads the Kit's history back from comments the core's plans
// posted. These tests post them through planFor and read them back, so the
// writer and the reader can't drift apart.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan, Snapshot } from "../loop/types.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import {
  conflictAttemptsIn,
  conflictRunIn,
  conflictRunInFlightIn,
  countEmptyDiffs,
  designSessionOf,
  designTurnFailedIn,
  pendingPrototypeIn,
  pushedSinceVerdictIn,
  requestChangesRunIn,
  unansweredPrototypesIn,
  verdictsIn,
} from "./threads.ts";
import { conflictAttemptMarker, CONFLICT_RUN_ENDED_MARKER, CONFLICT_RUN_MARKER, requestChangesAnswersIn, verdictMarker } from "../loop/markers.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const VERDICT_URL = "https://github.com/acme/shop/pull/50#issuecomment-9001";

function commentsOf(plan: Plan): string[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

function redChecks(headSha: string): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha, failed: ["build"], runUrl: RUN };
}

function reviewed(output: string, headSha = HEAD_SHA): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

describe("Reading a PR's Verdicts", () => {
  it("reads them back from a PR's comments alone, oldest first, skipping every other comment", () => {
    const ci = planFor(redChecks("1".repeat(40)), snapshotOfPullRequest(aPullRequest({ headSha: "1".repeat(40) })), kitConfig());
    const pass = planFor(
      reviewed("verdict: pass", "2".repeat(40)),
      snapshotOfPullRequest(aPullRequest({ headSha: "2".repeat(40) })),
      kitConfig(),
    );
    const comments = [
      "Nice work!",
      ...commentsOf(ci),
      "<!-- fabrik:verdict not json -->",
      'Quoting: <!-- fabrik:verdict {"verdict":"pass","source":"reviewer","requestChanges":false,"headSha":"x"} -->',
      ...commentsOf(pass),
    ];

    expect(verdictsIn(comments)).toEqual([
      { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: "1".repeat(40) },
      { verdict: "pass", source: "reviewer", requestChanges: false, headSha: "2".repeat(40) },
    ]);
  });
});

describe("Reading whether a PR's latest push came from a Request-changes run", () => {
  const pushed: LoopEvent = {
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({
      title: "Rename the total",
      summary: "Renames the total.",
      fix: "Renamed the total as the Operator asked.",
      reviewMiss: false,
      amendsTicket: true,
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, review: 900 },
  };
  const pushSnapshot: Snapshot = {
    ...snapshotOfPullRequest(
      aPullRequest({
        verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
        notedChangesRequests: [900],
        requestChangesRunInFlight: 900,
        requestChangesRunReviews: [900],
      }),
    ),
    issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
  };

  it("is true once the Kit's note of the push is posted", () => {
    expect(requestChangesRunIn(commentsOf(planFor(pushed, pushSnapshot, kitConfig())))).toBe(true);
  });

  it("stops being true once a Verdict lands after it, which is itself marked as from the Request-changes run", () => {
    const note = commentsOf(planFor(pushed, pushSnapshot, kitConfig()));
    const head = "b".repeat(40);
    const verdict = commentsOf(
      planFor(
        reviewed("verdict: pass", head),
        snapshotOfPullRequest(aPullRequest({ headSha: head, requestChangesRun: requestChangesRunIn(note) })),
        kitConfig(),
      ),
    );

    expect(verdictsIn(verdict)).toEqual([{ verdict: "pass", source: "reviewer", requestChanges: true, headSha: head }]);
    expect(requestChangesRunIn([...note, ...verdict])).toBe(false);
  });
});

describe("Reading a Request-changes run's answers about its review (#369)", () => {
  // The Request-changes run the Kit's note started for `review` is in flight (#341).
  const pushSnapshot = (review: number): Snapshot => ({
    ...snapshotOfPullRequest(
      aPullRequest({
        verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
        notedChangesRequests: [review],
        requestChangesRunInFlight: review,
        requestChangesRunReviews: [review],
      }),
    ),
    issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
  });
  const pushedFor = (review: number, answers: Record<string, unknown>): LoopEvent => ({
    kind: "implement-run-finished",
    issue: 7,
    output: JSON.stringify({ title: "Rebase onto main", summary: "Adds the waitlist.", fix: "Rebased onto main as the Operator asked.", ...answers }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [], commits: [], updatedFromMain: true },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, review },
  });

  it("reads a review that only asked for a rebase back as no Review miss and no amendment, for that review", () => {
    const [note = ""] = commentsOf(planFor(pushedFor(901, { reviewMiss: false, amendsTicket: false }), pushSnapshot(901), kitConfig()));

    expect(requestChangesAnswersIn(note)).toEqual({ review: 901, reviewMiss: false, amendsTicket: false });
  });

  it("reads each review's answers from its own run's comment", () => {
    const first = commentsOf(planFor(pushedFor(901, { reviewMiss: true, reviewMissPoints: ["The Ticket asked for it"], amendsTicket: false }), pushSnapshot(901), kitConfig()));
    const second = commentsOf(planFor(pushedFor(902, { reviewMiss: false, amendsTicket: true }), pushSnapshot(902), kitConfig()));

    expect([...first, ...second].map(requestChangesAnswersIn)).toEqual([
      { review: 901, reviewMiss: true, amendsTicket: false },
      { review: 902, reviewMiss: false, amendsTicket: true },
    ]);
  });

  it.each([
    ["a Request-changes note from before the answers", "<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes."],
    [
      "a marker quoted further down, as agent text",
      '<!-- fabrik:request-changes-run -->\nThe Implementer pushed.\n<!-- fabrik:request-changes-answers {"review":901,"reviewMiss":false,"amendsTicket":false} -->',
    ],
    ["a marker naming no review", '<!-- fabrik:request-changes-run -->\n<!-- fabrik:request-changes-answers {"reviewMiss":false,"amendsTicket":false} -->'],
    ["a marker with an answer that isn't yes or no", '<!-- fabrik:request-changes-run -->\n<!-- fabrik:request-changes-answers {"review":901,"reviewMiss":"no","amendsTicket":false} -->'],
    ["a marker that isn't JSON", "<!-- fabrik:request-changes-run -->\n<!-- fabrik:request-changes-answers {review} -->"],
  ])("reads no answers from %s", (_, body) => {
    expect(requestChangesAnswersIn(body)).toBeNull();
  });
});

describe("Counting a Ticket's earlier empty diffs", () => {
  const marker = "<!-- fabrik:empty-diff -->\nThe Implementer's branch changed nothing.";
  const round = "<!-- fabrik:design-round 1 -->\n@operator **Design session, round 1.**";
  const finishedSession = "**Design session finished.** This issue is now its agent brief, ready for an Implementer.";

  it("counts the comment an empty diff posts", () => {
    const empty: LoopEvent = {
      kind: "implement-run-finished",
      issue: 7,
      output: JSON.stringify({ title: "Add a waitlist", summary: "Nothing." }),
      branch: "fabrik/ticket-7",
      base: "main",
      changes: { net: [], commits: [] },
    };
    const comments = commentsOf(planFor(empty, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })), kitConfig()));

    expect(countEmptyDiffs(comments)).toBe(1);
  });

  it("counts the Kit's empty-diff comments", () => {
    expect(countEmptyDiffs(["hello", marker, "a reply", marker])).toBe(2);
  });

  it.each([
    ["a Design-session round", round],
    ["a finished Design session", finishedSession],
    ["a live Design session's outcome", "<!-- fabrik:live-outcome brief -->\nDecided in a live session."],
  ])("starts again after %s, so a Ticket back from design gets fresh retries", (_what, comment) => {
    expect(countEmptyDiffs([marker, marker, comment, marker])).toBe(1);
  });

  it("ignores someone quoting the marker mid-comment", () => {
    expect(countEmptyDiffs([`see this: ${marker}`])).toBe(0);
  });
});

/** A Ticket's comment, as the adapter reads it: its text, and whether a bot (the Fabrik App) wrote it. */
const kit = (body: string) => ({ body, byBot: true });
const person = (body: string) => ({ body, byBot: false });
const note = (pullRequest: number) =>
  kit(`<!-- fabrik:back-to-design ${pullRequest} ${VERDICT_URL} -->\n**Back to design.** The Reviewer gave #${pullRequest} a Design flaw.`);
const round = (n: number) => kit(`<!-- fabrik:design-round ${n} -->\n@jrey **Design session, round ${n}.**`);

describe("Reading a Ticket's Design session from its comments", () => {
  it("a Ticket that never came back has no return, and counts its rounds", () => {
    expect(designSessionOf([round(1), person("yes"), round(2)])).toEqual({ designRounds: 2, sentBack: null });
  });

  it("the Kit's note starts a new session that follows the return, counting rounds again from 1", () => {
    const comments = [
      round(1),
      person("yes"),
      kit("**Design session finished.** This issue is now its agent brief, ready for an Implementer."),
      note(50),
      round(1),
    ];

    expect(designSessionOf(comments)).toEqual({
      designRounds: 1,
      sentBack: { pullRequest: 50, verdictUrl: VERDICT_URL },
    });
  });

  it("the session finishing ends the return", () => {
    const comments = [note(50), round(1), person("yes"), kit("**Design session finished.** This issue is now its agent brief.")];

    expect(designSessionOf(comments)).toEqual({ designRounds: 0, sentBack: null });
  });

  it("the latest return counts, after a Ticket came back twice", () => {
    expect(designSessionOf([note(50), round(1), kit("**Design session finished.** Done."), note(61)]).sentBack).toEqual({
      pullRequest: 61,
      verdictUrl: VERDICT_URL,
    });
  });

  it("a person quoting the note doesn't fake a return", () => {
    expect(designSessionOf([person(note(50).body)]).sentBack).toBeNull();
  });

  it("reads the note the Operator's needs-design on an agent PR leaves as a return from that PR", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "needs-design" },
      snapshotOfPullRequest(aPullRequest({ draft: false })),
      kitConfig(),
    );

    expect(designSessionOf(commentsOf(plan).map(kit)).sentBack).toEqual({ pullRequest: 50, verdictUrl: null });
  });

  it("reads a round the core posted as a round", () => {
    const output = JSON.stringify({ kind: "round", intro: "Hi.", questions: [{ question: "Q?", recommendation: "R." }] });
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })),
      kitConfig(),
    );

    expect(designSessionOf(commentsOf(plan).map(kit)).designRounds).toBe(1);
  });

  it("reads a prototype request the core posted as no round, and no end of the session or its return", () => {
    const output = JSON.stringify({ kind: "prototype", route: "/book", variants: 3, brief: "Three takes.", comment: "Prototyping it." });
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: 1 })),
      kitConfig({ ui: UI }),
    );
    const requested = commentsOf(plan);

    expect(requested).toHaveLength(1);
    expect(designSessionOf([note(50), round(1), person("Yes, prototype it."), ...requested.map(kit)])).toEqual({
      designRounds: 1,
      sentBack: { pullRequest: 50, verdictUrl: VERDICT_URL },
    });
  });
});

describe("Reading whether a Design-session turn failed in the current session", () => {
  const failed = (): { body: string; byBot: boolean }[] => {
    const plan = planFor(
      { kind: "agent-run-failed", role: "design", issue: 7, runUrl: RUN, jobResult: "failure", secretsStep: "success", report: null },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })),
      kitConfig(),
    );
    return commentsOf(plan).map(kit);
  };

  it("reads the failure notice the core posted for a Design-session turn", () => {
    expect(designTurnFailedIn(failed())).toBe(true);
  });

  it("reads a session with no failure notice as not failed", () => {
    expect(designTurnFailedIn([round(1), person("yes")])).toBe(false);
  });

  it("forgets a failure once the session ends, or a new one follows a return", () => {
    expect(designTurnFailedIn([...failed(), kit("**Design session finished.** This issue is now its agent brief.")])).toBe(false);
    expect(designTurnFailedIn([...failed(), note(50)])).toBe(false);
  });

  it("doesn't read another role's failure notice, or a person quoting one, as a failed turn", () => {
    const implement = planFor(
      { kind: "agent-run-failed", role: "implement", issue: 7, runUrl: RUN, jobResult: "failure", secretsStep: "success", report: null },
      snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"] })),
      kitConfig(),
    );

    expect(designTurnFailedIn(commentsOf(implement).map(kit))).toBe(false);
    expect(designTurnFailedIn(failed().map(({ body }) => person(body)))).toBe(false);
  });
});

describe("Reading an issue's pending prototype request in the current session", () => {
  /** A comment as the adapter reads it for this: its id, its text, and whether the Fabrik App wrote it. */
  let ids = 100;
  const app = (body: string) => ({ id: ids++, body, byApp: true });
  const other = (body: string, id = ids++) => ({ id, body, byApp: false });
  const brief = "- **A**: one long form.\n- **B**: a stepper.";
  const asked = { route: "/book", variants: 2, brief };

  /** The prototype request the core posts for an ordinary turn that asked for this one: started by the Operator's reply `reply`, or by agent:design. */
  function requested(request: { route: string; variants: number; brief: string } = asked, reply: number | null = null) {
    const output = JSON.stringify({ kind: "prototype", ...request, comment: "Prototyping it." });
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output, ...(reply === null ? {} : { startedBy: reply }) },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: 1 }), reply === null ? {} : { startingComment: { id: reply, exists: true } }),
      kitConfig({ ui: UI }),
    );
    return app(commentsOf(plan)[0] ?? "");
  }

  /** The failure notice the core posts for a Design-session turn, a prototype turn's included (#155). */
  function turnFailed() {
    const plan = planFor(
      { kind: "agent-run-failed", role: "design", issue: 7, runUrl: RUN, jobResult: "failure", secretsStep: "success", report: null },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })),
      kitConfig(),
    );
    return app(commentsOf(plan)[0] ?? "");
  }

  /** A prototype round, or a prototype failure round, as #277 posts it: a round whose marker line has the prototype's right under it. */
  const prototypeRound = (n: number, marker: string) =>
    app([designRoundMarker(n), marker, `@jrey **Design session, round ${n}.** Here are the variants.`].join("\n"));
  const ordinaryRound = (n: number) => app(`${designRoundMarker(n)}\n@jrey **Design session, round ${n}.**`);

  it("reads the request the core posted as pending, through the Operator's replies and the session's ordinary rounds since, with its comment, its prototype turn not yet started", () => {
    const request = requested();

    expect(pendingPrototypeIn([ordinaryRound(1), other("Yes, prototype it."), request, other("Keep the header."), ordinaryRound(2)])).toEqual({
      request: asked,
      reply: null,
      comment: request.id,
      started: false,
    });
  });

  it("reads a request whose approving reply is still on the issue as pending, with that reply", () => {
    expect(pendingPrototypeIn([ordinaryRound(1), other("Yes, prototype it.", 9001), requested(asked, 9001)])).toMatchObject({ request: asked, reply: 9001 });
  });

  // The reply is older than its request, so it can fall outside the comments the snapshot reads while the request doesn't.
  it("reads a request whose approving reply was deleted, or is older than every comment read, as not pending, so no agent:design builds it again", () => {
    expect(pendingPrototypeIn([ordinaryRound(1), requested(asked, 9001)])).toBeNull();
    expect(pendingPrototypeIn([other("Yes, prototype it.", 9001), requested(asked, 9001)], new Set([]))).toBeNull();
  });

  it("reads none in a session that asked for none", () => {
    expect(pendingPrototypeIn([ordinaryRound(1), other("yes")])).toBeNull();
  });

  it.each([
    ["a prototype round", () => prototypeRound(2, PROTOTYPE_ROUND_MARKER)],
    ["a prototype failure round", () => prototypeRound(2, PROTOTYPE_FAILURE_ROUND_MARKER)],
    ["the failure notice of a Design-session turn", turnFailed],
  ])("reads a request followed by %s as no longer pending", (_, after) => {
    expect(pendingPrototypeIn([ordinaryRound(1), requested(), after()])).toBeNull();
  });

  it("reads the latest request as pending when another follows one that ended", () => {
    const again = { route: "/checkout", variants: 3, brief: "Three checkouts." };

    const latest = requested(again);

    expect(pendingPrototypeIn([requested(), prototypeRound(2, PROTOTYPE_ROUND_MARKER), other("Try /checkout too."), latest])).toEqual({
      request: again,
      reply: null,
      comment: latest.id,
      started: false,
    });
  });

  it("forgets a request once the session ends, or a new one follows a return", () => {
    expect(pendingPrototypeIn([requested(), app("**Design session finished.** This issue is now its agent brief.")])).toBeNull();
    expect(pendingPrototypeIn([requested(), app("<!-- fabrik:live-outcome brief -->\nDone live.")])).toBeNull();
    expect(pendingPrototypeIn([requested(), app(note(50).body)])).toBeNull();
  });

  it("reads neither a request nor its end from anyone but the Fabrik App", () => {
    const { body } = requested();

    expect(pendingPrototypeIn([other(body)])).toBeNull();
    expect(pendingPrototypeIn([requested(), other(prototypeRound(2, PROTOTYPE_ROUND_MARKER).body), other(turnFailed().body)])).toMatchObject({
      request: asked,
      reply: null,
    });
  });

  it("reads a prototype round's marker only right under its round marker, so a round quoting one leaves the request pending", () => {
    const quoting = app([designRoundMarker(2), "@jrey **Design session, round 2.**", "", PROTOTYPE_ROUND_MARKER].join("\n"));

    expect(pendingPrototypeIn([requested(), quoting, app(PROTOTYPE_FAILURE_ROUND_MARKER)])).not.toBeNull();
  });

  describe("and the requests a prototype turn's result may still land on", () => {
    const again = { route: "/checkout", variants: 3, brief: "Three checkouts." };

    /** The Map cap's refusal of a turn's Map, which opens like a failed turn's notice. */
    function mapRefused() {
      const output = JSON.stringify({
        kind: "map",
        comment: "Too foggy for one session, so it's a Map.",
        destination: "Patients book group classes online.",
        notes: "Notes.",
        notYetSpecified: "- How classes are priced",
        outOfScope: "- Video classes",
        decisions: [{ key: "provider", title: "Group classes: provider?", body: "## Question\n\nWhich provider?", type: "research", blockedBy: [] }],
      });
      const plan = planFor(
        { kind: "agent-run-finished", role: "design", issue: 7, output },
        snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: 1 }), { openMaps: [12] }),
        kitConfig({ caps: { ...kitConfig().caps, maps: 1 } }),
      );
      return app(commentsOf(plan)[0] ?? "");
    }

    it("reads a request no prototype round has answered as one, though another turn's failure notice or the Map cap's refusal ended it as pending", () => {
      for (const ended of [turnFailed(), mapRefused()]) {
        const thread = [requested(), other("Keep the header."), ended];

        expect(pendingPrototypeIn(thread)).toBeNull();
        expect(unansweredPrototypesIn(thread)).toEqual([{ request: asked, reply: null }]);
      }
    });

    it.each([
      ["a prototype round", PROTOTYPE_ROUND_MARKER],
      ["a prototype failure round", PROTOTYPE_FAILURE_ROUND_MARKER],
    ])("reads a request %s answered as answered, so a second landing of it is stale", (_, marker) => {
      expect(unansweredPrototypesIn([requested(), prototypeRound(2, marker)])).toEqual([]);
    });

    it("reads each round as answering the oldest request it follows, as the session's turns build them in turn", () => {
      const thread = [requested(), requested(again), prototypeRound(2, PROTOTYPE_ROUND_MARKER)];

      expect(unansweredPrototypesIn(thread)).toEqual([{ request: again, reply: null }]);
      expect(unansweredPrototypesIn([...thread, prototypeRound(3, PROTOTYPE_ROUND_MARKER)])).toEqual([]);
    });

    it("reads none once the session ends, from anyone but the Fabrik App, or a round's marker anywhere but under its round marker", () => {
      expect(unansweredPrototypesIn([requested(), app("**Design session finished.** This issue is now its agent brief.")])).toEqual([]);
      expect(unansweredPrototypesIn([requested(), app(note(50).body)])).toEqual([]);
      expect(unansweredPrototypesIn([other(requested().body)])).toEqual([]);
      expect(unansweredPrototypesIn([requested(), other(prototypeRound(2, PROTOTYPE_ROUND_MARKER).body)])).toHaveLength(1);
      expect(unansweredPrototypesIn([requested(), app([designRoundMarker(2), "@jrey **Round 2.**", PROTOTYPE_ROUND_MARKER].join("\n"))])).toHaveLength(1);
    });
  });
});

describe("Reading a PR's conflict attempts and conflict-only run (#304)", () => {
  const MAIN = "9".repeat(40);
  const NEXT = "7".repeat(40);
  const started = (main: string) => `${conflictAttemptMarker({ main, outcome: "conflict-run" })}\nA conflict-only run starts.`;
  const rebased = (main: string) => `${conflictAttemptMarker({ main, outcome: "rebased" })}\nRebased cleanly.`;
  const verdict = (conflictRun: boolean) =>
    verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, ...(conflictRun ? { conflictRun: true as const } : {}), headSha: "b".repeat(40) });

  it("reads every main head the Kit tried, oldest first, however each attempt went", () => {
    expect(conflictAttemptsIn([rebased(MAIN), "Some comment", started(NEXT)])).toEqual([MAIN, NEXT]);
  });

  it("reads only a note's first line, so quoting a marker further down doesn't count", () => {
    expect(conflictAttemptsIn([`Quoting:\n${rebased(MAIN)}`])).toEqual([]);
  });

  it("has a conflict-only run in flight from the note that started it until its push note or its ended note", () => {
    expect(conflictRunInFlightIn([started(MAIN)])).toBe(MAIN);
    expect(conflictRunInFlightIn([started(MAIN), `${CONFLICT_RUN_MARKER}\nPushed.`])).toBeNull();
    expect(conflictRunInFlightIn([started(MAIN), `${CONFLICT_RUN_ENDED_MARKER}\nIt failed.`])).toBeNull();
    expect(conflictRunInFlightIn([rebased(MAIN)])).toBeNull();
  });

  it("counts a conflict-only run's push as a run's push, and marks the next Verdict as from it until one lands", () => {
    const pushed = [started(MAIN), `${CONFLICT_RUN_MARKER}\nPushed.`];

    expect(pushedSinceVerdictIn(pushed)).toBe(true);
    expect(conflictRunIn(pushed)).toBe(true);
    expect(conflictRunIn([...pushed, verdict(true)])).toBe(false);
  });

  it("reads a Verdict marked as from a conflict-only run, and an older marker without the mark as from none", () => {
    expect(verdictsIn([verdict(true)])).toEqual([expect.objectContaining({ conflictRun: true })]);
    expect(verdictsIn([verdict(false)])[0]).not.toHaveProperty("conflictRun");
    expect(verdict(false)).not.toContain("conflictRun");
  });
});
