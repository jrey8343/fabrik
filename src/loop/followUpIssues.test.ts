import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, kitConfig, notificationsOf, snapshotOf, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { faultsNamedIn, followUpsSection, type NamedFollowUp, newIssueUrl } from "./followUps.ts";
import { followUpIssueOf, followUpsOpenedIn, fromPullRequestIn, verdictMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Action, CreatedIssue, FollowUpIssuesSnapshot, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

type Closed = Extract<LoopEvent, { kind: "pull-request-closed" }>;

const REPO = "https://github.com/acme/shop";
const merged: Closed = { kind: "pull-request-closed", pullRequest: 42, merged: true, closedByBot: false };

const A = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count.\n\nSeen on the product page." } as const;
const B = { kind: "fault", title: "The footer test is skipped", body: "`footer.test.ts:3` is `it.skip`." } as const;
const C = { kind: "fault", title: "The README names a removed flag", body: "`README.md:40` says `--fast`, which `cli.ts` no longer reads." } as const;
const IDEA = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;

/** The Fabrik App's pass on #42 at a head, as the Kit posts it, listing these Follow-ups. */
const aPassNaming = (head: string, ...followUps: NamedFollowUp[]) =>
  [verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: head.repeat(40) }), "## Verdict: Pass", ...followUpsSection(followUps, REPO, 42)].join("\n");

/** The agent pull request #42 once it has merged, its passes having named these faults, as the Loop reads them from its Verdict comments. */
const pullRequest = (comments: readonly string[], overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot =>
  aPullRequest({ number: 42, ticket: 30, open: false, draft: false, url: `${REPO}/pull/42`, faults: faultsNamedIn(comments), ...overrides });

/** What the Loop read of the repo's issues for #42's merge: none of its Follow-ups is an issue yet, and the Kit has no Follow-up issue open. */
const issues = (overrides: Partial<FollowUpIssuesSnapshot> = {}): FollowUpIssuesSnapshot => ({ repoUrl: REPO, open: 0, ofPullRequest: [], ...overrides });

const TWO_PASSES = [aPassNaming("a", A, IDEA, B), aPassNaming("b", B, C)];

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

const closing = (event: Closed, closed: PullRequestSnapshot, followUpIssues: FollowUpIssuesSnapshot | null = issues(), caps: { followUpIssues?: number } = {}): Plan =>
  planFor(event, snapshotOfPullRequest(closed, { followUpIssues }), kitConfig({ caps: { ...kitConfig().caps, ...caps } }));

/** The issues a plan opens, in order. */
const opened = (plan: Plan) => actionsOf(plan).flatMap((action) => (action.kind === "create-issue" ? [action] : []));

/** The comments a plan posts on #42, each as GitHub is given it once the plan's issues are #101, #102, … in the order opened. */
function commentsOf(plan: Plan): string[] {
  const keys = opened(plan).map(({ key }) => key);
  const numbered = (issue: CreatedIssue | { readonly posted: string }) => ("created" in issue ? `#${101 + keys.indexOf(issue.created)}` : "");
  return actionsOf(plan).flatMap((action) => {
    if (action.kind === "comment" && action.issue === 42) return [action.body];
    if (action.kind === "comment-linking" && action.issue === 42) return [action.body.map((part) => (typeof part === "string" ? part : numbered(part))).join("")];
    return [];
  });
}

describe("An agent pull request merging whose passes named faults (#885)", () => {
  it("opens every fault any pass named, once each, in the order named: A and B, then B and C, open A, B and C", () => {
    const plan = closing(merged, pullRequest(TWO_PASSES));

    expect(opened(plan).map(({ title }) => title)).toEqual([A.title, B.title, C.title]);
    // After the Ticket and the Roll-ins are seen to, and before the Dispatch check.
    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["create-issue", "create-issue", "create-issue", "comment-linking", "check-dispatch"]);
  });

  it("opens each with needs-triage alone, the Follow-up marker naming the pull request as its first line, the fault's body, and the From PR line last", () => {
    const [first] = opened(closing(merged, pullRequest(TWO_PASSES)));

    expect(first).toEqual({
      kind: "create-issue",
      key: "follow-up:1",
      title: A.title,
      body: ['<!-- fabrik:follow-up {"pullRequest":42} -->', A.body, "", "From PR #42"].join("\n"),
      labels: ["needs-triage"],
      parent: null,
      blockedBy: [],
    });
    expect(followUpIssueOf(first?.body ?? "")).toBe(42);
    expect(fromPullRequestIn(first?.body ?? "")).toBe(42);
  });

  it("posts one quiet comment on the merged pull request, naming each issue it opened", () => {
    const plan = closing(merged, pullRequest(TWO_PASSES));

    expect(commentsOf(plan)).toEqual([
      [
        "<!-- fabrik:follow-ups-opened -->",
        `<!-- fabrik:follow-up-opened #101 {"title":"${A.title}"} -->`,
        `<!-- fabrik:follow-up-opened #102 {"title":"${B.title}"} -->`,
        `<!-- fabrik:follow-up-opened #103 {"title":"${C.title}"} -->`,
        "This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):",
        "",
        `- #101 ${A.title}`,
        `- #102 ${B.title}`,
        `- #103 ${C.title}`,
      ].join("\n"),
    ]);
    expect(notificationsOf(plan)).toEqual([]);
    expect(followUpsOpenedIn(commentsOf(plan)[0] ?? "")).toEqual({
      opened: [
        { issue: 101, title: A.title },
        { issue: 102, title: B.title },
        { issue: 103, title: C.title },
      ],
      left: [],
    });
  });
});

