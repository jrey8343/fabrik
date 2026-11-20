// The names rule and the Kit's own Execution flaw for an Evidence miss (#819),
// through the rules core: what an Implement run's push job does with the
// Evidence shots its output names, on each kind of Implement run.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { A, B, C, finished, PullRequestOnGitHub } from "../__fixtures__/pullRequestThread.ts";
import { anEvidence, SHOTS_UI, UI } from "../__fixtures__/uiEvidence.ts";
import { type ShotsMarker, shotsMarkerIn, shotsSection, waitingShotsMarker } from "../evidence/uiEvidence.ts";
import { verdictMarker } from "./markers.ts";
import { runInFlight } from "./retry.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

type ImplementRunFinished = Extract<LoopEvent, { kind: "implement-run-finished" }>;

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
/** The head the run's push lands. */
const PUSHED = "e".repeat(40);
const SHOTS = kitConfig({ ui: SHOTS_UI });
/** A change to a page, which ui.paths makes UI. */
const PAGE = { net: [{ path: "src/pages/inbox.astro" }], commits: [{ path: "src/pages/inbox.astro" }], pushedHead: PUSHED };
const RETRY_TRIGGER: Action = { kind: "add-labels", issue: 7, labels: ["agent:implement"] };

const outputOf = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Show an empty inbox", summary: "Adds the empty inbox state.", ...fields });

/** A first run's push job, its branch changing a page. */
function firstRun(fields: Record<string, unknown> = {}, overrides: Partial<ImplementRunFinished> = {}): ImplementRunFinished {
  return {
    kind: "implement-run-finished",
    issue: 7,
    output: outputOf(fields),
    branch: "fabrik/ticket-7",
    base: "main",
    changes: PAGE,
    evidence: anEvidence(undefined, { artifact: null, evidencePage: null }),
    runUrl: RUN,
    ...overrides,
  };
}

const readyTicket = (landedNothing = 0) => anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], landedNothing });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function openedBody(plan: Plan): string {
  const opened = actionsOf(plan).find((action) => action.kind === "open-pull-request");
  if (opened === undefined) throw new Error(`expected a plan that opens a PR, got ${JSON.stringify(plan)}`);
  return opened.body;
}

/** The section's lines in a body. */
const sectionOf = (body: string) => body.slice(body.indexOf("<!-- fabrik:ui-evidence-start -->")).split("\n");

/** Every comment the plan posts, on the PR it opens or on an existing one. */
const commentsOf = (plan: Plan) =>
  actionsOf(plan).flatMap((action) => (action.kind === "comment" || action.kind === "comment-on-opened" ? [action.body] : []));

