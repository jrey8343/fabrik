import { describe, expect, it } from "vitest";
import { anIssue, aTicket, dispatchSnapshotOf, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan } from "./types.ts";

// An Operator step is a piece of a Spec only the Operator can do (GLOSSARY.md),
// such as a secret or a trust-root edit. Tickets can wait on it, and it on them.
const ticket = (key: string, blockedBy: string[] = []) => ({
  key,
  title: `Waitlist: ${key}`,
  body: `## What to build\n\nThe ${key} slice.`,
  blockedBy,
});

const operatorStep = (key: string, blockedBy: string[] = [], steps = ["Add the SMS_TOKEN secret", "Run the setup check"]) => ({
  key,
  title: `Waitlist: ${key}`,
  body: "The SMS provider needs a token only the Operator holds.",
  blockedBy,
  operator: true,
  steps,
});

const spec = (tickets: unknown[]) => ({
  kind: "spec",
  comment: "Needs a secret first.",
  spec: { title: "Spec: Waitlist", body: "## Problem Statement\n\nFully booked days lose patients." },
  tickets,
});

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey" });

describe("A Design session's Operator steps", () => {
  it("creates a Ticket ready for an Implementer and an Operator step ready for the Operator, both under the Spec", () => {
    const plan = planFor(turnFinished(spec([ticket("model"), operatorStep("secret")])), inSession, kitConfig());

    expect(created(plan).slice(1)).toEqual([
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
        key: "ticket:secret",
        title: "Waitlist: secret",
        body: [
          "The SMS provider needs a token only the Operator holds.",
          "",
          "## Steps",
          "",
          "- [ ] Add the SMS_TOKEN secret",
          "- [ ] Run the setup check",
        ].join("\n"),
        labels: ["enhancement", "ready-for-human"],
        assignees: ["jrey"],
        parent: { created: "spec" },
        blockedBy: [],
      },
    ]);
  });

  it("links a Ticket blocked by an Operator step, and an Operator step blocked by a Ticket, by native blocked-by edges", () => {
    const output = spec([ticket("sms", ["secret"]), operatorStep("secret"), operatorStep("announce", ["sms"])]);

    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(created(plan).map((action) => [action.key, action.blockedBy])).toEqual([
      ["spec", []],
      ["ticket:secret", []],
      ["ticket:sms", [{ created: "ticket:secret" }]],
      ["ticket:announce", [{ created: "ticket:sms" }]],
    ]);
  });

  it("names how many of the new items are Operator steps in the closing comment, mentioning nobody", () => {
    const plan = planFor(turnFinished(spec([ticket("model"), ticket("sms"), operatorStep("secret")])), inSession, kitConfig());

    const comment = closingComment(plan);
    expect(comment).toBe(
      "**Design session finished.** This issue is superseded by the Spec <spec> and its 2 Tickets and 1 Operator step.\n\nNeeds a secret first.",
    );
    expect(comment).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
  });

  it("notifies the Operator only by assigning each Operator step", () => {
    const plan = planFor(turnFinished(spec([ticket("model"), operatorStep("secret")])), inSession, kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual(['assign new "Waitlist: secret"']);
  });

  it("accepts a Spec made only of Operator steps", () => {
    const plan = planFor(turnFinished(spec([operatorStep("secret"), operatorStep("settings")])), inSession, kitConfig());

    expect(created(plan).map((action) => action.labels)).toEqual([
      ["enhancement", "ready-for-agent"],
      ["enhancement", "ready-for-human"],
      ["enhancement", "ready-for-human"],
    ]);
    expect(closingComment(plan)).toContain(" and its 2 Operator steps.");
  });

  it("names the Operator steps among a split's sibling Tickets", () => {
    const underSpec = snapshotOf(anIssue({ number: 7, labels: ["bug", "needs-design"], parent: 3 }), { operator: "jrey" });
    const output = { kind: "split", comment: "Split.", tickets: [ticket("fix"), operatorStep("secret")] };

    const plan = planFor(turnFinished(output), underSpec, kitConfig());

    expect(created(plan).map((action) => [action.labels, action.assignees])).toEqual([
      [["bug", "ready-for-agent"], undefined],
      [["bug", "ready-for-human"], ["jrey"]],
    ]);
    expect(closingComment(plan)).toBe(
      "**Design session finished.** This Ticket is split into <ticket:fix>, <ticket:secret>: 1 Ticket and 1 Operator step, siblings under the Spec #3.\n\nSplit.",
    );
  });

  it.each([
    ["an Operator step with no steps", spec([operatorStep("secret", [], [])]), 'operator step "secret"'],
    ["an Operator step with an empty step", spec([operatorStep("secret", [], ["Add it", " "])]), 'operator step "secret"'],
    ["an Operator step with no steps list", spec([{ ...ticket("secret"), operator: true }]), 'operator step "secret"'],
    ["a ticket with steps but no operator marker", spec([{ ...ticket("model"), steps: ["Do it"] }]), 'ticket "model"'],
    ["a cycle through an Operator step", spec([ticket("sms", ["secret"]), operatorStep("secret", ["sms"])]), "cycle"],
    ["an empty tickets list", spec([]), "at least one ticket"],
  ])("refuses %s as an Infrastructure failure, naming it", (_, output, named) => {
    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure", reason: expect.stringContaining(named) });
  });
});

