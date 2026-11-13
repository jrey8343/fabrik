import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import {
  aComment,
  aDeploymentsRead,
  aDeployOf,
  aDesignRound,
  aDesignTurnFailedNotice,
  aLabelAdded,
  aMapCapRefusal,
  aMergedLastDay,
  aMergedPullRequest,
  anOpenAudit,
  anOpenIssue,
  anOpenPullRequest,
  anOpenReplay,
  anOpenRetro,
  aPlainPullRequest,
  aReplayBody,
  aReview,
  aRunInFlight,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  standingFactsOf,
} from "../read/builders.ts";
import { aTicket } from "../__fixtures__/snapshots.ts";
import { resetsAtMarker } from "../loop/kitIssueMarks.ts";
import { NEEDS_DESIGN, NEEDS_INFO, NEEDS_TRIAGE, READY_FOR_AGENT, READY_FOR_HUMAN, TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL, WEEKLY_LIMIT_LABEL } from "../loop/labels.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { roundLineOf } from "../loop/roundLine.ts";
import { subscriptionMarker } from "../loop/subscriptions.ts";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "./config.ts";
import { type Standing, standingAt, STANDING_NAMES, STANDING_SCHEMA, standingsOf, type StandingFacts } from "./standing.ts";
import { isSpec } from "./standingInFlight.ts";
import type { CommentFacts, GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);
const OLD_HEAD = "o".repeat(40);

/** Every read a test in this file made, with the Standings it gave, for the plain-data checks at the end. */
const produced: { readonly facts: StandingFacts; readonly now: string; readonly standings: readonly Standing[] }[] = [];

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  const facts = standingFactsOf({ github: factsOf(github), ...overrides });
  const standings = standingsOf(facts, now);
  produced.push({ facts, now, standings });
  return standings;
}

