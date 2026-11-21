// A Check's issue (#462, #781) Triage sent to needs-design keeps the tie to its
// check however its Design session ends (#839): a brief keeps the marker line,
// a Spec takes the issue's place, carrying the marker and fabrik:flaky-check,
// and the superseded issue gives both up, so the healing ADR-0031 starts from
// the check's issue closing as completed fires when the fix lands, never before.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { type CheckReport, checkIssueActions } from "./checkIssue.ts";
import { flakyCheckIssueMarker, flakyCheckIssueOf } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, ConflictCandidate, IssueSnapshot, Plan } from "./types.ts";

const MARKER = flakyCheckIssueMarker("e2e");

const CHECK_ISSUE_BODY = [
  MARKER,
  "The required check `e2e` failed on a head no pull request caused.",
  "",
  "The Kit comments here each time the check proves flaky again, or the Reviewer judges another of its red runs an Unrelated failure, while this is open.",
].join("\n");

/** The Check's issue #7 the Fabrik App filed for `e2e`, which Triage sent to needs-design. */
function checkIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return anIssue({ number: 7, labels: ["bug", "needs-design", "fabrik:flaky-check"], byApp: true, body: CHECK_ISSUE_BODY, ...overrides });
}

const turnFinished = (output: unknown) => ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const AGENT_BRIEF = { kind: "brief", comment: "One PR fixes it.", brief: { summary: "Wait for the server before the e2e run.", acceptanceCriteria: ["e2e waits for the server"] } };
const OPERATOR_BRIEF = { kind: "brief", comment: "Only the Operator can.", brief: { operator: true, summary: "Raise the runner's memory.", steps: ["Raise it"] } };

describe("A Design session that ends a Check's issue in a brief", () => {
  it.each([
    ["an agent brief", AGENT_BRIEF],
    ["an Operator brief", OPERATOR_BRIEF],
  ])("opens the body of %s with the issue's marker line, so the check is still read from it", (_, output) => {
    const body = rewrittenBody(planFor(turnFinished(output), snapshotOf(checkIssue()), kitConfig())) ?? "";

    expect(body.split("\n")[0]).toBe(MARKER);
    expect(flakyCheckIssueOf(body)).toBe("e2e");
    expect(body.split("\n").filter((line) => line === MARKER)).toHaveLength(1);
  });

  it.each([
    ["an agent brief", AGENT_BRIEF],
    ["an Operator brief", OPERATOR_BRIEF],
  ])("keeps no marker in %s of an issue the Fabrik App didn't open", (_, output) => {
    const quoted = checkIssue({ byApp: false });

    const body = rewrittenBody(planFor(turnFinished(output), snapshotOf(quoted), kitConfig()));

    expect(body).toBeDefined();
    expect(body).not.toContain("fabrik:flaky-check-issue");
  });

  it("keeps fabrik:flaky-check on an agent brief, which becomes ready-for-agent", () => {
    const brief = landed(checkIssue(), planFor(turnFinished(AGENT_BRIEF), snapshotOf(checkIssue()), kitConfig()));

    expect(brief.labels).toEqual(["bug", "fabrik:flaky-check", "ready-for-agent"]);
  });

  it("brings up to date the agent PR its check holds at the Merge gate when the brief closes as completed", () => {
    const brief = landed(checkIssue(), planFor(turnFinished(AGENT_BRIEF), snapshotOf(checkIssue()), kitConfig()));

    expect(rebasedOnClose(brief)).toEqual([50]);
  });

  it("is the open Check's issue a red run of its check comments on, so no second one is filed", () => {
    const brief = landed(checkIssue(), planFor(turnFinished(AGENT_BRIEF), snapshotOf(checkIssue()), kitConfig()));

    expect(redRunOf("e2e", [brief]).map(({ kind }) => kind)).toEqual(["comment"]);
    expect(redRunOf("e2e", [brief])[0]).toMatchObject({ issue: 7 });
  });
});

const SPEC = {
  kind: "spec",
  comment: "Too big for one PR.",
  spec: { title: "Spec: A steady e2e check", body: "## Problem Statement\n\n`e2e` is red on main." },
  tickets: [
    { key: "cause", title: "Find why e2e times out", body: "## What to build\n\nThe cause.", blockedBy: [] },
    { key: "secret", title: "Add the test account", body: "## What to do\n\nThe account.", blockedBy: [], operator: true, steps: ["Add the secret"] },
    { key: "fix", title: "Fix the e2e timeout", body: "## What to build\n\nThe fix.", blockedBy: ["cause", "secret"] },
  ],
};

