// The adapter reads the Kit's history back from comments the core's plans
// posted. These tests post them through planFor and read them back, so the
// writer and the reader can't drift apart.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan, Snapshot } from "../loop/types.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { countEmptyDiffs, designSessionOf, designTurnFailedIn, pendingPrototypeIn, requestChangesRunIn, verdictsIn } from "./threads.ts";

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
    output: JSON.stringify({ title: "Rename the total", summary: "Renames the total.", fix: "Renamed the total as the Operator asked." }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, requestChanges: true },
  };
  const pushSnapshot: Snapshot = {
    ...snapshotOfPullRequest(aPullRequest({ verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] })),
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
      { prototypes: true },
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
  /** A comment as the adapter reads it for this: its text, and whether the Fabrik App wrote it. */
  const app = (body: string) => ({ body, byApp: true });
  const other = (body: string) => ({ body, byApp: false });
  const brief = "- **A**: one long form.\n- **B**: a stepper.";
  const asked = { route: "/book", variants: 2, brief };

  /** The prototype request the core posts for an ordinary turn that asked for this one. */
  function requested(request: { route: string; variants: number; brief: string } = asked) {
    const output = JSON.stringify({ kind: "prototype", ...request, comment: "Prototyping it." });
    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output },
      snapshotOf(anIssue({ number: 7, labels: ["needs-design"], designRounds: 1 })),
      kitConfig({ ui: UI }),
      { prototypes: true },
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

  it("reads the request the core posted as pending, through the Operator's replies and the session's ordinary rounds since", () => {
    expect(pendingPrototypeIn([ordinaryRound(1), other("Yes, prototype it."), requested(), other("Keep the header."), ordinaryRound(2)])).toEqual({
      request: asked,
      reply: null,
    });
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

    expect(pendingPrototypeIn([requested(), prototypeRound(2, PROTOTYPE_ROUND_MARKER), other("Try /checkout too."), requested(again)])).toEqual({
      request: again,
      reply: null,
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
    expect(pendingPrototypeIn([requested(), other(prototypeRound(2, PROTOTYPE_ROUND_MARKER).body), other(turnFailed().body)])).toEqual({
      request: asked,
      reply: null,
    });
  });

  it("reads a prototype round's marker only right under its round marker, so a round quoting one leaves the request pending", () => {
    const quoting = app([designRoundMarker(2), "@jrey **Design session, round 2.**", "", PROTOTYPE_ROUND_MARKER].join("\n"));

    expect(pendingPrototypeIn([requested(), quoting, app(PROTOTYPE_FAILURE_ROUND_MARKER)])).not.toBeNull();
  });
});