describe("A first run's names, on a Product repo that uses Evidence shots (#819)", () => {
  it("give the pull request the shots its output names, in order, a fifth dropped with a line in the section", () => {
    const body = openedBody(planFor(firstRun({ shots: ["inbox: empty", "inbox: one message", "c", "d", "e"] }), snapshotOf(readyTicket()), SHOTS));

    expect(shotsMarkerIn(body)?.named).toEqual([{ name: "inbox: empty" }, { name: "inbox: one message" }, { name: "c" }, { name: "d" }]);
    expect(sectionOf(body)).toEqual(expect.arrayContaining(["- `inbox: empty`", "- `inbox: one message`", "1 name past the first four was dropped: at most four count."]));
    expect(sectionOf(body)).toContain("Waiting for the `e2e` check: the Evidence shots it takes at this head show here once it has finished and the Review has read them.");
  });

  it("drop a name that breaks the name rule as a fifth is, and say so", () => {
    const body = openedBody(planFor(firstRun({ shots: ["inbox: <empty>", "inbox: empty"] }), snapshotOf(readyTicket()), SHOTS));

    expect(shotsMarkerIn(body)?.named).toEqual([{ name: "inbox: empty" }]);
    expect(sectionOf(body).some((line) => line.startsWith("1 name was dropped for breaking the name rule"))).toBe(true);
    expect(body).not.toContain("<empty>");
  });

  it("win over the sentence when the output gives both", () => {
    const body = openedBody(planFor(firstRun({ shots: ["inbox: empty"], nothingVisible: "Nothing changes." }), snapshotOf(readyTicket()), SHOTS));

    expect(shotsMarkerIn(body)).toMatchObject({ named: [{ name: "inbox: empty" }] });
    expect(shotsMarkerIn(body)).not.toHaveProperty("nothingVisible");
    expect(body).not.toContain("Nothing changes.");
  });

  it("are none when it says nothing visible changes, whose sentence the section gives, with no Verdict", () => {
    const plan = planFor(firstRun({ nothingVisible: "Only the inbox's sort order in the API changed." }), snapshotOf(readyTicket()), SHOTS);

    expect(sectionOf(openedBody(plan))).toContain("> Only the inbox's sort order in the API changed.");
    expect(verdictsPostedIn(commentsOf(plan))).toEqual([]);
  });

  it.each([
    ["names routes", { routes: ["/inbox"] }],
    ["names routes beside its shots", { routes: ["/inbox"], shots: ["inbox: empty"] }],
  ])("ignore the routes when it %s, and when the Ticket names one", (_, fields) => {
    const ticket = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], body: "Show an empty state on `/inbox`." });

    const body = openedBody(planFor(firstRun(fields), snapshotOf(ticket), SHOTS));

    expect(body).not.toContain("`/inbox`");
    expect(shotsMarkerIn(body)?.routes).toEqual([]);
  });

  it.each([
    ["names shots", { shots: ["inbox: empty"] }],
    ["names nothing", {}],
  ])("give a pull request that isn't UI no section and no miss, when its output %s", (_, fields) => {
    const plan = planFor(firstRun(fields, { changes: { net: [{ path: "src/api/inbox.ts" }], commits: [{ path: "src/api/inbox.ts" }], pushedHead: PUSHED } }), snapshotOf(readyTicket()), SHOTS);

    expect(openedBody(plan)).toBe("Adds the empty inbox state.\n\nCloses #7");
    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request"]);
  });
});

describe("A first run that names nothing on a UI pull request (#819)", () => {
  it("gets the Kit's Execution flaw at the head it pushed, on the pull request it opens, which starts the Retry", () => {
    const plan = planFor(firstRun(), snapshotOf(readyTicket()), SHOTS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request", "comment-on-opened", "add-labels"]);
    expect(verdictsPostedIn(commentsOf(plan))).toEqual([{ verdict: "execution-flaw", source: "evidence-miss", requestChanges: false, headSha: PUSHED }]);
    expect(actionsOf(plan)).toContainEqual(RETRY_TRIGGER);
  });

  it("says in the flaw that the pull request changes the UI and shows nothing of it, and what to do", () => {
    const [verdict = ""] = commentsOf(planFor(firstRun(), snapshotOf(readyTicket()), SHOTS));

    expect(verdict).toContain("## Verdict: Execution flaw");
    expect(verdict).toContain(`From an Evidence miss, on ${PUSHED.slice(0, 7)}.`);
    expect(verdict).toContain("This pull request changes the UI and shows nothing of the change");
    expect(verdict).toContain("Name up to four Evidence shots");
    expect(verdict).toContain("add one to the Journey that reaches it");
    expect(verdict).toContain("say why in `nothingVisible`");
    expect(verdict).toContain("Retry 1 of 2 starts now");
    expect(verdict).toContain(`[The run](${RUN})`);
  });

  it("says in the section that nothing was named and that it was sent back, and records the miss", () => {
    const body = openedBody(planFor(firstRun(), snapshotOf(readyTicket()), SHOTS));

    expect(sectionOf(body)).toContain(
      "**Evidence miss:** the Implementer named no Evidence shot and didn't say that nothing visible changes, so the Kit sent it back with an Execution flaw, which uses a Retry.",
    );
    expect(shotsMarkerIn(body)).toMatchObject({ named: [], miss: "nothing-named", head: null });
  });

  it("calls for the Retry the Ticket's pool has left, after its empty diffs and Broken runs", () => {
    const [verdict = ""] = commentsOf(planFor(firstRun(), snapshotOf(readyTicket(1)), SHOTS));

    expect(verdict).toContain("Retry 2 of 2 starts now, stepped up");
  });

  it("with no Retry left gets no Verdict from the Kit, and goes on to Review, the section saying nothing was named", () => {
    const plan = planFor(firstRun(), snapshotOf(readyTicket(2)), SHOTS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["push-branch", "open-pull-request"]);
    expect(sectionOf(openedBody(plan))).toContain(
      "**Evidence miss:** the Implementer named no Evidence shot and didn't say that nothing visible changes. No Retry is left, so it goes on to Review showing nothing of the change.",
    );
    expect(shotsMarkerIn(openedBody(plan))?.miss).toBe("nothing-named");
  });
});

/** The shots marker a pull request's body holds: these names, or this sentence. */
const markerNaming = (named: readonly string[], nothingVisible?: string): ShotsMarker =>
  waitingShotsMarker({ named: named.map((name) => ({ name })), ...(nothingVisible === undefined ? {} : { nothingVisible }) }, 8000, { kind: "none" });

/** An earlier Verdict. */
const earlier = (overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "0".repeat(40), ...overrides });

