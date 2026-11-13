import { describe, expect, it } from "vitest";
import { workKeyOf } from "../kit/standing.ts";
import { aLabelAdded, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { Facts } from "./gather.ts";
import { joinChecks } from "./joinChecks.ts";
import type { HeadCheck, RequiredChecksRead } from "./requiredChecks.ts";
import { type Row, rowsOf } from "./rows.ts";

const NOW = "2026-11-12T10:00:00Z";
const head = (digit: string) => digit.repeat(40);

/** A checks read of `owner/product`'s `main`, requiring `test` and `lint`, with these heads. */
function aChecksRead(heads: RequiredChecksRead["heads"], readAt = NOW): RequiredChecksRead {
  return { repo: "owner/product", branch: "main", readAt, required: ["test", "lint"], holdsAdmins: "yes", heads };
}

/** A Required check on a head, reported at `at` (never reported when null). */
const check = (name: string, is: HeadCheck["is"], at: string | null): HeadCheck => ({ name, is, url: at === null ? null : `https://github.com/owner/product/runs/${name}`, at });

/** Head 1's checks: `test` passed, `lint` still running. */
const EARLIER = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "running", "2026-11-12T09:01:00Z")] }, "2026-11-12T09:30:00Z");
/** Head 1's checks a little later: both passed, `lint` last. */
const ALL_PASSED = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "passed", "2026-11-12T09:40:00Z")] });
/** Head 1's checks a little later: `lint` failed. */
const LINT_FAILED = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "failing", "2026-11-12T09:42:00Z")] });

/** The rows in a fixed order, so the join and the rule are compared row for row. */
const byWork = (rows: readonly Row[]) => rows.toSorted((a, b) => `${workKeyOf(a.standing)} ${a.standing.pullRequest}`.localeCompare(`${workKeyOf(b.standing)} ${b.standing.pullRequest}`));

/** The kept rows of `facts` with the earlier read, joined with the later one; and the rows the rule gives with the later read. */
function joinedAndRule(facts: Facts, earlier: RequiredChecksRead | null, later: RequiredChecksRead) {
  const kept = rowsOf(facts, null, earlier, null, NOW);
  return { kept, joined: joinChecks(kept, later, NOW), rule: rowsOf(facts, null, later, null, NOW) };
}

/** The one row of Plain pull request 70, with head 1. */
const plainFacts = (overrides: Parameters<typeof aPlainPullRequest>[0] = {}) =>
  homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest({ number: 70, headSha: head("1"), ...overrides })] }) });

