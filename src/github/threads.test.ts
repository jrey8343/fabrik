// The adapter reads the Kit's history back from comments the core's plans
// posted. These tests post them through planFor and read them back, so the
// writer and the reader can't drift apart.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { planFor } from "../loop/rules.ts";
import type { LoopEvent, Plan, Snapshot } from "../loop/types.ts";
import { countEmptyDiffs, designSessionOf, requestChangesRunIn, verdictsIn } from "./threads.ts";

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
  return { kind: "review-run-finished", pullRequest: 50, headSha, output, runUrl: RUN };
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
    output: JSON.stringify({ title: "Rename the total", summary: "Renamed the total as the Operator asked." }),
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
});