describe("the Standing rule", () => {
  describe("at the Merge gate", () => {
    it("gives an agent PR out of draft with a pass on its head one Standing, yours to merge and stopping work, carrying its Ticket, since the pass", () => {
      const standings = standingsIn({
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")] })],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: "merge-gate",
          name: "yours-to-merge",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-07T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { plain: null, passedHead: HEAD, head: HEAD },
        },
      ]);
    });

    const passed = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const atTheGate = (number: number, overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
      anOpenPullRequest({ number, ticket: number - 50, draft: false, comments: [passed], ...overrides });
    const namesIn = (standings: readonly Standing[]) => standings.map(({ pullRequest, name }) => ({ pullRequest, name }));

    describe("by the Required checks on its head (#564)", () => {
      const withChecks = (headChecks: RepoKitFacts["headChecks"]) =>
        ({ kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks } }) as const;
      const atTheGateWith = (checks: RepoKitFacts["headChecks"][string]) => standingsIn({ openPullRequests: [atTheGate(60)] }, withChecks({ [HEAD]: checks }));
      const fieldsOf = ({ pullRequest, issue, place, name, move, yours, stopsWork, since, detail }: Standing) => ({ pullRequest, issue, place, name, move, yours, stopsWork, since, detail });

      it("stands as check-failing, stopping work, since the failing report, naming the check and keeping the pass", () => {
        const standings = atTheGateWith([
          { name: "lint", is: "passed", at: "2026-11-05T19:00:00Z" },
          { name: "ci", is: "failing", at: "2026-11-06T08:00:00Z" },
        ]);
        expect(standings.map(fieldsOf)).toEqual([
          {
            pullRequest: 60,
            issue: 10,
            place: "merge-gate",
            name: "check-failing",
            move: "operator",
            yours: true,
            stopsWork: true,
            since: "2026-11-06T08:00:00Z",
            detail: { plain: null, check: "ci", checkIs: "failing", passedAt: "2026-11-05T20:00:00Z", passedHead: HEAD, head: HEAD },
          },
        ]);
      });

      it("stands as check-failing, stopping work, since the pass, for a Required check never reported on its head", () => {
        expect(atTheGateWith([{ name: "ci", is: "never-reported" }]).map(fieldsOf)).toEqual([
          expect.objectContaining({
            name: "check-failing",
            move: "operator",
            stopsWork: true,
            since: "2026-11-05T20:00:00Z",
            detail: { plain: null, check: "ci", checkIs: "never-reported", passedAt: "2026-11-05T20:00:00Z", passedHead: HEAD, head: HEAD },
          }),
        ]);
      });

      it("waits on a running Required check, the Kit's move and stopping nothing, since the pass, with no run awaited", () => {
        const [standing] = atTheGateWith([{ name: "ci", is: "running", at: "2026-11-07T08:00:00Z" }]);
        expect(standing).toEqual(
          expect.objectContaining({
            place: "merge-gate",
            name: "waiting-on-checks",
            move: "kit",
            yours: false,
            stopsWork: false,
            since: "2026-11-05T20:00:00Z",
            awaits: null,
            stuckAt: null,
            detail: { plain: null, check: "ci", checksUnread: false, passedAt: "2026-11-05T20:00:00Z", passedHead: HEAD, head: HEAD },
          }),
        );
      });

      it("reads a failing check before a running one, and a running one before one never reported", () => {
        const failing = atTheGateWith([
          { name: "a", is: "never-reported" },
          { name: "b", is: "running" },
          { name: "c", is: "failing", at: "2026-11-06T08:00:00Z" },
        ]);
        const running = atTheGateWith([
          { name: "a", is: "never-reported" },
          { name: "b", is: "running" },
        ]);
        expect([...failing, ...running].map(({ name, detail }) => ({ name, check: "check" in detail ? detail.check : null }))).toEqual([
          { name: "check-failing", check: "c" },
          { name: "waiting-on-checks", check: "b" },
        ]);
      });

      it("stays yours to merge, since the pass, with every check passed, none required, or its checks unread", () => {
        const yoursToMerge = expect.objectContaining({ name: "yours-to-merge", stopsWork: true, since: "2026-11-05T20:00:00Z", detail: { plain: null, passedHead: HEAD, head: HEAD } });
        expect(atTheGateWith([{ name: "ci", is: "passed", at: "2026-11-07T08:00:00Z" }])).toEqual([yoursToMerge]);
        expect(atTheGateWith([])).toEqual([yoursToMerge]);
        expect(standingsIn({ openPullRequests: [atTheGate(60)] }, withChecks({}))).toEqual([yoursToMerge]);
        expect(standingsIn({ openPullRequests: [atTheGate(60)] }, withChecks({ [HEAD]: "unread" }))).toEqual([yoursToMerge]);
      });

      it("leaves an agent draft waiting on its Review's checks as it was, whatever its head's checks", () => {
        const draft = anOpenPullRequest({ number: 60, ticket: 10, draft: true, headSha: HEAD });
        const runsInFlight = [aRunInFlight({ role: "review", job: "waiting-on-checks", createdAt: "2026-11-08T19:00:00Z" })];
        const [standing] = standingsIn({ openPullRequests: [draft] }, { kit: { ...withChecks({ [HEAD]: [{ name: "ci", is: "failing", at: "2026-11-08T19:30:00Z" }] }).kit, runsInFlight } });
        expect(standing).toEqual(expect.objectContaining({ place: "review", name: "waiting-on-checks", detail: { plain: null, check: null, checksUnread: false, head: HEAD } }));
      });
    });

    it("leaves an agent PR yours to merge after the Operator's comment or approving review, which the Kit never acts on (ADR-0007)", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "approved", body: "Ship it." })] }),
          atTheGate(61, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "commented", body: "Nice." })] }),
          atTheGate(62, { comments: [passed, aComment("Looks good.", "2026-11-07T06:00:00Z", { author: "operator", byBot: false })] }),
        ],
      });
      expect(namesIn(standings)).toEqual([
        { pullRequest: 60, name: "yours-to-merge" },
        { pullRequest: 61, name: "yours-to-merge" },
        { pullRequest: 62, name: "yours-to-merge" },
      ]);
    });

    it("takes an agent PR off what is the Operator's once they request changes after the pass, but not for a dismissed one, one before the pass or someone else's", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { reviews: [aReview("2026-11-07T06:00:00Z")] }),
          atTheGate(61, { reviews: [aReview("2026-11-07T06:00:00Z", { state: "dismissed" })] }),
          atTheGate(62, { reviews: [aReview("2026-11-04T20:00:00Z")] }),
          atTheGate(63, { reviews: [aReview("2026-11-07T06:00:00Z", { author: "someone" })] }),
          atTheGate(64, { reviews: [aReview("2026-11-06T06:00:00Z"), aReview("2026-11-07T06:00:00Z", { state: "approved" })] }),
        ],
      });
      expect(namesIn(standings.filter(({ move }) => move === "operator"))).toEqual([
        { pullRequest: 61, name: "yours-to-merge" },
        { pullRequest: 62, name: "yours-to-merge" },
        { pullRequest: 63, name: "yours-to-merge" },
      ]);
      // A Request changes no run was started for is the Kit's, Stuck by now (#608).
      expect(namesIn(standings.filter(({ move }) => move === "kit"))).toEqual([
        { pullRequest: 64, name: "stuck" },
        { pullRequest: 60, name: "stuck" },
      ]);
    });

    it("gives no Standing of the Operator's to a draft, or to a PR whose latest Verdict is no pass", () => {
      const standings = standingsIn({
        openPullRequests: [
          atTheGate(60, { draft: true }),
          atTheGate(62, { comments: [passed, aVerdictComment("execution-flaw", HEAD, "2026-11-06T20:00:00Z")] }),
          atTheGate(63, { comments: [passed, aVerdictComment("design-flaw", OLD_HEAD, "2026-11-06T20:00:00Z")] }),
        ],
      });
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
      expect(standings.map(({ pullRequest, name, detail }) => ({ pullRequest, name, silence: "silence" in detail ? detail.silence : null }))).toEqual(
        expect.arrayContaining([
          { pullRequest: 62, name: "waiting-on-kit", silence: "left-over" },
          { pullRequest: 63, name: "waiting-on-kit", silence: "left-over" },
        ]),
      );
    });

    describe("with its head moved since the pass (#692)", () => {
      const passedOld = aVerdictComment("pass", OLD_HEAD, "2026-11-05T20:00:00Z");
      const moved = (number: number, overrides: Parameters<typeof anOpenPullRequest>[0] = {}) => atTheGate(number, { headSha: HEAD, comments: [passedOld], ...overrides });

      it("stands as yours to merge, stopping work, since the pass, naming the head it passed and the head it has", () => {
        expect(standingsIn({ openPullRequests: [moved(60)] })).toEqual([
          {
            schema: 1,
            repo: "owner/product",
            issue: 10,
            pullRequest: 60,
            work: "ticket",
            place: "merge-gate",
            name: "yours-to-merge",
            move: "operator",
            yours: true,
            stopsWork: true,
            since: "2026-11-05T20:00:00Z",
            stuckAt: null,
            awaits: null,
            subscription: null,
            detail: { plain: null, passedHead: OLD_HEAD, head: HEAD },
          },
        ]);
      });

      it("stands by the Required checks on its own head, as #564 reads them, each name carrying the head it passed", () => {
        const kit = (checks: RepoKitFacts["headChecks"][string]) =>
          ({ kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks: { [HEAD]: checks, [OLD_HEAD]: [] } } }) as const;
        const at = (checks: RepoKitFacts["headChecks"][string]) => standingsIn({ openPullRequests: [moved(60)] }, kit(checks)).map(({ name, since, detail }) => ({ name, since, detail }));
        expect([
          ...at([{ name: "ci", is: "failing", at: "2026-11-06T08:00:00Z" }]),
          ...at([{ name: "ci", is: "running", at: "2026-11-07T08:00:00Z" }]),
          ...at([{ name: "ci", is: "never-reported" }]),
        ]).toEqual([
          { name: "check-failing", since: "2026-11-06T08:00:00Z", detail: { plain: null, check: "ci", checkIs: "failing", passedAt: "2026-11-05T20:00:00Z", passedHead: OLD_HEAD, head: HEAD } },
          { name: "waiting-on-checks", since: "2026-11-05T20:00:00Z", detail: { plain: null, check: "ci", checksUnread: false, passedAt: "2026-11-05T20:00:00Z", passedHead: OLD_HEAD, head: HEAD } },
          { name: "check-failing", since: "2026-11-05T20:00:00Z", detail: { plain: null, check: "ci", checkIs: "never-reported", passedAt: "2026-11-05T20:00:00Z", passedHead: OLD_HEAD, head: HEAD } },
        ]);
      });

      it("reads the latest Verdict on any head: a pass on an older head after a flaw on it counts", () => {
        const flawThenPass = moved(60, { comments: [aVerdictComment("execution-flaw", OLD_HEAD, "2026-11-04T20:00:00Z"), passedOld] });
        expect(namesIn(standingsIn({ openPullRequests: [flawThenPass] }))).toEqual([{ pullRequest: 60, name: "yours-to-merge" }]);
      });

      it("reads a Request changes or a hand-back since the pass as it does on the passed head, never as left over", () => {
        const standings = standingsIn({
          openPullRequests: [moved(60, { reviews: [aReview("2026-11-08T19:00:00Z")] }), moved(61, { labelEvents: [aLabelAdded(READY_FOR_HUMAN, "2026-11-06T20:00:00Z")] })],
        });
        expect(standings.map(({ pullRequest, name, place, detail }) => ({ pullRequest, name, place, silence: "silence" in detail ? detail.silence : null }))).toEqual([
          { pullRequest: 61, name: "yours-to-do", place: "merge-gate", silence: null },
          { pullRequest: 60, name: "waiting-on-kit", place: "implement", silence: "request-changes" },
        ]);
      });

      it("leaves a draft whose pass is on an older head as any quiet draft", () => {
        const [standing] = standingsIn({ openPullRequests: [moved(60, { draft: true })] });
        expect(standing).toEqual(expect.objectContaining({ place: "review", move: "kit", detail: expect.objectContaining({ silence: "quiet-draft" }) }));
      });
    });
  });

  describe("with ready-for-human", () => {
    const passed = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const handedBack = aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z");

    it("gives an agent PR the Kit handed back after its pass one Standing, yours to do at the Merge gate and stopping work, since the label", () => {
      const standings = standingsIn({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [passed], labelEvents: [handedBack] })] });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: "merge-gate",
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: null, role: null, failure: null, label: null, head: HEAD },
        },
      ]);
    });

    it("hands back a PR the Kit labelled after the Operator's Request changes, but not one labelled before a later pass or whose label came off", () => {
      const standings = standingsIn({
        openPullRequests: [
          anOpenPullRequest({ number: 60, ticket: 10, draft: false, comments: [passed], reviews: [aReview("2026-11-06T08:00:00Z")], labelEvents: [handedBack] }),
          anOpenPullRequest({ number: 61, ticket: 11, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-07T20:00:00Z")], labelEvents: [handedBack] }),
          anOpenPullRequest({
            number: 62,
            ticket: 12,
            draft: false,
            comments: [passed],
            labelEvents: [handedBack, aLabelAdded("ready-for-human", "2026-11-07T08:00:00Z", { action: "unlabeled", actor: "operator" })],
          }),
        ],
      });
      expect(standings.map(({ pullRequest, name, since }) => ({ pullRequest, name, since }))).toEqual([
        { pullRequest: 62, name: "yours-to-merge", since: "2026-11-05T20:00:00Z" },
        { pullRequest: 60, name: "yours-to-do", since: "2026-11-06T20:00:00Z" },
        { pullRequest: 61, name: "yours-to-merge", since: "2026-11-07T20:00:00Z" },
      ]);
    });

    it("gives any open issue labelled ready-for-human one Standing, yours to do with no place and stopping work, since the label, or since it was opened", () => {
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("needs-triage", "2026-10-30T20:00:00Z"), aLabelAdded("ready-for-human", "2026-11-01T20:00:00Z")] }),
          anOpenIssue({ number: 14, labels: ["ready-for-human"], createdAt: "2026-11-02T20:00:00Z" }),
          anOpenIssue({ number: 15, labels: ["needs-triage"] }),
        ],
      });
      // #15 waits on Triage, the Kit's (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 13,
          pullRequest: null,
          work: "ready-for-human",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-01T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: null, role: null, failure: null, label: null },
        },
        expect.objectContaining({ issue: 14, name: "yours-to-do", since: "2026-11-02T20:00:00Z" }),
      ]);
    });
  });

  describe("in a Design session", () => {
    const operatorAnswer = (at: string) => aComment("Option A, please.", at, { author: "operator", byBot: false });
    const designing = (number: number, comments: readonly CommentFacts[]) => anOpenIssue({ number, labels: ["needs-design"], comments });

    it("gives a needs-design issue whose last comment is the Fabrik App's Round one Standing, a Design round at Design with its number, stopping work, since the Round", () => {
      const standings = standingsIn({
        openIssues: [designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z"), aDesignRound(2, "2026-11-05T20:00:00Z")])],
      });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: null,
          work: "design-session",
          place: "design",
          name: "design-round",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-05T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { round: 2, prototype: null },
        },
      ]);
    });

    it("says whether the Round is a prototype round or a prototype's failure round", () => {
      const round = (number: number, marker: string) => aComment(`${designRoundMarker(number)}\n${marker}\nWhich variant?`, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openIssues: [designing(12, [round(3, PROTOTYPE_ROUND_MARKER)]), designing(13, [round(4, PROTOTYPE_FAILURE_ROUND_MARKER)])],
      });
      expect(standings.map(({ issue, name, detail }) => ({ issue, name, detail }))).toEqual([
        { issue: 12, name: "design-round", detail: { round: 3, prototype: "ready" } },
        { issue: 13, name: "design-round", detail: { round: 4, prototype: "failed" } },
      ]);
    });

    it("reads a Round carrying its hidden line as an ordinary Round, not a prototype round", () => {
      const line = roundLineOf({ v: 1, kind: "round", round: 3, intro: "Hi.", questions: [{ question: "Q?", recommendation: "R." }], asksMap: true });
      const round = aComment(`${designRoundMarker(3)}\n${line}\n@operator **Design session, round 3.**`, "2026-11-05T20:00:00Z");
      const standings = standingsIn({ openIssues: [designing(12, [round])] });
      expect(standings.map(({ issue, name, detail }) => ({ issue, name, detail }))).toEqual([{ issue: 12, name: "design-round", detail: { round: 3, prototype: null } }]);
    });

    it("gives a Design session whose last word is the Kit's notice that a turn failed one Standing, yours to do at Design, stopping work, since the notice", () => {
      const standings = standingsIn({ openIssues: [designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z"), aDesignTurnFailedNotice("2026-11-06T20:00:00Z")])] });
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 12,
          pullRequest: null,
          work: "design-session",
          place: "design",
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: "design-turn-failed", role: "design", failure: null, label: null },
        },
      ]);
    });

    it("tells the Map cap's refusal apart from a failed turn", () => {
      const standings = standingsIn({ openIssues: [designing(21, [aMapCapRefusal("2026-11-07T20:00:00Z")])] });
      expect(standings).toEqual([
        expect.objectContaining({ issue: 21, work: "design-session", place: "design", name: "yours-to-do", stopsWork: true, detail: { handBack: "map-cap-refused", role: "design", failure: null, label: null } }),
      ]);
    });

    it("gives no Standing of the Operator's once they replied to the notice, once the session is over, or for a notice another bot posted", () => {
      const standings = standingsIn({
        openIssues: [
          designing(12, [aDesignTurnFailedNotice("2026-11-06T20:00:00Z"), operatorAnswer("2026-11-07T20:00:00Z")]),
          anOpenIssue({ number: 13, labels: ["ready-for-agent"], comments: [aDesignTurnFailedNotice("2026-11-06T20:00:00Z")] }),
          designing(14, [{ ...aDesignTurnFailedNotice("2026-11-06T20:00:00Z"), author: "other-app[bot]" }]),
        ],
      });
      // Each waits on the Kit instead (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
    });

    it("gives no Design round once the Operator answered it, or for a Round marker another bot or a person posted", () => {
      const standings = standingsIn({
        openIssues: [
          designing(12, [aDesignRound(1, "2026-11-02T20:00:00Z"), operatorAnswer("2026-11-03T20:00:00Z")]),
          designing(13, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "other-app[bot]" }]),
          designing(14, [{ ...aDesignRound(1, "2026-11-02T20:00:00Z"), author: "operator", byBot: false }]),
        ],
      });
      // Each waits on the Kit's next turn instead (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([]);
    });

    it("gives no Design round to an issue that has left Design by hand, its last comment still a Round", () => {
      const standings = standingsIn(
        {
          openIssues: [
            anOpenIssue({ number: 12, labels: ["ready-for-agent"], comments: [aDesignRound(2, "2026-11-05T20:00:00Z")] }),
            anOpenIssue({ number: 13, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")], comments: [aDesignRound(3, "2026-11-05T20:00:00Z")] }),
          ],
        },
        {
          kit: {
            repo: "owner/product",
            branch: "main",
            config: { ok: true, config: DEFAULT_KIT_CONFIG },
            dispatch: null,
            headChecks: {},
            runsInFlight: [aRunInFlight({ issue: 12, createdAt: "2026-11-08T19:20:00Z" })],
          },
        },
      );
      expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([
        { issue: 13, name: "yours-to-do" },
        { issue: 12, name: "running" },
      ]);
    });
  });

  describe("a Subscription's issue", () => {
    const listing = (...subscriptions: readonly string[]) =>
      ({ kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, subscriptions } }, dispatch: null, runsInFlight: [], headChecks: {} } }) as const;
    /** Open Kit-owned issue `number`, labelled `labels`, naming `subscription` in its body (none when null), opened at `createdAt`: as the open issues and as the Kit's issues. */
    const kitIssue = (number: number, labels: readonly string[], subscription: string | null, createdAt: string, body = "") => ({
      open: anOpenIssue({ number, labels, createdAt, labelEvents: labels.map((label) => aLabelAdded(label, createdAt)) }),
      kit: { number, labels, body: [body, ...(subscription === null ? [] : [subscriptionMarker(subscription)])].join("\n"), comments: [] },
    });
    const weeklyLimit = (number: number, subscription: string | null, resetsAt: string, createdAt = "2026-11-06T20:00:00Z") =>
      kitIssue(number, ["fabrik:weekly-limit"], subscription, createdAt, resetsAtMarker(resetsAt));
    const tokenRotation = (number: number, subscription: string | null) => kitIssue(number, ["ready-for-human", "fabrik:token-rotation"], subscription, "2026-11-05T20:00:00Z");
    const usageCredits = (number: number, subscription: string) => kitIssue(number, ["ready-for-human", "fabrik:usage-credits"], subscription, "2026-11-04T20:00:00Z");
    const facts = (...issues: readonly ReturnType<typeof kitIssue>[]) => ({ openIssues: issues.map(({ open }) => open), kitIssues: issues.map(({ kit }) => kit) });

    it("is waiting for its reset, the Kit's and never Stuck, for a weekly-limit issue while another Subscription is free, naming its Subscription", () => {
      expect(standingsIn(facts(weeklyLimit(20, "B", "2026-11-10T22:00:00Z")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 20,
          pullRequest: null,
          work: "weekly-limit",
          place: null,
          name: "waiting-for-reset",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { resetsAt: "2026-11-10T22:00:00Z" },
        },
      ]);
    });

    it("is the Operator's weekly limit reached, stopping work, once every Subscription listed is used up, each saying when the first resets", () => {
      const standings = standingsIn(facts(weeklyLimit(20, "A", "2026-11-10T22:00:00Z"), weeklyLimit(21, "B", "2026-11-09T22:00:00Z", "2026-11-07T20:00:00Z")), listing("A", "B"));
      expect(standings).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 20,
          pullRequest: null,
          work: "weekly-limit",
          place: null,
          name: "weekly-limit-reached",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "A",
          detail: { resetsAt: "2026-11-09T22:00:00Z" },
        },
        expect.objectContaining({ issue: 21, name: "weekly-limit-reached", subscription: "B", detail: { resetsAt: "2026-11-09T22:00:00Z" } }),
      ]);
    });

    it("names the first Subscription listed for an issue whose body names none, and judges used up by the Kit's default config when none was read", () => {
      expect(standingsIn(facts(weeklyLimit(20, null, "2026-11-10T22:00:00Z")), listing("A", "B"))).toEqual([
        expect.objectContaining({ name: "waiting-for-reset", subscription: "A" }),
      ]);
      expect(standingsIn(facts(weeklyLimit(20, null, "2026-11-10T22:00:00Z")))).toEqual([
        expect.objectContaining({ name: "weekly-limit-reached", subscription: "Claude token" }),
      ]);
    });

    it("is the Operator's token refused, stopping work, for a token-rotation issue, saying whether another Subscription is free, not ready-for-human work", () => {
      expect(standingsIn(facts(tokenRotation(22, "B")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 22,
          pullRequest: null,
          work: "token-rotation",
          place: null,
          name: "token-refused",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-05T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { anotherFree: true },
        },
      ]);
      expect(standingsIn(facts(tokenRotation(22, null)))).toEqual([expect.objectContaining({ name: "token-refused", subscription: "Claude token", detail: { anotherFree: false } })]);
    });

    it("is the Operator's to do, stopping work, for a usage-credits issue, naming its Subscription", () => {
      expect(standingsIn(facts(usageCredits(23, "B")), listing("A", "B"))).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 23,
          pullRequest: null,
          work: "usage-credits",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-04T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: "B",
          detail: { handBack: null, role: null, failure: null, label: null },
        },
      ]);
    });
  });

  describe("reading matter", () => {
    const reading = (issue: number, work: Standing["work"], since: string, detail = { map: null as number | null, decisions: [] as number[] }) => ({
      schema: 1,
      repo: "owner/product",
      issue,
      pullRequest: null,
      work,
      place: null,
      name: "yours-to-read",
      move: "operator",
      yours: true,
      stopsWork: false,
      since,
      stuckAt: null,
      awaits: null,
      subscription: null,
      detail,
    });

    it("gives the Fabrik App's open Audit and Retro, filled or still pending, one Standing each, yours to read and stopping no work, since each was opened", () => {
      const standings = standingsIn({
        openAudits: [anOpenAudit({ number: 90, createdAt: "2026-11-02T20:00:00Z" })],
        openRetros: [anOpenRetro({ number: 120, createdAt: "2026-10-31T20:00:00Z" })],
      });
      expect(standings).toEqual([reading(120, "retro", "2026-10-31T20:00:00Z"), reading(90, "audit", "2026-11-02T20:00:00Z")]);
    });

    it("gives none to a fabrik:audit or fabrik:retro issue someone other than the Fabrik App opened", () => {
      const standings = standingsIn({
        openAudits: [anOpenAudit({ author: "operator" }), anOpenAudit({ number: 91, author: "other-app[bot]" })],
        openRetros: [anOpenRetro({ author: "operator" })],
      });
      expect(standings).toEqual([]);
    });

    it("gives the Operator's Replay whose results are in one, since the Kit wrote them, and none to one still running or someone else's", () => {
      const standings = standingsIn({
        openReplays: [
          anOpenReplay({ number: 140, lastEditedAt: "2026-11-06T20:00:00Z" }),
          anOpenReplay({ number: 141, body: aReplayBody({ state: "pending" }) }),
          anOpenReplay({ number: 142, author: "someone-else" }),
        ],
      });
      // #141, between its steps, waits on the Kit (#608).
      expect(standings.filter(({ move }) => move === "operator")).toEqual([reading(140, "replay", "2026-11-06T20:00:00Z")]);
    });

    it("gives an open Map one, since it got wayfinder:map, carrying its open grilling, prototype and task Decisions, and each of them one carrying the Map", () => {
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 30, labels: ["wayfinder:map"], labelEvents: [aLabelAdded("wayfinder:map", "2026-11-03T20:00:00Z")], subIssues: [31, 32, 33, 34, 35] }),
          anOpenIssue({ number: 31, labels: ["wayfinder:grilling"], labelEvents: [aLabelAdded("wayfinder:grilling", "2026-11-04T20:00:00Z")] }),
          anOpenIssue({ number: 32, labels: ["wayfinder:prototype"], createdAt: "2026-11-05T20:00:00Z" }),
          anOpenIssue({ number: 33, labels: ["wayfinder:task"], createdAt: "2026-11-05T20:00:00Z" }),
          // The Researcher's, and its run hasn't failed: not the Operator's.
          anOpenIssue({ number: 34, labels: ["wayfinder:research"] }),
          // On no open Map.
          anOpenIssue({ number: 36, labels: ["wayfinder:grilling"] }),
        ],
        openMaps: [30],
      });
      expect(standings).toEqual([
        reading(30, "map", "2026-11-03T20:00:00Z", { map: null, decisions: [31, 32, 33] }),
        reading(31, "operator-decision", "2026-11-04T20:00:00Z", { map: 30, decisions: [] }),
        reading(32, "operator-decision", "2026-11-05T20:00:00Z", { map: 30, decisions: [] }),
        reading(33, "operator-decision", "2026-11-05T20:00:00Z", { map: 30, decisions: [] }),
      ]);
    });

    it("gives an open issue labelled wayfinder:map that the Map cap's read doesn't count no Standing as a Map", () => {
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 30, labels: ["wayfinder:map"] })] })).toEqual([]);
    });
  });

  describe("a research Decision", () => {
    const failureNotice = (decision: number, at: string) => aComment(`${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #${decision} failed: it timed out.`, at);
    const mapOf = (number: number, decisions: readonly number[]) => anOpenIssue({ number, labels: ["wayfinder:map"], subIssues: decisions, createdAt: "2026-11-07T20:00:00Z" });
    const failed = (number: number, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
      anOpenIssue({ number, labels: ["wayfinder:research"], comments: [failureNotice(number, "2026-11-06T20:00:00Z")], ...overrides });
    const decisionsIn = (standings: readonly Standing[]) => standings.filter(({ work }) => work === "research-decision");

    it("on an open Map whose last run failed is the Operator's to do, stopping work, since the Kit's notice, until agent:research is added again", () => {
      const standings = standingsIn({ openIssues: [mapOf(30, [31]), failed(31)], openMaps: [30] });
      expect(decisionsIn(standings)).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 31,
          pullRequest: null,
          work: "research-decision",
          place: null,
          name: "yours-to-do",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { handBack: "research-failed", role: "research", failure: null, label: "agent:research" },
        },
      ]);
    });

    it("is no longer the Operator's once agent:research was added again after the notice", () => {
      const readded = aLabelAdded("agent:research", "2026-11-07T20:00:00Z", { actor: "operator" });
      const before = aLabelAdded("agent:research", "2026-11-05T20:00:00Z", { actor: "operator" });
      const standings = standingsIn({ openIssues: [mapOf(30, [31, 32]), failed(31, { labelEvents: [readded] }), failed(32, { labelEvents: [before] })], openMaps: [30] });
      expect(decisionsIn(standings).map(({ issue }) => issue)).toEqual([32]);
    });

    it("reads the failure from the Fabrik App's comments alone, and none on no open Map or whose later word answered it", () => {
      const otherBot = { author: "dependabot[bot]", byBot: true };
      const standings = standingsIn({
        openIssues: [
          mapOf(30, [31, 32, 33]),
          failed(31, { comments: [failureNotice(31, "2026-11-06T20:00:00Z"), aComment("Bumped a dependency.", "2026-11-07T08:00:00Z", otherBot)] }),
          failed(32, { comments: [aComment(`${RESEARCH_RUN_FAILED_MARKER}\nA look-alike.`, "2026-11-06T20:00:00Z", otherBot)] }),
          failed(33, { comments: [failureNotice(33, "2026-11-04T20:00:00Z"), aComment("Resolved: Stripe and Square both do.", "2026-11-05T20:00:00Z")] }),
          failed(34),
        ],
        openMaps: [30],
      });
      expect(decisionsIn(standings).map(({ issue, since }) => ({ issue, since }))).toEqual([{ issue: 31, since: "2026-11-06T20:00:00Z" }]);
    });
  });

  describe("in needs-info", () => {
    const asked = (number: number, author: string, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
      anOpenIssue({ number, author, labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", "2026-11-06T20:00:00Z")], ...overrides });

    it("gives an unanswered needs-info issue the Operator filed one Standing, needs your answer at Triage, stopping work, since the label", () => {
      expect(standingsIn({ openIssues: [asked(18, "operator")] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 18,
          pullRequest: null,
          work: "issue",
          place: "triage",
          name: "needs-your-answer",
          move: "operator",
          yours: true,
          stopsWork: true,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { author: "operator" },
        },
      ]);
    });

    it("gives one the Fabrik App filed as the Monitor the same, naming the App as its author", () => {
      expect(standingsIn({ openIssues: [asked(15, "fabrik-app[bot]")] })).toEqual([
        expect.objectContaining({ issue: 15, name: "needs-your-answer", move: "operator", stopsWork: true, detail: { author: "fabrik-app[bot]" } }),
      ]);
    });

    it("never makes one anyone else filed the Operator's: it waits on its author, nobody's move, at Triage", () => {
      expect(standingsIn({ openIssues: [asked(16, "kate")] })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 16,
          pullRequest: null,
          work: "issue",
          place: "triage",
          name: "waiting-on-author",
          move: "nobody",
          yours: false,
          stopsWork: false,
          since: "2026-11-06T20:00:00Z",
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { author: "kate" },
        },
      ]);
    });

    it("gives none once a person answered after the question, though a bot's comment or an answer before it leaves it waiting", () => {
      const standings = standingsIn({
        openIssues: [
          asked(18, "operator", { comments: [aComment("CSV.", "2026-11-07T20:00:00Z", { author: "operator", byBot: false })] }),
          asked(19, "kate", { comments: [aComment("Since 2.3.", "2026-11-07T20:00:00Z", { author: "kate", byBot: false })] }),
          asked(20, "operator", { comments: [aComment("Still looking.", "2026-11-07T20:00:00Z")] }),
          asked(21, "operator", { comments: [aComment("Earlier.", "2026-11-05T20:00:00Z", { author: "operator", byBot: false })] }),
          anOpenIssue({ number: 22, author: "operator", labels: ["needs-triage"] }),
        ],
      });
      // The answered ones and #22 wait on Triage, the Kit's (#608).
      expect(standings.filter(({ move }) => move === "operator").map(({ issue, name }) => ({ issue, name }))).toEqual([
        { issue: 20, name: "needs-your-answer" },
        { issue: 21, name: "needs-your-answer" },
      ]);
    });
  });

  describe("a Plain pull request", () => {
    it("is named by its draft, its merge and its Required checks, each with its kind and no place (src/kit/standingPlain.test.ts)", () => {
      const head = (digit: string) => digit.repeat(40);
      const kit = {
        repo: "owner/product",
        branch: "main",
        config: { ok: true, config: DEFAULT_KIT_CONFIG },
        dispatch: null,
        runsInFlight: [],
        headChecks: { [head("1")]: [{ name: "test", is: "running" }], [head("2")]: [{ name: "test", is: "failing" }] },
      } as const;
      const standings = standingsIn(
        {
          plainPullRequests: [
            aPlainPullRequest({ number: 70, headSha: head("1") }),
            aPlainPullRequest({ number: 71, headSha: head("2"), author: "operator", headRef: "fabrik/setup-v3.1.0" }),
            aPlainPullRequest({ number: 72, mergeable: false }),
            aPlainPullRequest({ number: 73, draft: true, author: "operator", headRef: "fix-typo" }),
          ],
        },
        { kit },
      );
      expect(standings.map(({ pullRequest, name, detail }) => ({ pullRequest, name, detail }))).toEqual([
        { pullRequest: 70, name: "waiting-on-checks", detail: { plain: "kit-bump", check: "test", checksUnread: false, head: head("1") } },
        { pullRequest: 71, name: "check-failing", detail: { plain: "setup", check: "test", checkIs: "failing", head: head("2") } },
        { pullRequest: 72, name: "conflicts", detail: { plain: "kit-bump", head: head("p") } },
        { pullRequest: 73, name: "draft", detail: { plain: "other", head: head("p") } },
      ]);
    });
  });

  describe("one piece of work", () => {
    it("is one Standing for a Ticket and the agent PR that closes it, carrying both numbers", () => {
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
        openPullRequests: [
          anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z")] }),
          anOpenPullRequest({ number: 51, ticket: 8 }),
        ],
      });
      expect(standings).toEqual([
        expect.objectContaining({ issue: 8, pullRequest: 51, name: "stuck" }),
        expect.objectContaining({ issue: 7, pullRequest: 50, work: "ready-for-human", name: "yours-to-do" }),
      ]);
    });

    it("keeps two open agent PRs that close the same Ticket apart, the Ticket's own Standing going with the lower", () => {
      const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] })],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: 7, draft: false, comments: [pass] }), anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [pass] })],
      });
      expect(standings.map(({ issue, pullRequest, name }) => ({ issue, pullRequest, name }))).toEqual([
        { issue: 7, pullRequest: 51, name: "yours-to-merge" },
        { issue: 7, pullRequest: 50, name: "yours-to-do" },
      ]);
    });

    it("is one Standing for an agent PR that closes no Ticket, keyed by its number", () => {
      const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
      const standings = standingsIn({
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: null, draft: false, comments: [pass] }), anOpenPullRequest({ number: 51, ticket: null, draft: false, comments: [pass] })],
      });
      expect(standings.map(({ issue, pullRequest }) => ({ issue, pullRequest }))).toEqual([
        { issue: null, pullRequest: 50 },
        { issue: null, pullRequest: 51 },
      ]);
    });

    it("carries its open pull request's head commit in detail.head, an agent PR's, a Plain one's and a Pairing session's, and no such key with none (#618)", () => {
      const head = (digit: string) => digit.repeat(40);
      const standings = standingsIn({
        openIssues: [
          anOpenIssue({ number: 7, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T20:00:00Z")] }),
          anOpenIssue({ number: 9, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-06T21:00:00Z")] }),
          anOpenIssue({ number: 12 }),
        ],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, headSha: head("1") })],
        plainPullRequests: [
          aPlainPullRequest({ number: 70, headSha: head("2") }),
          aPlainPullRequest({ number: 71, headSha: head("3"), author: "operator", headRef: "fabrik/pair-12", closes: [12] }),
        ],
      });
      const heads = standings.map((standing) => ({ issue: standing.issue, pullRequest: standing.pullRequest, head: "head" in standing.detail ? standing.detail.head : "none" }));
      expect(heads).toEqual(
        expect.arrayContaining([
          { issue: 7, pullRequest: 50, head: head("1") },
          { issue: 9, pullRequest: null, head: "none" },
          { issue: null, pullRequest: 70, head: head("2") },
          { issue: 12, pullRequest: 71, head: head("3") },
        ]),
      );
    });
  });
});

