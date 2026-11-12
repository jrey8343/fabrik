import { describe, expect, it } from "vitest";
import { PAST_HAND_BACK_NOTICES } from "../__fixtures__/handBackWordings.ts";
import { aPullRequest } from "../__fixtures__/snapshots.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aRunInFlight, aWeeklyLimitIssue, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { conflictRunEnded, requestChangesRunEnded } from "../loop/conflicts.ts";
import type { HandBack } from "../loop/handBacks.ts";
import { stopTicketOf } from "../loop/handClosing.ts";
import { stopForGoneKeptBranch } from "../loop/keptBranch.ts";
import { handBackMarker } from "../loop/markers.ts";
import { unstartedRetry } from "../loop/retry.ts";
import type { Action, AgentRole } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { landingFailureReport, pushLanding } from "./landingFailure.ts";
import { type Standing, standingsOf } from "./standing.ts";
import { handBackOfNotice } from "./standingHandBacks.ts";
import { wordStanding } from "./standingWording.ts";
import type { GitHubFacts } from "./weeklySummary.ts";

describe("reading which hand-back a notice is", () => {
  it("reads the hidden line, wherever it is", () => {
    const body = ["<!-- fabrik:implement-run-failed -->", "@operator The Implement run on #7 failed: it crashed.", "", handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "crash" })].join("\n");
    expect(handBackOfNotice(body)).toEqual({ kind: "infrastructure-failure", role: "implement", failure: "crash" });
  });

  it.each(PAST_HAND_BACK_NOTICES.map((notice) => [notice.release, notice.handBack, notice.role ?? "no role", notice] as const))(
    "reads a notice as %s wrote it as %s, by %s, as its marked successor names it, but the failure",
    (_release, handBack, _role, { role, body }) => {
      expect(handBackOfNotice(body)).toEqual({ kind: handBack, ...(role === undefined ? {} : { role }) });
    },
  );

  it("holds one past wording of every hand-back the Kit's notices have handed back by", () => {
    expect(new Set(PAST_HAND_BACK_NOTICES.map(({ handBack }) => handBack))).toEqual(
      new Set([
        "infrastructure-failure",
        "broken-run-no-retry",
        "trigger-swept",
        "retry-never-started",
        "landing-failed",
        "request-changes-empty",
        "conflict-run-unlanded",
        "request-changes-unlanded",
        "closed-by-hand",
        "kept-branch-gone",
        "research-failed",
        "design-turn-failed",
      ]),
    );
  });

  it.each([
    ["a counted Broken run, an Execution flaw the Kit re-runs itself", "<!-- fabrik:broken-run -->\nThe Implement run on #7 was a Broken run, and the Kit opened no PR: it crashed. A Broken run is an Execution flaw: retry 1 of 2 starts now."],
    ["a Request-changes run that committed nothing on a head that moved", "<!-- fabrik:request-changes-run-empty -->\nThe Request-changes run on #50 committed nothing to `fabrik/ticket-7` on top of aaaaaaa, the head it started on, which moved to bbbbbbb while it worked. Review runs on bbbbbbb, and its Verdict decides what's next. No retry was used."],
    ["the sweep's first strike", "<!-- fabrik:stuck-trigger-readded agent:implement -->\n`agent:implement` sat 40 minutes with no run behind it, so the Kit added it again."],
    ["a failed Audit run, which the tick tries again", "@operator The Audit run on #30 failed: it crashed.\n\nThis is an Infrastructure failure, so the Loop won't retry it. The next scheduled tick opens a new Audit."],
    ["a person's word", "Any news on this?"],
  ])("reads nothing from %s", (_what, body) => {
    expect(handBackOfNotice(body)).toBeNull();
  });
});

const NOW = "2026-11-08T20:00:00Z";
const APP = "fabrik-app[bot]";

function standingsIn(github: Partial<GitHubFacts>): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github) }), NOW);
}

/** The Fabrik App's failure notice for the Implement run on #7, as the Kit writes it now. */
const infrastructureFailure = (at: string) =>
  aComment(
    [
      "<!-- fabrik:implement-run-failed -->",
      "@operator The Implement run on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `agent:implement` on this Ticket to run it again.",
      "",
      "[The run](https://github.com/owner/product/actions/runs/42/attempts/1)",
      handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "crash" }),
    ].join("\n"),
    at,
  );

