// A UI pull request's Review on a Product repo that uses Evidence shots
// (#820), through the rules core: what its Review is started with, the
// section its push job writes once the Review's jobs have read the named
// check's artifact, and the Kit's own Execution flaw for a named shot the
// check didn't produce.
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { aShotsCollected, SHOTS_UI } from "../__fixtures__/uiEvidence.ts";
import type { ShotsCollected } from "../evidence/shotsCollect.ts";
import { readShotsMarker, type ShotsMarker, shotsMarkerIn, waitingShotsMarker } from "../evidence/shotsEvidence.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan, PullRequestSnapshot, VerdictRecord } from "./types.ts";

const SHOTS = kitConfig({ ui: SHOTS_UI });
const RUN = "https://github.com/acme/shop/actions/runs/9300/attempts/1";
const REPO = "https://github.com/acme/shop";
const OPERATOR_PUSH = "b".repeat(40);

/** The pull request's marker, as its Implement run's push job wrote it: naming two shots, at the head that run pushed. */
const waiting = (overrides: Partial<ShotsMarker> = {}): ShotsMarker => ({
  ...waitingShotsMarker({ named: [{ name: "composer: draft ready" }, { name: "inbox: empty" }] }, 9100, { kind: "none" }, HEAD_SHA),
  ...overrides,
});

const pullRequestOf = (overrides: Partial<PullRequestSnapshot> = {}) => aPullRequest({ shotsMarker: waiting(), ...overrides });

/** A flaw that called for a Retry, as an earlier head's Verdict records it. */
const flawAt = (headSha: string): VerdictRecord => ({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

const commentsOf = (plan: Plan) => actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));

/** The section the plan writes in place of the pull request's, by the action that replaces it. */
function sectionOf(plan: Plan): string {
  const replaced = actionsOf(plan).find((action) => action.kind === "replace-evidence-section");
  if (replaced === undefined) throw new Error(`expected a plan that replaces the section, got ${JSON.stringify(plan)}`);
  return replaced.section;
}

const missMissing = (overrides: Partial<ShotsCollected> = {}) =>
  aShotsCollected({ named: [aShotsCollected().named[1]!], missed: [{ name: "composer: draft ready", why: "not-produced" }], sendsBack: true, ...overrides });

const read = (collected: ShotsCollected) => ({ collected, run: 9300, artifact: 9301 });

function reviewed(collected: ShotsCollected = aShotsCollected(), overrides: Partial<Extract<LoopEvent, { kind: "review-run-finished" }>> = {}): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks right.", runUrl: RUN, repoUrl: REPO, shots: read(collected), ...overrides };
}

function missFound(collected: ShotsCollected = missMissing()): LoopEvent {
  return { kind: "evidence-miss-found", pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, repoUrl: REPO, shots: read(collected) };
}

describe("The Review of a UI pull request on a Product repo that uses Evidence shots (#820)", () => {
  const started = (pullRequest: PullRequestSnapshot) => actionsOf(planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(pullRequest), SHOTS));

  it("starts with the check, the artifact, the pull request's names, and the head a miss would be sent back at", () => {
    expect(started(pullRequestOf())).toMatchObject([
      {
        kind: "start-agent-run",
        role: "review",
        shots: { check: "e2e", artifact: "fabrik-evidence-shots", names: ["composer: draft ready", "inbox: empty"], sendsBackAt: HEAD_SHA },
      },
    ]);
    expect(started(pullRequestOf())[0]).not.toHaveProperty("evidence");
  });

  it("carries the Implementer's sentence that nothing visible changes", () => {
    expect(started(pullRequestOf({ shotsMarker: waiting({ named: [], nothingVisible: "Only the API changed." }) }))).toMatchObject([
      { shots: { names: [], nothingVisible: "Only the API changed." } },
    ]);
  });

  it.each([
    ["the Operator pushed", pullRequestOf({ headSha: OPERATOR_PUSH })],
    ["the Kit's plain rebase made", pullRequestOf({ headSha: OPERATOR_PUSH, conflictAttempts: ["c".repeat(40)] })],
    ["a run that pushed nothing left", pullRequestOf({ shotsMarker: waiting({ pushed: undefined }) })],
  ])("sends nothing back at a head %s", (_, pullRequest) => {
    expect(started(pullRequest)).toMatchObject([{ shots: { sendsBackAt: null } }]);
  });

  it("sends nothing back once the Ticket's Retries are used up", () => {
    const used = pullRequestOf({ verdicts: [flawAt("1".repeat(40)), flawAt("2".repeat(40))], pushedSinceVerdict: true });

    expect(started(used)).toMatchObject([{ shots: { sendsBackAt: null } }]);
  });

  it("starts no Review at a head its Implement run's push sent back for naming nothing", () => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(pullRequestOf({ shotsMarker: waiting({ named: [], miss: "nothing-named" }) })), SHOTS);

    expect(plan).toEqual({ kind: "nothing", reason: "#50's Evidence miss at aaaaaaa sends it back with the Kit's Execution flaw, so no Reviewer judges that head" });
  });

  it("starts a Review of a pull request that names nothing when it isn't sent back, as when no Retry is left", () => {
    const used = pullRequestOf({ shotsMarker: waiting({ named: [], miss: "nothing-named" }), verdicts: [flawAt("1".repeat(40)), flawAt("2".repeat(40))], pushedSinceVerdict: true });

    expect(started(used)).toMatchObject([{ kind: "start-agent-run", shots: { names: [], sendsBackAt: null } }]);
  });

  it("is what it was on a Product repo without shots", () => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest({ uiEvidenceMarker: { run: 9100, artifact: 9202 } })), kitConfig());

    expect(actionsOf(plan)[0]).not.toHaveProperty("shots");
    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", evidence: { run: 9100, artifact: 9202 } }]);
  });
});

