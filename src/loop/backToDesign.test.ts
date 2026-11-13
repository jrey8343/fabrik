import { describe, expect, it } from "vitest";
import {
  anIssue,
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { roundLineIn, withoutRoundLines } from "./roundLine.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function reviewed(output: string): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
}

function redChecks(): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** An earlier Verdict on an older commit. */
function earlier(verdict: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return { verdict, source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides };
}

const designFlaw = reviewed("verdict: design-flaw\n\nThe Ticket asks for a cart total the checkout never reads.");

describe("A Design flaw sends the Ticket back to design", () => {
  it("closes the PR, keeping its branch, and swaps ready-for-agent for needs-design on the Ticket", () => {
    const plan = planFor(designFlaw, snapshotOfPullRequest(aPullRequest()), kitConfig());

    const actions = actionsOf(plan);
    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "ready-for-agent" });
    expect(actions).toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
    // Nothing else happens: no action deletes the branch. needs-design goes on last,
    // so the Design session it starts sees everything else.
    expect(actions.map((action) => action.kind)).toEqual([
      "comment",
      "close-pull-request",
      "comment-linking",
      "remove-label",
      // The Kept-branch start mark, so the Design session starts with it off (#536).
      "remove-label",
      "add-labels",
    ]);
  });
});

/** Two Execution flaws already on the PR, so the next is its third. */
const usedUp = aPullRequest({ pushedSinceVerdict: true, verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { source: "ci" })] });

/** The second retry's push job, holding a branch that changed nothing on the PR it fixes. */
const emptySecondRetry: LoopEvent = {
  kind: "implement-run-finished",
  runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
  issue: 7,
  output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change.", fix: "Nothing to change." }),
  branch: "fabrik/ticket-7",
  base: "fabrik/ticket-7",
  changes: { net: [], commits: [] },
  fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN },
};

describe("A third Execution flaw counts as a Design flaw", () => {
  it.each([
    ["from the Reviewer", reviewed("verdict: execution-flaw\n\nStill throws on the empty cart."), snapshotOfPullRequest(usedUp)],
    ["from red CI", redChecks(), snapshotOfPullRequest(usedUp)],
    [
      "from a retry that changed nothing",
      emptySecondRetry,
      {
        ...snapshotOfPullRequest(
          aPullRequest({ verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { headSha: HEAD_SHA })] }),
        ),
        issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
      },
    ],
  ])("%s sends its Ticket to needs-design and closes the PR, starting no retry", (_, event, snapshot) => {
    const actions = actionsOf(planFor(event, snapshot, kitConfig()));

    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions).toContainEqual({ kind: "remove-label", issue: 7, label: "ready-for-agent" });
    expect(actions.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
    expect(actions).not.toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });

  it("a second Execution flaw still retries, and leaves the Ticket and its PR as they are", () => {
    const pullRequest = aPullRequest({ pushedSinceVerdict: true, verdicts: [earlier("execution-flaw")] });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).not.toContain("close-pull-request");
    expect(actionsOf(plan)).not.toContainEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
  });

  it("an Execution flaw from a Request-changes run counts toward the third, as the Retry it called for does (#393)", () => {
    // The first flaw started Retry 1; the Request-changes run's flaw started Retry 2; this one has none left.
    const pullRequest = aPullRequest({
      pushedSinceVerdict: true,
      verdicts: [earlier("execution-flaw"), earlier("execution-flaw", { requestChanges: true })],
    });
    const plan = planFor(reviewed("verdict: execution-flaw\n\nStill throws."), snapshotOfPullRequest(pullRequest), kitConfig());

    expect(actionsOf(plan)).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
  });
});

