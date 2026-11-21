import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { aCheckIssue, aComment, aGateRerunAsk, aGateRerunDone, aLabelAdded, anOpenIssue, anOpenPullRequest, anOperatorMention, aPassNaming, aPlainPullRequest, aRunInFlight, aVerdictComment, factsOf, standingFactsOf } from "../read/builders.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingAt, standingsOf, type StandingFacts } from "./standing.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts, RequiredChecksFact } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);
const OLD_HEAD = "o".repeat(40);
const PASSED = "2026-11-08T18:00:00Z";
const FAILED = "2026-11-08T17:50:00Z";

/** A time `minutes` after `at`, as the rule writes one. */
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
/** 210 minutes: the bar on default timeouts. */
const BAR = 210;

/** `owner/product`'s Kit on default timeouts, with these Required checks on HEAD. */
function aKit(checks: RequiredChecksFact): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks: { [HEAD]: checks } };
}

/** A Required check failing since FAILED, before the pass, unless a test says when. */
const failing = (name: string, at = FAILED) => ({ name, is: "failing", at }) as const;
/** A Required check that passed before the pass. */
const passing = (name: string) => ({ name, is: "passed", at: "2026-11-08T17:40:00Z" }) as const;

/** Agent PR 50 for Ticket 7 at the Merge gate on HEAD, passed at PASSED by a Verdict naming `test` an Unrelated failure, with these later comments. */
const held = (comments: readonly CommentFacts[] = [], overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
  anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: HEAD, comments: [aPassNaming(["test"], HEAD, PASSED), ...comments], ...overrides });

/** The Standings of `owner/product` with these GitHub facts and these Required checks on HEAD: `test` failing and `lint` passed, unless a test says otherwise. */
function standingsIn(github: Partial<GitHubFacts>, checks: RequiredChecksFact = [failing("test"), passing("lint")], overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit: aKit(checks), ...overrides }), now);
}

