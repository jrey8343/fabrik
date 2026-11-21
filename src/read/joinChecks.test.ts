import { describe, expect, it } from "vitest";
import { workKeyOf } from "../kit/standing.ts";
import { handBackMarker } from "../loop/markers.ts";
import type { CommentFacts } from "../kit/weeklySummary.ts";
import { aCheckIssue, aComment, aGateRerunAsk, aGateRerunDone, aLabelAdded, anOpenIssue, anOpenPullRequest, anOperatorMention, aPassNaming, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
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

  describe("an agent row at the Merge gate held by an Unrelated failure settles with the checks it keeps as healing (#795)", () => {
    const PASSED_AT = "2026-11-12T08:00:00Z";
    /** Head 1's checks: `test` failed before the pass, `lint` passed. */
    const TEST_FAILED = aChecksRead({ [head("1")]: [check("test", "failing", "2026-11-12T07:50:00Z"), check("lint", "passed", "2026-11-12T07:40:00Z")] });
    /** A little later: `test` is running again. */
    const TEST_RUNNING = aChecksRead({ [head("1")]: [check("test", "running", "2026-11-12T09:05:00Z"), check("lint", "passed", "2026-11-12T07:40:00Z")] });
    /** Later still: `test` failed again. */
    const TEST_FAILED_AGAIN = aChecksRead({ [head("1")]: [check("test", "failing", "2026-11-12T09:20:00Z"), check("lint", "passed", "2026-11-12T07:40:00Z")] });
    /** Or: `test` passed, and everything with it. */
    const TEST_PASSED = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:20:00Z"), check("lint", "passed", "2026-11-12T07:40:00Z")] });
    /** Or: both failed. */
    const BOTH_FAILED = aChecksRead({ [head("1")]: [check("test", "failing", "2026-11-12T09:20:00Z"), check("lint", "failing", "2026-11-12T09:25:00Z")] });

    /** Agent PR 50 at the Merge gate on head 1, whose pass names these checks Unrelated failures, with these later comments of the Fabrik App's. */
    const heldFacts = (unrelated: readonly string[] = ["test"], comments: readonly CommentFacts[] = [], github: Parameters<typeof factsOf>[0] = {}) =>
      homeFactsOf({
        github: factsOf({
          openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
          openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: head("1"), comments: [aPassNaming(unrelated, head("1"), PASSED_AT), ...comments] })],
          ...github,
        }),
      });
    const whose = (rows: readonly Row[]) => rows.map(({ standing: { name, move, yours, stopsWork, since, stuckAt } }) => ({ name, move, yours, stopsWork, since, stuckAt }));
    /** 210 minutes after the pass: the bar on default timeouts. */
    const BAR = "2026-11-12T11:30:00.000Z";

    it("yours to merge, comes back the Kit's when the healing check fails, turning Stuck when the row kept that it would", () => {
      const { kept, joined, rule } = joinedAndRule(heldFacts(), TEST_PASSED, TEST_FAILED_AGAIN);

      expect(whose(kept)).toEqual([{ name: "yours-to-merge", move: "operator", yours: true, stopsWork: true, since: PASSED_AT, stuckAt: null }]);
      expect(whose(joined)).toEqual([{ name: "check-healing", move: "kit", yours: false, stopsWork: false, since: "2026-11-12T09:20:00Z", stuckAt: BAR }]);
      expect(joined).toEqual(rule);
    });

    it("kept with no checks read, comes back as the rule gives it with the read", () => {
      const { joined, rule } = joinedAndRule(heldFacts(), null, TEST_FAILED);

      expect(joined.map(({ standing }) => standing.name)).toEqual(["check-healing"]);
      expect(joined).toEqual(rule);
    });

    it("the Kit's, goes waiting on the check once it runs again, and back to the Kit's, not the Operator's, when it fails again", () => {
      const facts = heldFacts(["test"], [aGateRerunAsk(["test"], head("1"), "2026-11-12T09:00:00Z")]);
      const kept = rowsOf(facts, null, TEST_FAILED, null, NOW);
      const running = joinChecks(kept, TEST_RUNNING, NOW);
      const failedAgain = joinChecks(running, TEST_FAILED_AGAIN, NOW);

      expect(kept.map(({ standing }) => standing.name)).toEqual(["check-healing"]);
      expect(running.map(({ standing }) => standing.name)).toEqual(["waiting-on-checks"]);
      expect(running).toEqual(rowsOf(facts, null, TEST_RUNNING, null, NOW));
      expect(failedAgain[0]?.standing).toMatchObject({ name: "check-healing", move: "kit", yours: false, stopsWork: false, since: "2026-11-12T09:20:00Z", detail: { check: "test", rerun: "asked" } });
      expect(failedAgain).toEqual(rowsOf(facts, null, TEST_FAILED_AGAIN, null, NOW));
    });

    it("the Kit's, comes back yours to merge once the check passes, since the pass", () => {
      const { joined, rule } = joinedAndRule(heldFacts(), TEST_FAILED, TEST_PASSED);

      expect(whose(joined)).toEqual([{ name: "yours-to-merge", move: "operator", yours: true, stopsWork: true, since: PASSED_AT, stuckAt: null }]);
      expect(joined).toEqual(rule);
    });

    it("the Kit's, comes back the Operator's when a check the pass did not name fails too, and the Kit's again once that one passes", () => {
      const failing = joinedAndRule(heldFacts(), TEST_FAILED, BOTH_FAILED);
      expect(failing.joined[0]?.standing).toMatchObject({ name: "check-failing", move: "operator", yours: true, stopsWork: true, stuckAt: null, detail: { check: "lint" } });
      expect(failing.joined).toEqual(failing.rule);

      const passing = joinedAndRule(heldFacts(), BOTH_FAILED, TEST_FAILED_AGAIN);
      expect(passing.joined[0]?.standing).toMatchObject({ name: "check-healing", stuckAt: BAR, detail: { check: "test" } });
      expect(passing.joined).toEqual(passing.rule);
    });

    it("names the next healing check, with its own re-run, issue and bar, when the first passes", () => {
      const facts = heldFacts(["test", "lint"], [aGateRerunDone(["lint"], head("1"), "2026-11-12T09:00:00Z")], {
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] }), aCheckIssue("lint", { number: 92, labels: ["ready-for-agent", "fabrik:flaky-check"] })],
      });
      const lintOnly = aChecksRead({ [head("1")]: [check("test", "passed", "2026-11-12T09:30:00Z"), check("lint", "failing", "2026-11-12T09:25:00Z")] });

      const { kept, joined, rule } = joinedAndRule(facts, BOTH_FAILED, lintOnly);
      const standingOf = (rows: readonly Row[]) => rows.find(({ standing }) => standing.pullRequest === 50)?.standing;

      expect(standingOf(kept)).toMatchObject({ name: "check-healing", stuckAt: "2026-11-12T12:30:00.000Z", detail: { check: "test", rerun: "to-come", issue: null } });
      expect(standingOf(joined)).toMatchObject({ name: "check-healing", stuckAt: null, detail: { check: "lint", rerun: "done", issue: 92 } });
      expect(byWork(joined)).toEqual(byWork(rule));
    });

    it("waiting on a check the Kit mentioned the Operator over, comes back the Operator's when it fails, still saying it was mentioned", () => {
      const facts = heldFacts(["test"], [anOperatorMention([{ name: "test", issue: 91 }], head("1"), "2026-11-12T09:00:00Z")]);

      const { joined, rule } = joinedAndRule(facts, TEST_RUNNING, TEST_FAILED_AGAIN);

      expect(joined[0]?.standing).toMatchObject({ name: "check-failing", move: "operator", yours: true, stopsWork: true, detail: { check: "test", mentioned: ["test"] } });
      expect(joined).toEqual(rule);
    });

    describe("read past its bar", () => {
      const PAST = "2026-11-12T11:31:00Z";
      const at = (earlier: RequiredChecksRead, later: RequiredChecksRead) => {
        const kept = rowsOf(heldFacts(), null, earlier, null, PAST);
        return { kept, joined: joinChecks(kept, later, PAST), rule: rowsOf(heldFacts(), null, later, null, PAST) };
      };

      it("Stuck, stays Stuck while the check still fails, and comes back yours to merge once it passes", () => {
        const still = at(TEST_FAILED, TEST_FAILED_AGAIN);
        expect(still.kept[0]?.standing).toMatchObject({ name: "stuck", move: "kit", yours: true, stopsWork: true, detail: { was: "check-healing", check: "test" } });
        expect(still.joined[0]?.standing).toMatchObject({ name: "stuck", since: "2026-11-12T09:20:00Z", stuckAt: BAR, detail: { was: "check-healing" } });
        expect(still.joined).toEqual(still.rule);

        const passed = at(TEST_FAILED, TEST_PASSED);
        expect(whose(passed.joined)).toEqual([{ name: "yours-to-merge", move: "operator", yours: true, stopsWork: true, since: PASSED_AT, stuckAt: null }]);
        expect(passed.joined).toEqual(passed.rule);
      });

      it("yours to merge, comes back Stuck when the healing check fails past the bar the row kept", () => {
        const { joined, rule } = at(TEST_PASSED, TEST_FAILED_AGAIN);

        expect(joined[0]?.standing).toMatchObject({ name: "stuck", yours: true, stopsWork: true, stuckAt: BAR, detail: { was: "check-healing" } });
        expect(joined).toEqual(rule);
      });
    });

    it("kept before #795 with no healing checks, settles as it did: the failing check is the Operator's", () => {
      const kept = rowsOf(heldFacts(), null, TEST_PASSED, null, NOW);
      const { healing: _, ...detail } = kept[0]?.standing.detail as { healing?: unknown };
      const older = kept.map((row) => ({ ...row, standing: { ...row.standing, detail } }) as Row);

      const joined = joinChecks(older, TEST_FAILED_AGAIN, NOW);

      expect(whose(joined)).toEqual([{ name: "check-failing", move: "operator", yours: true, stopsWork: true, since: "2026-11-12T09:20:00Z", stuckAt: null }]);
      expect(joined[0]?.standing.detail).toEqual({ plain: null, check: "test", checkIs: "failing", passedAt: PASSED_AT, passedHead: head("1"), head: head("1") });
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

  describe("a Pairing session's pull request beside a Ticket whose agent PR is not handed to the Operator stands by itself, and settles so (#851)", () => {
    const agentHead = head("1");
    const pairHead = head("2");
    const factsWith = (ticket: Parameters<typeof anOpenIssue>[0], agentPullRequest: Parameters<typeof anOpenPullRequest>[0]) =>
      homeFactsOf({
        github: factsOf({
          openIssues: [anOpenIssue({ number: 8, ...ticket })],
          openPullRequests: [anOpenPullRequest({ number: 50, ticket: 8, draft: false, headSha: agentHead, ...agentPullRequest })],
          plainPullRequests: [aPlainPullRequest({ number: 74, author: "operator", headRef: "fabrik/pair-8", closes: [8], headSha: pairHead })],
        }),
      });
    const atGate = factsWith({ labels: ["ready-for-agent"] }, { comments: [aVerdictComment("pass", agentHead, "2026-11-11T20:00:00Z")] });
    const handedOver = factsWith({ labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-11T09:00:00Z")] }, { draft: true });
    const handBack = aComment(["@operator The Review run on #50 failed: it crashed.", handBackMarker({ kind: "infrastructure-failure", role: "review", failure: "crash" })].join("\n"), "2026-11-11T09:00:00Z");
    const handedBack = factsWith({ labels: ["ready-for-agent"] }, { comments: [handBack] });
    const passed = [check("test", "passed", "2026-11-12T09:00:00Z"), check("lint", "passed", "2026-11-12T09:40:00Z")];
    const running = [check("test", "running", "2026-11-12T09:41:00Z"), check("lint", "passed", "2026-11-12T09:40:00Z")];
    const failing = [check("test", "failing", "2026-11-12T09:42:00Z"), check("lint", "passed", "2026-11-12T09:40:00Z")];
    const reads = { passed, running, failing };
    const readOf = (agent: keyof typeof reads, pairing: keyof typeof reads) => aChecksRead({ [agentHead]: reads[agent], [pairHead]: reads[pairing] });
    const named = (rows: readonly Row[]) =>
      byWork(rows).map(({ standing }) => [standing.issue, standing.pullRequest, standing.work, standing.name, standing.detail.head, "check" in standing.detail ? standing.detail.check : null]);

    it.each([
      ["passed", "running", [[8, 50, "ticket", "yours-to-merge", agentHead, null], [8, 74, "plain", "waiting-on-checks", pairHead, "test"]]],
      ["passed", "failing", [[8, 50, "ticket", "yours-to-merge", agentHead, null], [8, 74, "plain", "check-failing", pairHead, "test"]]],
      ["failing", "running", [[8, 50, "ticket", "check-failing", agentHead, "test"], [8, 74, "plain", "waiting-on-checks", pairHead, "test"]]],
    ] as const)("the agent head %s and the Pairing head %s, kept from any read, settle as the rule gives them", (agent, pairing, rows) => {
      for (const earlier of [null, readOf("passed", "passed"), readOf("failing", "failing"), readOf("running", "running")]) {
        const { joined, rule } = joinedAndRule(atGate, earlier, readOf(agent, pairing));

        expect(named(rule)).toEqual(rows);
        expect(byWork(joined)).toEqual(byWork(rule));
      }
    });

    it.each([
      ["a `ready-for-human` issue", handedOver],
      ["a hand-back on its agent PR", handedBack],
    ])("joins the row of %s, carrying the Pairing session's number, and settles it as the rule does (#611)", (_what, facts) => {
      for (const [earlier, later] of [
        [null, readOf("passed", "running")],
        [readOf("passed", "running"), readOf("passed", "passed")],
        [readOf("passed", "passed"), readOf("passed", "failing")],
      ] as const) {
        const { joined, rule } = joinedAndRule(facts, earlier, later);

        expect(rule.map(({ standing }) => [standing.issue, standing.pullRequest])).toEqual([[8, 74]]);
        expect(joined).toEqual(rule);
      }
      expect(rowsOf(facts, null, readOf("passed", "running"), null, NOW).map(({ standing }) => [standing.name, standing.detail.pullRequest])).toEqual([["yours-to-do", "waiting-on-checks"]]);
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