describe("work the Kit hands back", () => {
  it("gives a Ticket whose run ended in an Infrastructure failure yours-to-do at once, stopping work, since the notice, naming the hand-back", () => {
    const standings = standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [infrastructureFailure("2026-11-08T19:59:00Z")] })] });
    expect(standings).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: null,
        work: "ticket",
        place: "implement",
        name: "yours-to-do",
        move: "operator",
        yours: true,
        stopsWork: true,
        since: "2026-11-08T19:59:00Z",
        stuckAt: null,
        awaits: null,
        subscription: null,
        detail: { handBack: "infrastructure-failure", role: "implement", failure: "crash", label: "agent:implement" },
      },
    ]);
  });

  it("gives it the moment the Kit says so: a notice posted at the filing is already the Operator's, with no bar to wait out", () => {
    const [standing] = standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [infrastructureFailure(NOW)] })] });
    expect(standing).toMatchObject({ name: "yours-to-do", yours: true, stuckAt: null, since: NOW });
    // A plain value: written as JSON and read back, it is equal.
    expect(JSON.parse(JSON.stringify(standing))).toEqual(standing);
  });

  it("is no longer the Operator's once they add the resuming label, nor once the Kit has said anything since", () => {
    const readded = anOpenIssue({
      number: 7,
      labels: ["ready-for-agent", "agent:implement"],
      comments: [infrastructureFailure("2026-11-08T18:00:00Z")],
      labelEvents: [aLabelAdded("agent:implement", "2026-11-08T19:00:00Z", { actor: "operator" })],
    });
    const spokenSince = anOpenIssue({ number: 8, labels: ["ready-for-agent"], comments: [infrastructureFailure("2026-11-08T18:00:00Z"), aComment("The Kit's later word.", "2026-11-08T19:00:00Z")] });
    expect(standingsIn({ openIssues: [readded, spokenSince] }).filter(({ name }) => name === "yours-to-do")).toEqual([]);
  });

  it("reads only the Fabrik App's comments: a person quoting a notice, marker and all, hands nothing back", () => {
    const quoted = { ...infrastructureFailure("2026-11-08T19:00:00Z"), author: "operator", byBot: false };
    const otherBot = { ...infrastructureFailure("2026-11-08T19:00:00Z"), author: "dependabot[bot]" };
    expect(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [quoted] }), anOpenIssue({ number: 8, labels: ["ready-for-agent"], comments: [otherBot] })] }).filter(({ move }) => move === "operator")).toEqual([]);
  });

  it("gives no yours-to-do for a Broken run the Kit counted as an Execution flaw, which it re-runs itself", () => {
    const counted = aComment(
      "<!-- fabrik:broken-run -->\nThe Implement run on #7 was a Broken run, and the Kit opened no PR: the Implementer left its branch. A Broken run is an Execution flaw: retry 1 of 2 starts now.\n\n[The run](https://github.com/owner/product/actions/runs/42/attempts/1)",
      "2026-11-08T19:00:00Z",
    );
    // It waits on the Kit (#608), the Operator's in no way.
    expect(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], comments: [counted] })] }).filter(({ move }) => move === "operator")).toEqual([]);
  });

  it("gives a Ticket a held marker names held, not yours-to-do, whatever failure notice is its latest word", () => {
    const standings = standingsIn({
      openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [infrastructureFailure("2026-11-08T19:00:00Z")] })],
      kitIssues: [aWeeklyLimitIssue(null, [{ role: "implement", issue: 7, label: "agent:implement" }], { createdAt: "2026-11-08T18:00:00Z" })],
    });
    expect(standings.find(({ issue }) => issue === 7)).toMatchObject({ name: "held", move: "kit" });
  });

  it("wins over a run in flight for the same work", () => {
    const standings = standingsOf(
      standingFactsOf({
        github: factsOf({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [infrastructureFailure("2026-11-08T19:30:00Z")] })] }),
        kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [aRunInFlight({ issue: 7 })], headChecks: {} },
      }),
      NOW,
    );
    expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([{ issue: 7, name: "yours-to-do" }]);
  });

  it.each(PAST_HAND_BACK_NOTICES.filter(({ handBack }) => handBack === "infrastructure-failure" || handBack === "broken-run-no-retry").map((notice) => [notice.release, notice.handBack, notice] as const))(
    "reads a notice as %s wrote it as the same hand-back, %s, as its marked successor, the failure aside",
    (_release, handBack, { role, body }) => {
      const onPullRequest = role === "review";
      const notice = aComment(body, "2026-11-08T19:00:00Z");
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: onPullRequest ? [] : [notice] })],
        openPullRequests: onPullRequest ? [anOpenPullRequest({ number: 50, ticket: 7, comments: [notice] })] : [],
      });
      expect(standings.map(({ name, detail }) => ({ name, detail }))).toEqual([
        { name: "yours-to-do", detail: { handBack, role: role ?? null, failure: null, label: role === "review" ? "agent:review" : role === "triage" ? "needs-triage" : "agent:implement" } },
      ]);
    },
  );

  it("gives a ready-for-human issue whose notice the rule doesn't recognise yours-to-do with no hand-back named", () => {
    const standings = standingsIn({
      openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-human"], createdAt: "2026-11-01T00:00:00Z", comments: [aComment("The Kit has a word on this nobody taught the rule.", "2026-11-08T19:00:00Z")] })],
    });
    expect(standings.map(({ name, work, detail }) => ({ name, work, detail }))).toEqual([{ name: "yours-to-do", work: "ready-for-human", detail: { handBack: null, role: null, failure: null, label: null } }]);
  });

  describe("by each notice that hands work back", () => {
    const at = "2026-11-08T19:00:00Z";
    const said = (actions: readonly Action[]) => aComment(actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []))[0] ?? "", at);
    const handedBackIn = (standings: readonly Standing[]) => standings.map(({ issue, pullRequest, name, work, place, since, detail }) => ({ issue, pullRequest, name, work, place, since, detail }));
    const readyForHuman = aLabelAdded("ready-for-human", at);

    it("a Ticket whose agent PR was closed by hand, while it carries ready-for-human", () => {
      const ticket = anOpenIssue({ number: 7, labels: ["ready-for-human"], comments: [said(stopTicketOf({ kind: "pull-request-closed", pullRequest: 50, merged: false, closedByBot: false }, aPullRequest({ number: 50, ticket: 7, open: false, ticketLabels: ["ready-for-agent"] }), "operator"))], labelEvents: [readyForHuman] });
      expect(handedBackIn(standingsIn({ openIssues: [ticket] }))).toEqual([
        { issue: 7, pullRequest: null, name: "yours-to-do", work: "ticket", place: null, since: at, detail: { handBack: "closed-by-hand", role: "implement", failure: null, label: "ready-for-agent" } },
      ]);
      expect(standingsIn({ openIssues: [{ ...ticket, labels: ["ready-for-agent"] }] }).filter(({ name }) => name === "yours-to-do")).toEqual([]);
    });

    it("a Ticket marked for a Kept-branch start whose Kept branch is gone", () => {
      const ticket = anOpenIssue({ number: 7, labels: ["ready-for-human", "fabrik:kept-branch"], comments: [said(stopForGoneKeptBranch(7, "operator"))], labelEvents: [readyForHuman] });
      expect(handedBackIn(standingsIn({ openIssues: [ticket] }))[0]?.detail).toEqual({ handBack: "kept-branch-gone", role: "implement", failure: null, label: "ready-for-agent" });
    });

    it.each([
      ["a conflict-only run that didn't land", conflictRunEnded(50, "d".repeat(40), "operator", "it changed nothing", "https://github.com/owner/product/actions/runs/42"), "conflict-run-unlanded"],
      ["a Request-changes run that didn't land", requestChangesRunEnded(50, "d".repeat(40), "operator", "it still conflicts", "https://github.com/owner/product/actions/runs/42"), "request-changes-unlanded"],
    ] as const)("an agent PR handed back by %s, at the Merge gate while it carries ready-for-human", (_what, actions, handBack) => {
      const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [said(actions)], labelEvents: [readyForHuman] });
      expect(handedBackIn(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [pullRequest] }))).toEqual([
        { issue: 7, pullRequest: 50, name: "yours-to-do", work: "ticket", place: "merge-gate", since: at, detail: { handBack, role: "implement", failure: null, label: null } },
      ]);
      const labelOff = { ...pullRequest, labelEvents: [readyForHuman, { ...readyForHuman, action: "unlabeled" as const, at: "2026-11-08T19:30:00Z" }] };
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [labelOff] }).filter(({ name }) => name === "yours-to-do")).toEqual([]);
    });

    it("a Retry that never started on a Ticket no longer ready-for-agent, on its draft", () => {
      const flaw = { verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) } as const;
      const ended = unstartedRetry(aPullRequest({ number: 50, ticket: 7, ticketLabels: ["enhancement"], verdicts: [flaw], verdictPostedAt: "2026-11-08T12:00:00Z", headSha: "a".repeat(40) }), "operator", "2026-11-08T19:00:00Z", 90, false);
      const standings = standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["enhancement"] })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, comments: [said(ended ?? [])] })] });
      expect(handedBackIn(standings)).toEqual([
        { issue: 7, pullRequest: 50, name: "yours-to-do", work: "ticket", place: "review", since: at, detail: { handBack: "retry-never-started", role: "implement", failure: null, label: "ready-for-agent" } },
      ]);
    });

    it("a trigger label the sweep took off, until it is added again", () => {
      const sweptNotice = aComment(
        [
          "<!-- fabrik:stuck-trigger-gave-up agent:review -->",
          "@operator `agent:review` came off: nothing started when it was added, nor when the Kit added it again. Check the Loop's Actions runs (an invalid Kit config is the usual cause), then add `agent:review` again once it's fixed.",
          handBackMarker({ kind: "trigger-swept", role: "review" }),
        ].join("\n"),
        at,
      );
      const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, comments: [sweptNotice] });
      expect(handedBackIn(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [pullRequest] }))[0]?.detail).toEqual({
        handBack: "trigger-swept",
        role: "review",
        failure: null,
        label: "agent:review",
      });
      const readded = { ...pullRequest, labelEvents: [aLabelAdded("agent:review", "2026-11-08T19:10:00Z", { actor: "operator" })] };
      expect(standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [readded] }).filter(({ name }) => name === "yours-to-do")).toEqual([]);
    });

    it("a push job that failed landing a finished run", () => {
      const landing = pushLanding({ kind: "agent-result", role: "implement", issue: 7, pullRequest: null } as Parameters<typeof pushLanding>[0], "https://github.com/owner/product/actions/runs/42");
      const { comment } = landingFailureReport(landing!, { kind: "error", error: new Error("boom") }, "operator");
      const standings = standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"], comments: [aComment(comment?.body ?? "", at)] })] });
      expect(handedBackIn(standings)[0]?.detail).toEqual({ handBack: "landing-failed", role: "implement", failure: null, label: "agent:implement" });
    });

    it("a Broken run that used no retry, naming which", () => {
      const notice = aComment(
        [
          "<!-- fabrik:implement-run-failed -->",
          "@operator The Implement run on #7 failed: the Implementer left its branch, so its work couldn't be read off it.",
          "",
          "This is a Broken run on a Request-changes run, which uses no retry, so the Loop won't run it again. Re-add `agent:implement` on the Ticket (#7) to run it again.",
          handBackMarker({ kind: "broken-run-no-retry", role: "implement", failure: "left-branch" }),
        ].join("\n"),
        at,
      );
      const standings = standingsIn({ openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, comments: [notice] })] });
      expect(handedBackIn(standings)[0]?.detail).toEqual({ handBack: "broken-run-no-retry", role: "implement", failure: "left-branch", label: "agent:implement" });
    });

    it("a Request-changes run that committed nothing, while its PR carries ready-for-human", () => {
      const notice = aComment(
        [
          "<!-- fabrik:request-changes-run-empty -->",
          "@operator The Request-changes run on #50 committed nothing to `fabrik/ticket-7` on top of hhhhhhh, so your requested changes aren't built, and it's yours from here. No retry was used.",
          handBackMarker({ kind: "request-changes-empty", role: "implement" }),
        ].join("\n"),
        at,
      );
      const standings = standingsIn({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [notice], labelEvents: [readyForHuman] })],
      });
      expect(handedBackIn(standings)[0]?.detail).toEqual({ handBack: "request-changes-empty", role: "implement", failure: null, label: null });
    });

    describe("on a research Decision and a Design session, read with their own markers", () => {
      const map = anOpenIssue({ number: 30, labels: ["wayfinder:map"], subIssues: [31], createdAt: "2026-11-07T20:00:00Z" });
      const decision = (body: string) => anOpenIssue({ number: 31, labels: ["wayfinder:research"], comments: [aComment(body, at)] });
      const decisionIn = (body: string) => standingsIn({ openIssues: [map, decision(body)], openMaps: [30] }).find(({ issue }) => issue === 31);

      it("tells a research branch the Kit refused from a failed Research run by the hidden line, as its own hand-back", () => {
        const refused = ["<!-- fabrik:research-run-failed -->", "@operator The Researcher's branch for #31 doesn't write its findings file.", handBackMarker({ kind: "research-branch-refused", role: "research" })].join("\n");
        expect(decisionIn(refused)?.detail).toEqual({ handBack: "research-branch-refused", role: "research", failure: null, label: "agent:research" });
      });

      it("names which failure a marked Research run's notice says", () => {
        const failed = ["<!-- fabrik:research-run-failed -->", "@operator The Research run on #31 failed: it crashed.", handBackMarker({ kind: "research-failed", role: "research", failure: "crash" })].join("\n");
        expect(decisionIn(failed)?.detail).toEqual({ handBack: "research-failed", role: "research", failure: "crash", label: "agent:research" });
      });

      it("reads the sweep taking agent:research off as the trigger label swept, and on a Design session agent:design", () => {
        const swept = (label: string, marker: string, role: string) =>
          [marker, `<!-- fabrik:stuck-trigger-gave-up ${label} -->`, `@operator \`${label}\` came off: nothing started when it was added, nor when the Kit added it again.`, `<!-- fabrik:hand-back {"kind":"trigger-swept","role":"${role}"} -->`].join("\n");
        expect(decisionIn(swept("agent:research", "<!-- fabrik:research-run-failed -->", "research"))?.detail).toEqual({ handBack: "trigger-swept", role: "research", failure: null, label: "agent:research" });
        const session = anOpenIssue({ number: 12, labels: ["needs-design"], comments: [aComment(swept("agent:design", "<!-- fabrik:design-turn-failed -->", "design"), at)] });
        expect(standingsIn({ openIssues: [session] })[0]?.detail).toEqual({ handBack: "trigger-swept", role: "design", failure: null, label: "agent:design" });
      });
    });
  });
});