describe("work that goes on without the Operator (#606)", () => {
  it("gives one Standing of each of its names, the Kit's move or nobody's, none of them the Operator's or able to turn Stuck", () => {
    const readyAt = "2026-11-05T12:00:00Z";
    const ready = (number: number) => anOpenIssue({ number, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", readyAt)] });
    const standings = standingsIn(
      {
        openIssues: [ready(7), ready(9), ready(14), ready(15)],
        openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8 })],
        kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 9, label: "agent:implement" }], { commentedAt: ["2026-11-08T10:00:00Z"] })],
      },
      {
        kit: {
          repo: "owner/product",
          branch: "main",
          config: { ok: true, config: DEFAULT_KIT_CONFIG },
          dispatch: { candidates: { tickets: [aTicket({ number: 14 }), aTicket({ number: 15, openBlockers: [3] })], researchDecisions: [] } },
          headChecks: {},
          runsInFlight: [
            aRunInFlight({ issue: 7, createdAt: "2026-11-08T19:20:00Z" }),
            aRunInFlight({ issue: 12 }),
            aRunInFlight({ role: "review", job: "waiting-on-checks", createdAt: "2026-11-08T19:40:00Z" }),
          ],
        },
      },
    );
    expect(standings.map(({ issue, name, move, yours, stopsWork, stuckAt }) => ({ issue, name, move, yours, stopsWork, stuckAt }))).toEqual([
      { issue: 14, name: "waiting-for-slot", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 15, name: "blocked", move: "nobody", yours: false, stopsWork: false, stuckAt: null },
      { issue: 9, name: "held", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 7, name: "running", move: "kit", yours: false, stopsWork: false, stuckAt: null },
      { issue: 8, name: "waiting-on-checks", move: "kit", yours: false, stopsWork: false, stuckAt: null },
    ]);
  });
});

