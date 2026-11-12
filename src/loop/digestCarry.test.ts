import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, notificationsOf, snapshotOfPullRequest, verdictsPostedIn } from "../__fixtures__/snapshots.ts";
import type { ChangeFingerprint } from "./changeFingerprint.ts";
import { agentRunIn } from "../github/apply.ts";
import { digestCommentOf, noDigestLine } from "./digestContract.ts";
import type { DigestAsk } from "./digestFacts.ts";
import { planFor } from "./rules.ts";
import type { Action, DigestOnThread, KitIssueSnapshot, LoopEvent, Plan, PullRequestSnapshot } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const REPO = "https://github.com/acme/shop";
/** The head the last Digest was written at, before the pull request was rebased onto `main` to HEAD_SHA. */
const WRITTEN_AT = "b".repeat(40);

/** The pull request's own change, as a Verdict records it: the same on both heads when only `main` moved. */
function aChange(all = "1".repeat(12)): ChangeFingerprint {
  return { v: 1, all, product: "2".repeat(12), files: null };
}

/** An ask of the Operator's, as Kit code lists one: a Request changes, by its id. */
function anAsk(id: string): DigestAsk {
  return { id, what: "request-changes", url: `${REPO}/pull/50#pullrequestreview-${id.replace("review-", "")}` };
}

/** A Digest's comment, written as of `head`, having answered `asks`. */
function aDigestBody(head: string = WRITTEN_AT, asks: readonly string[] = []): string {
  const reply = aDigestReply({ asks: asks.map((id) => ({ id, answer: "in-head", where: "src/basket/save.ts", checkedBy: "reading" })) });
  const rendered = digestCommentOf(reply, aDigestGiven({ repoUrl: REPO, headSha: head, runUrl: RUN, facts: aDigestFacts({ asks: asks.map(anAsk) }) }));
  if (!rendered.ok) throw new Error(rendered.refused);
  return rendered.body;
}

function onThread(body: string, overrides: Partial<DigestOnThread> = {}): DigestOnThread {
  return { node: "IC_last", minimized: false, body, postedAt: "2026-11-10T09:00:00Z", ...overrides };
}

/**
 * #50, a draft rebased onto `main` since its last Digest: that Digest was
 * written at WRITTEN_AT, where the Reviewer's pass recorded the pull
 * request's own change, and the push job has read the same change at its
 * head now, with the Kit's list of asks as that Digest answered it.
 */
function rebased(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return aPullRequest({
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT, change: aChange() }],
    digests: [onThread(aDigestBody())],
    change: aChange(),
    asks: [],
    ...overrides,
  });
}

/** The Reviewer passes #50 at its head. */
const PASSED: LoopEvent = { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: "verdict: pass\n\nLooks good.", runUrl: RUN, repoUrl: REPO };