describe("A Design session that ends a Check's issue in a Spec", () => {
  const plan = () => planFor(turnFinished(SPEC), snapshotOf(checkIssue()), kitConfig());

  it("opens the Spec's body with the issue's marker line, and labels it fabrik:flaky-check beside its category and ready-for-agent", () => {
    const spec = created(plan()).find((action) => action.key === "spec");

    expect(spec?.body.split("\n")[0]).toBe(MARKER);
    expect(flakyCheckIssueOf(spec?.body ?? "")).toBe("e2e");
    expect(spec?.labels).toEqual(["bug", "ready-for-agent", "fabrik:flaky-check"]);
  });

  it("labels each Ticket and each Operator step fabrik:flaky-check, with no marker in any body", () => {
    const items = created(plan()).filter((action) => action.key !== "spec");

    expect(items.map((action) => [action.key, action.labels])).toEqual([
      ["ticket:cause", ["bug", "ready-for-agent", "fabrik:flaky-check"]],
      ["ticket:secret", ["bug", "ready-for-human", "fabrik:flaky-check"]],
      ["ticket:fix", ["bug", "ready-for-agent", "fabrik:flaky-check"]],
    ]);
    expect(items.filter((action) => action.body.includes("fabrik:flaky-check-issue"))).toEqual([]);
  });

  it("files nothing with fabrik:flaky-check from an issue without it", () => {
    const plain = anIssue({ number: 7, labels: ["bug", "needs-design"] });

    const labels = created(planFor(turnFinished(SPEC), snapshotOf(plain), kitConfig())).flatMap((action) => action.labels);

    expect(labels).not.toContain("fabrik:flaky-check");
  });

  it("takes the marker line and fabrik:flaky-check off the superseded issue, leaving the rest of its body as it was, before it closes as completed", () => {
    const actions = actionsOf(plan()).filter((action) => "issue" in action && action.issue === 7);

    expect(rewrittenBody(plan())).toBe(CHECK_ISSUE_BODY.split("\n").slice(1).join("\n"));
    expect(actions.map(({ kind }) => kind)).toEqual(["remove-label", "edit-issue-body", "remove-label", "close-as-superseded"]);
    expect(actions.filter((action) => action.kind === "remove-label").map((action) => action.kind === "remove-label" && action.label)).toEqual(["needs-design", "fabrik:flaky-check"]);
    expect(landed(checkIssue(), plan())).toMatchObject({ open: false, labels: ["bug"] });
  });

  it("takes the marker line off a body edited on GitHub, whose lines end with \\r\\n, keeping the rest as it was", () => {
    const edited = checkIssue({ body: `${MARKER}\r\nThe required check \`e2e\` failed.\r\n` });

    expect(rewrittenBody(planFor(turnFinished(SPEC), snapshotOf(edited), kitConfig()))).toBe("The required check `e2e` failed.\r\n");
  });

  it("leaves the body of an issue the Fabrik App didn't open as it is", () => {
    expect(rewrittenBody(planFor(turnFinished(SPEC), snapshotOf(checkIssue({ byApp: false })), kitConfig()))).toBeUndefined();
  });

  it("brings nothing up to date when the superseded issue closes, though it closes as completed", () => {
    expect(rebasedOnClose(landed(checkIssue(), plan()))).toEqual([]);
  });

  it("makes the Spec the open Check's issue a red run of the check comments on, so no second one is filed", () => {
    const spec = specFiled(plan());

    expect(redRunOf("e2e", [landed(checkIssue(), plan()), spec])).toEqual([expect.objectContaining({ kind: "comment", issue: 60 })]);
  });

  it("brings up to date the agent PR its check holds at the Merge gate when the Spec closes as completed", () => {
    expect(rebasedOnClose(specFiled(plan()))).toEqual([50]);
  });
});

describe("A Design session that splits a Ticket of a Check's issue's Spec", () => {
  const split = {
    kind: "split",
    comment: "The wait and the retry ship separately.",
    tickets: [
      { key: "wait", title: "Wait for the server", body: "## What to build\n\nWait.", blockedBy: [] },
      { key: "retry", title: "Retry a dropped connection", body: "## What to build\n\nRetry.", blockedBy: ["wait"] },
    ],
  };

  it("labels each sibling fabrik:flaky-check, as the Ticket it splits carries it", () => {
    const ticket = anIssue({ number: 7, parent: 60, labels: ["bug", "needs-design", "fabrik:flaky-check"], byApp: true, body: "## Agent brief\n\nFix e2e." });

    const labels = created(planFor(turnFinished(split), snapshotOf(ticket), kitConfig())).map((action) => action.labels);

    expect(labels).toEqual([
      ["bug", "ready-for-agent", "fabrik:flaky-check"],
      ["bug", "ready-for-agent", "fabrik:flaky-check"],
    ]);
  });
});

const MAP = {
  kind: "map",
  comment: "Too foggy for one session.",
  destination: "`e2e` is steady.",
  notes: "",
  notYetSpecified: "",
  outOfScope: "",
  decisions: [{ key: "cause", title: "Why is e2e red?", body: "## Question\n\nWhy?", type: "research", blockedBy: [] }],
};

describe("A Design session that ends a Check's issue in a Map", () => {
  it("is refused as a wrong outcome, whatever room the Map cap has, and changes nothing", () => {
    const plan = planFor(turnFinished(MAP), snapshotOf(checkIssue(), { openMaps: [] }), kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason:
        "The Design-session turn on #7 emitted output that breaks its contract: #7 is the Check's issue for `e2e`, which never becomes a Map: its fix lands from a brief or a Spec, whose first Ticket can find the check's cause",
    });
  });

  it("is charted as before on an issue the Fabrik App didn't open", () => {
    const plan = planFor(turnFinished(MAP), snapshotOf(checkIssue({ byApp: false }), { openMaps: [] }), kitConfig());

    expect(plan.kind).toBe("act");
  });
});

