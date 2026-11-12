import { describe, expect, it } from "vitest";
import { aDesignQueueIssue, aTicket } from "../__fixtures__/snapshots.ts";
import {
  aComment,
  aDeploymentsRead,
  aDeployOf,
  aDesignRound,
  aDesignTurnFailedNotice,
  aLabelAdded,
  aMapCapRefusal,
  aMergedLastDay,
  anOpenAudit,
  anOpenIssue,
  anOpenPullRequest,
  anOpenReplay,
  anOpenRetro,
  aPlainPullRequest,
  aReplayBody,
  aReview,
  aVerdictComment,
  factsOf,
  standingFactsOf,
} from "../read/builders.ts";
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
    const joined = plain({ number: 80, author: "operator", headRef: "fabrik/pair-12", closes: [12] }, undefined, {
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

describe("the wording of a silence that waits on the Kit (#608)", () => {
  const HEAD = "h".repeat(40);
  const RUNS = "Check [the Loop's runs](https://github.com/owner/product/actions)";
  const operators = (body: string, at: string) => aComment(body, at, { author: "operator", byBot: false });
  /** The one Standing of these facts at SINCE, and as the rule reads them `minutes` on. */
  const read = (github: Partial<GitHubFacts>, minutes: number) => {
    const [standing, ...rest] = standingsOf(standingFactsOf({ github: factsOf(github) }), minutesAfter(minutes));
    if (standing === undefined || rest.length > 0) throw new Error("expected one Standing");
    return wordStanding(standing, minutesAfter(minutes), ZONE);
  };

  it.each([
    [
      "the Operator's Request changes with no run",
      { openPullRequests: [anOpenPullRequest({ draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-08T11:00:00Z")], reviews: [aReview(SINCE)] })] },
      "You requested changes 40 minutes ago; no run has started. The Kit starts one at an hourly check, once it is sure none is working.",
      "No run has started for your Request changes of 4 hours ago.",
      `${RUNS}, then add \`agent:implement\` to #7.`,
    ],
    [
      "a conflicting draft GitHub never reviewed",
      { openPullRequests: [anOpenPullRequest({ mergeable: false, commits: [{ at: SINCE, byApp: true }] })] },
      "#50 conflicts with `main`, so GitHub started no Review of its push 40 minutes ago. The Kit brings it up to date at an hourly check.",
      "#50 has conflicted with `main` since its push 4 hours ago and the Kit has not brought it up to date.",
      `${RUNS}, then resolve the conflict on the branch and push.`,
    ],
    [
      "an answered needs-info",
      { openIssues: [anOpenIssue({ labels: ["needs-info"], labelEvents: [aLabelAdded("needs-info", "2026-11-08T11:00:00Z")], comments: [operators("It's Safari.", SINCE)] })] },
      "The question was answered 40 minutes ago; Triage has not run again.",
      "Triage has not run since the answer 4 hours ago.",
      `${RUNS}, then take \`needs-info\` off and add \`needs-triage\`.`,
    ],
    [
      "needs-triage with no run",
      { openIssues: [anOpenIssue({ labels: ["needs-triage"], labelEvents: [aLabelAdded("needs-triage", SINCE)] })] },
      "Waiting for Triage since 40 minutes ago; no run has started.",
      "Triage has not run since `needs-triage` was added 4 hours ago.",
      `${RUNS}, then take \`needs-triage\` off and add it again.`,
    ],
    [
      "an answered Round with no turn",
      { openIssues: [anOpenIssue({ labels: ["needs-design"], comments: [aDesignRound(2, "2026-11-08T11:00:00Z"), operators("The second.", SINCE)] })] },
      "You answered round 2 40 minutes ago; the next turn has not started.",
      "No turn has started since your answer 4 hours ago.",
      `${RUNS}, then reply on #12 again.`,
    ],
    [
      "a passed draft whose Merge gate never opened",
      { openPullRequests: [anOpenPullRequest({ comments: [aVerdictComment("pass", HEAD, SINCE)] })] },
      "The Reviewer passed #50 40 minutes ago; the Kit has not opened the Merge gate yet.",
      "The Reviewer passed #50 4 hours ago and the Merge gate never opened.",
      `${RUNS}, then mark #50 ready for review.`,
    ],
    [
      "a draft with nothing above to explain it",
      { openPullRequests: [anOpenPullRequest({ commits: [{ at: SINCE, byApp: true }] })] },
      "Nothing has happened on #50 since 40 minutes ago and no run is working on it.",
      "The Kit has made no sign on #50 for 4 hours.",
      `${RUNS}, then add \`agent:review\` to #50.`,
    ],
  ] as const)("words %s before the bar and at it, with its remedy", (_, github, before, after, remedy) => {
    expect(read(github, 40)).toEqual({ pill: "Waiting on the Kit", sentence: before, remedy });
    expect(read(github, 4 * 60)).toEqual({ pill: "Stuck", sentence: after, remedy });
  });

  it("says what the Kit does next for a silence it can't date, and only how long it has stood so for one no rule names", () => {
    const releasing = standingsOf(
      standingFactsOf({
        github: factsOf({ openIssues: [anOpenIssue({ number: 14, labels: ["ready-for-agent"], createdAt: SINCE })] }),
        kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: { candidates: { tickets: [aTicket({ number: 14 })], researchDecisions: [] } }, runsInFlight: [], headChecks: {} },
      }),
      SINCE,
    );
    expect(releasing.map((standing) => wordStanding(standing, minutesAfter(40), ZONE))).toEqual([
      { pill: "Waiting on the Kit", sentence: "Ready and unblocked. Dispatch releases it at the Kit's next hourly check.", remedy: null },
    ]);
    expect(wordStanding(theStandingIn({ designQueue: { issues: [aDesignQueueIssue({ number: 21 })], designTurnsInProgress: [] } }), minutesAfter(40), ZONE)).toEqual({
      pill: "Waiting on the Kit",
      sentence: "A Design session slot is free. The Design queue starts the session at the Kit's next hourly check.",
      remedy: null,
    });
    expect(wordStanding(theStandingIn({ openReplays: [anOpenReplay({ lastEditedAt: SINCE, body: aReplayBody({ state: "pending" }) })] }), minutesAfter(40), ZONE)).toEqual({
      pill: "Waiting on the Kit",
      sentence: "Between its steps for 40 minutes. The Kit takes the next at its next hourly check.",
      remedy: null,
    });
    expect(wordStanding(theStandingIn({ openIssues: [anOpenIssue({ labels: ["needs-design"], createdAt: SINCE })] }), minutesAfter(40), ZONE)).toEqual({
      pill: "Waiting on the Kit",
      sentence: "Waiting on the Kit for 40 minutes.",
      remedy: null,
    });
  });

  it("says the Operator parked a passed draft", () => {
    const parked = anOpenPullRequest({
      comments: [aVerdictComment("pass", HEAD, "2026-11-08T11:00:00Z")],
      draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: "2026-11-08T11:01:00Z" }, { kind: "draft", actor: "operator", at: SINCE }],
    });
    expect(wordStanding(theStandingIn({ openPullRequests: [parked] }), minutesAfter(40), ZONE)).toEqual({
      pill: "Parked by you",
      sentence: "You put #50 back in draft 40 minutes ago, after its pass.",
      remedy: null,
    });
  });
});

describe("the wording of a merged agent pull request at Production (#634)", () => {
  const MERGE = "m".repeat(40);
  const kit = (environment: string | null) =>
    ({ repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment } } }, dispatch: null, runsInFlight: [], headChecks: {} }) as const;
  /** The one Standing of pull request 50, merged at SINCE, read at `now`. */
  const atProduction = (deploy: Parameters<typeof aDeployOf>[0] | "unread" | null, now: string, environment: string | null = "production"): Standing => {
    const deployments = deploy === null ? null : aDeploymentsRead({ [MERGE]: deploy === "unread" ? "unread" : aDeployOf(deploy) });
    const [standing, ...rest] = standingsOf(standingFactsOf({ kit: kit(environment), mergedLastDay: [aMergedLastDay(SINCE)], deployments }), now);
    if (standing === undefined || rest.length > 0) throw new Error("expected one Standing");
    return standing;
  };

  it("says a merge no deploy has started for yet, one whose Deployments could not be read, and one in a repo that tracks none, is merged", () => {
    expect(wordStanding(atProduction({ is: "none" }, minutesAfter(40)), minutesAfter(40), ZONE)).toEqual({
      pill: "Merged",
      sentence: "Merged 40 minutes ago. No deploy has started yet.",
      remedy: null,
    });
    for (const unread of ["unread", null] as const) {
      expect(wordStanding(atProduction(unread, minutesAfter(40)), minutesAfter(3 * 60), ZONE)).toEqual({
        pill: "Merged",
        sentence: "Merged 3 hours ago. Deployments could not be read.",
        remedy: null,
      });
    }
    expect(wordStanding(atProduction({ is: "none" }, minutesAfter(40), null), minutesAfter(40), ZONE)).toEqual({
      pill: "Merged",
      sentence: "Merged 40 minutes ago. Deploys are not tracked in this repo.",
      remedy: null,
    });
  });

  it("says a deploy is running, from the Deployment's creation", () => {
    expect(wordStanding(atProduction({ is: "running", deployment: 901, commit: MERGE, at: minutesAfter(5) }, minutesAfter(10)), minutesAfter(25), ZONE)).toEqual({
      pill: "Deploying",
      sentence: "A deploy to `production` has been running for 20 minutes.",
      remedy: null,
    });
  });

  it("says it is live, since the deciding report", () => {
    expect(wordStanding(atProduction({ is: "succeeded", deployment: 900, commit: MERGE, at: minutesAfter(10) }, minutesAfter(10)), minutesAfter(70), ZONE)).toEqual({
      pill: "Live",
      sentence: "Live in `production` since 1 hour ago.",
      remedy: null,
    });
  });

  it("says the deploy failed, since the failed report", () => {
    const failed = atProduction({ is: "failed", deployment: 902, commit: MERGE, at: minutesAfter(10), log: "https://github.com/owner/product/actions/runs/40/job/41" }, minutesAfter(10));
    expect(wordStanding(failed, minutesAfter(50), ZONE)).toEqual({ pill: "Deploy failed", sentence: "The deploy to `production` failed 40 minutes ago.", remedy: null });
  });

  it("says no deploy has started since the merge, aged from the merge", () => {
    expect(wordStanding(atProduction({ is: "none" }, minutesAfter(2 * 60)), minutesAfter(2 * 60), ZONE)).toEqual({
      pill: "No deploy seen",
      sentence: "No deploy to `production` has started since the merge 2 hours ago.",
      remedy: null,
    });
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
