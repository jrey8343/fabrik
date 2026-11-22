import { describe, expect, it } from "vitest";
import { aNamedPullRequest, anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { readDesignTurnOutput } from "./designOutput.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan } from "./types.ts";

// A Design session opens a Spin-off itself (#883): work the Operator's answers put outside the session's outcome
// becomes an issue when the session finishes, with no Operator step and no link to click.
const spinOff = (extra: Record<string, unknown> = {}) => ({
  title: "Remind waitlisted patients by SMS",
  body: "## What is wanted\n\nA text a day before the slot.",
  restsOn: 'Round 2, answer 3: "not now, but we will want reminders"',
  blockedBy: [],
  ...extra,
});

const ticket = (key: string, blockedBy: (string | number)[] = [], extra: Record<string, unknown> = {}) => ({
  key,
  title: `Waitlist: ${key}`,
  body: `## What to build\n\nThe ${key} slice.`,
  blockedBy,
  ...extra,
});

const spec = (extra: Record<string, unknown> = {}) => ({
  kind: "spec",
  comment: "Too big for one PR, so it's a Spec in two Tickets.",
  spec: { title: "Spec: Waitlist", body: "## Problem Statement\n\nFully booked days lose patients." },
  tickets: [ticket("model"), ticket("ui", ["model"])],
  ...extra,
});

const split = { kind: "split", comment: "Split.", tickets: [ticket("model"), ticket("ui", ["model"])] };
const agentBrief = { kind: "brief", comment: "Small.", brief: { summary: "Add the waitlist.", acceptanceCriteria: ["A patient can join."] } };
const operatorBrief = { kind: "brief", comment: "Yours.", brief: { operator: true, summary: "Set the SMS secret.", steps: ["Add the secret"] } };
const notPlanned = { kind: "not-planned", comment: "The Operator decided against it." };
const rollIn = { kind: "roll-in", pullRequest: 12, summary: "Add the waitlist to the booking page.", acceptanceCriteria: ["A patient can join."] };
const round = { kind: "round", intro: "One thing to settle.", questions: [{ question: "SMS or email?", recommendation: "SMS." }] };
const map = {
  kind: "map",
  comment: "Foggy.",
  destination: "Patients can join a waitlist.",
  notes: "",
  notYetSpecified: "",
  outOfScope: "",
  decisions: [{ key: "provider", title: "Which SMS provider?", body: "## Question", type: "research", blockedBy: [] }],
};

describe("A Design output's spinOffs", () => {
  it("takes Spin-offs on a Spec, each with its title, body, restsOn and blockedBy", () => {
    const result = readDesignTurnOutput(spec({ spinOffs: [spinOff(), spinOff({ title: "Export the waitlist" })] }), 7, []);

    expect(result).toMatchObject({
      ok: true,
      output: { kind: "spec", spinOffs: [spinOff(), spinOff({ title: "Export the waitlist" })] },
    });
  });

  it.each([
    ["a split", split],
    ["an agent brief", agentBrief],
    ["an Operator brief", operatorBrief],
    ["a Roll-in", rollIn],
    ["a not-planned finish", notPlanned],
  ])("takes Spin-offs on %s", (_name, finish) => {
    const result = readDesignTurnOutput({ ...finish, spinOffs: [spinOff()] }, 7, []);

    expect(result).toMatchObject({ ok: true, output: { kind: finish.kind, spinOffs: [spinOff()] } });
  });

  it("refuses Spin-offs on a round, which finishes nothing", () => {
    expect(readDesignTurnOutput({ ...round, spinOffs: [spinOff()] }, 7, [])).toEqual({
      ok: false,
      errors: ["a round takes no spinOffs: the Kit opens a Spin-off only when the session finishes, and never on a Map"],
    });
  });

  it("refuses Spin-offs on a Map, whose open questions are its Decisions", () => {
    expect(readDesignTurnOutput({ ...map, spinOffs: [spinOff()] }, 7, [])).toEqual({
      ok: false,
      errors: ["a map takes no spinOffs: the Kit opens a Spin-off only when the session finishes, and never on a Map"],
    });
  });

  it("refuses Spin-offs on a prototype request, which finishes nothing either", () => {
    const prototype = { kind: "prototype", comment: "Two layouts.", route: "/waitlist", variants: 2, brief: "A list and a calendar." };

    expect(readDesignTurnOutput({ ...prototype, spinOffs: [spinOff()] }, 7, [])).toEqual({
      ok: false,
      errors: ["a prototype takes no spinOffs: the Kit opens a Spin-off only when the session finishes, and never on a Map"],
    });
  });

  it.each([
    ["an empty title", { title: " " }],
    ["an empty body", { body: "" }],
    ["an empty restsOn", { restsOn: "" }],
    ["no restsOn", { restsOn: undefined }],
    ["a restsOn of more than one line", { restsOn: "Round 2, answer 3\nand round 3" }],
    ["no blockedBy list", { blockedBy: undefined }],
    ["a blocker that is neither a key nor a number", { blockedBy: [null] }],
    ["a blocker that is no issue's number", { blockedBy: [0] }],
  ])("refuses a Spin-off with %s, naming it by its place", (_name, bad) => {
    expect(readDesignTurnOutput(spec({ spinOffs: [spinOff(), spinOff(bad)] }), 7, [])).toEqual({
      ok: false,
      errors: ["spin-off 2 needs non-empty title and body text, restsOn as one non-empty line, and a blockedBy list of Tickets' keys and open Tickets' numbers"],
    });
  });

  it.each(["Remind them", { title: "x" }, [[]]])("refuses spinOffs that isn't a list of Spin-offs: %j", (spinOffs) => {
    expect(readDesignTurnOutput({ ...notPlanned, spinOffs }, 7, [])).toMatchObject({ ok: false });
  });

  it("leaves spinOffs out of a finish that has none, or an empty list", () => {
    for (const finish of [spec(), spec({ spinOffs: [] }), { ...notPlanned, spinOffs: [] }]) {
      const result = readDesignTurnOutput(finish, 7, []);

      expect(result.ok && "spinOffs" in result.output).toBe(false);
    }
  });
});

describe("A Spin-off's blockedBy", () => {
  it("takes the keys of the Tickets the finish writes, an Operator step's among them, and an open Ticket's number", () => {
    const tickets = [ticket("model"), { ...ticket("secret"), operator: true, steps: ["Add the secret"] }];
    const result = readDesignTurnOutput(spec({ tickets, spinOffs: [spinOff({ blockedBy: ["model", "secret", 482] })] }), 7, [482]);

    expect(result).toMatchObject({ ok: true, output: { spinOffs: [{ blockedBy: ["model", "secret", 482] }] } });
  });

  it("takes a sibling Ticket's key on a split", () => {
    expect(readDesignTurnOutput({ ...split, spinOffs: [spinOff({ blockedBy: ["ui"] })] }, 7, [])).toMatchObject({ ok: true });
  });

  it("refuses a key that names no Ticket of the finish", () => {
    expect(readDesignTurnOutput(spec({ spinOffs: [spinOff({ blockedBy: ["sms"] })] }), 7, [])).toEqual({
      ok: false,
      errors: ['spin-off 1 is blocked by "sms", which isn\'t a ticket here'],
    });
  });

  it.each([
    ["an agent brief", agentBrief],
    ["an Operator brief", operatorBrief],
    ["a Roll-in", rollIn],
    ["a not-planned finish", notPlanned],
  ])("refuses any key on %s, which writes no Tickets", (_name, finish) => {
    expect(readDesignTurnOutput({ ...finish, spinOffs: [spinOff({ blockedBy: ["model"] })] }, 7, [])).toEqual({
      ok: false,
      errors: ['spin-off 1 is blocked by "model", which isn\'t a ticket here'],
    });
  });

  it("refuses a number that isn't an open Ticket the turn was given, as a Ticket's is", () => {
    expect(readDesignTurnOutput(spec({ spinOffs: [spinOff(), spinOff({ blockedBy: [481] })] }), 7, [482])).toEqual({
      ok: false,
      errors: ['spin-off 2 is blocked by #481, which isn\'t one of "The open Tickets" this turn was given'],
    });
  });

  it("takes any issue's number on the push job's side, which wasn't given the list", () => {
    expect(readDesignTurnOutput(spec({ spinOffs: [spinOff({ blockedBy: [481] })] }), 7)).toMatchObject({ ok: true });
  });

  it("takes, on an agent brief, the number of the issue the brief rewrites", () => {
    const result = readDesignTurnOutput({ ...agentBrief, spinOffs: [spinOff({ blockedBy: [7] })] }, 7, [482]);

    expect(result).toMatchObject({ ok: true, output: { kind: "brief", spinOffs: [{ blockedBy: [7] }] } });
  });

  it.each([
    ["an Operator brief", operatorBrief],
    ["a Spec", spec()],
    ["a split", split],
    ["a Roll-in", rollIn],
    ["a not-planned finish", notPlanned],
  ])("refuses the session's own issue on %s, which leaves it no Ticket", (_name, finish) => {
    expect(readDesignTurnOutput({ ...finish, spinOffs: [spinOff({ blockedBy: [7] })] }, 7, [482])).toEqual({
      ok: false,
      errors: ['spin-off 1 is blocked by #7, which isn\'t one of "The open Tickets" this turn was given'],
    });
  });

  it("names a Ticket's bad blocker and a Spin-off's together", () => {
    const result = readDesignTurnOutput(spec({ tickets: [ticket("ui", [481])], spinOffs: [spinOff({ blockedBy: ["sms"] })] }), 7, [482]);

    expect(result).toEqual({
      ok: false,
      errors: [
        'ticket "ui" is blocked by #481, which isn\'t one of "The open Tickets" this turn was given',
        'spin-off 1 is blocked by "sms", which isn\'t a ticket here',
      ],
    });
  });
});

const turnFinished = (output: unknown) => ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey" });

const MARKER = '<!-- fabrik:spin-off {"from":"design","issue":7} -->';

const sms = spinOff();
const exported = spinOff({ title: "Export the waitlist", body: "A CSV of who is waiting.", restsOn: 'Round 1, answer 2: "later"' });

/** The issues the plan opens for Spin-offs, in order. */
function spinOffsOpened(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  const actions = plan.kind === "act" ? plan.actions : [];
  return actions.filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue" && action.key.startsWith("spin-off:"));
}

describe("Finishing a Design session with Spin-offs (#883)", () => {
  it("opens each Spin-off after the Spec's Tickets, with needs-triage, the Spin-off marker and no other label, and names each in the closing comment", () => {
    const plan = planFor(turnFinished(spec({ spinOffs: [sms, exported] })), inSession, kitConfig());

    const followed = { spec: { created: "spec" }, tickets: [{ created: "ticket:model" }, { created: "ticket:ui" }] };
    expect(plan.kind === "act" ? plan.actions.slice(3) : plan).toEqual([
      {
        kind: "create-issue",
        key: "spin-off:1",
        title: "Remind waitlisted patients by SMS",
        body: `${MARKER}\n## What is wanted\n\nA text a day before the slot.`,
        labels: ["needs-triage"],
        parent: null,
        blockedBy: [],
        follows: followed,
      },
      {
        kind: "create-issue",
        key: "spin-off:2",
        title: "Export the waitlist",
        body: `${MARKER}\nA CSV of who is waiting.`,
        labels: ["needs-triage"],
        parent: null,
        blockedBy: [],
        follows: followed,
      },
      { kind: "remove-label", issue: 7, label: "needs-design" },
      {
        kind: "close-as-superseded",
        issue: 7,
        comment: [
          "**Design session finished.** This issue is superseded by the Spec ",
          { created: "spec" },
          " and its 2 Tickets.\n\nToo big for one PR, so it's a Spec in two Tickets.",
          "\n\nThe Kit opened 2 Spin-offs, work the Operator's answers put outside this outcome, which Triage sorts next:\n",
          "\n- ",
          { created: "spin-off:1" },
          ' Remind waitlisted patients by SMS\n  Rests on: Round 2, answer 3: "not now, but we will want reminders"',
          "\n- ",
          { created: "spin-off:2" },
          ' Export the waitlist\n  Rests on: Round 1, answer 2: "later"',
        ],
      },
      { kind: "check-dispatch" },
      { kind: "check-design-queue" },
    ]);
    expect(plan.kind === "act" ? plan.actions.slice(0, 3).map((action) => (action.kind === "create-issue" ? action.key : action.kind)) : []).toEqual([
      "spec",
      "ticket:model",
      "ticket:ui",
    ]);
  });

  it("makes a Spin-off wait, by blocked-by edges, on the issue the Kit opens for a Ticket of the same Spec, and on an open Ticket by its number", () => {
    const waiting = spinOff({ blockedBy: ["ui", 482, "ui", 482] });

    const plan = planFor(turnFinished(spec({ spinOffs: [waiting] })), inSession, kitConfig());

    expect(spinOffsOpened(plan).map((action) => action.blockedBy)).toEqual([[{ created: "ticket:ui" }, { ticket: 482 }]]);
  });

  it("takes on none of the superseded issue's own blocked-by edges", () => {
    const blocked = anIssue({ number: 7, labels: ["needs-design"], blockers: [{ repo: "acme/shop", number: 10, databaseId: 1010 }] });

    const plan = planFor(turnFinished(spec({ spinOffs: [sms] })), snapshotOf(blocked), kitConfig());

    expect(spinOffsOpened(plan).map((action) => action.blockedBy)).toEqual([[]]);
  });

  it("names only the Tickets an Implementer builds in the Follows line, never an Operator step", () => {
    const tickets = [ticket("ui", ["model"]), { ...ticket("secret"), operator: true, steps: ["Add the secret"] }, ticket("model")];

    const plan = planFor(turnFinished(spec({ tickets, spinOffs: [sms] })), inSession, kitConfig());

    expect(spinOffsOpened(plan).map((action) => action.follows)).toEqual([
      { spec: { created: "spec" }, tickets: [{ created: "ticket:model" }, { created: "ticket:ui" }] },
    ]);
  });
});

/** The plan's comment on the session's issue, with each created issue written as `<key>`. */
function closingCommentOf(plan: Plan): string {
  const actions = plan.kind === "act" ? plan.actions : [];
  const linking = actions.find((action) => action.kind === "comment-linking");
  if (linking?.kind !== "comment-linking") throw new Error("the plan posts no comment that links what it created");
  return linking.body.map((part) => (typeof part === "string" ? part : "created" in part ? `<${part.created}>` : "<comment>")).join("");
}

const LISTED = [
  "",
  "The Kit opened 1 Spin-off, work the Operator's answers put outside this outcome, which Triage sorts next:",
  "",
  "- <spin-off:1> Remind waitlisted patients by SMS",
  '  Rests on: Round 2, answer 3: "not now, but we will want reminders"',
];

describe("Finishing a Design session with Spin-offs, by each finish (#883)", () => {
  it("opens a split's Spin-offs after its sibling Tickets, following the Spec they sit under", () => {
    const underSpec = snapshotOf(anIssue({ number: 7, labels: ["needs-design"], parent: 3 }));

    const plan = planFor(turnFinished({ ...split, spinOffs: [spinOff({ blockedBy: ["ui"] })] }), underSpec, kitConfig());

    const actions = plan.kind === "act" ? plan.actions : [];
    expect(actions.map((action) => (action.kind === "create-issue" ? action.key : action.kind))).toEqual([
      "ticket:model",
      "ticket:ui",
      "spin-off:1",
      "remove-label",
      "close-as-superseded",
      "check-dispatch",
      "check-design-queue",
    ]);
    expect(spinOffsOpened(plan)).toMatchObject([
      { labels: ["needs-triage"], parent: null, blockedBy: [{ created: "ticket:ui" }], follows: { spec: 3, tickets: [{ created: "ticket:model" }, { created: "ticket:ui" }] } },
    ]);
    const close = actions.find((action) => action.kind === "close-as-superseded");
    expect(close?.kind === "close-as-superseded" ? close.comment.slice(-3) : null).toEqual([
      "\n- ",
      { created: "spin-off:1" },
      ' Remind waitlisted patients by SMS\n  Rests on: Round 2, answer 3: "not now, but we will want reminders"',
    ]);
  });

  it("opens an agent brief's Spin-offs, one waiting on the issue the brief rewrites, and names them in a closing comment that links them", () => {
    const plan = planFor(turnFinished({ ...agentBrief, spinOffs: [spinOff({ blockedBy: [7, 482] })] }), inSession, kitConfig());

    const actions = plan.kind === "act" ? plan.actions : [];
    expect(actions.map((action) => (action.kind === "create-issue" ? action.key : action.kind))).toEqual([
      "edit-issue-body",
      "spin-off:1",
      "comment-linking",
      "remove-label",
      "add-labels",
      "check-dispatch",
      "check-design-queue",
    ]);
    expect(spinOffsOpened(plan)).toEqual([
      {
        kind: "create-issue",
        key: "spin-off:1",
        title: "Remind waitlisted patients by SMS",
        body: `${MARKER}\n## What is wanted\n\nA text a day before the slot.`,
        labels: ["needs-triage"],
        parent: null,
        blockedBy: [{ ticket: 7 }, { ticket: 482 }],
      },
    ]);
    expect(closingCommentOf(plan)).toBe(
      ["**Design session finished.** This issue is now its agent brief, ready for an Implementer.", "", "Small.", ...LISTED].join("\n"),
    );
  });

  it("opens an Operator brief's Spin-offs", () => {
    const plan = planFor(turnFinished({ ...operatorBrief, spinOffs: [sms] }), inSession, kitConfig());

    expect(spinOffsOpened(plan)).toMatchObject([{ key: "spin-off:1", labels: ["needs-triage"], blockedBy: [] }]);
    expect(closingCommentOf(plan)).toBe(
      ["**Design session finished.** This issue is now an Operator brief, ready for a Pairing session.", "", "Yours.", ...LISTED].join("\n"),
    );
  });

  it("opens a not-planned finish's Spin-offs before the issue closes, after the issues that stay blocked by it", () => {
    const blocking = anIssue({ number: 7, labels: ["needs-design"], openBlocking: [{ repo: "acme/shop", number: 20 }] });

    const plan = planFor(turnFinished({ ...notPlanned, spinOffs: [sms] }), snapshotOf(blocking), kitConfig());

    const actions = plan.kind === "act" ? plan.actions : [];
    expect(actions.map((action) => (action.kind === "create-issue" ? action.key : action.kind))).toEqual([
      "spin-off:1",
      "comment-linking",
      "remove-label",
      "add-labels",
      "close",
      "check-design-queue",
    ]);
    expect(closingCommentOf(plan)).toBe(
      [
        "**Design session finished.** This issue won't be built, so the Kit closes it as not planned.",
        "",
        "The Operator decided against it.",
        "",
        "#20 stays blocked by it: an issue closed as not planned never lands its work, so Dispatch won't start it until the Operator removes the blocked-by edge.",
        ...LISTED,
      ].join("\n"),
    );
  });

  it("opens a Roll-in's Spin-offs, and names them after the Roll-in's text, whose hidden lines still open the comment", () => {
    const named = [aNamedPullRequest({ number: 12, open: true, merged: false, headRef: "fabrik/ticket-30" })];

    const plan = planFor(turnFinished({ ...rollIn, spinOffs: [sms] }), { ...inSession, namedPullRequests: named }, kitConfig());

    expect(spinOffsOpened(plan)).toMatchObject([{ key: "spin-off:1", labels: ["needs-triage"], blockedBy: [] }]);
    const comment = closingCommentOf(plan).split("\n");
    expect(comment[0]).toMatch(/^<!-- fabrik:roll-in /);
    expect(comment[2]).toBe("**Design session finished.** The Operator settled a Roll-in onto #12, so the Kit closes this issue as not planned.");
    expect(comment.slice(-6)).toEqual([
      "Nothing has been sent to #12. The Operator sends this Roll-in with a Request changes on #12 that carries this text and names this issue, #7.",
      ...LISTED,
    ]);
  });

  it("notifies nobody, whatever the Spin-off's text mentions", () => {
    const noisy = spinOff({ title: "Ask @jrey about SMS", body: "As @jrey said.", restsOn: "@jrey: not now" });

    for (const finish of [spec(), agentBrief, operatorBrief, notPlanned]) {
      const plan = planFor(turnFinished({ ...finish, spinOffs: [noisy] }), inSession, kitConfig());

      expect(notificationsOf(plan, "jrey").filter((note) => !note.startsWith("assign #7"))).toEqual([]);
      expect(spinOffsOpened(plan).map(({ title, body }) => `${title}\n${body}`).join("\n")).not.toMatch(/@jrey\b/);
    }
  });

  it("ends the closing comment with the Operator comments the turn weighed, after its Spin-offs", () => {
    const given = [{ id: "conversation-1", url: "https://github.com/acme/shop/pull/50#issuecomment-1" }];
    const event = { ...turnFinished({ ...agentBrief, spinOffs: [sms], operatorCommentsConsidered: ["conversation-1"] }), operatorComments: given };

    const plan = planFor(event, inSession, kitConfig());

    const lines = closingCommentOf(plan).split("\n");
    expect(lines.indexOf("- <spin-off:1> Remind waitlisted patients by SMS")).toBeGreaterThan(0);
    expect(lines.findIndex((line) => line.includes("issuecomment-1"))).toBeGreaterThan(lines.indexOf("- <spin-off:1> Remind waitlisted patients by SMS"));
  });
});

describe("A Spin-off the Kit has opened", () => {
  const opened = anIssue({ number: 104, labels: ["needs-triage"], author: "fabrik-app[bot]", byApp: true, body: `${MARKER}\nA text a day before the slot.` });

  it("is left alone by Intake, since it already has its state label", () => {
    expect(planFor({ kind: "issue-opened", issue: 104 }, snapshotOf(opened), kitConfig()).kind).toBe("nothing");
  });

  it("starts a Triage run when its needs-triage label lands", () => {
    const plan = planFor({ kind: "label-added", issue: 104, label: "needs-triage" }, snapshotOf(opened), kitConfig());

    expect(plan.kind === "act" ? plan.actions : []).toMatchObject([{ kind: "start-agent-run", role: "triage", issue: 104 }]);
  });
});

