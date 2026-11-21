import { describe, expect, it } from "vitest";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { aLabelAdded } from "../read/builders.ts";
import { closesATrialProblem, type TrialFacts, type TrialProblemFacts, type TrialPullRequestFacts, trialResultOf } from "./trialResult.ts";
import type { LabelEvent } from "./weeklySummary.ts";

const OPERATOR = "operator";
/** The Operator adding `label` at `at`. */
const added = (label: string, at: string, actor = OPERATOR): LabelEvent => aLabelAdded(label, at, { actor });
/** The Operator taking `label` off at `at`. */
const removed = (label: string, at: string, actor = OPERATOR): LabelEvent => aLabelAdded(label, at, { actor, action: "unlabeled" });
/** What the rule reads of merged pull request `pullRequest`: these label events, closing these issues. */
const merged = (pullRequest: number, labelEvents: readonly LabelEvent[] = [], closes: readonly number[] = []): TrialPullRequestFacts => ({ pullRequest, labelEvents, closes });
/** Trial problem `issue`, whose line names pull request 50, closed as completed unless a test says otherwise. */
const aTrialProblem = (issue: number, overrides: Partial<TrialProblemFacts> = {}): TrialProblemFacts => ({ issue, pullRequest: 50, title: "The cart total reads 0", open: false, closedAs: "completed", ...overrides });
const facts = (pullRequests: readonly TrialPullRequestFacts[], problems: readonly TrialProblemFacts[] = []): TrialFacts => ({ pullRequests, problems });
/** Pull request 50's result with these label events alone. */
const labelled = (...labelEvents: LabelEvent[]) => trialResultOf(50, facts([merged(50, labelEvents)]), OPERATOR);

const UNTRIED = { is: "untried" };

