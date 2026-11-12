import { describe, expect, it } from "vitest";
import { aComment, aDesignRound, aDesignTurnFailedNotice, aLabelAdded, aMapCapRefusal, aPlainPullRequest, aVerdictComment, anOpenAudit, anOpenIssue, anOpenPullRequest, anOpenReplay, anOpenRetro, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { resetsAtMarker } from "../loop/kitIssueMarks.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { subscriptionMarker } from "../loop/subscriptions.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf } from "./standing.ts";
import { ageSince, wordStanding } from "./standingWording.ts";
import type { CommentFacts, GitHubFacts, RequiredChecksFact } from "./weeklySummary.ts";

const SINCE = "2026-11-08T12:00:00Z";
const minutesAfter = (minutes: number) => new Date(Date.parse(SINCE) + minutes * 60 * 1000).toISOString();
const ZONE = "Australia/Sydney";

function theStandingIn(github: Partial<GitHubFacts>): Standing {
  const [standing, ...rest] = standingsOf(standingFactsOf({ github: factsOf(github) }), SINCE);
  if (standing === undefined || rest.length > 0) throw new Error("expected one Standing");
  return standing;
}

describe("the wording of a Standing", () => {
  const atTheGate = theStandingIn({
    openPullRequests: [anOpenPullRequest({ draft: false, comments: [aVerdictComment("pass", "h".repeat(40), SINCE)] })],
  });

  it("says an agent PR at the Merge gate is yours to merge, aged from the time it is given", () => {
    expect(wordStanding(atTheGate, minutesAfter(40), ZONE)).toEqual({
      pill: "Yours to merge",
      sentence: "Passed Review 40 minutes ago and is waiting for your merge.",
      remedy: null,
    });
    expect(wordStanding(atTheGate, minutesAfter(3 * 60), ZONE).sentence).toBe("Passed Review 3 hours ago and is waiting for your merge.");
  });

  it("says work handed back with ready-for-human, a PR or an issue, is yours to do", () => {
    const handedBack = theStandingIn({
      openPullRequests: [
        anOpenPullRequest({ draft: false, comments: [aVerdictComment("pass", "h".repeat(40), "2026-11-07T00:00:00Z")], labelEvents: [aLabelAdded("ready-for-human", SINCE)] }),
      ],
    });
    const issue = theStandingIn({ openIssues: [anOpenIssue({ labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", SINCE)] })] });
    for (const standing of [handedBack, issue]) {
      expect(wordStanding(standing, minutesAfter(5 * 24 * 60), ZONE)).toEqual({
        pill: "Yours to do",
        sentence: "Handed to you with `ready-for-human` 5 days ago.",
        remedy: null,
      });
    }
  });

  it("says a Design round has waited for the Operator's answer, and whether its prototype is ready or failed", () => {
    const round = (body: string) => theStandingIn({ openIssues: [anOpenIssue({ labels: ["needs-design"], comments: [aComment(body, SINCE)] })] });
    const plain = theStandingIn({ openIssues: [anOpenIssue({ labels: ["needs-design"], comments: [aDesignRound(2, SINCE)] })] });
    const ready = round(`${designRoundMarker(3)}\n${PROTOTYPE_ROUND_MARKER}\nWhich variant?`);
    const failed = round(`${designRoundMarker(4)}\n${PROTOTYPE_FAILURE_ROUND_MARKER}\nCarry on without one?`);
    expect(wordStanding(plain, minutesAfter(1), ZONE)).toEqual({ pill: "Design round 2", sentence: "Round 2 has waited for your answer since 1 minute ago.", remedy: null });
    expect(wordStanding(ready, minutesAfter(90), ZONE)).toEqual({
      pill: "Design round 3",
      sentence: "Round 3 has waited for your answer since 1 hour ago: the prototype is ready to look at.",
      remedy: null,
    });
    expect(wordStanding(failed, minutesAfter(90), ZONE)).toEqual({
      pill: "Design round 4",
      sentence: "Round 4 has waited for your answer since 1 hour ago: the prototype failed.",
      remedy: null,
    });
  });
});

describe("the wording of a Standing the Kit handed back", () => {
  it("says a Design-session turn failed, or the Map cap refused the session's Map, and that a reply carries on", () => {
    const stopped = (notice: CommentFacts) => theStandingIn({ openIssues: [anOpenIssue({ labels: ["needs-design"], comments: [notice] })] });
    expect(wordStanding(stopped(aDesignTurnFailedNotice(SINCE)), minutesAfter(2 * 60), ZONE)).toEqual({
      pill: "Yours to do",
      sentence: "A Design-session turn failed 2 hours ago. Reply on the issue to run it again.",
      remedy: null,
    });
    expect(wordStanding(stopped(aMapCapRefusal(SINCE)), minutesAfter(2 * 60), ZONE)).toEqual({
      pill: "Yours to do",
      sentence: "The Map cap refused this session's Map 2 hours ago. Reply on the issue to carry on.",
      remedy: null,
    });
  });
});

describe("the wording of a failed research run", () => {
  it("says the Research run failed and that adding agent:research again runs it", () => {
    const failed = theStandingIn({
      openIssues: [
        anOpenIssue({ number: 30, labels: ["wayfinder:map"], subIssues: [31] }),
        anOpenIssue({ number: 31, labels: ["wayfinder:research"], comments: [aComment(`${RESEARCH_RUN_FAILED_MARKER}\nThe Research run failed.`, SINCE)] }),
      ],
    });
    expect(wordStanding(failed, minutesAfter(5), ZONE)).toEqual({
      pill: "Yours to do",
      sentence: "The Research run failed 5 minutes ago. Add `agent:research` again to run it.",
      remedy: null,
    });
  });
});

describe("the wording of a Subscription's issue", () => {
  const listing = (...subscriptions: readonly string[]) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, subscriptions } }, dispatch: null, runsInFlight: [], headChecks: {} }) as const;
  const kitIssue = (number: number, labels: readonly string[], subscription: string, resetsAt: string | null = null) => ({
    open: anOpenIssue({ number, labels, createdAt: SINCE }),
    kit: { number, labels, body: [subscriptionMarker(subscription), ...(resetsAt === null ? [] : [resetsAtMarker(resetsAt)])].join("\n"), comments: [] },
  });
  const words = (subscriptions: readonly string[], ...issues: readonly ReturnType<typeof kitIssue>[]) =>
    standingsOf(standingFactsOf({ github: factsOf({ openIssues: issues.map(({ open }) => open), kitIssues: issues.map(({ kit }) => kit) }), kit: listing(...subscriptions) }), SINCE).map(
      (standing) => wordStanding(standing, minutesAfter(60), ZONE),
    );
  const weeklyLimit = (number: number, subscription: string, resetsAt: string | null) => kitIssue(number, ["fabrik:weekly-limit"], subscription, resetsAt);

  it("says a used-up Subscription resets, told in the Operator's time zone, while runs go to the next", () => {
    expect(words(["A", "B"], weeklyLimit(20, "A", "2026-11-10T22:00:00Z"))).toEqual([
      { pill: "Used up", sentence: "A reached its weekly limit and resets 2026-11-11 09:00 Australia/Sydney. Runs go to the next Subscription.", remedy: null },
    ]);
    expect(words(["A", "B"], weeklyLimit(20, "A", null))[0]?.sentence).toBe("A reached its weekly limit; when it resets is not known. Runs go to the next Subscription.");
  });

  it("says every Subscription is used up and when the first resets", () => {
    expect(words(["A"], weeklyLimit(20, "A", "2026-11-10T22:00:00Z"))).toEqual([
      { pill: "Weekly limit reached", sentence: "Every Subscription is used up. The first resets 2026-11-11 09:00 Australia/Sydney.", remedy: null },
    ]);
    expect(words(["A"], weeklyLimit(20, "A", null))[0]?.sentence).toBe("Every Subscription is used up; when the first resets is not known.");
  });

  it("says no run starts until a refused token is rotated, or that runs go to the next Subscription while another is free", () => {
    const rotation = kitIssue(22, ["ready-for-human", "fabrik:token-rotation"], "A");
    expect(words(["A"], rotation)).toEqual([{ pill: "Claude token refused", sentence: "No run can start until it's rotated.", remedy: null }]);
    expect(words(["A", "B"], rotation)).toEqual([
      { pill: "Claude token refused", sentence: "A's Claude token was refused. Runs go to the next Subscription until it's rotated.", remedy: null },
    ]);
  });

  it("says a Subscription was caught spending usage credits and nothing runs on it until the Operator acts", () => {
    expect(words(["A", "B"], kitIssue(23, ["ready-for-human", "fabrik:usage-credits"], "B"))).toEqual([
      { pill: "Yours to do", sentence: "B was caught spending usage credits. Nothing runs on it until you turn them off and close this issue.", remedy: null },
    ]);
  });
});

describe("the wording of reading matter", () => {
  const all = (github: Partial<GitHubFacts>) => standingsOf(standingFactsOf({ github: factsOf(github) }), SINCE);
  const words = (github: Partial<GitHubFacts>) => all(github).map((standing) => wordStanding(standing, minutesAfter(3 * 24 * 60), ZONE));

  it("says how long an Audit or a Retro has been open, and how long a Replay's results have waited", () => {
    expect(
      words({
        openAudits: [anOpenAudit({ createdAt: SINCE })],
        openRetros: [anOpenRetro({ createdAt: minutesAfter(1) })],
        openReplays: [anOpenReplay({ lastEditedAt: minutesAfter(2) })],
      }),
    ).toEqual([
      { pill: "Yours to read", sentence: "Audit open for 3 days.", remedy: null },
      { pill: "Yours to read", sentence: "Retro open for 2 days.", remedy: null },
      { pill: "Yours to read", sentence: "Replay results in for 2 days.", remedy: null },
    ]);
  });

  it("says how long a Map has been open and how many Decisions wait on the Operator, and names a Decision's Map", () => {
    const map = (number: number, subIssues: readonly number[]) => anOpenIssue({ number, labels: ["wayfinder:map"], createdAt: SINCE, subIssues });
    const decision = (number: number) => anOpenIssue({ number, labels: ["wayfinder:task"], createdAt: minutesAfter(number) });
    expect(words({ openIssues: [map(30, [31, 32]), decision(31), decision(32), map(40, [41]), decision(41), map(50, [])], openMaps: [30, 40, 50] })).toEqual([
      { pill: "Yours to read", sentence: "Map open for 3 days, 2 Decisions waiting on you.", remedy: null },
      { pill: "Yours to read", sentence: "Map open for 3 days, 1 Decision waiting on you.", remedy: null },
      { pill: "Yours to read", sentence: "Map open for 3 days, no Decisions waiting on you.", remedy: null },
      { pill: "Yours to read", sentence: "A Decision on Map #30 that is yours to resolve.", remedy: null },
      { pill: "Yours to read", sentence: "A Decision on Map #30 that is yours to resolve.", remedy: null },
      { pill: "Yours to read", sentence: "A Decision on Map #40 that is yours to resolve.", remedy: null },
    ]);
  });
});

describe("the wording of a Standing in needs-info", () => {
  const asked = (author: string) =>
    theStandingIn({ openIssues: [anOpenIssue({ author, labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", SINCE)] })] });

  it("says Triage waits for the Operator's answer to their own or the Monitor's issue", () => {
    for (const author of ["operator", "fabrik-app[bot]"]) {
      expect(wordStanding(asked(author), minutesAfter(3 * 60), ZONE)).toEqual({
        pill: "Needs your answer",
        sentence: "Triage asked a question 3 hours ago and is waiting for your answer.",
        remedy: null,
      });
    }
  });

  it("names the author anyone else's issue waits on, with no @ so it mentions nobody", () => {
    expect(wordStanding(asked("kate"), minutesAfter(40), ZONE)).toEqual({
      pill: "Waiting on its author",
      sentence: "Triage asked its author, kate, a question 40 minutes ago.",
      remedy: null,
    });
  });
});

describe("the wording of a Plain pull request's Standing", () => {
  const HEAD = "p".repeat(40);
  const plain = (overrides: Parameters<typeof aPlainPullRequest>[0], checks: RequiredChecksFact = [{ name: "test", is: "passed" }], github: Partial<GitHubFacts> = {}) => {
    const kit = { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null, runsInFlight: [], headChecks: { [HEAD]: checks } } as const;
    const [standing] = standingsOf(standingFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest({ headSha: HEAD, headCommittedAt: SINCE, createdAt: SINCE, ...overrides })], ...github }), kit }), SINCE);
    if (standing === undefined) throw new Error("expected a Standing");
    return standing;
  };

  it("says a ready one has had its Required checks passed since its head", () => {
    expect(wordStanding(plain({}), minutesAfter(3 * 60), ZONE)).toEqual({ pill: "Yours to merge", sentence: "Ready, with its Required checks passed, since 3 hours ago.", remedy: null });
  });

  it("says a Pairing session's pull request joined to its issue is ready", () => {
    const joined = plain({ number: 80, author: "operator", headRef: "fabrik/pair-12", closes: 12 }, undefined, {
      openIssues: [anOpenIssue({ number: 12, labels: ["ready-for-human"], labelEvents: [aLabelAdded("ready-for-human", "2026-11-05T20:00:00Z")] })],
    });
    expect(wordStanding(joined, minutesAfter(40), ZONE)).toEqual({
      pill: "Yours to merge",
      sentence: "Its Pairing session's pull request, #80, is ready, with its Required checks passed, since 40 minutes ago.",
      remedy: null,
    });
  });

  it("names the check it waits on, or says its checks could not be read", () => {
    expect(wordStanding(plain({}, [{ name: "test", is: "running" }]), minutesAfter(5), ZONE)).toEqual({ pill: "Waiting on checks", sentence: "Waiting on `test`.", remedy: null });
    expect(wordStanding(plain({}, "unread"), minutesAfter(5), ZONE)).toEqual({
      pill: "Waiting on checks",
      sentence: "Waiting on its Required checks, which could not be read.",
      remedy: null,
    });
  });

  it("is pilled with the check that is failing or has never reported", () => {
    expect(wordStanding(plain({}, [{ name: "lint", is: "failing" }]), minutesAfter(5), ZONE)).toEqual({ pill: "lint", sentence: "`lint` is failing.", remedy: null });
    expect(wordStanding(plain({}, [{ name: "lint", is: "never-reported" }]), minutesAfter(5), ZONE)).toEqual({
      pill: "lint",
      sentence: "`lint` has not reported on its head.",
      remedy: null,
    });
  });

  it("says one that conflicts is resolved on GitHub, but that Dependabot rebases a Kit bump by itself", () => {
    expect(wordStanding(plain({ mergeable: false, author: "operator", headRef: "fix-typo" }), minutesAfter(5), ZONE)).toEqual({
      pill: "Conflicts with `main`",
      sentence: "It conflicts with `main`. Resolve it on GitHub.",
      remedy: null,
    });
    expect(wordStanding(plain({ mergeable: false }), minutesAfter(5), ZONE)).toEqual({
      pill: "Conflicts with `main`",
      sentence: "It conflicts with `main`. Dependabot rebases it by itself.",
      remedy: null,
    });
  });

  it("says nothing is owed on a draft", () => {
    expect(wordStanding(plain({ draft: true }), minutesAfter(5), ZONE)).toEqual({ pill: "Draft", sentence: "A draft; nothing is owed on it.", remedy: null });
  });
});

describe("an age", () => {
  it.each([
    [0, "under a minute"],
    [1, "1 minute"],
    [40, "40 minutes"],
    [59, "59 minutes"],
    [60, "1 hour"],
    [47 * 60 + 59, "47 hours"],
    [48 * 60, "2 days"],
    [10 * 24 * 60, "10 days"],
  ])("%i minutes on reads %s", (minutes, age) => {
    expect(ageSince(SINCE, minutesAfter(minutes))).toBe(age);
  });
});