describe("Finishing a Design session with an Operator brief", () => {
  const operatorBrief = {
    kind: "brief",
    comment: "This is all Operator work. Thanks @someone.",
    brief: { operator: true, summary: "Set up SMS for @jrey.", steps: ["Add the SMS_TOKEN secret", "Turn on the webhook"] },
  };

  it("rewrites the issue as its Operator brief, swaps needs-design for ready-for-human and assigns the Operator", () => {
    const plan = planFor(turnFinished(operatorBrief), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 7,
          body: [
            "## Operator brief",
            "",
            "Set up SMS for @\u200bjrey.",
            "",
            "## Steps",
            "",
            "- [ ] Add the SMS_TOKEN secret",
            "- [ ] Turn on the webhook",
            "",
            "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
          ].join("\n"),
        },
        {
          kind: "comment",
          issue: 7,
          body: "**Design session finished.** This issue is now an Operator brief, ready for a Pairing session.\n\nThis is all Operator work. Thanks @\u200bsomeone.",
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
        { kind: "assign", issue: 7, assignee: "jrey" },
      ],
    });
  });

  it("notifies the Operator only by the assignment", () => {
    const plan = planFor(turnFinished(operatorBrief), inSession, kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual(["assign #7"]);
  });

  it.each([
    ["has no steps", { operator: true, summary: "Set up SMS.", steps: [] }],
    ["has an empty step", { operator: true, summary: "Set up SMS.", steps: [""] }],
    ["has no summary", { operator: true, steps: ["Add it"] }],
  ])("refuses an Operator brief that %s, naming it", (_, brief) => {
    const plan = planFor(turnFinished({ ...operatorBrief, brief }), inSession, kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure", reason: expect.stringContaining("Operator brief") });
  });
});

describe("Dispatch and Operator steps", () => {
  it("never releases an Operator step, which is ready-for-human", () => {
    const step = aTicket({ number: 12, labels: ["enhancement", "ready-for-human"] });

    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([step]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: #12 isn't ready-for-agent" });
  });
});

describe("Landing a live Design session that ended with an Operator brief", () => {
  it("swaps needs-design for ready-for-human and assigns the Operator, without a Dispatch check", () => {
    const plan = planFor(
      {
        kind: "issue-comment-created",
        issue: 7,
        commenter: "jrey",
        commenterIsBot: false,
        body: "<!-- fabrik:live-outcome operator-brief -->\n**Design session finished live.** This issue is now an Operator brief.",
        comment: 9001,
      },
      inSession,
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
        { kind: "assign", issue: 7, assignee: "jrey" },
      ],
    });
  });
});

/** The close-as-superseded comment, with each created issue written as `<key>`. */
function closingComment(plan: Plan): string {
  const close = plan.kind === "act" ? plan.actions.find((action) => action.kind === "close-as-superseded") : undefined;
  if (close?.kind !== "close-as-superseded") throw new Error("the plan doesn't close the issue as superseded");
  return close.comment.map((part) => (typeof part === "string" ? part : `<${part.created}>`)).join("");
}

function created(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue")
    : [];
}