describe("work a cap holds (#459)", () => {
  const readyAt = "2026-11-05T12:00:00Z";
  const ready = anOpenIssue({ number: 14, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", readyAt)] });
  const kit = (runsInFlight: RepoKitFacts["runsInFlight"]): RepoKitFacts => ({
    repo: "owner/product",
    branch: "main",
    config: { ok: true, config: DEFAULT_KIT_CONFIG },
    dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [] } },
    headChecks: {},
    runsInFlight,
  });

  it("names max_in_flight for a Ticket only it holds, as Research runs fill it and never reach the Merge gate", () => {
    const standings = standingsIn({ openIssues: [ready] }, { kit: kit([aRunInFlight({ role: "research", issue: 30 }), aRunInFlight({ role: "research", issue: 31 })]) });
    expect(standings.filter(({ issue }) => issue === 14).map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "waiting-for-slot", detail: { slot: "max-in-flight", maxInFlight: 2 } },
    ]);
  });
});

describe("a run that was asked for and never began (#607)", () => {
  const LABELLED = "2026-11-08T19:20:00Z";
  const STUCK_AT = "2026-11-08T22:50:00.000Z";
  const asked = { openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("agent:implement", LABELLED)] })] };

  it("is not-started before the bar and stuck after it, the Kit's move still, but the Operator's to act on and stopping work", () => {
    expect(standingsIn(asked, {}, "2026-11-08T22:49:00Z")).toMatchObject([{ name: "not-started", move: "kit", yours: false, stopsWork: false, stuckAt: STUCK_AT }]);
    expect(standingsIn(asked, {}, "2026-11-08T22:51:00Z")).toMatchObject([
      { name: "stuck", move: "kit", yours: true, stopsWork: true, since: LABELLED, stuckAt: STUCK_AT, detail: { was: "not-started", silence: "trigger-label", label: "agent:implement" } },
    ]);
  });

  it.each([
    ["before the bar", "2026-11-08T22:49:00Z"],
    ["at the bar", STUCK_AT],
    ["after the bar", "2026-11-09T09:00:00Z"],
  ])("reads a kept Standing at a later time as the rule reads the same facts then, %s", (_, later) => {
    const kept = standingsIn(asked, {}, "2026-11-08T20:00:00Z");
    expect(kept.map((standing) => standingAt(standing, later))).toStrictEqual(standingsIn(asked, {}, later));
  });

  it("leaves a kept Standing with no stuckAt, or one already stuck, as it is", () => {
    const pass = aVerdictComment("pass", HEAD, "2026-11-05T20:00:00Z");
    const [atTheGate] = standingsIn({ openPullRequests: [anOpenPullRequest({ draft: false, comments: [pass] })] });
    const [stuck] = standingsIn(asked, {}, "2026-11-09T09:00:00Z");
    expect(standingAt(atTheGate!, "2027-01-01T00:00:00Z")).toBe(atTheGate);
    expect(standingAt(stuck!, "2027-01-01T00:00:00Z")).toBe(stuck);
  });
});