/** A PR whose Reviewer's flaw on HEAD_SHA started Retry 1, its body holding these shots names, after these earlier Verdicts. */
const flawed = (shotsMarker: ShotsMarker | null, before: readonly VerdictRecord[] = [], overrides: Partial<PullRequestSnapshot> = {}) =>
  aPullRequest({ verdicts: [...before, earlier({ headSha: HEAD_SHA })], shotsMarker, ...overrides });

/** A run on PR #50's branch, its changes matching no ui.paths, so only the PR's marker makes it UI. */
function onPullRequest(fields: Record<string, unknown> = {}, fixes: Partial<NonNullable<ImplementRunFinished["fixes"]>> = {}, overrides: Partial<ImplementRunFinished> = {}): ImplementRunFinished {
  return {
    ...firstRun({ fix: "Fixes the inbox.", reviewMiss: false, amendsTicket: false, ...fields }),
    base: "fabrik/ticket-7",
    changes: { net: [{ path: "src/api/inbox.ts" }], commits: [{ path: "src/api/inbox.ts" }], pushedHead: PUSHED },
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, ...fixes },
    ...overrides,
  };
}

const snapshotWith = (pullRequest: PullRequestSnapshot): Snapshot => ({
  ...snapshotOfPullRequest(pullRequest, { operator: "jrey" }),
  issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }),
});

/** The body the plan gives PR #50. */
function editedBody(plan: Plan): string {
  const edit = actionsOf(plan).find((action) => action.kind === "edit-issue-body");
  if (edit === undefined) throw new Error(`expected a plan that edits the PR's body, got ${JSON.stringify(plan)}`);
  return edit.body;
}

describe("The names rule on a run on the pull request (#819)", () => {
  it("keeps the names the marker held when a Retry gives neither, and the section still lists them", () => {
    const body = editedBody(planFor(onPullRequest(), snapshotWith(flawed(markerNaming(["inbox: empty", "inbox: one message"]))), SHOTS));

    expect(shotsMarkerIn(body)?.named).toEqual([{ name: "inbox: empty" }, { name: "inbox: one message" }]);
    expect(sectionOf(body)).toEqual(expect.arrayContaining(["- `inbox: empty`", "- `inbox: one message`"]));
  });

  it("keeps the sentence the marker held when a Retry gives neither", () => {
    const body = editedBody(planFor(onPullRequest(), snapshotWith(flawed(markerNaming([], "Nothing changes."))), SHOTS));

    expect(shotsMarkerIn(body)).toMatchObject({ named: [], nothingVisible: "Nothing changes." });
  });

  it("replaces the names with those a later run names", () => {
    const body = editedBody(planFor(onPullRequest({ shots: ["inbox: archived"] }), snapshotWith(flawed(markerNaming(["inbox: empty"]))), SHOTS));

    expect(shotsMarkerIn(body)?.named).toEqual([{ name: "inbox: archived" }]);
    expect(body).not.toContain("inbox: empty");
  });

  it("clears the names when a later run says nothing visible changes, and shows its sentence", () => {
    const body = editedBody(planFor(onPullRequest({ nothingVisible: "The fix is in the API alone." }), snapshotWith(flawed(markerNaming(["inbox: empty"]))), SHOTS));

    expect(shotsMarkerIn(body)).toMatchObject({ named: [], nothingVisible: "The fix is in the API alone." });
    expect(sectionOf(body)).toContain("> The fix is in the API alone.");
    expect(body).not.toContain("inbox: empty");
  });

  it("holds for a Touch-up, a Request-changes run, a conflict-only run and a body-only Touch-up alike", () => {
    const named = markerNaming(["inbox: empty"]);
    const touchUp = earlier({ headSha: HEAD_SHA, tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 0 }, touchUp: 1 });
    const bodyOnly = earlier({ headSha: HEAD_SHA, tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 1 }, touchUp: 1 });
    const runs: readonly [ImplementRunFinished, PullRequestSnapshot][] = [
      [onPullRequest({}, { touchUp: 1 }), aPullRequest({ verdicts: [touchUp], shotsMarker: named })],
      [
        onPullRequest({}, { review: 900 }),
        aPullRequest({ verdicts: [earlier({ verdict: "pass", headSha: HEAD_SHA })], shotsMarker: named, notedChangesRequests: [900], requestChangesRunInFlight: 900, requestChangesRunReviews: [900] }),
      ],
      [
        onPullRequest({}, { conflict: "9".repeat(40) }, { changes: { net: [], commits: [], updatedFromMain: true, pushedHead: PUSHED } }),
        aPullRequest({ verdicts: [earlier({ verdict: "pass", headSha: HEAD_SHA })], shotsMarker: named, conflictRunInFlight: "9".repeat(40) }),
      ],
      [onPullRequest({}, { touchUp: 1 }, { changes: { net: [], commits: [] } }), aPullRequest({ verdicts: [bodyOnly], shotsMarker: named })],
    ];

    for (const [event, pullRequest] of runs) {
      expect(shotsMarkerIn(editedBody(planFor(event, snapshotWith(pullRequest), SHOTS)))?.named).toEqual([{ name: "inbox: empty" }]);
    }
  });
});

