import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan } from "./types.ts";

const ticket = (key: string, blockedBy: string[] = []) => ({
  key,
  title: `Waitlist: ${key}`,
  body: `## What to build\n\nThe ${key} slice.`,
  blockedBy,
});

const finished = {
  kind: "spec",
  comment: "Too big for one PR, so it's a Spec in two Tickets.",
  spec: { title: "Spec: Waitlist", body: "## Problem Statement\n\nFully booked days lose patients." },
  tickets: [ticket("model"), ticket("sms", ["model"])],
};

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey" });

describe("Finishing a Design session with a Spec and its Tickets", () => {
  it("creates the Spec, then its Tickets as sub-issues with blocked-by edges, and closes the issue as superseded", () => {
    const plan = planFor(turnFinished(finished), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "create-issue",
          key: "spec",
          title: "Spec: Waitlist",
          body: [
            "## Problem Statement",
            "",
            "Fully booked days lose patients.",
            "",
            "<sub>Written by the Fabrik Design session on #7, which this Spec supersedes.</sub>",
          ].join("\n"),
          labels: ["enhancement", "ready-for-agent"],
          parent: null,
          blockedBy: [],
        },
        {
          kind: "create-issue",
          key: "ticket:model",
          title: "Waitlist: model",
          body: "## What to build\n\nThe model slice.",
          labels: ["enhancement", "ready-for-agent"],
          parent: { created: "spec" },
          blockedBy: [],
        },
        {
          kind: "create-issue",
          key: "ticket:sms",
          title: "Waitlist: sms",
          body: "## What to build\n\nThe sms slice.",
          labels: ["enhancement", "ready-for-agent"],
          parent: { created: "spec" },
          blockedBy: [{ created: "ticket:model" }],
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        {
          kind: "close-as-superseded",
          issue: 7,
          comment: [
            "**Design session finished.** This issue is superseded by the Spec ",
            { created: "spec" },
            " and its 2 Tickets.\n\nToo big for one PR, so it's a Spec in two Tickets.",
          ],
        },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("says the session finished once, even when the agent's comment starts by saying so too", () => {
    const output = { ...finished, comment: "**Design session finished.** Decisions:\n\n1. Two PRs." };

    const plan = planFor(turnFinished(output), inSession, kitConfig());

    const close = plan.kind === "act" ? plan.actions.find((a) => a.kind === "close-as-superseded") : undefined;
    expect(close && "comment" in close ? close.comment.at(-1) : null).toBe(" and its 2 Tickets.\n\nDecisions:\n\n1. Two PRs.");
  });

  it("creates each Ticket after the Tickets that block it, whatever order the session listed them in", () => {
    const output = { ...finished, tickets: [ticket("ui", ["sms", "model"]), ticket("sms", ["model"]), ticket("model"), ticket("docs")] };

    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(createdKeys(plan)).toEqual(["spec", "ticket:model", "ticket:sms", "ticket:ui", "ticket:docs"]);
  });

  it("gives the Spec and its Tickets only ready-for-agent when the issue has no category", () => {
    const plan = planFor(turnFinished(finished), snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());

    expect(created(plan).map((action) => action.labels)).toEqual([
      ["ready-for-agent"],
      ["ready-for-agent"],
      ["ready-for-agent"],
    ]);
  });

  it("says Ticket, not Tickets, when the Spec has only one", () => {
    const plan = planFor(turnFinished({ ...finished, tickets: [ticket("model")] }), inSession, kitConfig());

    expect(plan).toMatchObject({
      kind: "act",
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "close-as-superseded", comment: expect.arrayContaining([expect.stringContaining(" and its 1 Ticket.")]) }),
      ]),
    });
  });

  it("notifies nobody: no title, body or comment @-mentions anyone", () => {
    const noisy = {
      ...finished,
      comment: "Thanks @someone.",
      spec: { title: "Spec for @jrey", body: "Ask @org/team." },
      tickets: [{ ...ticket("model"), title: "Ping @jrey", body: "cc @reviewer" }],
    };

    const plan = planFor(turnFinished(noisy), inSession, kitConfig());

    const texts =
      plan.kind === "act"
        ? plan.actions.flatMap((action) => {
            if (action.kind === "create-issue") return [action.title, action.body];
            if (action.kind === "close-as-superseded") return action.comment.filter((part) => typeof part === "string");
            return [];
          })
        : [];
    expect(texts).toHaveLength(6);
    expect(texts.join("\n")).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
  });

  it("drops the outcome if the issue left needs-design while the turn ran, saying why", () => {
    const plan = planFor(turnFinished(finished), snapshotOf(anIssue({ number: 7, labels: ["ready-for-human"] })), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 no longer has needs-design" });
  });

  it.each([
    ["has no tickets", { ...finished, tickets: [] }],
    ["has no spec title", { ...finished, spec: { body: "Why." } }],
    ["has no comment", { ...finished, comment: "" }],
    ["has a ticket with no key", { ...finished, tickets: [{ ...ticket("model"), key: "" }] }],
    ["uses a ticket key twice", { ...finished, tickets: [ticket("model"), ticket("model")] }],
    ["has a ticket blocked by one that isn't there", { ...finished, tickets: [ticket("sms", ["model"])] }],
    ["has a ticket that blocks itself", { ...finished, tickets: [ticket("sms", ["sms"])] }],
    ["has tickets that block each other", { ...finished, tickets: [ticket("a", ["b"]), ticket("b", ["a"])] }],
  ])("fails the turn as an Infrastructure failure, changing nothing, when the spec %s", (_, output) => {
    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

describe("A Ticket the Design session marks for a Stepped-up start (ADR-0014)", () => {
  const labelsOf = (tickets: readonly object[]) =>
    created(planFor(turnFinished({ ...finished, tickets }), inSession, kitConfig()))
      .slice(1)
      .map((action) => action.labels);

  it("is created with fabrik:step-up beside its ready labels; an unmarked one, or one marked false, without", () => {
    expect(labelsOf([{ ...ticket("model"), stepUp: true }, ticket("sms", ["model"]), { ...ticket("ui"), stepUp: false }])).toEqual([
      ["enhancement", "ready-for-agent", "fabrik:step-up"],
      ["enhancement", "ready-for-agent"],
      ["enhancement", "ready-for-agent"],
    ]);
  });

  it("never marks an Operator step, which the Operator builds", () => {
    const step = { ...ticket("secret"), operator: true, steps: ["Add the SMS_TOKEN secret"], stepUp: true };

    expect(labelsOf([step])).toEqual([["enhancement", "ready-for-human"]]);
  });

  it("refuses a stepUp that isn't a boolean", () => {
    const plan = planFor(turnFinished({ ...finished, tickets: [{ ...ticket("model"), stepUp: "yes" }] }), inSession, kitConfig());

    expect(created(plan)).toEqual([]);
    expect(JSON.stringify(plan)).toContain("stepUp");
  });
});

describe("A Spec that supersedes an issue keeps the issue's place among its blockers", () => {
  const output = { ...finished, tickets: [ticket("model"), ticket("copy"), ticket("sms", ["model"])] };

  it("gives each Ticket with no blocker in the outcome a blocked-by edge to every open blocker of the issue, and none to a closed one", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], openBlockers: [10] });

    const plan = planFor(turnFinished(output), snapshotOf(issue), kitConfig());

    expect(created(plan).map((action) => [action.key, action.blockedBy])).toEqual([
      ["spec", []],
      ["ticket:model", [10]],
      ["ticket:copy", [10]],
      ["ticket:sms", [{ created: "ticket:model" }]],
    ]);
  });

  it("points each open issue the superseded issue blocked at every Ticket no other Ticket waits on, before the issue closes", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], openBlocking: [20] });

    const plan = planFor(turnFinished(output), snapshotOf(issue), kitConfig());

    const actions = plan.kind === "act" ? plan.actions : [];
    const edges = actions.filter((action) => action.kind === "add-blocked-by");
    expect(edges).toEqual([
      { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:copy" } },
      { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:sms" } },
    ]);
    const closing = actions.findIndex((action) => action.kind === "close-as-superseded");
    expect(actions.findLastIndex((action) => action.kind === "add-blocked-by")).toBeLessThan(closing);
    expect(actions.findLastIndex((action) => action.kind === "create-issue")).toBeLessThan(
      actions.findIndex((action) => action.kind === "add-blocked-by"),
    );
  });

  it("says in the closing comment which blockers the Tickets took on and which issues now wait on which Tickets, mentioning nobody", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], openBlockers: [10, 11], openBlocking: [20, 21] });

    const plan = planFor(turnFinished(output), snapshotOf(issue), kitConfig());

    const comment = closingComment(plan);
    expect(comment).toBe(
      [
        "**Design session finished.** This issue is superseded by the Spec <spec> and its 3 Tickets.",
        "",
        "Too big for one PR, so it's a Spec in two Tickets.",
        "",
        "Blocked-by edges moved to the new Tickets:",
        "- <ticket:model>, <ticket:copy> are now blocked by #10, #11.",
        "- #20 is now blocked by <ticket:copy>, <ticket:sms>.",
        "- #21 is now blocked by <ticket:copy>, <ticket:sms>.",
      ].join("\n"),
    );
    expect(comment).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
  });

  it("adds nothing to the closing comment, and no edge, when the issue had no open blockers and blocked nothing open", () => {
    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(closingComment(plan)).toBe(
      "**Design session finished.** This issue is superseded by the Spec <spec> and its 3 Tickets.\n\nToo big for one PR, so it's a Spec in two Tickets.",
    );
    expect(plan.kind === "act" && plan.actions.some((action) => action.kind === "add-blocked-by")).toBe(false);
  });

  it("gives a single Ticket both the issue's blockers and the issues it blocked", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"], openBlockers: [10], openBlocking: [20] });

    const plan = planFor(turnFinished({ ...finished, tickets: [ticket("model")] }), snapshotOf(issue), kitConfig());

    expect(created(plan).at(-1)?.blockedBy).toEqual([10]);
    expect(plan.kind === "act" ? plan.actions.filter((action) => action.kind === "add-blocked-by") : []).toEqual([
      { kind: "add-blocked-by", issue: 20, blocker: { created: "ticket:model" } },
    ]);
    expect(closingComment(plan)).toContain("- <ticket:model> is now blocked by #10.\n- #20 is now blocked by <ticket:model>.");
  });
});

/** The close-as-superseded comment, with each created issue written as `<key>`. */
function closingComment(plan: Plan): string {
  const close = plan.kind === "act" ? plan.actions.find((action) => action.kind === "close-as-superseded") : undefined;
  if (close?.kind !== "close-as-superseded") throw new Error("the plan doesn't close the issue as superseded");
  return close.comment.map((part) => (typeof part === "string" ? part : `<${part.created}>`)).join("");
}

describe("Intake of the issues a Design session creates", () => {
  it("never sends the Spec or its Tickets to Triage", () => {
    const plan = planFor(turnFinished(finished), inSession, kitConfig());

    const intakes = created(plan).map((action, i) =>
      planFor(
        { kind: "issue-opened", issue: 100 + i },
        // The Tickets' sub-issue links may not have landed yet when Intake looks.
        snapshotOf(anIssue({ number: 100 + i, labels: action.labels, author: "fabrik-app[bot]" })),
        kitConfig(),
      ),
    );

    expect(intakes).toHaveLength(3);
    expect(intakes.map((intake) => intake.kind)).toEqual(["nothing", "nothing", "nothing"]);
  });
});

function created(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue")
    : [];
}

function createdKeys(plan: Plan): string[] {
  return created(plan).map((action) => action.key);
}