describe("every other silence, and a draft the Operator parked (#608)", () => {
  const PUSHED = "2026-11-08T19:20:00Z";
  /** Agent draft #50 for Ticket 7, last pushed by the Fabrik App at PUSHED. */
  const draft = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) => anOpenPullRequest({ number: 50, ticket: 7, commits: [{ at: PUSHED, byApp: true }], ...overrides });
  const kit = (runsInFlight: readonly RunInFlightFact[] = []) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {} }) as const;

  it("gives a quiet draft waiting on the Kit a minute before the bar and Stuck a minute after it", () => {
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit() }, "2026-11-08T22:49:00Z")).toMatchObject([
      { issue: 7, pullRequest: 50, name: "waiting-on-kit", stuckAt: "2026-11-08T22:50:00.000Z", detail: { silence: "quiet-draft" } },
    ]);
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit() }, "2026-11-08T22:51:00Z")).toMatchObject([{ name: "stuck", detail: { was: "waiting-on-kit" } }]);
  });

  it("gives a draft with a pass the Operator put back in draft parked, theirs, stopping no work and never Stuck; never taken out of draft, the passed-draft silence", () => {
    const pass = aVerdictComment("pass", HEAD, PUSHED);
    const parked = draft({ comments: [pass], draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: "2026-11-08T19:21:00Z" }, { kind: "draft", actor: "operator", at: "2026-11-08T19:40:00Z" }] });
    expect(standingsIn({ openPullRequests: [parked] }, { kit: kit() }, "2027-01-01T00:00:00Z")).toMatchObject([
      { name: "parked", move: "operator", yours: true, stopsWork: false, since: "2026-11-08T19:40:00Z", stuckAt: null },
    ]);
    expect(standingsIn({ openPullRequests: [draft({ comments: [pass] })] }, { kit: kit() })).toMatchObject([{ name: "waiting-on-kit", since: PUSHED, detail: { silence: "passed-draft" } }]);
  });

  it("gives a draft with a run in flight on it running, and one whose Ticket's run is held held", () => {
    expect(standingsIn({ openPullRequests: [draft()] }, { kit: kit([aRunInFlight({ role: "review", pullRequest: 50 })]) })).toMatchObject([{ issue: 7, pullRequest: 50, name: "running" }]);
    const held = aWeeklyLimitIssue(null, [{ role: "implement", issue: 7, label: "agent:implement" }], { commentedAt: ["2026-11-08T10:00:00Z"] });
    expect(standingsIn({ openPullRequests: [draft()], kitIssues: [held] }, { kit: kit() })).toMatchObject([{ issue: 7, pullRequest: 50, name: "held" }]);
  });

  it("gives a releasable Ticket with a free slot waiting on the Kit with no stuckAt", () => {
    const ready = anOpenIssue({ number: 14, labels: ["ready-for-agent"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-05T12:00:00Z")] });
    const releasing = { ...kit(), dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [] } } };
    expect(standingsIn({ openIssues: [ready] }, { kit: releasing })).toMatchObject([{ issue: 14, name: "waiting-on-kit", stuckAt: null, detail: { silence: "releasable" } }]);
  });
});