describe("A run on the pull request that leaves it naming nothing (#819)", () => {
  /** Verdicts the plan posts on PR #50. */
  const verdictsOf = (plan: Plan) => verdictsPostedIn(actionsOf(plan).flatMap((action) => (action.kind === "comment" && action.issue === 50 ? [action.body] : [])));

  it("gets the Kit's Execution flaw at the head it pushed, after its push note, which starts the next Retry and counts in the pool", () => {
    const plan = planFor(onPullRequest(), snapshotWith(flawed(markerNaming([]))), SHOTS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch", "comment", "add-labels"]);
    expect(verdictsOf(plan)).toEqual([{ verdict: "execution-flaw", source: "evidence-miss", requestChanges: false, headSha: PUSHED }]);
    expect(actionsOf(plan)).toContainEqual(RETRY_TRIGGER);
    expect(commentsOf(plan).at(-1)).toContain("Retry 2 of 2 starts now, stepped up");
  });

  it("marks the flaw on a Request-changes run's push and on a conflict-only run's as from that run", () => {
    const requestChanges = planFor(
      onPullRequest({}, { review: 900 }),
      snapshotWith(aPullRequest({ verdicts: [earlier({ verdict: "pass", headSha: HEAD_SHA })], shotsMarker: markerNaming([]), notedChangesRequests: [900], requestChangesRunInFlight: 900, requestChangesRunReviews: [900] })),
      SHOTS,
    );
    const conflict = planFor(
      onPullRequest({}, { conflict: "9".repeat(40) }, { changes: { net: [], commits: [], updatedFromMain: true, pushedHead: PUSHED } }),
      snapshotWith(aPullRequest({ verdicts: [earlier({ verdict: "pass", headSha: HEAD_SHA })], shotsMarker: markerNaming([]), conflictRunInFlight: "9".repeat(40) })),
      SHOTS,
    );

    expect(verdictsOf(requestChanges)).toEqual([{ verdict: "execution-flaw", source: "evidence-miss", requestChanges: true, headSha: PUSHED }]);
    expect(verdictsOf(conflict)).toEqual([{ verdict: "execution-flaw", source: "evidence-miss", requestChanges: false, conflictRun: true, headSha: PUSHED }]);
  });

  it("calls for a Retry, never a Touch-up, after a Touch-up", () => {
    const touchUp = earlier({ headSha: HEAD_SHA, tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 0 }, touchUp: 1 });

    const [verdict] = verdictsOf(planFor(onPullRequest({}, { touchUp: 1 }), snapshotWith(aPullRequest({ verdicts: [touchUp], shotsMarker: markerNaming([]) })), SHOTS));

    expect(verdict).not.toHaveProperty("touchUp");
    expect(verdict).toMatchObject({ source: "evidence-miss" });
  });

  it("with no Retry left gets no Verdict from the Kit, and the section says nothing was named", () => {
    const plan = planFor(onPullRequest(), snapshotWith(flawed(markerNaming([]), [earlier()])), SHOTS);

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["edit-issue-body", "comment", "push-branch"]);
    expect(sectionOf(editedBody(plan))).toContain(
      "**Evidence miss:** the Implementer named no Evidence shot and didn't say that nothing visible changes. No Retry is left, so it goes on to Review showing nothing of the change.",
    );
  });

  it("that pushes no head, as a body-only Touch-up, is shown and never sent back", () => {
    const bodyOnly = earlier({ headSha: HEAD_SHA, tags: { small: 1, missedEarlier: 0, counted: 0, smallBody: 1 }, touchUp: 1 });

    const plan = planFor(onPullRequest({}, { touchUp: 1 }, { changes: { net: [], commits: [] } }), snapshotWith(aPullRequest({ verdicts: [bodyOnly], shotsMarker: markerNaming([]) })), SHOTS);

    expect(verdictsOf(plan)).toEqual([]);
    expect(sectionOf(editedBody(plan)).some((line) => line.includes("No Implementer run pushed this head, so it isn't sent back"))).toBe(true);
  });

  it("isn't UI when neither its changes nor the PR's marker make it so, so it gets no section and no miss", () => {
    const plan = planFor(onPullRequest(), snapshotWith(flawed(null)), SHOTS);

    expect(editedBody(plan)).toBe("Adds the empty inbox state.\n\nCloses #7");
    expect(verdictsOf(plan)).toEqual([]);
  });
});