describe("the wording of work handed back", () => {
  const SINCE = "2026-11-08T12:00:00Z";
  const FORTY_MINUTES_ON = "2026-11-08T12:40:00Z";
  const handedBack = (handBack: HandBack, role: AgentRole | null, label: string | null, failure: string | null = null): Standing => ({
    schema: 1,
    repo: "owner/product",
    issue: 7,
    pullRequest: 50,
    work: "ticket",
    place: null,
    name: "yours-to-do",
    move: "operator",
    yours: true,
    stopsWork: true,
    since: SINCE,
    stuckAt: null,
    awaits: null,
    subscription: null,
    detail: { handBack, role, failure, label },
  });

  it.each<[string, Standing, string]>([
    ["an Infrastructure failure", handedBack("infrastructure-failure", "implement", "agent:implement", "crash"), "The Implement run ended in an Infrastructure failure 40 minutes ago and the Loop won't retry it. Add `agent:implement` again to run it."],
    ["a Design-session turn's Infrastructure failure", handedBack("infrastructure-failure", "design", "agent:design"), "The Design-session turn ended in an Infrastructure failure 40 minutes ago and the Loop won't retry it. Reply on the issue to run the turn again."],
    ["an old notice's Infrastructure failure, naming no run", handedBack("infrastructure-failure", null, null), "The run ended in an Infrastructure failure 40 minutes ago and the Loop won't retry it."],
    ["a Broken run that used no retry", handedBack("broken-run-no-retry", "implement", "agent:implement", "left-branch"), "The Implement run was a Broken run that used no retry. Add `agent:implement` again to run it."],
    ["a label the sweep took off", handedBack("trigger-swept", "review", "agent:review"), "`agent:review` came off 40 minutes ago: nothing started when it was added, nor when the Kit added it again. Check the Loop's runs, then add it again."],
    ["a Retry that never started", handedBack("retry-never-started", "implement", "ready-for-agent"), "The Retry never started and #7 is no longer `ready-for-agent`, so none will."],
    ["a failed push or claim job", handedBack("landing-failed", "implement", "agent:implement"), "The Kit couldn't land a finished run 40 minutes ago. Open the run and re-run its failed jobs."],
    ["a Request-changes run that committed nothing", handedBack("request-changes-empty", "implement", null), "The Request-changes run committed nothing, so your changes aren't built. It's yours from here."],
    ["a conflict-only run that didn't land", handedBack("conflict-run-unlanded", "implement", null), "The conflict-only run didn't bring #50 up to date with `main`."],
    ["a Request-changes run that didn't land", handedBack("request-changes-unlanded", "implement", null), "The Request-changes run on #50 didn't land."],
    ["an agent PR closed by hand", handedBack("closed-by-hand", "implement", "ready-for-agent"), "Its agent pull request was closed by hand, so the Ticket stopped."],
    ["a Kept branch gone", handedBack("kept-branch-gone", "implement", "ready-for-agent"), "Marked for a Kept-branch start, but the Kept branch is gone."],
    ["a research branch the Kit refused", handedBack("research-branch-refused", "research", "agent:research"), "The Kit refused the Research run's branch 40 minutes ago. Add `agent:research` again to run it."],
  ])("says of %s that it is yours to do, worded from the hand-back, never the notice", (_what, standing, sentence) => {
    expect(wordStanding(standing, FORTY_MINUTES_ON, "Australia/Sydney")).toEqual({ pill: "Yours to do", sentence, remedy: null });
  });
});
