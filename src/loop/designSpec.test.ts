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
      ],
    });
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