describe("the join of kept rows with a Required checks read", () => {
  describe("a Plain row neither a draft nor in conflict takes the name the rule gives for the fresh checks on its head", () => {
    it("waiting on checks, comes back yours to merge once every Required check has passed, since the last passed", () => {
      const { kept, joined, rule } = joinedAndRule(plainFacts(), EARLIER, ALL_PASSED);

      expect(kept.map(({ standing }) => standing.name)).toEqual(["waiting-on-checks"]);
      expect(joined.map(({ standing }) => standing)).toMatchObject([
        { pullRequest: 70, name: "yours-to-merge", move: "operator", yours: true, stopsWork: false, since: "2026-11-12T09:40:00Z", detail: { plain: "kit-bump", head: head("1") } },
      ]);
      expect(joined).toEqual(rule);
    });

    it("waiting on checks, comes back named for the failing check, since it failed", () => {
      const { joined, rule } = joinedAndRule(plainFacts(), EARLIER, LINT_FAILED);

      expect(joined.map(({ standing }) => standing)).toMatchObject([
        { pullRequest: 70, name: "check-failing", move: "operator", yours: true, since: "2026-11-12T09:42:00Z", detail: { plain: "kit-bump", check: "lint", checkIs: "failing", head: head("1") } },
      ]);
      expect(joined).toEqual(rule);
    });

    it("named for a check never reported, which no report decides, since the pull request's own time, as the rule gives it", () => {
      const unreported = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "never-reported", null)] });

      const { kept, joined, rule } = joinedAndRule(plainFacts({ headCommittedAt: "2026-11-11T15:00:00Z" }), EARLIER, unreported);

      expect(kept.map(({ standing }) => standing.since)).toEqual(["2026-11-12T09:01:00Z"]);
      expect(joined.map(({ standing }) => standing)).toMatchObject([{ name: "check-failing", since: "2026-11-11T15:00:00Z", detail: { check: "lint", checkIs: "never-reported" } }]);
      expect(joined).toEqual(rule);
    });

    it("check failing, comes back yours to merge on a branch now requiring nothing, since the pull request's own time, as the rule gives it", () => {
      const { joined, rule } = joinedAndRule(plainFacts({ headCommittedAt: "2026-11-11T15:00:00Z" }), LINT_FAILED, { ...aChecksRead({ [head("1")]: [] }), required: [] });

      expect(joined.map(({ standing }) => [standing.name, standing.since])).toEqual([["yours-to-merge", "2026-11-11T15:00:00Z"]]);
      expect(joined).toEqual(rule);
    });

    it("kept with no checks read, comes back as the rule gives it with the read", () => {
      const { joined, rule } = joinedAndRule(plainFacts(), null, ALL_PASSED);

      expect(joined).toEqual(rule);
    });
  });

  it("leaves a draft and a conflicting Plain row as they were", () => {
    for (const overrides of [{ draft: true }, { mergeable: false }]) {
      const { kept, joined, rule } = joinedAndRule(plainFacts(overrides), EARLIER, LINT_FAILED);

      expect(joined).toEqual(kept);
      expect(joined).toEqual(rule);
    }
  });

  describe("an agent row at the Merge gate takes the name the rule gives for the fresh checks on its head (#564)", () => {
    const PASSED_AT = "2026-11-11T20:00:00Z";
    const agentFacts = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
      homeFactsOf({
        github: factsOf({
          openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
          openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: head("1"), comments: [aVerdictComment("pass", head("1"), PASSED_AT)], ...overrides })],
        }),
      });
    const named = (rows: readonly Row[]) => rows.map(({ standing }) => [standing.pullRequest, standing.place, standing.name, standing.stopsWork, standing.since]);

    it("yours to merge, comes back named for the failing check, stopping work, since it failed", () => {
      const { kept, joined, rule } = joinedAndRule(agentFacts(), ALL_PASSED, LINT_FAILED);

      expect(named(kept)).toEqual([[50, "merge-gate", "yours-to-merge", true, PASSED_AT]]);
      expect(named(joined)).toEqual([[50, "merge-gate", "check-failing", true, "2026-11-12T09:42:00Z"]]);
      expect(joined[0]?.standing.detail).toEqual({ plain: null, check: "lint", checkIs: "failing", passedAt: PASSED_AT, passedHead: head("1"), head: head("1") });
      expect(joined).toEqual(rule);
    });

    it("check failing, comes back yours to merge once every check has passed again, since the pass, not the re-run", () => {
      const { kept, joined, rule } = joinedAndRule(agentFacts(), LINT_FAILED, ALL_PASSED);

      expect(named(kept)).toEqual([[50, "merge-gate", "check-failing", true, "2026-11-12T09:42:00Z"]]);
      expect(named(joined)).toEqual([[50, "merge-gate", "yours-to-merge", true, PASSED_AT]]);
      expect(joined[0]?.standing.detail).toEqual({ plain: null, passedHead: head("1"), head: head("1") });
      expect(joined).toEqual(rule);
    });

    describe("with its head moved since the pass (#692)", () => {
      const moved = () => agentFacts({ comments: [aVerdictComment("pass", head("9"), PASSED_AT)] });

      it("yours to merge, comes back named for the failing check on its own head, and back again once it passes, keeping the head it passed", () => {
        const failing = joinedAndRule(moved(), ALL_PASSED, LINT_FAILED);
        expect(named(failing.kept)).toEqual([[50, "merge-gate", "yours-to-merge", true, PASSED_AT]]);
        expect(failing.joined[0]?.standing.detail).toEqual({ plain: null, check: "lint", checkIs: "failing", passedAt: PASSED_AT, passedHead: head("9"), head: head("1") });
        expect(failing.joined).toEqual(failing.rule);

        const passing = joinedAndRule(moved(), LINT_FAILED, ALL_PASSED);
        expect(passing.joined[0]?.standing.detail).toEqual({ plain: null, passedHead: head("9"), head: head("1") });
        expect(passing.joined).toEqual(passing.rule);
      });
    });

    it("kept before #692 with no head it passed, takes its own head as the one passed, as the rule then read it", () => {
      const { kept, rule } = joinedAndRule(agentFacts(), ALL_PASSED, LINT_FAILED);
      const { passedHead: _, ...detail } = kept[0]?.standing.detail as { passedHead?: string };
      const older = kept.map((row) => ({ ...row, standing: { ...row.standing, detail } }) as Row);

      expect(joinChecks(older, LINT_FAILED, NOW)).toEqual(rule);
    });

    it("check failing, comes back waiting on a re-run check, the Kit's and stopping nothing, since the pass", () => {
      const rerunning = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "running", "2026-11-12T09:50:00Z")] });

      const { joined, rule } = joinedAndRule(agentFacts(), LINT_FAILED, rerunning);

      expect(named(joined)).toEqual([[50, "merge-gate", "waiting-on-checks", false, PASSED_AT]]);
      expect(joined[0]?.standing).toMatchObject({ move: "kit", yours: false, awaits: null });
      expect(joined).toEqual(rule);
    });

    it("leaves an agent draft and one handed back at the Merge gate as they were", () => {
      const cases = [
        { facts: agentFacts({ draft: true }), place: "review" },
        { facts: agentFacts({ labelEvents: [aLabelAdded("ready-for-human", "2026-11-12T08:00:00Z")] }), place: "merge-gate", name: "yours-to-do" },
      ];
      for (const { facts, ...was } of cases) {
        const { kept, joined, rule } = joinedAndRule(facts, ALL_PASSED, LINT_FAILED);

        expect(kept[0]?.standing).toMatchObject(was);
        expect(joined).toEqual(kept);
        expect(joined).toEqual(rule);
      }
    });
  });

  it("leaves a row whose head the read does not hold, or holds as unread, as it was", () => {
    const kept = rowsOf(plainFacts(), null, EARLIER, null, NOW);

    expect(joinChecks(kept, aChecksRead({ [head("2")]: [] }), NOW)).toEqual(kept);
    expect(joinChecks(kept, aChecksRead({ [head("1")]: "unread" }), NOW)).toEqual(kept);
  });

  it("takes a head with an empty list, from a branch requiring nothing, as all passed", () => {
    const kept = rowsOf(plainFacts(), null, EARLIER, null, NOW);

    expect(joinChecks(kept, { ...aChecksRead({ [head("1")]: [] }), required: [] }, NOW).map(({ standing }) => standing.name)).toEqual(["yours-to-merge"]);
  });

  describe("a Pairing session's pull request joined to its issue's row is settled the same way inside that row", () => {
    const pairingFacts = homeFactsOf({
      github: factsOf({
        openIssues: [anOpenIssue({ number: 12, labels: ["needs-triage"], labelEvents: [aLabelAdded("needs-triage", "2026-11-11T09:00:00Z")] })],
        plainPullRequests: [aPlainPullRequest({ number: 80, author: "operator", headRef: "fabrik/pair-12", closes: [12], headSha: head("1") })],
      }),
    });

    it("keeps the issue's own Standing, carrying the pull request's new name", () => {
      const { kept, joined, rule } = joinedAndRule(pairingFacts, EARLIER, LINT_FAILED);

      expect(kept.map(({ standing }) => [standing.issue, standing.pullRequest, standing.detail.pullRequest])).toEqual([[12, 80, "waiting-on-checks"]]);
      expect(joined.map(({ standing }) => [standing.name, standing.detail.pullRequest])).toEqual([[kept[0]?.standing.name, "check-failing"]]);
      expect(joined).toEqual(rule);
    });

    it("takes yours to merge, with the mark off, once every Required check has passed", () => {
      const { joined, rule } = joinedAndRule(pairingFacts, EARLIER, ALL_PASSED);

      expect(joined.map(({ standing }) => standing)).toMatchObject([
        { issue: 12, pullRequest: 80, name: "yours-to-merge", move: "operator", stopsWork: false, since: "2026-11-12T09:40:00Z", detail: { plain: "pairing", pullRequest: "yours-to-merge", head: head("1") } },
      ]);
      expect(joined).toEqual(rule);
    });

    it("taken over as yours to merge, gives the row back to the issue's own Standing, carrying the pull request's new name, once a Required check fails", () => {
      const { kept, joined, rule } = joinedAndRule(pairingFacts, ALL_PASSED, LINT_FAILED);

      expect(kept.map(({ standing }) => [standing.name, standing.detail.pullRequest])).toEqual([["yours-to-merge", "yours-to-merge"]]);
      expect(joined.map(({ standing }) => [standing.issue, standing.pullRequest, standing.detail.pullRequest])).toEqual([[12, 80, "check-failing"]]);
      expect(joined.map(({ standing }) => standing.name)).not.toEqual(["yours-to-merge"]);
      expect(joined).toEqual(rule);
    });

    it("taken over as yours to merge, stays so since the last pass of a later read", () => {
      const passedAgain = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "passed", "2026-11-12T09:50:00Z")] });

      const { joined, rule } = joinedAndRule(pairingFacts, ALL_PASSED, passedAgain);

      expect(joined.map(({ standing }) => [standing.name, standing.since])).toEqual([["yours-to-merge", "2026-11-12T09:50:00Z"]]);
      expect(joined).toEqual(rule);
    });

    it("takes yours to merge on a branch requiring nothing, which no report decides, since the pull request's own time, as the rule gives it", () => {
      const { joined, rule } = joinedAndRule(pairingFacts, null, { ...aChecksRead({ [head("1")]: [] }), required: [] });

      expect(joined.map(({ standing }) => [standing.name, standing.since])).toEqual([["yours-to-merge", "2026-11-06T20:00:00Z"]]);
      expect(joined).toEqual(rule);
    });
  });

  it("agrees with the rule for a repo of every kind of row at once", () => {
    const facts = homeFactsOf({
      github: factsOf({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: head("2"), comments: [aVerdictComment("pass", head("2"), "2026-11-11T20:00:00Z")] })],
        plainPullRequests: [
          aPlainPullRequest({ number: 70, headSha: head("1") }),
          aPlainPullRequest({ number: 71, headSha: head("3"), draft: true }),
          aPlainPullRequest({ number: 72, headSha: head("4"), mergeable: false }),
        ],
      }),
    });
    const both = (read: RequiredChecksRead): RequiredChecksRead => ({ ...read, heads: { ...read.heads, [head("2")]: read.heads[head("1")] ?? "unread", [head("3")]: read.heads[head("1")] ?? "unread", [head("4")]: read.heads[head("1")] ?? "unread" } });

    for (const later of [ALL_PASSED, LINT_FAILED]) {
      const { joined, rule } = joinedAndRule(facts, both(EARLIER), both(later));

      expect(byWork(joined)).toEqual(byWork(rule));
    }
  });

  it("returns rows that come back equal after being written as JSON and read again", () => {
    const joined = joinChecks(rowsOf(plainFacts(), null, EARLIER, null, NOW), ALL_PASSED, NOW);

    expect(JSON.parse(JSON.stringify(joined))).toStrictEqual(joined);
  });
});