describe("A live Design session's outcome on a Check's issue", () => {
  const live = (outcome: string) =>
    ({ kind: "issue-comment-created", issue: 7, commenter: "operator", commenterIsBot: false, body: `<!-- fabrik:live-outcome ${outcome} -->\n**Design session finished live.**`, comment: 9001 }) as const;
  const inSession = snapshotOf(checkIssue({ designRounds: 1 }));

  it.each([
    ["spec", "a Spec"],
    ["map", "a Map"],
  ])("is refused for %s: the issue stays open in needs-design, nothing closes, and the Kit says why on it", (outcome, what) => {
    const plan = planFor(live(outcome), inSession, kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment"]);
    const [comment] = actionsOf(plan);
    const body = comment?.kind === "comment" ? comment.body : "";
    expect(body.split("\n")[0]).toBe("<!-- fabrik:design-turn-failed -->");
    expect(body).toContain(`The live Design session ended #7 in ${what}, which the Kit refused: #7 is the Check's issue for \`e2e\``);
    expect(body).toContain("The Kit left #7 open in `needs-design` and closed nothing.");
  });

  it.each([["brief"], ["operator-brief"]])("lands a live %s as it lands one on any issue", (outcome) => {
    const plain = snapshotOf(anIssue({ number: 7, labels: ["bug", "needs-design"], designRounds: 1 }));

    expect(planFor(live(outcome), inSession, kitConfig())).toEqual(planFor(live(outcome), plain, kitConfig()));
  });
});

/** The Spec `plan` files, as GitHub holds it once filed: issue #60, opened by the Fabrik App. */
function specFiled(plan: Plan): IssueSnapshot {
  const spec = created(plan).find((action) => action.key === "spec");
  if (spec === undefined) throw new Error("The plan files no Spec");
  return anIssue({ number: 60, title: spec.title, labels: spec.labels, body: spec.body, byApp: true });
}

function created(plan: Plan): Extract<Action, { kind: "create-issue" }>[] {
  return actionsOf(plan).filter((action): action is Extract<Action, { kind: "create-issue" }> => action.kind === "create-issue");
}

/** The issue as GitHub holds it once `plan` landed on it: its body edited, its labels moved, closed if the plan closes it. */
function landed(issue: IssueSnapshot, plan: Plan): IssueSnapshot {
  return actionsOf(plan).reduce((now, action) => {
    if (!("issue" in action) || action.issue !== issue.number) return now;
    if (action.kind === "edit-issue-body") return { ...now, body: action.body };
    if (action.kind === "remove-label") return { ...now, labels: now.labels.filter((label) => label !== action.label) };
    if (action.kind === "add-labels") return { ...now, labels: [...now.labels, ...action.labels.filter((label) => !now.labels.includes(label))] };
    if (action.kind === "close" || action.kind === "close-as-superseded") return { ...now, open: false };
    return now;
  }, issue);
}

/** Agent PR #50 for Ticket #3, its pass on its head held at the Merge gate by an Unrelated failure of `e2e`. */
const HELD: ConflictCandidate = {
  pullRequest: aPullRequest({ number: 50, ticket: 3, draft: false, verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA, unrelated: ["e2e"] }], verdictPostedAt: "2026-11-18T08:00:00Z" }),
  mergeable: true,
};

/** The PRs the Kit brings up to date when `issue`, as the snapshot reads it, closes as completed. */
function rebasedOnClose(issue: IssueSnapshot): number[] {
  const closed = { ...issue, open: false };
  const snapshot = snapshotOf(closed, { conflicts: { main: "9".repeat(40), now: "2026-11-18T10:00:00Z", implementJobUnderWay: null, pullRequests: [HELD] } });
  return actionsOf(planFor({ kind: "issue-closed", issue: issue.number, stateReason: "completed" }, snapshot, kitConfig())).flatMap((action) =>
    action.kind === "rebase-onto-main" ? [action.pullRequest] : [],
  );
}

/** What a red run of `check` files or comments, with these open issues as the Kit reads them: only the App's body. */
function redRunOf(check: string, open: readonly IssueSnapshot[]): Action[] {
  const issues = open.map(({ number, labels, body, byApp }) => ({ number, labels, body: byApp ? body : "", comments: [] }));
  const report: CheckReport = { kind: "unrelated-failure", name: check, red: "https://example.test/red", opening: "Red.", again: "Red again." };
  return checkIssueActions(HEAD_SHA, [report], issues).actions;
}

function actionsOf(plan: Plan): readonly Action[] {
  return plan.kind === "act" ? plan.actions : [];
}

function rewrittenBody(plan: Plan, issue = 7): string | undefined {
  const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body" && action.issue === issue);
  return edit?.kind === "edit-issue-body" ? edit.body : undefined;
}