describe("The section a Review's push job writes once the Review's jobs have read the shots (#820)", () => {
  it("lists the named shots with the head they are from, before the Verdict, and links the Evidence page", () => {
    const plan = planFor(reviewed(), snapshotOfPullRequest(pullRequestOf()), SHOTS);
    const section = sectionOf(plan);

    expect(actionsOf(plan).findIndex((action) => action.kind === "replace-evidence-section")).toBeLessThan(actionsOf(plan).findIndex((action) => action.kind === "comment"));
    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "replace-evidence-section", issue: 50 }));
    expect(section).toContain("[Open the Evidence page](<https://github.com/acme/shop/actions/runs/9300/artifacts/9301>)");
    expect(section).toContain("- `composer: draft ready`, from the Journey `write-a-clinical-note`, at `/patients/6f1b2c3d/notes/new`");
    expect(shotsMarkerIn(section)).toMatchObject({ head: HEAD_SHA, run: 9300, artifact: 9301, pushed: HEAD_SHA, implementRun: 9100 });
    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ verdict: "pass", source: "reviewer" }]);
  });

  it.each([
    ["no Retry is left", pullRequestOf({ verdicts: [flawAt("1".repeat(40)), flawAt("2".repeat(40))], pushedSinceVerdict: true }), "No Retry is left, so it goes on to Review with the miss shown."],
    ["the Operator pushed the head", pullRequestOf({ headSha: OPERATOR_PUSH }), "No Implementer run pushed `bbbbbbb`, so it isn't sent back"],
  ])("says what was missed when %s, and lands the Reviewer's Verdict", (_, pullRequest, said) => {
    const plan = planFor(reviewed(missMissing({ sendsBack: false, head: pullRequest.headSha }), { headSha: pullRequest.headSha }), snapshotOfPullRequest(pullRequest), SHOTS);

    expect(sectionOf(plan)).toContain(said);
    expect(sectionOf(plan)).toContain("- `composer: draft ready` wasn't produced: the `e2e` check's run took no shot of that name.");
    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ source: "reviewer" }]);
  });

  it("says the shots are from a run that failed, and sends nothing back for evidence, when the named check is still red", () => {
    const plan = planFor(
      reviewed(missMissing({ sendsBack: false, red: true }), {
        output: "verdict: execution-flaw\n\nThe composer breaks.\n\nred-checks:\n- caused `e2e`: the composer test fails on the change.",
        redChecks: { failed: ["e2e"], excerpts: [] },
      }),
      snapshotOfPullRequest(pullRequestOf()),
      SHOTS,
    );

    expect(sectionOf(plan)).toContain("**The `e2e` check is red:** it is still red after the Kit's re-run, so these Evidence shots are from a run that failed.");
    expect(sectionOf(plan)).toContain("The check is still red after the Kit's re-run, so nothing is sent back for evidence: the Reviewer's judgment of the check decides.");
    expect(verdictsPostedIn(commentsOf(plan))).toMatchObject([{ source: "reviewer", checks: ["e2e"] }]);
  });

  it("writes no section on a Product repo without shots, nor when the Review's jobs read none", () => {
    const routes = planFor(reviewed(aShotsCollected(), { shots: undefined }), snapshotOfPullRequest(aPullRequest({ uiEvidenceMarker: { run: 9100, artifact: 9202 } })), kitConfig());
    const unread = planFor(reviewed(aShotsCollected(), { shots: undefined }), snapshotOfPullRequest(pullRequestOf()), SHOTS);

    expect(actionsOf(routes).map(({ kind }) => kind)).not.toContain("replace-evidence-section");
    expect(actionsOf(unread).map(({ kind }) => kind)).not.toContain("replace-evidence-section");
  });
});