describe("The cap on the Follow-up issues the Kit has open (#885)", () => {
  const THREE = [aPassNaming("a", A, B, C)];
  const linkOf = (fault: NamedFollowUp) => `[Open as issue](${newIssueUrl(REPO, fault.title, fault.body, "From PR #42")})`;

  it("opens faults only up to the room under it: with four open and the cap at 5, a merge naming three opens one and gives the other two their links", () => {
    const plan = closing(merged, pullRequest(THREE), issues({ open: 4 }));

    expect(opened(plan).map(({ title }) => title)).toEqual([A.title]);
    expect(commentsOf(plan)).toEqual([
      [
        "<!-- fabrik:follow-ups-opened -->",
        `<!-- fabrik:follow-up-opened #101 {"title":"${A.title}"} -->`,
        `<!-- fabrik:follow-up-left {"title":"${B.title}"} -->`,
        `<!-- fabrik:follow-up-left {"title":"${C.title}"} -->`,
        "This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):",
        "",
        `- #101 ${A.title}`,
        "",
        "`caps.follow_up_issues` is 5 and the Kit had 4 such issues open when this pull request merged, so each of these faults its passes named stays a link:",
        "",
        `- ${B.title}: ${linkOf(B)}`,
        `- ${C.title}: ${linkOf(C)}`,
      ].join("\n"),
    ]);
    expect(followUpsOpenedIn(commentsOf(plan)[0] ?? "")).toEqual({ opened: [{ issue: 101, title: A.title }], left: [B.title, C.title] });
  });

  it("opens none at a Product repo's lower cap once that many are open, nor when more are open than the cap", () => {
    expect(opened(closing(merged, pullRequest(THREE), issues({ open: 2 }), { followUpIssues: 2 }))).toEqual([]);
    expect(opened(closing(merged, pullRequest(THREE), issues({ open: 7 })))).toEqual([]);
  });

  it("opens none at 0, and every fault stays a link in the one comment", () => {
    const plan = closing(merged, pullRequest(THREE), issues(), { followUpIssues: 0 });

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["comment", "check-dispatch"]);
    expect(commentsOf(plan)).toEqual([
      [
        "<!-- fabrik:follow-ups-opened -->",
        `<!-- fabrik:follow-up-left {"title":"${A.title}"} -->`,
        `<!-- fabrik:follow-up-left {"title":"${B.title}"} -->`,
        `<!-- fabrik:follow-up-left {"title":"${C.title}"} -->`,
        "`caps.follow_up_issues` is 0, so the Kit opens no fault as an issue. Each of these faults this pull request's passes named stays a link:",
        "",
        `- ${A.title}: ${linkOf(A)}`,
        `- ${B.title}: ${linkOf(B)}`,
        `- ${C.title}: ${linkOf(C)}`,
      ].join("\n"),
    ]);
    expect(notificationsOf(plan)).toEqual([]);
  });
});