describe("a merged agent pull request at Production (#634)", () => {
  const MERGED = "2026-11-08T19:30:00Z";
  const MERGE = "m".repeat(40);
  const kit = (production: KitConfig["production"]) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production } }, dispatch: null, runsInFlight: [], headChecks: {} }) as const;
  const TRACKED = kit({ url: "https://shop.example", environment: "production" });
  /** The Standings of agent pull request 50, merged at `mergedAt`, in a repo declaring production with environment `production`, with this Deployments fact. */
  const atProduction = (deploys: StandingFacts["deployments"], { mergedAt = MERGED, now = NOW, overrides = {} as Partial<Omit<StandingFacts, "kind" | "github">> } = {}) =>
    standingsIn({}, { kit: TRACKED, mergedLastDay: [aMergedLastDay(mergedAt)], deployments: deploys, ...overrides }, now);
  const read = (deploy: Parameters<typeof aDeployOf>[0] | "unread") => aDeploymentsRead({ [MERGE]: deploy === "unread" ? "unread" : aDeployOf(deploy) });

  it("is live once a deploy that counts succeeded, nobody's move, since the deciding report, carrying its Ticket though closed", () => {
    expect(atProduction(read({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }))).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "production",
        name: "live",
        move: "nobody",
        yours: false,
        stopsWork: false,
        since: "2026-11-08T19:40:00Z",
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { mergeCommit: MERGE, mergedAt: MERGED, environment: "production", noDeployAt: null, deployment: 900, log: null, deploysUnread: false },
      },
    ]);
  });

  it("is deploying while a deploy that counts is running, the Kit's move, since the Deployment's creation; not live", () => {
    expect(atProduction(read({ is: "running", deployment: 901, commit: MERGE, at: "2026-11-08T19:35:00Z" }))).toMatchObject([
      { issue: 7, pullRequest: 50, place: "production", name: "deploying", move: "kit", yours: false, stopsWork: false, since: "2026-11-08T19:35:00Z", stuckAt: null, awaits: null, detail: { deployment: 901, noDeployAt: null, deploysUnread: false } },
    ]);
  });

  it("is deploy failed when the newest that counts failed and none succeeded or is running, since the failed report, with its log; not deploying", () => {
    const log = "https://github.com/owner/product/actions/runs/40/job/41";
    expect(atProduction(read({ is: "failed", deployment: 902, commit: MERGE, at: "2026-11-08T19:45:00Z", log }))).toMatchObject([
      { place: "production", name: "deploy-failed", move: "nobody", since: "2026-11-08T19:45:00Z", detail: { deployment: 902, log, noDeployAt: null, deploysUnread: false } },
    ]);
  });

  it("is merged in the first hour with none started, since the merge, with when it turns no deploy seen; and no deploy seen a minute after the hour, since its end", () => {
    const merged = atProduction(read({ is: "none" }), { now: "2026-11-08T20:29:00Z" });
    expect(merged).toMatchObject([
      { place: "production", name: "merged", move: "nobody", since: MERGED, detail: { noDeployAt: "2026-11-08T20:30:00.000Z", deployment: null, deploysUnread: false } },
    ]);
    const unseen = atProduction(read({ is: "none" }), { now: "2026-11-08T20:31:00Z" });
    expect(unseen).toMatchObject([{ place: "production", name: "no-deploy-seen", move: "nobody", since: "2026-11-08T20:30:00.000Z", detail: { noDeployAt: null, deploysUnread: false } }]);
    expect(merged.map((standing) => standingAt(standing, "2026-11-08T20:31:00Z"))).toStrictEqual(unseen);
  });

  it("turns no deploy seen into deploying when a deploy starts after the hour", () => {
    const later = { now: "2026-11-08T21:00:00Z" };
    expect(atProduction(read({ is: "none" }), later)).toMatchObject([{ name: "no-deploy-seen" }]);
    expect(atProduction(read({ is: "running", deployment: 903, commit: MERGE, at: "2026-11-08T20:50:00Z" }), later)).toMatchObject([
      { name: "deploying", since: "2026-11-08T20:50:00Z" },
    ]);
  });

  it("is merged with its deploys unread, and never no deploy seen, when the Deployments read is missing, or unread for this merge", () => {
    const unread = { place: "production", name: "merged", since: MERGED, detail: { noDeployAt: null, deploysUnread: true } };
    expect(atProduction(undefined, { now: "2026-11-08T23:00:00Z" })).toMatchObject([unread]);
    expect(atProduction(null, { now: "2026-11-08T23:00:00Z" })).toMatchObject([unread]);
    expect(atProduction(read("unread"), { now: "2026-11-08T23:00:00Z" })).toMatchObject([unread]);
    expect(atProduction(aDeploymentsRead({}), { now: "2026-11-08T23:00:00Z" })).toMatchObject([unread]);
  });

  it("is merged with place null, for 24 hours, in a repo that declares an address and no environment", () => {
    const untracked = { kit: kit({ url: "https://shop.example", environment: null }) };
    for (const now of ["2026-11-08T20:00:00Z", "2026-11-09T19:29:00Z"]) {
      expect(atProduction(read({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }), { now, overrides: untracked })).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: null,
          name: "merged",
          move: "nobody",
          yours: false,
          stopsWork: false,
          since: MERGED,
          stuckAt: null,
          awaits: null,
          subscription: null,
          detail: { mergeCommit: MERGE, mergedAt: MERGED, environment: null, noDeployAt: null, deployment: null, log: null, deploysUnread: false },
        },
      ]);
    }
  });

  it("carries a null issue when the merged pull request names no Ticket", () => {
    expect(standingsIn({}, { kit: TRACKED, mergedLastDay: [aMergedLastDay(MERGED, { ticket: null })] })).toMatchObject([{ issue: null, pullRequest: 50, name: "merged" }]);
  });

  it("gives none with no production block, with an invalid Kit config even with ui.before_url set, or with the merges unread", () => {
    const ui = { paths: ["src/**"], serve: "npm run dev", url: "http://localhost:3000", beforeUrl: "https://shop.example", defaultRoutes: ["/"] };
    const merges = { mergedLastDay: [aMergedLastDay(MERGED)], deployments: read({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" }) };
    expect(standingsIn({}, { ...merges, kit: { ...kit(null), config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, ui, production: null } } } })).toEqual([]);
    expect(standingsIn({}, { ...merges, kit: { ...TRACKED, config: { ok: false, errors: ["max_in_flight must be a whole number"] } } })).toEqual([]);
    expect(standingsIn({}, { ...merges, kit: null })).toEqual([]);
    expect(standingsIn({}, { kit: TRACKED, deployments: merges.deployments })).toEqual([]);
  });

  it("stands at 24 hours from the merge and is gone a minute after, whatever the deploys say", () => {
    const live = read({ is: "succeeded", deployment: 900, commit: MERGE, at: "2026-11-08T19:40:00Z" });
    // Read straight from the rule: a minute later the rule drops it, which a kept Standing read later cannot.
    const ruleAt = (now: string) => standingsOf(standingFactsOf({ kit: TRACKED, mergedLastDay: [aMergedLastDay(MERGED)], deployments: live }), now);
    expect(ruleAt("2026-11-09T19:30:00Z")).toMatchObject([{ name: "live" }]);
    expect(ruleAt("2026-11-09T19:31:00Z")).toEqual([]);
    expect(atProduction(read({ is: "none" }), { now: "2026-11-09T19:31:00Z" })).toEqual([]);
    expect(atProduction(undefined, { now: "2026-11-09T19:31:00Z" })).toEqual([]);
  });

  it("gives none from the Weekly summary's facts, whose merged pull requests reach back 97 days, with one merged an hour ago and production declared", () => {
    expect(standingsIn({ pullRequests: [aMergedPullRequest("2026-11-08T19:00:00Z")] }, { kit: TRACKED })).toEqual([]);
  });

  it("is never yours, never stops work and never carries a stuckAt, whatever its name", () => {
    const atAll = produced.flatMap(({ standings }) => standings).filter(({ pullRequest, work }) => work === "ticket" && pullRequest === 50);
    const names = new Set(atAll.map(({ name }) => name));
    expect([...names].filter((name) => ["deploying", "live", "deploy-failed", "no-deploy-seen", "merged"].includes(name)).toSorted()).toEqual(["deploy-failed", "deploying", "live", "merged", "no-deploy-seen"]);
    for (const standing of atAll.filter(({ place }) => place === "production" || place === null)) expect(standing).toMatchObject({ yours: false, stopsWork: false, stuckAt: null, awaits: null });
  });
});