describe("A Verdict that would go back to design while the Ticket is closed (#585)", () => {
  const ticketClosed = { ticketState: "closed" } as const;

  it.each([
    ["A Design flaw", designFlaw, aPullRequest(ticketClosed), "The Ticket #7 is closed, so this PR stays open and no Design session starts."],
    [
      "A third Execution flaw from the Reviewer",
      reviewed("verdict: execution-flaw\n\nStill throws on the empty cart."),
      aPullRequest({ ...usedUp, ...ticketClosed }),
      "This is the Ticket's third Execution flaw, which counts as a Design flaw. The Ticket #7 is closed, so this PR stays open and no Design session starts.",
    ],
    [
      "A third Execution flaw from red CI",
      redChecks(),
      aPullRequest({ ...usedUp, ...ticketClosed }),
      "This is the Ticket's third Execution flaw, which counts as a Design flaw. The Ticket #7 is closed, so this PR stays open and no Design session starts.",
    ],
  ])("%s posts its Verdict, ending with why, and closes nothing and leaves the Ticket alone", (_, event, pullRequest, line) => {
    const actions = actionsOf(planFor(event, snapshotOfPullRequest(pullRequest), kitConfig()));

    expect(actions).toHaveLength(1);
    const [verdict] = actions;
    expect(verdict).toMatchObject({ kind: "comment", issue: 50, key: "verdict" });
    const body = verdict?.kind === "comment" ? withoutRoundLines(verdict.body) : "";
    expect(body).toContain(`\n\n${line}\n\n[The run](${RUN})`);
    expect(body).not.toContain("closes unmerged");
    expect(body).not.toContain("A Design session on this Ticket starts now");
  });

  it("goes back to design as ever when the PR doesn't link its Ticket, as its state wasn't read", () => {
    const actions = actionsOf(planFor(designFlaw, snapshotOfPullRequest(aPullRequest({ ticketState: "unknown" })), kitConfig()));

    expect(actions).toContainEqual({ kind: "close-pull-request", pullRequest: 50 });
    expect(actions.at(-1)).toEqual({ kind: "add-labels", issue: 7, labels: ["needs-design"] });
  });
});