describe("A fault that is already an issue when its pull request merges (#885)", () => {
  it("is not opened again when the Operator opened it from its link, and the comment names that issue", () => {
    const plan = closing(merged, pullRequest(TWO_PASSES), issues({ ofPullRequest: [{ number: 90, title: ` ${B.title} `, openedBy: "operator" }] }));

    expect(opened(plan).map(({ title }) => title)).toEqual([A.title, C.title]);
    expect(commentsOf(plan)[0]).toContain(`- #101 ${A.title}\n- #102 ${C.title}\n\nAlready an issue when this pull request merged, so the Kit opened none for it:\n\n- #90 ${B.title}`);
  });

  it("is not opened again when the Kit opened it in a plan that was only partly applied, and takes no room under the cap twice", () => {
    const plan = closing(merged, pullRequest(TWO_PASSES), issues({ open: 4, ofPullRequest: [{ number: 95, title: A.title, openedBy: "kit" }] }));

    expect(opened(plan).map(({ title }) => title)).toEqual([B.title]);
    expect(followUpsOpenedIn(commentsOf(plan)[0] ?? "")?.left).toEqual([C.title]);
  });

  it("is recorded as the issue the Kit opened for the fault when the Kit opened it in such a plan, as if this plan had: the comment is the one record of it", () => {
    const plan = closing(merged, pullRequest(TWO_PASSES), issues({ open: 1, ofPullRequest: [{ number: 95, title: B.title, openedBy: "kit" }] }));

    expect(commentsOf(plan)).toEqual([
      [
        "<!-- fabrik:follow-ups-opened -->",
        `<!-- fabrik:follow-up-opened #101 {"title":"${A.title}"} -->`,
        `<!-- fabrik:follow-up-opened #95 {"title":"${B.title}"} -->`,
        `<!-- fabrik:follow-up-opened #102 {"title":"${C.title}"} -->`,
        "This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):",
        "",
        `- #101 ${A.title}`,
        `- #95 ${B.title}`,
        `- #102 ${C.title}`,
      ].join("\n"),
    ]);
    expect(followUpsOpenedIn(commentsOf(plan)[0] ?? "")).toEqual({
      opened: [
        { issue: 101, title: A.title },
        { issue: 95, title: B.title },
        { issue: 102, title: C.title },
      ],
      left: [],
    });
  });

  it("records every fault when the earlier plan opened them all and failed before its comment: a plain comment, and nothing opened", () => {
    const plan = closing(merged, pullRequest([aPassNaming("a", A)]), issues({ open: 1, ofPullRequest: [{ number: 95, title: A.title, openedBy: "kit" }] }));

    expect(actionsOf(plan)).toEqual([
      {
        kind: "comment",
        issue: 42,
        body: [
          "<!-- fabrik:follow-ups-opened -->",
          `<!-- fabrik:follow-up-opened #95 {"title":"${A.title}"} -->`,
          "This pull request merged, so the Kit opened each of these faults its passes named as an issue, which enters at Triage (ADR-0039):",
          "",
          `- #95 ${A.title}`,
        ].join("\n"),
      },
      { kind: "check-dispatch" },
    ]);
  });

  it("stays under Already an issue, with no record of an issue the Kit opened, when the Operator opened it", () => {
    const plan = closing(merged, pullRequest([aPassNaming("a", A, B)]), issues({ ofPullRequest: [{ number: 90, title: B.title, openedBy: "operator" }] }));

    expect(followUpsOpenedIn(commentsOf(plan)[0] ?? "")).toEqual({ opened: [{ issue: 101, title: A.title }], left: [] });
    expect(commentsOf(plan)[0]).toContain(`Already an issue when this pull request merged, so the Kit opened none for it:\n\n- #90 ${B.title}`);
  });

  it("leaves one comment and opens nothing when every fault is one", () => {
    const plan = closing(merged, pullRequest([aPassNaming("a", A)]), issues({ ofPullRequest: [{ number: 90, title: A.title, openedBy: "operator" }] }));

    expect(actionsOf(plan)).toEqual([
      { kind: "comment", issue: 42, body: `<!-- fabrik:follow-ups-opened -->\nAlready an issue when this pull request merged, so the Kit opened none for it:\n\n- #90 ${A.title}` },
      { kind: "check-dispatch" },
    ]);
  });
});

