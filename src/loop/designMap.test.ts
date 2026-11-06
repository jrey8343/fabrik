import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, Plan } from "./types.ts";

const decision = (key: string, type: string, blockedBy: string[] = []) => ({
  key,
  title: `Group classes: ${key}?`,
  body: `## Question\n\nWhat do we know about ${key}?`,
  type,
  blockedBy,
});

const charted = {
  kind: "map",
  comment: "Too foggy for one session, so it's a Map.",
  destination: "Patients book group classes online.",
  notes: "Consult the domain-modeling skill.",
  notYetSpecified: "- How classes are priced",
  outOfScope: "- Video classes",
  decisions: [decision("provider", "research"), decision("demand", "grilling", ["provider"])],
};

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

// No Map is open, so the Map cap has room (src/loop/mapCap.test.ts holds a full one).
const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey", openMaps: [] });

describe("Finishing a Design session with a Map and its Decisions", () => {
  it("rewrites the issue as a Map, files its Decisions as sub-issues, swaps needs-design for wayfinder:map, and checks Dispatch and the Design queue", () => {
    const plan = planFor(turnFinished(charted), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 7,
          body: [
            "## Destination",
            "",
            "Patients book group classes online.",
            "",
            "## Notes",
            "",
            "Consult the domain-modeling skill.",
            "",
            "## Decisions so far",
            "",
            "## Not yet specified",
            "",
            "- How classes are priced",
            "",
            "## Out of scope",
            "",
            "- Video classes",
            "",
            "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
          ].join("\n"),
        },
        {
          kind: "create-issue",
          key: "decision:provider",
          title: "Group classes: provider?",
          body: "## Question\n\nWhat do we know about provider?",
          labels: ["wayfinder:research"],
          parent: 7,
          blockedBy: [],
        },
        {
          kind: "create-issue",
          key: "decision:demand",
          title: "Group classes: demand?",
          body: "## Question\n\nWhat do we know about demand?",
          labels: ["wayfinder:grilling"],
          parent: 7,
          blockedBy: [{ created: "decision:provider" }],
        },
        { kind: "comment-linking", issue: 7, body: expect.any(Array) },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["wayfinder:map"] },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("closes the session with a comment that lists each Decision filed, by its number, title and type", () => {
    const plan = planFor(turnFinished(charted), inSession, kitConfig());

    expect(closingComment(plan)).toBe(
      [
        "**Design session finished.** This issue is now a Map, with 2 Decisions filed under it:",
        "",
        "- <decision:provider> Group classes: provider? (research)",
        "- <decision:demand> Group classes: demand? (grilling)",
        "",
        "Too foggy for one session, so it's a Map.",
      ].join("\n"),
    );
  });
});

describe("The Map and the Decisions a Design session charts", () => {
  it("creates each Decision after the Decisions that block it, whatever order the session listed them in", () => {
    const output = {
      ...charted,
      decisions: [
        decision("pricing", "grilling", ["demand", "provider"]),
        decision("demand", "prototype", ["provider"]),
        decision("provider", "research"),
        decision("signup", "task"),
      ],
    };

    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(created(plan).map((action) => [action.key, action.blockedBy])).toEqual([
      ["decision:provider", []],
      ["decision:demand", [{ created: "decision:provider" }]],
      ["decision:pricing", [{ created: "decision:demand" }, { created: "decision:provider" }]],
      ["decision:signup", []],
    ]);
    expect(closingComment(plan)).toContain("- <decision:provider> Group classes: provider? (research)\n- <decision:demand>");
  });

  it("labels each Decision with its type alone, never a state or category label, and gives the Map's own blockers to none of them", () => {
    const issue = anIssue({ number: 7, labels: ["bug", "needs-design"], openBlockers: [10], openBlocking: [20] });
    const output = { ...charted, decisions: ["research", "prototype", "grilling", "task"].map((type) => decision(type, type)) };

    const plan = planFor(turnFinished(output), snapshotOf(issue, { openMaps: [] }), kitConfig());

    expect(created(plan).map((action) => [action.labels, action.parent, action.blockedBy])).toEqual([
      [["wayfinder:research"], 7, []],
      [["wayfinder:prototype"], 7, []],
      [["wayfinder:grilling"], 7, []],
      [["wayfinder:task"], 7, []],
    ]);
    expect(plan.kind === "act" && plan.actions.some((action) => action.kind === "add-blocked-by")).toBe(false);
  });

  it("leaves the issue's category label on the Map, taking off only needs-design", () => {
    const issue = anIssue({ number: 7, labels: ["bug", "needs-design"] });

    const plan = planFor(turnFinished(charted), snapshotOf(issue, { openMaps: [] }), kitConfig());

    const labelChanges = plan.kind === "act" ? plan.actions.filter((action) => action.kind === "remove-label" || action.kind === "add-labels") : [];
    expect(labelChanges).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["wayfinder:map"] },
    ]);
  });

  it("writes a section the session left empty as its heading alone, as Decisions so far starts", () => {
    const plan = planFor(turnFinished({ ...charted, notes: "", outOfScope: "  " }), inSession, kitConfig());

    expect(rewrittenBody(plan)).toContain(
      ["## Destination", "", "Patients book group classes online.", "", "## Notes", "", "## Decisions so far", ""].join("\n"),
    );
    expect(rewrittenBody(plan)).toContain(
      ["## Out of scope", "", "<sub>Written by the Fabrik Design session"].join("\n"),
    );
  });

  it("says Decision, not Decisions, when the Map starts with only one", () => {
    const plan = planFor(turnFinished({ ...charted, decisions: [decision("provider", "research")] }), inSession, kitConfig());

    expect(closingComment(plan)).toMatch(/^\*\*Design session finished\.\*\* This issue is now a Map, with 1 Decision filed under it:\n/);
  });

  it("says the session finished once, even when the agent's comment starts by saying so too", () => {
    const plan = planFor(turnFinished({ ...charted, comment: "**Design session finished.** It's foggy." }), inSession, kitConfig());

    expect(closingComment(plan).match(/Design session finished/g)).toHaveLength(1);
    expect(closingComment(plan)).toMatch(/\(grilling\)\n\nIt's foggy\.$/);
  });

  it("notifies nobody: no Map section, Decision or comment @-mentions anyone", () => {
    const noisy = {
      ...charted,
      comment: "Thanks @someone.",
      destination: "Ask @jrey.",
      notes: "cc @org/team",
      notYetSpecified: "@jrey to say",
      outOfScope: "@reviewer's idea",
      decisions: [{ ...decision("provider", "research"), title: "Ping @jrey", body: "cc @reviewer" }],
    };

    const plan = planFor(turnFinished(noisy), inSession, kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
    const texts = [rewrittenBody(plan), ...created(plan).flatMap((action) => [action.title, action.body]), closingComment(plan)];
    expect(texts.join("\n")).not.toMatch(/(?<![\w`])@[A-Za-z0-9]/);
  });

  it("never sends a Decision to Triage", () => {
    const plan = planFor(turnFinished({ ...charted, decisions: ["research", "prototype", "grilling", "task"].map((type) => decision(type, type)) }), inSession, kitConfig());

    const intakes = created(plan).map((action, i) =>
      planFor(
        { kind: "issue-opened", issue: 100 + i },
        // The sub-issue link may not have landed yet when Intake looks.
        snapshotOf(anIssue({ number: 100 + i, labels: action.labels, author: "fabrik-app[bot]" })),
        kitConfig(),
      ),
    );

    expect(intakes.map((intake) => intake.kind)).toEqual(["nothing", "nothing", "nothing", "nothing"]);
  });
});

describe("A Map outcome the issue can't take", () => {
  it("fails the turn on a Ticket under a Spec, changing nothing: it splits into sibling Tickets, never a Map of its own", () => {
    const ticket = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], parent: 3 }), { operator: "jrey" });

    const plan = planFor(turnFinished(charted), ticket, kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason:
        "The Design-session turn on #7 emitted output that breaks its contract: #7 is a Ticket under the Spec #3, so it splits into sibling Tickets, never a Map of its own",
    });
  });

  it("drops the outcome if the issue left needs-design while the turn ran, saying why", () => {
    const plan = planFor(turnFinished(charted), snapshotOf(anIssue({ number: 7, labels: ["ready-for-human"] })), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 no longer has needs-design" });
  });

  it.each([
    ["has no Decisions", { ...charted, decisions: [] }, "a map needs at least one decision"],
    [
      "has a Decision of a type the Loop doesn't know",
      { ...charted, decisions: [decision("provider", "spike")] },
      'decision "provider" has the type "spike", which must be one of research, prototype, grilling, task',
    ],
    [
      "has a Decision blocked by one that isn't there",
      { ...charted, decisions: [decision("demand", "grilling", ["provider"])] },
      'decision "demand" is blocked by "provider", which isn\'t a decision here',
    ],
    [
      "has a Decision that blocks itself",
      { ...charted, decisions: [decision("demand", "grilling", ["demand"])] },
      'decision "demand" blocks itself',
    ],
    [
      "has Decisions that block each other",
      { ...charted, decisions: [decision("a", "research", ["b"]), decision("b", "task", ["a"])] },
      "the decisions' blockers form a cycle",
    ],
    [
      "uses a Decision key twice",
      { ...charted, decisions: [decision("provider", "research"), decision("provider", "task")] },
      'decision key "provider" is used more than once',
    ],
    [
      "has a Decision with no title",
      { ...charted, decisions: [{ ...decision("provider", "research"), title: "" }] },
      "decision 1 needs non-empty key, title and body text, and a blockedBy list of keys",
    ],
    ["has no destination", { ...charted, destination: " " }, "a map needs non-empty destination text"],
    ["has no comment", { ...charted, comment: "" }, "a map needs non-empty comment text"],
    ["leaves out its notes", { ...charted, notes: undefined }, "a map needs notes text, which may be empty"],
  ])("fails the turn as an Infrastructure failure, changing nothing, when the map %s", (_, output, error) => {
    const plan = planFor(turnFinished(output), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: `The Design-session turn on #7 emitted output that breaks its contract: ${error}`,
    });
  });
});

function created(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  return plan.kind === "act"
    ? plan.actions.filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue")
    : [];
}

/** The body the plan rewrites issue #7 to. */
function rewrittenBody(plan: Plan): string | undefined {
  const edit = plan.kind === "act" ? plan.actions.find((action) => action.kind === "edit-issue-body" && action.issue === 7) : undefined;
  return edit?.kind === "edit-issue-body" ? edit.body : undefined;
}

/** The closing comment-linking comment, with each created issue written as `<key>`. */
function closingComment(plan: Plan): string {
  const comment = plan.kind === "act" ? plan.actions.find((action) => action.kind === "comment-linking") : undefined;
  if (comment?.kind !== "comment-linking") throw new Error("the plan posts no closing comment");
  return comment.body.map((part) => (typeof part === "string" ? part : `<${"created" in part ? part.created : part.posted}>`)).join("");
}