describe("Going back to design notifies nobody", () => {
  it.each([
    ["a Design flaw", reviewed("verdict: design-flaw\n\nWrong approach, @someone."), aPullRequest()],
    ["a third Execution flaw", reviewed("verdict: execution-flaw\n\nStill throws, @someone."), usedUp],
  ])("%s mentions, assigns and requests nobody: the Design session's round 1 does", (_, event, pullRequest) => {
    const plan = planFor(event, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
    expect(notificationsOf(plan, "someone")).toEqual([]);
  });
});

describe("The Kit's note on the Ticket", () => {
  it("links the closed PR and its Verdict, which the same plan posts first", () => {
    const actions = actionsOf(planFor(designFlaw, snapshotOfPullRequest(aPullRequest()), kitConfig()));

    const verdict = actions.find((action) => action.kind === "comment");
    const note = actions.find((action) => action.kind === "comment-linking");
    expect(verdict).toMatchObject({ issue: 50, key: "verdict" });
    expect(note).toMatchObject({ issue: 7 });
    const text =
      note?.kind === "comment-linking"
        ? note.body.map((part) => (typeof part === "string" ? part : `<${"posted" in part ? part.posted : part.created}>`)).join("")
        : "";
    expect(text).toContain("#50");
    expect(text).toContain("[the Verdict](<verdict>)");
    expect(text).toContain("`fabrik/ticket-7`");
  });
});

const VERDICT_URL = "https://github.com/acme/shop/pull/50#issuecomment-9001";

const roundOutput = JSON.stringify({
  kind: "round",
  intro: "The cart total needs a home before the Ticket can be rebuilt.",
  questions: [{ question: "Should checkout read the cart total?", recommendation: "Yes, from the cart service." }],
});

const turnFinished: LoopEvent = { kind: "agent-run-finished", role: "design", issue: 7, output: roundOutput };

/** The Ticket in the Design session that follows its return from #50. */
const returnedTicket = anIssue({
  number: 7,
  parent: 3,
  labels: ["enhancement", "needs-design"],
  sentBack: { pullRequest: 50, verdictUrl: VERDICT_URL },
});

describe("The Design session after a Ticket comes back", () => {
  it("opens round 1 by saying why the Ticket came back, linking the closed PR and its Verdict", () => {
    const plan = planFor(turnFinished, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());

    const [round] = actionsOf(plan);
    expect(round).toMatchObject({ kind: "comment", issue: 7 });
    const body = round?.kind === "comment" ? round.body : "";
    expect(body).toContain("**Design session, round 1.**");
    expect(body).toContain(`This Ticket came back from #50, which the Kit closed unmerged after [its Verdict](${VERDICT_URL}).`);
    expect(body).toContain("The cart total needs a home");
  });

  it("round 1 is the event's one notification, an @-mention of the Operator", () => {
    const labeled = planFor({ kind: "label-added", issue: 7, label: "needs-design" }, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());
    const round = planFor(turnFinished, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());

    expect(notificationsOf(labeled, "jrey")).toEqual([]);
    expect(notificationsOf(round, "jrey")).toEqual(["mention on #7"]);
  });

  it("later rounds don't repeat it", () => {
    const plan = planFor(turnFinished, snapshotOf({ ...returnedTicket, designRounds: 1 }), kitConfig());

    const [round] = actionsOf(plan);
    expect(round?.kind === "comment" ? round.body : "").not.toContain("came back from");
  });

  it("round 1's hidden line carries the PR it came back from and its Verdict's address", () => {
    const [round] = actionsOf(planFor(turnFinished, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig()));

    expect(roundLineIn(round?.kind === "comment" ? round.body : "")).toMatchObject({ round: 1, sentBack: { pullRequest: 50, verdict: VERDICT_URL } });
  });

  it("round 1's hidden line carries a null Verdict when the Operator sent the Ticket back", () => {
    const sentByOperator = { ...returnedTicket, sentBack: { pullRequest: 50, verdictUrl: null } };

    const [round] = actionsOf(planFor(turnFinished, snapshotOf(sentByOperator, { operator: "jrey" }), kitConfig()));

    expect(roundLineIn(round?.kind === "comment" ? round.body : "")).toMatchObject({ round: 1, sentBack: { pullRequest: 50, verdict: null } });
  });

  it("later rounds' hidden lines carry no sentBack, nor does a session that didn't follow a return", () => {
    const later = actionsOf(planFor(turnFinished, snapshotOf({ ...returnedTicket, designRounds: 1 }), kitConfig()))[0];
    const plain = actionsOf(planFor(turnFinished, snapshotOf({ ...returnedTicket, sentBack: null }), kitConfig()))[0];

    for (const round of [later, plain]) {
      const line = roundLineIn(round?.kind === "comment" ? round.body : "");
      expect(line).not.toBeNull();
      expect(line).not.toHaveProperty("sentBack");
    }
  });

  it("a session that didn't follow a return says nothing about one, as before", () => {
    const plan = planFor(turnFinished, snapshotOf({ ...returnedTicket, sentBack: null }), kitConfig());

    const [round] = actionsOf(plan);
    expect(round?.kind === "comment" ? round.body : "").not.toContain("came back from");
  });
});

const given = [
  { id: "conversation-3", url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
  { id: "inline-8", url: "https://github.com/acme/shop/pull/50#discussion_r8" },
];

/** A finished turn on the returned Ticket that names `considered` and was given `operatorComments`. */
function turnNaming(output: object, considered: unknown, operatorComments = given): LoopEvent {
  return {
    kind: "agent-run-finished",
    role: "design",
    issue: 7,
    output: JSON.stringify({ ...output, operatorCommentsConsidered: considered }),
    operatorComments,
  };
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) =>
    action.kind === "comment"
      ? [action.body]
      : action.kind === "close-as-superseded"
        ? [action.comment.map((part) => (typeof part === "string" ? part : "#?")).join("")]
        : action.kind === "comment-linking"
          ? [action.body.map((part) => (typeof part === "string" ? part : "#?")).join("")]
          : [],
  );
}