function passOn(pullRequest: PullRequestSnapshot, config = kitConfig()): Plan {
  return planFor(PASSED, snapshotOfPullRequest(pullRequest, { operator: "jrey" }), config);
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** What a pass does after its Verdict. */
function afterTheVerdict(plan: Plan): Action[] {
  return actionsOf(plan).filter((action) => action.kind !== "comment");
}

describe("The Digest carried forward: a pass on a head where only main moved", () => {
  it("carries the last Digest to the new head and opens the Merge gate in the same step, adding no label", () => {
    const pullRequest = rebased();
    const plan = passOn(pullRequest);

    expect(verdictsPostedIn(actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : [])))).toMatchObject([{ verdict: "pass", headSha: HEAD_SHA }]);
    expect(afterTheVerdict(plan)).toEqual([
      {
        kind: "carry-digest",
        pullRequest: 50,
        headSha: HEAD_SHA,
        repoUrl: REPO,
        digest: pullRequest.digests[0]!.body,
        carried: [
          { kind: "minimize-comment", pullRequest: 50, node: "IC_last", classifier: "OUTDATED" },
          { kind: "mark-ready-for-review", pullRequest: 50 },
          { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
        ],
        otherwise: [{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }],
      },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  /** A pass with no Digest to carry: the label that starts the Digest writer, and nothing else. */
  const STARTS_THE_WRITER: Action[] = [{ kind: "add-labels", issue: 50, labels: ["agent:digest"] }];

  it.each<[string, Partial<PullRequestSnapshot>]>([
    ["a changed line in the pull request's own change", { change: aChange("9".repeat(12)) }],
    ["a new Request changes since the last Digest", { asks: ["review-9"] }],
    ["a Request changes that Digest answered, dismissed since", { digests: [onThread(aDigestBody(WRITTEN_AT, ["review-8"]))], asks: [] }],
    ["a pass with no fingerprint", { change: undefined }],
    ["a list of asks that was not read", { asks: undefined }],
    ["a last Digest that does not read back, having no data line", { digests: [onThread(aDigestBody().split("\n").toSpliced(1, 1).join("\n"))] }],
    ["a Verdict on the last Digest's head that recorded no fingerprint", { verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: WRITTEN_AT }] }],
    ["no Verdict on the head the last Digest names", { digests: [onThread(aDigestBody("c".repeat(40)))] }],
    ["no Digest on the thread", { digests: [] }],
  ])("%s carries nothing, and the pass adds agent:digest", (_what, overrides) => {
    expect(afterTheVerdict(passOn(rebased(overrides)))).toEqual(STARTS_THE_WRITER);
  });

  it("the same asks carry, by the ids the last Digest's first line names, in Kit code's order", () => {
    const answered = ["review-8", "inline-21"];
    const carries = (asks: readonly string[]): boolean => afterTheVerdict(passOn(rebased({ digests: [onThread(aDigestBody(WRITTEN_AT, answered))], asks }))).some(({ kind }) => kind === "carry-digest");

    expect(carries(answered)).toBe(true);
    expect(carries(["review-8"])).toBe(false);
    expect(carries(["review-8", "inline-21", "review-30"])).toBe(false);
  });

  it("weighs only the newest Digest, whatever head it names: an older one that would carry is not reached past it", () => {
    const newest = onThread(aDigestBody("c".repeat(40)), { node: "IC_newest", postedAt: "2026-11-11T09:00:00Z" });

    expect(afterTheVerdict(passOn(rebased({ digests: [onThread(aDigestBody()), newest] })))).toEqual(STARTS_THE_WRITER);
  });

  it("comes before the held check: with every Subscription used up it still carries, and only with the files unread does the no-Digest line open the gate", () => {
    const rotating = kitConfig({ subscriptions: ["Claude token", "Claude token 2"] });
    const usedUp = (number: number, subscription: string): KitIssueSnapshot => ({
      number,
      labels: ["fabrik:weekly-limit"],
      body: [`The weekly usage limit of the \`${subscription}\` Subscription is reached.`, "", `<!-- fabrik:subscription ${subscription} -->`, "<!-- fabrik:resets-at 2026-11-16T04:00:00.000Z -->"].join("\n"),
      comments: [],
    });
    const plan = planFor(PASSED, snapshotOfPullRequest(rebased(), { operator: "jrey", kitIssues: [usedUp(40, "Claude token"), usedUp(41, "Claude token 2")] }), rotating);

    expect(afterTheVerdict(plan)).toMatchObject([
      {
        kind: "carry-digest",
        otherwise: [
          { kind: "comment", issue: 50, body: noDigestLine({ head: HEAD_SHA, how: "no-subscription" }) },
          { kind: "mark-ready-for-review", pullRequest: 50 },
          { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
        ],
      },
    ]);
  });

  it("starts no run and adds no label, so no Run record is written for a carried Digest", () => {
    const [carry] = afterTheVerdict(passOn(rebased()));
    if (carry?.kind !== "carry-digest") throw new Error("expected the pass to carry the Digest");
    const lands = [...actionsOf(passOn(rebased())), ...carry.carried];

    // A Run record is written only for an agent job's run, which only a trigger label or a started run brings.
    expect(lands.filter(({ kind }) => kind === "start-agent-run" || kind === "hold-agent-run" || kind === "add-labels")).toEqual([]);
    expect(agentRunIn(passOn(rebased()))).toBeNull();
  });

  it("with the Digest off in Kit config, nothing is carried and the gate opens as it always has", () => {
    expect(afterTheVerdict(passOn(rebased(), kitConfig({ digest: { enabled: false } })))).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
  });
});