describe("an agent pull request at the Merge gate held by an Unrelated failure (#795)", () => {
  it("is the Kit's while the Kit has a move of its own: check-healing, not yours, stopping nothing, naming the check", () => {
    expect(standingsIn({ openPullRequests: [held()] })).toEqual([
      {
        schema: 2,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "merge-gate",
        name: "check-healing",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: FAILED,
        stuckAt: plus(PASSED, BAR),
        awaits: null,
        subscription: null,
        detail: {
          plain: null,
          check: "test",
          rerun: "to-come",
          issue: null,
          passedAt: PASSED,
          passedHead: HEAD,
          healing: [{ check: "test", rerun: "to-come", issue: null, stuckAt: plus(PASSED, BAR) }],
          head: HEAD,
        },
      },
    ]);
  });

  /** What whose row it is hangs on: the name, the move, the two marks and the check it names. */
  const whose = ({ name, move, yours, stopsWork, detail }: Standing) => ({ name, move, yours, stopsWork, check: "check" in detail ? detail.check : null });
  const theKits = (check: string) => ({ name: "check-healing", move: "kit", yours: false, stopsWork: false, check });
  const theOperators = (check: string) => ({ name: "check-failing", move: "operator", yours: true, stopsWork: true, check });

  describe("becomes the Operator's when the Kit mentions them", () => {
    const mention = anOperatorMention([{ name: "test", issue: 91 }], HEAD, "2026-11-08T19:30:00Z");

    it("is check-failing, yours and stopping work, once the Kit's Operator-mention marker names the check, keeping that it was mentioned", () => {
      const [standing] = standingsIn({ openPullRequests: [held([mention])] });

      expect(whose(standing!)).toEqual(theOperators("test"));
      expect(standing).toMatchObject({ since: FAILED, stuckAt: null });
      expect(standing?.detail).toEqual({ plain: null, check: "test", checkIs: "failing", passedAt: PASSED, passedHead: HEAD, mentioned: ["test"], head: HEAD });
    });

    it("counts a mention made on an earlier head: the Kit mentions a check once on a pull request", () => {
      const earlier = anOperatorMention([{ name: "test", issue: 91 }], OLD_HEAD, "2026-11-07T19:30:00Z");

      expect(standingsIn({ openPullRequests: [held([earlier])] }).map(whose)).toEqual([theOperators("test")]);
    });

    it("counts only the Fabrik App's own marker, so quoting one hands nothing over", () => {
      const quoted = { ...mention, author: "someone", byBot: false };

      expect(standingsIn({ openPullRequests: [held([quoted])] }).map(whose)).toEqual([theKits("test")]);
    });
  });

  describe("with more than one Required check red", () => {
    const both = [failing("test"), failing("lint", "2026-11-08T17:55:00Z")];

    it("is the Operator's, naming the check the pass did not name, when one failing check is healing and one is not", () => {
      expect(standingsIn({ openPullRequests: [held()] }, both).map(whose)).toEqual([theOperators("lint")]);
    });

    it("is the Operator's, naming the mentioned check, when two are healing and one has since been mentioned", () => {
      const twoNamed = anOpenPullRequest({
        number: 50,
        ticket: 7,
        draft: false,
        headSha: HEAD,
        comments: [aPassNaming(["test", "lint"], HEAD, PASSED), anOperatorMention([{ name: "lint", issue: 92 }], HEAD, "2026-11-08T19:30:00Z")],
      });

      const standings = standingsIn({ openPullRequests: [twoNamed] }, both);

      expect(standings.map(whose)).toEqual([theOperators("lint")]);
      expect(standings[0]?.detail).toMatchObject({ healing: [{ check: "test" }], mentioned: ["lint"] });
    });

    it("is the Kit's, naming the first failing in the order the checks are read, when every failing check is healing", () => {
      const twoNamed = anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: HEAD, comments: [aPassNaming(["lint", "test"], HEAD, PASSED)] });

      expect(standingsIn({ openPullRequests: [twoNamed] }, both).map(whose)).toEqual([theKits("test")]);
    });

    it("is the Operator's for a check never reported beside a healing one, and the Kit's while another is only running", () => {
      const unreported = standingsIn({ openPullRequests: [held()] }, [failing("test"), { name: "lint", is: "never-reported" }]);
      const running = standingsIn({ openPullRequests: [held()] }, [failing("test"), { name: "lint", is: "running", at: "2026-11-08T19:00:00Z" }]);

      expect(unreported.map(whose)).toEqual([theOperators("lint")]);
      expect(unreported).toMatchObject([{ detail: { checkIs: "never-reported" } }]);
      expect(running.map(whose)).toEqual([theKits("test")]);
    });

    it("is the Operator's for a check never reported beside a healing one even while a third is running: a failing check never waits on a running one", () => {
      const mixed = standingsIn({ openPullRequests: [held()] }, [failing("test"), { name: "lint", is: "running", at: "2026-11-08T19:00:00Z" }, { name: "e2e", is: "never-reported" }]);

      expect(mixed.map(whose)).toEqual([theOperators("e2e")]);
      expect(mixed).toMatchObject([{ since: PASSED, detail: { checkIs: "never-reported", healing: [{ check: "test" }] } }]);
    });
  });

  describe("reads as before", () => {
    it("with the check running again or every check green, keeping which checks the Kit is healing", () => {
      const healing = [{ check: "test", rerun: "to-come", issue: null, stuckAt: plus(PASSED, BAR) }];
      const running = standingsIn({ openPullRequests: [held()] }, [{ name: "test", is: "running", at: "2026-11-08T19:00:00Z" }, passing("lint")]);
      const green = standingsIn({ openPullRequests: [held()] }, [passing("test"), passing("lint")]);

      expect(running).toMatchObject([{ name: "waiting-on-checks", move: "kit", stopsWork: false, since: PASSED, stuckAt: null }]);
      expect(running[0]?.detail).toEqual({ plain: null, check: "test", checksUnread: false, passedAt: PASSED, passedHead: HEAD, healing, head: HEAD });
      expect(green).toMatchObject([{ name: "yours-to-merge", move: "operator", yours: true, stopsWork: true, since: PASSED, stuckAt: null }]);
      expect(green[0]?.detail).toEqual({ plain: null, passedHead: HEAD, healing, head: HEAD });
    });

    it("with its head moved since the pass, whatever the pass named: the Kit re-runs nothing there", () => {
      const moved = anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: HEAD, comments: [aPassNaming(["test"], OLD_HEAD, PASSED)] });

      const [standing] = standingsIn({ openPullRequests: [moved] });

      expect(whose(standing!)).toEqual(theOperators("test"));
      expect(standing?.detail).toEqual({ plain: null, check: "test", checkIs: "failing", passedAt: PASSED, passedHead: OLD_HEAD, head: HEAD });
    });

    it("for a failing check the pass named no Unrelated failure", () => {
      const plainPass = anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: HEAD, comments: [aVerdictComment("pass", HEAD, PASSED)] });

      expect(standingsIn({ openPullRequests: [plainPass] }).map(whose)).toEqual([theOperators("test")]);
    });

    it("for an agent draft, and for a Plain pull request", () => {
      const draft = held([], { draft: true });
      const plain = aPlainPullRequest({ number: 70, headSha: HEAD });

      const standings = standingsIn({ openPullRequests: [draft], plainPullRequests: [plain] });

      expect(standings.map(({ pullRequest, place, name, move, yours, stopsWork }) => ({ pullRequest, place, name, move, yours, stopsWork }))).toEqual([
        { pullRequest: 70, place: null, name: "check-failing", move: "operator", yours: true, stopsWork: false },
        { pullRequest: 50, place: "review", name: "waiting-on-kit", move: "kit", yours: false, stopsWork: false },
      ]);
      expect(standings[0]?.detail).toEqual({ plain: "kit-bump", check: "test", checkIs: "failing", head: HEAD });
    });
  });

  describe("says what the Kit does next, from the pull request's own lines", () => {
    const next = (comments: readonly CommentFacts[], github: Partial<GitHubFacts> = {}) => {
      const standing = standingsIn({ openPullRequests: [held(comments)], ...github }).find(({ pullRequest }) => pullRequest === 50);
      return standing?.name === "check-healing" ? { rerun: standing.detail.rerun, issue: standing.detail.issue } : null;
    };

    it("its re-run at the gate still to come, asked for on this head, or done there", () => {
      expect(next([])).toEqual({ rerun: "to-come", issue: null });
      expect(next([aGateRerunAsk(["test"], HEAD, "2026-11-08T19:00:00Z")])).toEqual({ rerun: "asked", issue: null });
      expect(next([aGateRerunAsk(["test"], HEAD, "2026-11-08T19:00:00Z"), aGateRerunDone(["test"], HEAD, "2026-11-08T19:50:00Z")])).toEqual({ rerun: "done", issue: null });
      expect(next([aGateRerunDone(["test"], HEAD, "2026-11-08T19:00:00Z", "red-on-main")])).toEqual({ rerun: "done", issue: null });
    });

    it("reads a re-run line for another head or another check as nothing said of this one", () => {
      expect(next([aGateRerunDone(["test"], OLD_HEAD, "2026-11-08T19:00:00Z"), aGateRerunAsk(["lint"], HEAD, "2026-11-08T19:00:00Z")])).toEqual({ rerun: "to-come", issue: null });
    });

    it("names the Check's issue: the open issue the Fabrik App filed for the check, labelled as a Check's issue", () => {
      expect(next([], { openIssues: [aCheckIssue("test")] })).toEqual({ rerun: "to-come", issue: 91 });
      expect(next([], { openIssues: [aCheckIssue("lint")] })).toEqual({ rerun: "to-come", issue: null });
      expect(next([], { openIssues: [aCheckIssue("test", { author: "someone" })] })).toEqual({ rerun: "to-come", issue: null });
      expect(next([], { openIssues: [aCheckIssue("test", { labels: ["needs-triage"] })] })).toEqual({ rerun: "to-come", issue: null });
    });
  });

  describe("runs on the clock every row waiting on the Kit runs on", () => {
    const stuckAtOf = (comments: readonly CommentFacts[], github: Partial<GitHubFacts> = {}, overrides: Parameters<typeof standingsIn>[2] = {}) =>
      standingsIn({ openPullRequests: [held(comments)], ...github }, undefined, overrides)
        .filter(({ pullRequest }) => pullRequest === 50)
        .map(({ name, stuckAt }) => ({ name, stuckAt }));

    it("turns Stuck at the repo's bar from the pass, restarting at the Kit's later sign on the pull request or its Ticket, never at a person's", () => {
      const asked = "2026-11-08T19:05:00Z";

      expect(stuckAtOf([])).toEqual([{ name: "check-healing", stuckAt: plus(PASSED, BAR) }]);
      expect(stuckAtOf([aGateRerunAsk(["test"], HEAD, asked)])).toEqual([{ name: "check-healing", stuckAt: plus(asked, BAR) }]);
      expect(stuckAtOf([aComment("Any news?", asked, { author: "operator", byBot: false })])).toEqual([{ name: "check-healing", stuckAt: plus(PASSED, BAR) }]);
      expect(stuckAtOf([], { openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [aComment("The Kit noted something.", asked)] })] })).toEqual([
        { name: "check-healing", stuckAt: plus(asked, BAR) },
      ]);
    });

    it("counts the repo's own bar", () => {
      // An Implement job's timeout of 120 minutes makes the bar 270, as the other silences' tests have it.
      const config = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, implement: { ...DEFAULT_KIT_CONFIG.roles.implement, timeoutMinutes: 120 } } });
      const kit = { ...aKit([failing("test")]), config: { ok: true, config } } as const;

      expect(stuckAtOf([], {}, { kit })).toEqual([{ name: "check-healing", stuckAt: plus(PASSED, 270) }]);
    });

    it("reads Stuck past its bar: the Kit's move still, yours and stopping work, carrying the name it had", () => {
      const at = (now: string) => standingsIn({ openPullRequests: [held()] }, undefined, {}, now);

      expect(at(plus(PASSED, BAR - 1))).toMatchObject([{ name: "check-healing", yours: false, stopsWork: false }]);
      const [stuck] = at(plus(PASSED, BAR + 1));
      expect(stuck).toMatchObject({ name: "stuck", place: "merge-gate", move: "kit", yours: true, stopsWork: true, since: FAILED, stuckAt: plus(PASSED, BAR) });
      expect(stuck?.detail).toEqual({
        was: "check-healing",
        plain: null,
        check: "test",
        rerun: "to-come",
        issue: null,
        passedAt: PASSED,
        passedHead: HEAD,
        healing: [{ check: "test", rerun: "to-come", issue: null, stuckAt: plus(PASSED, BAR) }],
        head: HEAD,
      });
      // A reader that kept the Standing reads the same answer with no facts.
      expect(standingAt(at(plus(PASSED, BAR - 1))[0]!, plus(PASSED, BAR + 1))).toEqual(stuck);
    });

    describe("but cannot turn Stuck while the check's fix is under way", () => {
      it("with the Check's issue open and ready-for-agent", () => {
        const ready = aCheckIssue("test", { labels: ["ready-for-agent", "fabrik:flaky-check"] });

        const standings = standingsIn({ openPullRequests: [held()], openIssues: [ready] }, undefined, {}, plus(PASSED, 10 * BAR));

        expect(standings.find(({ pullRequest }) => pullRequest === 50)).toMatchObject({ name: "check-healing", stuckAt: null, detail: { issue: 91, healing: [{ check: "test", issue: 91, stuckAt: null }] } });
      });

      it("with an open agent pull request closing the Check's issue, whatever its labels", () => {
        const fix = anOpenPullRequest({ number: 51, ticket: 91, headSha: "f".repeat(40), commits: [{ at: NOW, byApp: true }] });

        const standings = standingsIn({ openPullRequests: [held(), fix], openIssues: [aCheckIssue("test", { labels: ["fabrik:flaky-check"] })] });

        expect(standings.find(({ pullRequest }) => pullRequest === 50)).toMatchObject({ name: "check-healing", stuckAt: null });
      });

      it("can, with the Check's issue waiting on Triage or on the Operator", () => {
        for (const label of ["needs-triage", "needs-design", "ready-for-human"]) {
          expect(stuckAtOf([], { openIssues: [aCheckIssue("test", { labels: [label, "fabrik:flaky-check"] })] }), label).toContainEqual({ name: "check-healing", stuckAt: plus(PASSED, BAR) });
        }
      });
    });

    describe("and restarts when the fix stops being under way, so it never reads Stuck at the moment a fix lands", () => {
      // Two days after the pass, with no sign from the Kit since: long past the bar from the pass.
      const LATER = "2026-11-10T18:00:00Z";
      const stopped = "2026-11-10T17:50:00Z";
      const at = (github: Partial<GitHubFacts>, now: string) => standingsIn({ openPullRequests: [held()], ...github }, undefined, {}, now).filter(({ pullRequest }) => pullRequest === 50);

      it("when the Check's issue closes, as when its fix lands: Stuck only a full bar after the close", () => {
        const closed = { closedCheckIssues: [{ number: 91, check: "test", closedAt: stopped, stateReason: "completed" }] } as const;

        expect(at(closed, LATER)).toMatchObject([{ name: "check-healing", stuckAt: plus(stopped, BAR), detail: { issue: null } }]);
        expect(at(closed, plus(stopped, BAR + 1))).toMatchObject([{ name: "stuck", detail: { was: "check-healing" } }]);
        // With no close to date it, the same facts read Stuck at once.
        expect(at({}, LATER)).toMatchObject([{ name: "stuck" }]);
      });

      it("when the open Check's issue loses ready-for-agent: Stuck only a full bar after it came off", () => {
        const handedBack = aCheckIssue("test", {
          labels: ["ready-for-human", "fabrik:flaky-check"],
          labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T19:00:00Z"), aLabelAdded("ready-for-agent", stopped, { action: "unlabeled" }), aLabelAdded("ready-for-human", stopped)],
        });

        expect(at({ openIssues: [handedBack] }, LATER)).toMatchObject([{ name: "check-healing", stuckAt: plus(stopped, BAR) }]);
        expect(at({ openIssues: [handedBack] }, plus(stopped, BAR + 1))).toMatchObject([{ name: "stuck" }]);
      });

      it("dates no close in facts an earlier release gathered, which hold no closed Check's issues", () => {
        const { closedCheckIssues: _, ...earlier } = factsOf({ openPullRequests: [held()] });

        const standings = standingsOf(standingFactsOf({ github: earlier, kit: aKit([failing("test")]) }), NOW);

        expect(standings).toMatchObject([{ name: "check-healing", stuckAt: plus(PASSED, BAR) }]);
      });

      it("reads another check's issue closing as nothing to this one", () => {
        const other = { closedCheckIssues: [{ number: 92, check: "lint", closedAt: stopped, stateReason: "completed" }] } as const;

        expect(at(other, LATER)).toMatchObject([{ name: "stuck", stuckAt: plus(PASSED, BAR) }]);
      });
    });
  });

  it("gives way to nothing else read of the same work: a run in flight on its Ticket leaves it named for its check", () => {
    const kit = { ...aKit([failing("test")]), runsInFlight: [aRunInFlight({ role: "review", pullRequest: 50, exact: true })] };

    expect(standingsIn({ openPullRequests: [held()] }, undefined, { kit }).map(whose)).toEqual([theKits("test")]);
  });
});
