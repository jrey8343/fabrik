import { describe, expect, it } from "vitest";
import { aComment, aDesignRound, aDesignTurnFailedNotice, aLabelAdded, aMapCapRefusal, aVerdictComment, anOpenIssue, anOpenPullRequest, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import { designRoundMarker, PROTOTYPE_FAILURE_ROUND_MARKER, PROTOTYPE_ROUND_MARKER } from "../loop/markers.ts";
import { type Standing, standingsOf } from "./standing.ts";
import { ageSince, wordStanding } from "./standingWording.ts";
import type { CommentFacts, GitHubFacts } from "./weeklySummary.ts";

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