describe("The head an Evidence miss was sent back from, on the PR's thread (#819)", () => {
  /** PR #50 named nothing on A, and the Kit's flaw on A started Retry 1. */
  function sentBackOnA(): PullRequestOnGitHub {
    const thread = new PullRequestOnGitHub();
    thread.body = `Shows the empty state.\n\n${shotsSection({ check: "e2e", artifact: "fabrik-evidence-shots", marker: markerNaming([]), missOutcome: "sent-back" })}\n\nCloses #7`;
    thread.kitSays(verdictMarker({ verdict: "execution-flaw", source: "evidence-miss", requestChanges: false, headSha: A }));
    return thread;
  }

  it("is never judged by the Reviewer: Review doesn't start on it, and a Review that ran anyway lands no Verdict", async () => {
    const thread = sentBackOnA();
    const retry = finished(B, { retry: 1 });
    thread.apply(planFor(retry, await thread.pushJobSnapshot(), SHOTS), { pushLands: true, tip: B });

    const snapshot = snapshotOfPullRequest(await thread.pullRequest());
    expect(planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshot, SHOTS)).toMatchObject({ kind: "nothing" });
    const review: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: B, output: "verdict: pass", runUrl: RUN, repoUrl: "https://github.com/acme/shop" };
    expect(planFor(review, snapshot, SHOTS)).toMatchObject({ kind: "nothing" });
  });

  it("counts in the Ticket's pool: the flaw on the Retry's push calls for Retry 2, and the one after starts none", async () => {
    const thread = sentBackOnA();
    thread.apply(planFor(finished(B, { retry: 1 }), await thread.pushJobSnapshot(), SHOTS), { pushLands: true, tip: B });

    expect(runInFlight(await thread.pullRequest())).toEqual({ kind: "retry", retry: 2, flaw: B });

    const last = planFor(finished(C, { retry: 2 }, B), await thread.pushJobSnapshot(), SHOTS);
    expect(actionsOf(last)).not.toContainEqual(RETRY_TRIGGER);
    expect(shotsMarkerIn(editedBody(last))?.miss).toBe("nothing-named");
  });
});

describe("A first run on a Product repo without Evidence shots (#819)", () => {
  it.each([
    ["names shots", { shots: ["inbox: empty"] }],
    ["says nothing visible changes", { nothingVisible: "Nothing changes." }],
  ])("opens the same pull request when its output %s as when it gives neither", (_, fields) => {
    const config = kitConfig({ ui: UI });
    const route = { evidence: anEvidence(undefined, { artifact: null, evidencePage: null }) };

    expect(planFor(firstRun(fields, route), snapshotOf(readyTicket()), config)).toEqual(planFor(firstRun({}, route), snapshotOf(readyTicket()), config));
  });
});