describe("The Design session after a Ticket comes back names the Operator comments it weighed", () => {
  const round = JSON.parse(roundOutput) as object;

  it("ends a round with a link to each comment it named that it was given", () => {
    const plan = planFor(turnNaming(round, ["inline-8"]), snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());

    const [body] = commentsOf(plan);
    expect(body).toMatch(
      /\n\n### Operator comments considered\n\n- \[`inline-8`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#discussion_r8\)$/,
    );
    expect(body).not.toContain("conversation-3");
  });

  it("keeps the round's hidden line second, under its marker, and the comment without it as it always was", () => {
    const plan = planFor(turnNaming(round, ["inline-8"]), snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());

    const [body = ""] = commentsOf(plan);
    expect(body.split("\n")[1]).toMatch(/^<!-- fabrik:round-line .* -->$/);
    expect(roundLineIn(body)).toMatchObject({ round: 1, intro: "The cart total needs a home before the Ticket can be rebuilt." });
    expect(withoutRoundLines(body)).toBe(
      [
        "<!-- fabrik:design-round 1 -->",
        "@jrey **Design session, round 1.** Reply with the numbers you'd answer differently, or `yes` to take every recommendation.",
        "",
        `This Ticket came back from #50, which the Kit closed unmerged after [its Verdict](${VERDICT_URL}).`,
        "",
        "The cart total needs a home before the Ticket can be rebuilt.",
        "",
        "**1. Should checkout read the cart total?**",
        "➡️ Recommended: Yes, from the cart service.",
        "",
        "### Operator comments considered",
        "",
        "- [`inline-8`](https://github.com/acme/shop/pull/50#discussion_r8)",
      ].join("\n"),
    );
  });

  it("never links an id it wasn't given, and adds nothing when none is left", () => {
    const named = planFor(turnNaming(round, ["review-99"]), snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());
    const plain = planFor(turnFinished, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());

    expect(commentsOf(named)).toEqual(commentsOf(plain));
  });

  it("posts the comment unchanged when it names none, or gives a list that isn't one of ids", () => {
    const plain = commentsOf(planFor(turnFinished, snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig()));

    for (const considered of [[], undefined, "inline-8", [8]]) {
      const plan = planFor(turnNaming(round, considered), snapshotOf(returnedTicket, { operator: "jrey" }), kitConfig());
      expect(commentsOf(plan)).toEqual(plain);
    }
  });

  it("links nothing on a turn that was given no comments, as on an issue that was never sent back", () => {
    const issue = { ...returnedTicket, sentBack: null };
    const plan = planFor(turnNaming(round, ["inline-8"], []), snapshotOf(issue), kitConfig());

    expect(commentsOf(plan).join("\n")).not.toContain("Operator comments considered");
    expect(commentsOf(plan)).toEqual(commentsOf(planFor(turnFinished, snapshotOf(issue), kitConfig())));
  });

  const brief = {
    kind: "brief",
    comment: "Checkout reads the cart total.",
    brief: { summary: "Read the cart total at checkout.", acceptanceCriteria: ["Checkout shows the total."] },
  };
  const operatorBrief = {
    kind: "brief",
    comment: "Only the Operator can set the price.",
    brief: { operator: true, summary: "Set the price.", steps: ["Set it."] },
  };
  const ticket = { key: "total", title: "Read the total", body: "Checkout reads it.", blockedBy: [] };
  const split = { kind: "split", comment: "Two siblings.", tickets: [ticket, { ...ticket, key: "show", blockedBy: ["total"] }] };
  const notPlanned = { kind: "not-planned", comment: "The Operator dropped it." };

  it.each([
    ["an agent brief", brief],
    ["an Operator brief", operatorBrief],
    ["a split", split],
    ["not planned", notPlanned],
  ])("ends the closing comment of %s with the comments it weighed", (_, output) => {
    // returnedTicket blocks #12, so the split's moved edges and not-planned's note both come before the section.
    const plan = planFor(turnNaming(output, ["conversation-3"]), snapshotOf({ ...returnedTicket, openBlocking: [12] }), kitConfig());

    const closing = commentsOf(plan).filter((body) => body.includes("**Design session finished.**"));
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatch(
      /\n\n### Operator comments considered\n\n- \[`conversation-3`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#issuecomment-3\)$/,
    );
  });

  it("ends the closing comment of a Spec with the comments it weighed", () => {
    const spec = { kind: "spec", comment: "A Spec.", spec: { title: "Totals", body: "The Spec." }, tickets: [ticket] };
    const plan = planFor(turnNaming(spec, ["conversation-3"]), snapshotOf(anIssue({ ...returnedTicket, parent: null, parentIssue: null })), kitConfig());

    const [closing] = commentsOf(plan).filter((body) => body.includes("**Design session finished.**"));
    expect(closing).toMatch(/### Operator comments considered\n\n- \[`conversation-3`\]\([^)]+issuecomment-3\)$/);
  });

  it("ends the closing comment of a Map with the comments it weighed, after the Decisions it lists", () => {
    const decision = { key: "why", title: "Why did it come back?", body: "The question.", type: "grilling", blockedBy: [] };
    const map = { kind: "map", comment: "A Map.", destination: "Totals.", notes: "", notYetSpecified: "", outOfScope: "", decisions: [decision] };
    const plan = planFor(turnNaming(map, ["conversation-3"]), snapshotOf(anIssue({ ...returnedTicket, parent: null, parentIssue: null }), { openMaps: [] }), kitConfig());

    const closing = commentsOf(plan).filter((body) => body.includes("**Design session finished.**"));
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatch(/A Map\.\n\n### Operator comments considered\n\n- \[`conversation-3`\]\([^)]+issuecomment-3\)$/);
  });
});