describe("a Staging trial's result, read from label events alone (#856)", () => {
  it("is accepted for the Operator's fabrik:trial-accepted and a problem for their fabrik:trial-problem, since they put it on", () => {
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"))).toEqual({ is: "accepted", at: "2026-11-08T10:00:00Z", problems: [], fix: null });
    expect(labelled(added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z"))).toEqual({ is: "problem", at: "2026-11-08T10:00:00Z", problems: [] });
  });

  it("is untried with no label event, with only other labels' events, or for a pull request the facts hold nothing of", () => {
    expect(labelled()).toEqual(UNTRIED);
    expect(labelled(added("bug", "2026-11-08T10:00:00Z"), added("fabrik:trial", "2026-11-08T10:01:00Z"))).toEqual(UNTRIED);
    expect(trialResultOf(51, facts([merged(50, [added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z")])]), OPERATOR)).toEqual(UNTRIED);
  });

  it.each([
    ["another person", "kate"],
    ["the Fabrik App", "fabrik-app[bot]"],
    ["any other bot", "dependabot[bot]"],
    ["a deleted account", "ghost"],
  ])("leaves the pull request untried when %s applied either label", (_who, actor) => {
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z", actor))).toEqual(UNTRIED);
    expect(labelled(added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z", actor))).toEqual(UNTRIED);
  });

  it("reads past another actor's labelling to the Operator's own, in either order", () => {
    expect(labelled(added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z"), added(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z", "fabrik-app[bot]"))).toMatchObject({ is: "problem", at: "2026-11-08T10:00:00Z" });
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T09:00:00Z", "kate"), added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z"))).toMatchObject({ is: "problem", at: "2026-11-08T10:00:00Z" });
  });

  it("takes the later of the two when the Operator applied both, in either order, whatever order the events are held in", () => {
    const accepted = added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z");
    const problem = added(TRIAL_PROBLEM_LABEL, "2026-11-08T11:00:00Z");
    expect(labelled(accepted, problem)).toMatchObject({ is: "problem", at: "2026-11-08T11:00:00Z" });
    expect(labelled(problem, accepted)).toMatchObject({ is: "problem", at: "2026-11-08T11:00:00Z" });

    const first = added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z");
    const then = added(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z");
    expect(labelled(first, then)).toMatchObject({ is: "accepted", at: "2026-11-08T11:00:00Z" });
    expect(labelled(then, first)).toMatchObject({ is: "accepted", at: "2026-11-08T11:00:00Z" });
  });

  it("takes the later in GitHub's own order when both were put on in the one second, as one request does", () => {
    const at = "2026-11-08T10:00:00Z";
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, at), added(TRIAL_PROBLEM_LABEL, at))).toMatchObject({ is: "problem" });
    expect(labelled(added(TRIAL_PROBLEM_LABEL, at), added(TRIAL_ACCEPTED_LABEL, at))).toMatchObject({ is: "accepted" });
  });

  it("is untried once the Operator removed the deciding label, even while the other label is still on", () => {
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"), removed(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z"))).toEqual(UNTRIED);
    expect(
      labelled(added(TRIAL_PROBLEM_LABEL, "2026-11-08T09:00:00Z"), added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"), removed(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z")),
    ).toEqual(UNTRIED);
  });

  it("changes nothing when the Operator removes the other label, or anyone else removes the deciding one", () => {
    expect(
      labelled(added(TRIAL_PROBLEM_LABEL, "2026-11-08T09:00:00Z"), added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"), removed(TRIAL_PROBLEM_LABEL, "2026-11-08T11:00:00Z")),
    ).toMatchObject({ is: "accepted", at: "2026-11-08T10:00:00Z" });
    expect(labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"), removed(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z", "kate"))).toMatchObject({ is: "accepted", at: "2026-11-08T10:00:00Z" });
  });

  it("reads a label put on again after its removal, since the labelling that decides is the latest", () => {
    expect(
      labelled(added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z"), removed(TRIAL_ACCEPTED_LABEL, "2026-11-08T11:00:00Z"), added(TRIAL_ACCEPTED_LABEL, "2026-11-08T12:00:00Z")),
    ).toMatchObject({ is: "accepted", at: "2026-11-08T12:00:00Z" });
  });

  it("knows the Operator whatever the case their login is written in, as GitHub does", () => {
    expect(trialResultOf(50, facts([merged(50, [added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z", "JRey8343")])]), "jrey8343")).toMatchObject({ is: "accepted" });
  });
});

describe("a Trial problem's fix (#856)", () => {
  const PROBLEM = added(TRIAL_PROBLEM_LABEL, "2026-11-08T10:00:00Z");
  /** Pull request 50, labelled a problem at 10:00, with these Trial problems and these other merged pull requests. */
  const found = (problems: readonly TrialProblemFacts[], ...others: TrialPullRequestFacts[]) => trialResultOf(50, facts([merged(50, [PROBLEM]), ...others], problems), OPERATOR);

  it("names each Trial problem whose line names the pull request, lowest first, with whether it is open; and none of another pull request's", () => {
    const problems = [aTrialProblem(71, { open: true, closedAs: null }), aTrialProblem(70), aTrialProblem(72, { pullRequest: 51 })];
    expect(found(problems)).toEqual({ is: "problem", at: "2026-11-08T10:00:00Z", problems: [{ issue: 70, open: false }, { issue: 71, open: true }] });
    expect(trialResultOf(50, facts([merged(50, [added(TRIAL_ACCEPTED_LABEL, "2026-11-08T10:00:00Z")])], problems), OPERATOR)).toMatchObject({ is: "accepted", fix: null, problems: [{ issue: 70, open: false }, { issue: 71, open: true }] });
  });

  it("accepts the pull request through its fix once the one merged pull request that closed its Trial problem is accepted, since that acceptance, naming the fix", () => {
    const fix = merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T15:00:00Z")], [70]);
    expect(found([aTrialProblem(70)], fix)).toEqual({ is: "accepted", at: "2026-11-09T15:00:00Z", problems: [{ issue: 70, open: false }], fix: [61] });
  });

  it("stays a problem while the fix is untried, a problem itself, or accepted by someone other than the Operator", () => {
    const stays = { is: "problem", at: "2026-11-08T10:00:00Z", problems: [{ issue: 70, open: false }] };
    expect(found([aTrialProblem(70)], merged(61, [], [70]))).toEqual(stays);
    expect(found([aTrialProblem(70)], merged(61, [added(TRIAL_PROBLEM_LABEL, "2026-11-09T15:00:00Z")], [70]))).toEqual(stays);
    expect(found([aTrialProblem(70)], merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T15:00:00Z", "fabrik-app[bot]")], [70]))).toEqual(stays);
  });

  it.each([
    ["still open", aTrialProblem(70, { open: true, closedAs: null })],
    ["closed as not planned, though a merged pull request is linked to it", aTrialProblem(70, { closedAs: "not_planned" })],
    ["closed as a duplicate", aTrialProblem(70, { closedAs: "duplicate" })],
    ["closed with no reason given", aTrialProblem(70, { closedAs: null })],
  ])("stays a problem with a Trial problem %s, even with an accepted pull request linked as closing it", (_how, problem) => {
    const linked = merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T15:00:00Z")], [70]);
    expect(found([problem], linked)).toMatchObject({ is: "problem", at: "2026-11-08T10:00:00Z" });
  });

  it("stays a problem with a Trial problem closed with no pull request, and with no Trial problem at all, however many accepted pull requests there are", () => {
    const other = merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T15:00:00Z")], [99]);
    expect(found([aTrialProblem(70)], other)).toMatchObject({ is: "problem", problems: [{ issue: 70, open: false }] });
    expect(found([], other)).toEqual({ is: "problem", at: "2026-11-08T10:00:00Z", problems: [] });
  });

  it("is accepted by the Operator's later fabrik:trial-accepted, whatever became of its Trial problems, and not through a fix", () => {
    const events = [PROBLEM, added(TRIAL_ACCEPTED_LABEL, "2026-11-10T09:00:00Z")];
    for (const problem of [aTrialProblem(70, { open: true, closedAs: null }), aTrialProblem(70, { closedAs: "not_planned" }), aTrialProblem(70)]) {
      expect(trialResultOf(50, facts([merged(50, events)], [problem]), OPERATOR)).toMatchObject({ is: "accepted", at: "2026-11-10T09:00:00Z", fix: null });
    }
  });

  it("needs every Trial problem closed and every merged pull request that closed one accepted, and dates the acceptance from the last of them", () => {
    const problems = [aTrialProblem(70), aTrialProblem(71)];
    const first = merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T15:00:00Z")], [70]);
    const second = merged(62, [added(TRIAL_ACCEPTED_LABEL, "2026-11-09T18:00:00Z")], [70, 71]);
    expect(found(problems, first, second)).toEqual({ is: "accepted", at: "2026-11-09T18:00:00Z", problems: [{ issue: 70, open: false }, { issue: 71, open: false }], fix: [61, 62] });
    expect(found(problems, first, merged(62, [], [70, 71]))).toMatchObject({ is: "problem" });
    expect(found(problems, first)).toMatchObject({ is: "problem" });
    expect(found([aTrialProblem(70), aTrialProblem(71, { open: true, closedAs: null })], first)).toMatchObject({ is: "problem" });
  });

  it("accepts through a fix that was itself accepted through its own fix, by the same rule, since the last acceptance", () => {
    const fix = merged(61, [added(TRIAL_PROBLEM_LABEL, "2026-11-09T15:00:00Z")], [70]);
    const itsProblem = aTrialProblem(80, { pullRequest: 61 });
    const itsFix = merged(65, [added(TRIAL_ACCEPTED_LABEL, "2026-11-10T12:00:00Z")], [80]);
    expect(found([aTrialProblem(70), itsProblem], fix, itsFix)).toEqual({ is: "accepted", at: "2026-11-10T12:00:00Z", problems: [{ issue: 70, open: false }], fix: [61] });
    expect(found([aTrialProblem(70), itsProblem], fix, merged(65, [], [80]))).toMatchObject({ is: "problem" });
  });

  it("never dates an acceptance through a fix before the Operator found the problem", () => {
    const early = merged(61, [added(TRIAL_ACCEPTED_LABEL, "2026-11-07T09:00:00Z")], [70]);
    expect(found([aTrialProblem(70)], early)).toMatchObject({ is: "accepted", at: "2026-11-08T10:00:00Z", fix: [61] });
  });

  it("stays a problem, and ends, when GitHub's links go round: a pull request is no fix of its own Trial problem, nor of its fix's", () => {
    expect(trialResultOf(50, facts([merged(50, [PROBLEM], [70])], [aTrialProblem(70)]), OPERATOR)).toMatchObject({ is: "problem" });
    const round = facts(
      [merged(50, [PROBLEM], [80]), merged(61, [added(TRIAL_PROBLEM_LABEL, "2026-11-09T15:00:00Z")], [70])],
      [aTrialProblem(70), aTrialProblem(80, { pullRequest: 61 })],
    );
    expect(trialResultOf(50, round, OPERATOR)).toMatchObject({ is: "problem" });
    expect(trialResultOf(61, round, OPERATOR)).toMatchObject({ is: "problem" });
  });
});

describe("a pull request that closes a Trial problem (#856)", () => {
  it("is one GitHub records as closing an issue that carries the line, whichever pull request the line names; and no other", () => {
    const held = facts([merged(61, [], [70]), merged(62, [], [7]), merged(63)], [aTrialProblem(70, { pullRequest: 12 })]);
    expect(closesATrialProblem(61, held)).toBe(true);
    expect(closesATrialProblem(62, held)).toBe(false);
    expect(closesATrialProblem(63, held)).toBe(false);
    expect(closesATrialProblem(99, held)).toBe(false);
  });
});