describe("a passed draft waiting on its Digest (#654)", () => {
  const PASSED = "2026-11-08T19:20:00Z";
  const ASKED = "2026-11-08T19:21:00Z";
  const kit = (runsInFlight: readonly RunInFlightFact[] = [], config: KitConfig = DEFAULT_KIT_CONFIG) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {} }) as const;
  /** Agent draft #50 for Ticket 7, passed on its head at PASSED, the Fabrik App adding `agent:digest` at ASKED. */
  const waiting = (overrides: Parameters<typeof anOpenPullRequest>[0] = {}) =>
    anOpenPullRequest({ number: 50, ticket: 7, comments: [aVerdictComment("pass", HEAD, PASSED)], labelEvents: [aLabelAdded("agent:digest", ASKED)], ...overrides });
  /** A Digest run in flight on a pull request, read exactly: Actions run 4410, its job given a runner at 19:23. */
  const aDigestRunOn = (pullRequest: number, overrides: Partial<RunInFlightFact> = {}) =>
    aRunInFlight({ role: "digest", issue: 7, pullRequest, exact: true, run: 4410, createdAt: "2026-11-08T19:22:00Z", startedAt: "2026-11-08T19:23:00Z", ...overrides });

  it("is running while a Digest job is in flight on it: at Review, the Kit's, awaiting the role digest on the pull request, the pass shown as given", () => {
    expect(standingsIn({ openPullRequests: [waiting()] }, { kit: kit([aDigestRunOn(50)]) })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "review",
        name: "running",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: "2026-11-08T19:23:00Z",
        stuckAt: null,
        awaits: { role: "digest", on: "pullRequest" },
        subscription: null,
        detail: { run: "digest", retry: null, actionsRun: 4410, passed: true, head: HEAD },
      },
    ]);
  });

  it("is not-started while the label is on and no Digest job is in flight, from when the label was last added, turning Stuck at the bar after it", () => {
    expect(standingsIn({ openPullRequests: [waiting()] }, { kit: kit() })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: 50,
        work: "ticket",
        place: "review",
        name: "not-started",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: ASKED,
        stuckAt: "2026-11-08T22:51:00.000Z",
        awaits: { role: "digest", on: "pullRequest" },
        subscription: null,
        detail: { silence: "trigger-label", label: "agent:digest", passed: true, head: HEAD },
      },
    ]);
  });

  it("reads as not-started a minute before the bar and as Stuck a minute after it, the Operator's to act on and stopping work, the pass still shown as given", () => {
    const [before] = standingsIn({ openPullRequests: [waiting()] }, { kit: kit() }, "2026-11-08T22:50:00Z");
    const [after] = standingsIn({ openPullRequests: [waiting()] }, { kit: kit() }, "2026-11-08T22:52:00Z");
    expect(before).toMatchObject({ name: "not-started", move: "kit", yours: false, stopsWork: false });
    expect(after).toEqual({ ...before, name: "stuck", yours: true, stopsWork: true, detail: { was: "not-started", silence: "trigger-label", label: "agent:digest", passed: true, head: HEAD } });
  });

  it("keeps the bar where the recovery waits put it, 210 minutes on default timeouts, whatever time the Digest role is given", () => {
    const longDigest = { ...DEFAULT_KIT_CONFIG, roles: { ...DEFAULT_KIT_CONFIG.roles, digest: { ...DEFAULT_KIT_CONFIG.roles.digest, timeoutMinutes: 240 } } };
    expect(standingsIn({ openPullRequests: [waiting()] }, { kit: kit([], longDigest) })).toMatchObject([{ name: "not-started", since: ASKED, stuckAt: "2026-11-08T22:51:00.000Z" }]);
  });

  it("is not-started with the runs in flight unread, as no run is known then", () => {
    expect(standingsIn({ openPullRequests: [waiting()] }, { kit: { ...kit(), runsInFlight: "unread" } })).toMatchObject([{ name: "not-started", awaits: { role: "digest", on: "pullRequest" } }]);
  });

  it("is not made running by a Digest job on another pull request, though both close one Ticket", () => {
    const other = waiting({ number: 51, labelEvents: [aLabelAdded("agent:digest", "2026-11-08T19:21:30Z")] });
    expect(standingsIn({ openPullRequests: [waiting(), other] }, { kit: kit([aDigestRunOn(51)]) }).map(({ pullRequest, name, awaits }) => ({ pullRequest, name, awaits }))).toEqual([
      { pullRequest: 50, name: "not-started", awaits: { role: "digest", on: "pullRequest" } },
      { pullRequest: 51, name: "running", awaits: { role: "digest", on: "pullRequest" } },
    ]);
  });

  it("gives way to a run on its Ticket in flight beside the Digest's, which overtakes it", () => {
    const ticket = anOpenIssue({ number: 7, labels: ["ready-for-agent"] });
    const requestChanges = aRunInFlight({ role: "implement", issue: 7, pullRequest: 50, exact: true, kind: "request-changes", run: 4420, createdAt: "2026-11-08T19:30:00Z" });
    expect(standingsIn({ openIssues: [ticket], openPullRequests: [waiting()] }, { kit: kit([aDigestRunOn(50), requestChanges]) })).toMatchObject([
      { issue: 7, pullRequest: 50, name: "running", place: "implement", awaits: { role: "implement", on: "pullRequest" }, detail: { run: "request-changes", actionsRun: 4420 } },
    ]);
  });

  it("moves no clock on the Operator's comment", () => {
    const commented = waiting({ comments: [aVerdictComment("pass", HEAD, PASSED), aComment("Is this coming?", "2026-11-08T19:50:00Z", { author: "operator", byBot: false })] });
    expect(standingsIn({ openPullRequests: [commented] }, { kit: kit() })).toMatchObject([{ name: "not-started", since: ASKED, stuckAt: "2026-11-08T22:51:00.000Z" }]);
  });

  it("starts its clock again when the label is added again, whoever adds it", () => {
    const again = [aLabelAdded("agent:digest", ASKED), aLabelAdded("agent:digest", "2026-11-08T19:40:00Z", { action: "unlabeled" }), aLabelAdded("agent:digest", "2026-11-08T19:45:00Z", { actor: "operator" })];
    expect(standingsIn({ openPullRequests: [waiting({ labelEvents: again })] }, { kit: kit() })).toMatchObject([{ name: "not-started", since: "2026-11-08T19:45:00Z", stuckAt: "2026-11-08T23:15:00.000Z" }]);
  });

  describe("with no label and no run", () => {
    const TAKEN_OFF = "2026-11-08T19:50:00Z";
    const takenOff = [aLabelAdded("agent:digest", ASKED), aLabelAdded("agent:digest", TAKEN_OFF, { action: "unlabeled" })];

    it("is the silence of a passed draft whose Merge gate never opened, from the pass", () => {
      expect(standingsIn({ openPullRequests: [waiting({ labelEvents: [] })] }, { kit: kit() })).toMatchObject([
        { name: "waiting-on-kit", since: PASSED, stuckAt: "2026-11-08T22:50:00.000Z", awaits: { role: "review", on: "pullRequest" }, detail: { silence: "passed-draft" } },
      ]);
    });

    it("restarts that silence's clock when the Fabrik App takes agent:digest off, so a draft whose Digest attempt just ended gets the full bar", () => {
      const [standing] = standingsIn({ openPullRequests: [waiting({ labelEvents: takenOff })] }, { kit: kit() });
      expect(standing).toMatchObject({ name: "waiting-on-kit", since: PASSED, stuckAt: "2026-11-08T23:20:00.000Z", detail: { silence: "passed-draft" } });
      expect(standing?.detail).not.toHaveProperty("passed");
    });

    it("leaves that clock where it was when a person takes the label off", () => {
      const byOperator = [aLabelAdded("agent:digest", ASKED, { actor: "operator" }), aLabelAdded("agent:digest", TAKEN_OFF, { action: "unlabeled", actor: "operator" })];
      expect(standingsIn({ openPullRequests: [waiting({ labelEvents: byOperator })] }, { kit: kit() })).toMatchObject([{ name: "waiting-on-kit", stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });

    it("stays that silence though a Digest job is in flight on it, the label being what asks for one", () => {
      expect(standingsIn({ openPullRequests: [waiting({ labelEvents: takenOff })] }, { kit: kit([aDigestRunOn(50)]) })).toMatchObject([{ name: "waiting-on-kit", detail: { silence: "passed-draft" } }]);
    });
  });

  it("is yours to merge once the gate opens: the label off and the pull request out of draft, since the pass", () => {
    const opened = waiting({
      draft: false,
      labelEvents: [aLabelAdded("agent:digest", ASKED), aLabelAdded("agent:digest", "2026-11-08T19:30:00Z", { action: "unlabeled" })],
      draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: "2026-11-08T19:30:01Z" }],
    });
    expect(standingsIn({ openPullRequests: [opened] }, { kit: kit() })).toMatchObject([
      { name: "yours-to-merge", place: "merge-gate", move: "operator", yours: true, stopsWork: true, since: PASSED, stuckAt: null, awaits: null, detail: { plain: null } },
    ]);
  });

  it("reads a pull request at the Merge gate with the label on as yours to merge, and a draft whose head moved since its pass as any quiet draft", () => {
    expect(standingsIn({ openPullRequests: [waiting({ draft: false })] }, { kit: kit([aDigestRunOn(50)]) })).toMatchObject([{ name: "yours-to-merge" }]);
    const moved = waiting({ headSha: "n".repeat(40), commits: [{ at: "2026-11-08T19:40:00Z", byApp: true }] });
    const [standing] = standingsIn({ openPullRequests: [moved] }, { kit: kit() });
    expect(standing).toMatchObject({ name: "waiting-on-kit", awaits: { role: "review", on: "pullRequest" }, detail: { silence: "quiet-draft" } });
    expect(standing?.detail).not.toHaveProperty("passed");
  });
});

