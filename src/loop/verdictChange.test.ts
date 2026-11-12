// The change fingerprint on a Verdict comment (#643): each of a Verdict's four
// sources posts it as a hidden line under the marker, when the push job read one.
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import { type ChangeFingerprint, changeIn, changeLine, MAX_FILES } from "./changeFingerprint.ts";
import { GITHUB_COMMENT_LIMIT } from "./roundLine.ts";
import { planFor } from "./rules.ts";
import type { LoopEvent, Plan, PullRequestSnapshot, Snapshot, VerdictRecord } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa", "src/cart.test.ts": "bbbbbbbbbbbb" } };
const FLAW: VerdictRecord = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: HEAD_SHA };

const reviewed = (output: string): LoopEvent => ({
  kind: "review-run-finished",
  pullRequest: 50,
  headSha: HEAD_SHA,
  output,
  runUrl: RUN,
  repoUrl: "https://github.com/acme/shop",
});
const redChecks: LoopEvent = { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN };
/** A Retry on #50 that committed nothing, built on `headSha`. */
const changedNothing = (headSha = HEAD_SHA): LoopEvent => ({
  kind: "implement-run-finished",
  issue: 7,
  output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change.", fix: "Nothing." }),
  branch: "fabrik/ticket-7",
  base: "fabrik/ticket-7",
  changes: { net: [], commits: [] },
  fixes: { pullRequest: 50, headSha, runUrl: RUN },
  runUrl: RUN,
});
const brokenRun: LoopEvent = {
  kind: "agent-run-failed",
  role: "implement",
  issue: 7,
  runUrl: RUN,
  jobResult: "failure",
  secretsStep: "success",
  report: { failure: "left-branch", detail: "The agent left agent/7 for main" },
};

/** The push job's snapshot of a Retry: the Ticket and its PR, which has the Execution flaw the Retry is for. */
function retrySnapshot(pullRequest: Partial<PullRequestSnapshot>): Snapshot {
  return snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], openPullRequests: [50] }), {
    pullRequest: aPullRequest({ ticketLabels: ["ready-for-agent"], verdicts: [FLAW], ...pullRequest }),
  });
}

/** The one Verdict comment a plan posts. */
function verdictCommentOf(plan: Plan): string {
  const comments = (plan.kind === "act" ? plan.actions : []).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
  const verdicts = comments.filter((body) => verdictsPostedIn([body]).length === 1);
  if (verdicts.length !== 1) throw new Error(`expected one Verdict comment, got ${verdicts.length} in ${JSON.stringify(plan)}`);
  return verdicts[0]!;
}

const SOURCES: readonly (readonly [string, VerdictRecord["source"], LoopEvent, (pullRequest: Partial<PullRequestSnapshot>) => Snapshot])[] = [
  ["the Reviewer's", "reviewer", reviewed("verdict: pass"), (pullRequest) => snapshotOfPullRequest(aPullRequest(pullRequest))],
  ["one from red Required checks", "ci", redChecks, (pullRequest) => snapshotOfPullRequest(aPullRequest(pullRequest))],
  ["one from a Retry that changed nothing", "empty-diff", changedNothing(), retrySnapshot],
  ["one from a Broken run", "broken-run", brokenRun, retrySnapshot],
];

describe("A Verdict comment's change line", () => {
  it.each(SOURCES)("%s carries it directly under the marker, which reads as before", (_, source, event, snapshot) => {
    const body = verdictCommentOf(planFor(event, snapshot({ change: CHANGE }), kitConfig()));

    const [marker, second, third] = body.split("\n");
    expect(verdictsPostedIn([body])).toEqual([expect.objectContaining({ source, requestChanges: false, headSha: HEAD_SHA })]);
    expect(marker).not.toContain("fabrik:change");
    expect(marker).not.toContain(CHANGE.all);
    expect(second).toBe(changeLine(CHANGE));
    expect(third).toMatch(/^## Verdict: /);
    expect(changeIn(body)).toEqual(CHANGE);
  });

  it.each(SOURCES)("%s is the same comment but for that one line", (_, _source, event, snapshot) => {
    const without = verdictCommentOf(planFor(event, snapshot({}), kitConfig()));
    const withLine = verdictCommentOf(planFor(event, snapshot({ change: CHANGE }), kitConfig()));

    expect(without).not.toContain("fabrik:change");
    expect(without.split("\n")[1]).toMatch(/^## Verdict: /);
    expect(withLine.split("\n").filter((_line, at) => at !== 1)).toEqual(without.split("\n"));
  });

  it("changes nothing else the plan does", () => {
    const actionsBut = (plan: Plan) => (plan.kind === "act" ? plan.actions : []).map((action) => (action.kind === "comment" ? { ...action, body: "" } : action));

    for (const [, , event, snapshot] of SOURCES) {
      expect(actionsBut(planFor(event, snapshot({ change: CHANGE }), kitConfig()))).toEqual(actionsBut(planFor(event, snapshot({}), kitConfig())));
    }
  });

  it("is left out of a Verdict on a head the fingerprint was not read at", () => {
    const moved = retrySnapshot({ headSha: "b".repeat(40), verdicts: [{ ...FLAW, headSha: "b".repeat(40) }], change: CHANGE });

    const body = verdictCommentOf(planFor(changedNothing(HEAD_SHA), moved, kitConfig()));

    expect(verdictsPostedIn([body])).toEqual([expect.objectContaining({ source: "empty-diff", headSha: HEAD_SHA })]);
    expect(body).not.toContain("fabrik:change");
  });

  it("is left out of a comment it would take past GitHub's limit, so the Verdict is still posted", () => {
    const files = Object.fromEntries(Array.from({ length: MAX_FILES }, (_, at) => [`src/${"deep/".repeat(20)}file${at}.ts`, "aaaaaaaaaaaa"]));
    const long: ChangeFingerprint = { ...CHANGE, files };
    const findings = "The empty-cart case throws. ".repeat(2_000);
    const event = reviewed(`verdict: execution-flaw\n\n${findings}`);

    const withRoom = verdictCommentOf(planFor(reviewed("verdict: execution-flaw\n\nThe empty-cart case throws."), snapshotOfPullRequest(aPullRequest({ change: long })), kitConfig()));
    const body = verdictCommentOf(planFor(event, snapshotOfPullRequest(aPullRequest({ change: long })), kitConfig()));

    expect(changeIn(withRoom)).toEqual(long);
    expect(body.length + changeLine(long).length).toBeGreaterThan(GITHUB_COMMENT_LIMIT);
    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(body).not.toContain("fabrik:change");
    expect(body).toBe(verdictCommentOf(planFor(event, snapshotOfPullRequest(aPullRequest()), kitConfig())));
  });
});