describe("A named shot the green check didn't produce, at a head an Implementer run pushed with a Retry left (#820)", () => {
  it.each([
    ["the manifest lacks", { name: "composer: draft ready", why: "not-produced" }, "`composer: draft ready` wasn't produced: the `e2e` check's run took no shot of that name."],
    ["two entries share", { name: "composer: draft ready", why: "ambiguous-name" }, "`composer: draft ready` is ambiguous"],
    ["the artifact's rules refused", { name: "composer: draft ready", why: "refused" }, "`composer: draft ready` was refused"],
  ] as const)("gets the Kit's Execution flaw at that head for a name %s, naming it and listing the names the run produced", (_, miss, said) => {
    const plan = planFor(missFound(missMissing({ missed: [miss] })), snapshotOfPullRequest(pullRequestOf()), SHOTS);
    const [comment] = commentsOf(plan);

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([{ verdict: "execution-flaw", source: "evidence-miss", requestChanges: false, headSha: HEAD_SHA }]);
    expect(comment).toContain("From an Evidence miss, on aaaaaaa.");
    expect(comment).toContain(said);
    expect(comment).toContain("The shots the run did produce: `composer: draft ready`, `inbox: empty` and `sign in: form`.");
    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 7, labels: ["agent:implement"] });
  });

  it("calls for a Retry, never a Touch-up, and counts in the pool", () => {
    const plan = planFor(missFound(), snapshotOfPullRequest(pullRequestOf({ verdicts: [flawAt("1".repeat(40))], pushedSinceVerdict: true })), SHOTS);

    expect(commentsOf(plan)[0]).toContain("Retry 2 of 2");
    expect(verdictsPostedIn(commentsOf(plan))[0]).not.toHaveProperty("touchUp");
  });

  it("writes the section, saying it was sent back", () => {
    const section = sectionOf(planFor(missFound(), snapshotOfPullRequest(pullRequestOf()), SHOTS));

    expect(section).toContain("so the Kit sent it back with an Execution flaw, which uses a Retry.");
    expect(shotsMarkerIn(section)).toMatchObject({ head: HEAD_SHA, missed: [{ name: "composer: draft ready", why: "not-produced" }] });
  });

  it("lands nothing at a head the pull request has moved on from", () => {
    expect(planFor(missFound(), snapshotOfPullRequest(pullRequestOf({ headSha: OPERATOR_PUSH })), SHOTS)).toMatchObject({ kind: "nothing" });
  });

  it("lands no flaw when the pull request is no longer one it sends back, and starts a Review in its place", () => {
    const used = pullRequestOf({ verdicts: [flawAt("1".repeat(40)), flawAt("2".repeat(40))], pushedSinceVerdict: true });
    const plan = planFor(missFound(), snapshotOfPullRequest(used), SHOTS);

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([]);
    expect(actionsOf(plan)).toContainEqual({ kind: "add-labels", issue: 50, labels: ["agent:review"] });
  });
});

describe("The Kit's plain rebase of a UI pull request whose UI evidence is Evidence shots (#813)", () => {
  const MAIN = "9".repeat(40);
  const READ = readShotsMarker(waiting(), read(missMissing({ sendsBack: false })));
  const atMergeGate = (shotsMarker: ShotsMarker | null) =>
    aPullRequest({ draft: false, verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }], shotsMarker });
  const rebaseOf = (pullRequest: PullRequestSnapshot, config = SHOTS) => {
    const snapshot = { ...snapshotOfPullRequest(aPullRequest()), pullRequest: null, conflicts: { main: MAIN, now: "2026-01-01T00:00:00Z", implementJobUnderWay: null, pullRequests: [{ pullRequest, mergeable: false }] } };
    const rebase = actionsOf(planFor({ kind: "main-pushed", head: MAIN }, snapshot, config)).find((action) => action.kind === "rebase-onto-main");
    if (rebase?.kind !== "rebase-onto-main") throw new Error("expected a rebase");
    return rebase;
  };
  const sectionsIn = (actions: readonly Action[]) => actions.flatMap((action) => (action.kind === "replace-evidence-section" ? [action.section] : []));

  it("sends the section back to waiting once the rebase is pushed, keeping the names", () => {
    const [section, ...others] = sectionsIn(rebaseOf(atMergeGate(READ)).pushed);

    expect(others).toEqual([]);
    expect(section).toContain("Waiting for the `e2e` check");
    expect(section).not.toContain("Open the Evidence page");
    expect(shotsMarkerIn(section ?? "")).toEqual(waiting());
  });

  it("writes no section when the rebase is refused or conflicts, nor when the section already waits", () => {
    const rebase = rebaseOf(atMergeGate(READ));

    expect(sectionsIn([...rebase.clean, ...rebase.refused, ...rebase.conflicted])).toEqual([]);
    expect(sectionsIn(rebaseOf(atMergeGate(waiting())).pushed)).toEqual([]);
  });

  it("writes no section on a pull request with no shots marker, or a Product repo without ui.shots", () => {
    expect(sectionsIn(rebaseOf(atMergeGate(null)).pushed)).toEqual([]);
    expect(sectionsIn(rebaseOf(atMergeGate(READ), kitConfig()).pushed)).toEqual([]);
  });
});