describe("A merge the Kit has already seen to, and the closings that open nothing (#885)", () => {
  const ONLY_DISPATCH: Action[] = [{ kind: "check-dispatch" }];

  it("opens nothing more at a second look at the same merge, from an event or a Tick: the comment's mark is on the pull request", () => {
    const first = closing(merged, pullRequest(TWO_PASSES));
    const seenTo = pullRequest(TWO_PASSES, { followUpsOpened: followUpsOpenedIn(commentsOf(first)[0] ?? "") !== null });

    expect(seenTo.followUpsOpened).toBe(true);
    expect(actionsOf(closing(merged, seenTo))).toEqual(ONLY_DISPATCH);
    // Whatever the second look read of the issues, with every one of the first look's closed or renamed since.
    expect(actionsOf(closing(merged, seenTo, issues({ open: 0, ofPullRequest: [] })))).toEqual(ONLY_DISPATCH);
  });

  it("opens nothing for a pull request whose passes named only ideas, or nothing: its plan is what it was", () => {
    expect(actionsOf(closing(merged, pullRequest([aPassNaming("a", IDEA)])))).toEqual(ONLY_DISPATCH);
    expect(actionsOf(closing(merged, pullRequest([])))).toEqual(ONLY_DISPATCH);
  });

  it("opens nothing for an agent pull request closed unmerged, by hand or by the Kit", () => {
    const byTheKit = closing({ ...merged, merged: false, closedByBot: true }, pullRequest(TWO_PASSES));
    const byHand = closing({ ...merged, merged: false }, pullRequest(TWO_PASSES));

    expect(actionsOf(byTheKit)).toEqual(ONLY_DISPATCH);
    expect(opened(byHand)).toEqual([]);
    expect(commentsOf(byHand).filter((body) => body.includes("fabrik:follow-ups-opened"))).toEqual([]);
  });

  it("opens nothing for a Plain pull request, which has no Verdict: its plan is what it was", () => {
    const plain = pullRequest(TWO_PASSES, { isAgent: false, ticket: null });

    expect(closing(merged, plain)).toEqual({ kind: "nothing", reason: "#42 isn't an agent PR" });
  });

  it("opens nothing when the snapshot read no issues for the merge", () => {
    expect(actionsOf(closing(merged, pullRequest(TWO_PASSES), null))).toEqual(ONLY_DISPATCH);
  });
});

describe("The issue a fault opens as (#885)", () => {
  it("mentions nobody, in its title, its body or the comment that names it", () => {
    const plan = closing(merged, pullRequest([aPassNaming("a", { kind: "fault", title: "Ask @alice about the badge", body: "And @operator too." })]));
    const [issue] = opened(plan);

    expect(`${issue?.title}\n${issue?.body}`).not.toMatch(/@alice|@operator/);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("has a title GitHub takes, cut as its Open as issue link would cut it, and an empty body leaves only the marker and the From PR line", () => {
    const [issue] = opened(closing(merged, pullRequest([aPassNaming("a", { kind: "fault", title: "x".repeat(400), body: "" })])));

    expect(Array.from(issue?.title ?? "").length).toBe(256);
    expect(issue?.title).toMatch(/^x+…$/);
    expect(issue?.body).toBe('<!-- fabrik:follow-up {"pullRequest":42} -->\nFrom PR #42');
  });

  it("is told from one that only quotes the marker further down, or names no pull request", () => {
    expect(followUpIssueOf('Text first.\n<!-- fabrik:follow-up {"pullRequest":42} -->')).toBeNull();
    expect(followUpIssueOf('<!-- fabrik:follow-up {"pullRequest":"42"} -->\nText.')).toBeNull();
    expect(followUpIssueOf('<!-- fabrik:spin-off {"from":"design","issue":7} -->\nText.')).toBeNull();
  });
});

describe("A Design session on a Follow-up issue the Kit opened (#885)", () => {
  const FAULT_ISSUE_BODY = ['<!-- fabrik:follow-up {"pullRequest":42} -->', A.body, "", "From PR #42"].join("\n");
  const briefed = { kind: "brief", comment: "One PR fixes it.", brief: { summary: "Read the count after the refresh.", acceptanceCriteria: ["The badge shows the cart's count after a refresh"] } };
  const rewrittenBy = (byApp: boolean): string => {
    const issue = anIssue({ number: 101, labels: ["bug", "needs-design"], byApp, body: FAULT_ISSUE_BODY });
    const plan = planFor({ kind: "agent-run-finished", role: "design", issue: 101, output: JSON.stringify(briefed) }, snapshotOf(issue), kitConfig());
    const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body");
    return edit?.kind === "edit-issue-body" ? edit.body : "";
  };

  it("keeps the issue's marker as the first line of the body it rewrites, and its From PR line, so it still counts toward the cap while it is open", () => {
    const body = rewrittenBy(true);

    expect(body.split("\n")[0]).toBe('<!-- fabrik:follow-up {"pullRequest":42} -->');
    expect(followUpIssueOf(body)).toBe(42);
    expect(body.split("\n").filter((line) => line.includes("fabrik:follow-up"))).toHaveLength(1);
    expect(fromPullRequestIn(body)).toBe(42);
    expect(body).toContain("Read the count after the refresh.");
  });

  it("keeps no marker in the rewrite of an issue the Fabrik App didn't open", () => {
    expect(rewrittenBy(false)).not.toContain("fabrik:follow-up");
    expect(rewrittenBy(false)).toContain("Read the count after the refresh.");
  });
});