// After every test above: these read what they produced.
describe("a Standing, as plain data", () => {
  const MINUTE = 60 * 1000;
  const fixture = JSON.parse(readFileSync(new URL("../__fixtures__/standings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
  const all = () => produced.flatMap(({ standings }) => standings);

  it("gives every open issue on the Loop exactly one, a Spec aside, and every open agent PR one it shares with its Ticket, in every read the tests above made, and none to an issue with no such label", () => {
    // The state labels, and the Kit's own labels on an issue whose rule needs no other fact.
    const onTheLoop = [NEEDS_TRIAGE, NEEDS_INFO, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN, WEEKLY_LIMIT_LABEL, TOKEN_ROTATION_LABEL, USAGE_CREDITS_LABEL];
    let issues = 0;
    for (const { facts, standings } of produced) {
      const { openIssues, openPullRequests, plainPullRequests } = facts.github;
      for (const pullRequest of openPullRequests) {
        const its = standings.filter((standing) => standing.pullRequest === pullRequest.number);
        expect(its, `#${pullRequest.number}`).toHaveLength(1);
        if (openIssues.some(({ number }) => number === pullRequest.ticket)) expect(its[0]?.issue).toBe(pullRequest.ticket);
      }
      for (const issue of openIssues) {
        const its = standings.filter((standing) => standing.issue === issue.number);
        const closing = openPullRequests.filter(({ ticket }) => ticket === issue.number).length;
        if (issue.labels.some((label) => onTheLoop.includes(label)) && !isSpec(issue)) {
          issues += 1;
          // Two open agent PRs that close one Ticket are kept apart.
          expect(its, `#${issue.number}`).toHaveLength(Math.max(1, closing));
        } else if (issue.labels.length === 0 && closing === 0 && !plainPullRequests.some(({ closes }) => closes.includes(issue.number))) {
          expect(its, `#${issue.number}`).toEqual([]);
        }
      }
    }
    expect(issues).toBeGreaterThan(0);
  });

  it("survives a JSON round trip unchanged, every one the tests above produced", () => {
    expect(all().length).toBeGreaterThan(0);
    for (const standing of all()) expect(JSON.parse(JSON.stringify(standing))).toStrictEqual(standing);
  });

  it("stops work only when the Operator's, never for reading matter or a parked draft, and always for any other move of theirs but a Plain pull request's or a failed Weekly summary run's", () => {
    for (const standing of all()) {
      if (!standing.yours || standing.name === "yours-to-read" || standing.name === "parked") expect(standing).toMatchObject({ stopsWork: false });
      else if (standing.work !== "plain" && standing.work !== "weekly-summary") expect(standing).toMatchObject({ stopsWork: true });
    }
    expect(all().some(({ name }) => name === "yours-to-read")).toBe(true);
  });

  it("is the same for the same facts read a minute later, but for a Standing that crossed its bar then", () => {
    let crossed = 0;
    for (const { facts, now, standings } of produced) {
      const later = new Date(Date.parse(now) + MINUTE).toISOString();
      const read = standingsOf(facts, later);
      crossed += read.filter((standing, at) => standing.name !== standings[at]?.name).length;
      expect(read).toStrictEqual(standings.map((standing) => standingAt(standing, later)));
    }
    expect(crossed).toBeGreaterThan(0);
  });

  // A passed draft waiting on its Digest has no name of its own (#654): the fixture holds it under each name it takes, after one of each name.
  const WAITING_ON_ITS_DIGEST = ["running (digest)", "not-started (digest)", "stuck (digest)"];

  it("has one of each name so far in the schema fixture, in the order of the names, then a passed draft waiting on its Digest under each name it takes", () => {
    const names = new Set(all().map(({ name }) => name));
    expect(Object.keys(fixture)).toEqual([...STANDING_NAMES.filter((name) => names.has(name)), ...WAITING_ON_ITS_DIGEST]);
  });

  it("holds, for a passed draft waiting on its Digest, Standings the rule gave above, each awaiting the role digest on the pull request with the pass shown as given", () => {
    for (const key of WAITING_ON_ITS_DIGEST) {
      expect(all(), key).toContainEqual(fixture[key]);
      expect(fixture[key], key).toMatchObject({ place: "review", move: "kit", awaits: { role: "digest", on: "pullRequest" }, detail: { passed: true } });
    }
  });

  it("has the fixture's fields, and its detail's, so removing or renaming one fails here", () => {
    for (const [key, kept] of Object.entries(fixture)) {
      const name = key.replace(/ \(digest\)$/, "");
      // A stuck Standing's detail is the name it was's: the fixture's is matched by its `was`.
      const was = (kept.detail as { was?: string }).was;
      // `detail.head` is on a Standing with an open pull request only: the fixture's is matched by whether it has one.
      // `detail.passed` is on a passed draft waiting on its Digest only: the fixture's is matched by whether it has it.
      // `detail.mergeGate` is on a Ticket caps.merge_gate holds only (#459): the fixture's is matched by whether it has it.
      // `detail.passedAt` is on an agent pull request at the Merge gate whose checks aren't all passed only (#564): likewise.
      const standing = all().find(
        (read) =>
          read.name === name &&
          (was === undefined || ("was" in read.detail && read.detail.was === was)) &&
          (read.pullRequest === null) === (kept["pullRequest"] === null) &&
          "passed" in read.detail === "passed" in (kept.detail as object) &&
          "mergeGate" in read.detail === "mergeGate" in (kept.detail as object) &&
          "passedAt" in read.detail === "passedAt" in (kept.detail as object),
      );
      if (standing === undefined) throw new Error(`no test above produces a ${name} Standing`);
      expect(Object.keys(kept).toSorted()).toEqual(Object.keys(standing).toSorted());
      expect(Object.keys(kept.detail as object).toSorted()).toEqual(Object.keys(standing.detail).toSorted());
      expect(kept).toMatchObject({ schema: STANDING_SCHEMA, name });
    }
  });
});
