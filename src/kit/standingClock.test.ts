import { describe, expect, it } from "vitest";
import type { RunInFlightFact } from "../github/snapshot.ts";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { aComment, aLabelAdded, anOpenIssue, anOpenPullRequest, aReview, aRunInFlight, aVerdictComment, aWeeklyLimitIssue, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import {
  BROKEN_RUN_MARKER,
  EMPTY_DIFF_MARKER,
  RETRY_ENDED_MARKER,
  RETRY_PUSH_MARKER,
  RETRY_RESTARTED_MARKER,
  stuckTriggerReaddedMarker,
  UNMARKED_RETRY_PUSH,
  verdictMarker,
} from "../loop/markers.ts";
import type { KitConfig } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { type Standing, standingsOf, type StandingFacts } from "./standing.ts";
import type { CommentFacts } from "./retroEvidence.ts";
import { wordStanding } from "./standingWording.ts";
import type { GitHubFacts, RepoKitFacts } from "./weeklySummary.ts";

const NOW = "2026-11-08T20:00:00Z";

/** `owner/product`'s Kit at this Kit config, with nothing for Dispatch to weigh and these runs in flight. */
function aKit(runsInFlight: readonly RunInFlightFact[] | "unread" = [], config: KitConfig = DEFAULT_KIT_CONFIG): RepoKitFacts {
  return { repo: "owner/product", branch: "main", config: { ok: true, config }, dispatch: { candidates: { tickets: [], researchDecisions: [] } }, runsInFlight, headChecks: {} };
}

function standingsIn(github: Partial<GitHubFacts>, overrides: Partial<Omit<StandingFacts, "kind" | "github">> = {}, now = NOW): Standing[] {
  return standingsOf(standingFactsOf({ github: factsOf(github), kit: aKit(), ...overrides }), now);
}

/** Ticket 7, ready for an agent, with `agent:implement` added at `at`. */
const askedFor = (at: string, overrides: Parameters<typeof anOpenIssue>[0] = {}) =>
  anOpenIssue({ number: 7, labels: ["ready-for-agent", "agent:implement"], labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", at)], ...overrides });

describe("a run that was asked for and never began", () => {
  it("gives a Ticket whose agent:implement was added 40 minutes ago, with no Implement run in flight, not-started, the Kit's, turning Stuck 210 minutes after the label", () => {
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] })).toEqual([
      {
        schema: 1,
        repo: "owner/product",
        issue: 7,
        pullRequest: null,
        work: "ticket",
        place: "implement",
        name: "not-started",
        move: "kit",
        yours: false,
        stopsWork: false,
        since: "2026-11-08T19:20:00Z",
        stuckAt: "2026-11-08T22:50:00.000Z",
        awaits: { role: "implement", on: "issue" },
        subscription: null,
        detail: { silence: "trigger-label", label: "agent:implement" },
      },
    ]);
  });

  it("reads the same facts a minute before the bar as not-started, and a minute after as stuck, the Operator's and stopping work, keeping its since and the name it had", () => {
    const issue = askedFor("2026-11-08T19:20:00Z");
    const [before] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:49:00Z");
    const [after] = standingsIn({ openIssues: [issue] }, {}, "2026-11-08T22:51:00Z");
    expect(before).toMatchObject({ name: "not-started", move: "kit", yours: false, stopsWork: false });
    expect(after).toEqual({
      ...before,
      name: "stuck",
      yours: true,
      stopsWork: true,
      detail: { was: "not-started", silence: "trigger-label", label: "agent:implement" },
    });
  });

  it("counts the repo's own bar: with the Implement role's timeout raised to 120, Stuck comes 270 minutes after the label", () => {
    const config = kitConfig({ roles: { ...DEFAULT_KIT_CONFIG.roles, implement: { ...DEFAULT_KIT_CONFIG.roles.implement, timeoutMinutes: 120 } } });
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit: aKit([], config) })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T23:50:00.000Z" }]);
  });

  it("reads a repo whose Kit config is invalid on the Kit's default timeouts", () => {
    const kit: RepoKitFacts = { ...aKit([]), config: { ok: false, errors: ["roles.implement.timeoutMinutes: not a number"] } };
    expect(standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit })).toMatchObject([{ name: "not-started", stuckAt: "2026-11-08T22:50:00.000Z" }]);
  });

  describe("the clock", () => {
    const LABELLED = "2026-11-08T19:20:00Z";
    const LATER = "2026-11-08T19:50:00Z";
    /** Ticket 7 asked for at LABELLED, with its agent draft #50 open, and these facts on either. */
    const withSigns = ({ issue = {}, pullRequest = {}, ...overrides }: { issue?: Parameters<typeof anOpenIssue>[0]; pullRequest?: Parameters<typeof anOpenPullRequest>[0] } & Partial<Omit<StandingFacts, "kind" | "github">>) =>
      standingsIn({ openIssues: [askedFor(LABELLED, issue)], openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, createdAt: "2026-11-08T12:00:00Z", ...pullRequest })] }, overrides);
    const issueLabels = [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", LABELLED)];

    it("starts when the label was last added, whoever added it", () => {
      const byOperator = [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", LABELLED, { actor: "operator" })];
      expect(withSigns({ issue: { labelEvents: byOperator } })).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });

    it.each([
      ["a person's comment on the issue", { issue: { comments: [aComment("Any news?", LATER, { author: "operator", byBot: false })] } }],
      ["a person's comment on its pull request", { pullRequest: { comments: [aComment("Any news?", LATER, { author: "operator", byBot: false })] } }],
      ["another bot's comment", { issue: { comments: [aComment("Beep.", LATER, { author: "dependabot[bot]" })] } }],
      ["a label a person adds elsewhere on the issue", { issue: { labelEvents: [...issueLabels, aLabelAdded("priority", LATER, { actor: "operator" })] } }],
      ["a label a person takes off its pull request", { pullRequest: { labelEvents: [aLabelAdded("priority", LATER, { action: "unlabeled", actor: "operator" })] } }],
      ["a review", { pullRequest: { reviews: [aReview(LATER, { state: "commented" })] } }],
      ["a person's push", { pullRequest: { commits: [{ at: LATER }] } }],
      ["a person taking the pull request out of draft", { pullRequest: { draftEvents: [{ kind: "ready", actor: "operator", at: LATER }] } }],
      ["a run ending on other work", { runsEnded: [{ issue: 8, pullRequest: null, role: "implement", at: LATER }] }],
    ] as const)("leaves stuckAt where it was after %s", (_, overrides) => {
      expect(withSigns(overrides)).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });

    it.each([
      ["a comment the Fabrik App posts on the issue", { issue: { comments: [aComment("Noted.", LATER)] } }],
      ["a comment the Fabrik App posts on its pull request", { pullRequest: { comments: [aComment("Noted.", LATER)] } }],
      ["a label the Fabrik App adds elsewhere on the issue", { issue: { labelEvents: [...issueLabels, aLabelAdded("fabrik:step-up", LATER)] } }],
      ["a label the Fabrik App takes off its pull request", { pullRequest: { labelEvents: [aLabelAdded("agent:review", LATER, { action: "unlabeled" })] } }],
      ["a commit the Fabrik App pushes to its branch", { pullRequest: { commits: [{ at: LATER, byApp: true }] } }],
      ["the Fabrik App taking the pull request into draft", { pullRequest: { draftEvents: [{ kind: "draft", actor: "fabrik-app[bot]", at: LATER }] } }],
      ["the Fabrik App taking the pull request out of draft", { pullRequest: { draftEvents: [{ kind: "ready", actor: "fabrik-app[bot]", at: LATER }] } }],
      ["a run on the Ticket ending", { runsEnded: [{ issue: 7, pullRequest: null, role: "implement", at: LATER }] }],
      ["a run on its pull request ending", { runsEnded: [{ issue: null, pullRequest: 50, role: "review", at: LATER }] }],
    ] as const)("restarts after %s, keeping since", (_, overrides) => {
      expect(withSigns(overrides)).toMatchObject([{ name: "not-started", since: LABELLED, stuckAt: "2026-11-08T23:20:00.000Z" }]);
    });

    it("never runs back for a sign from before the label", () => {
      expect(withSigns({ issue: { comments: [aComment("Earlier.", "2026-11-08T18:00:00Z")] } })).toMatchObject([{ stuckAt: "2026-11-08T22:50:00.000Z" }]);
    });
  });

  describe("after the stuck-trigger sweep's re-add", () => {
    const READDED = "2026-11-08T19:30:00Z";
    const readdedLabels = [
      aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"),
      aLabelAdded("agent:implement", "2026-11-08T17:00:00Z", { actor: "operator" }),
      aLabelAdded("agent:implement", READDED, { action: "unlabeled" }),
      aLabelAdded("agent:implement", READDED),
    ];
    const readdNote = aComment(`${stuckTriggerReaddedMarker("agent:implement")}\n\`agent:implement\` sat 150 minutes with no run behind it, so the Kit added it again.`, READDED);

    it("is still not-started, says the Kit added the label again, and counts the full bar from the re-add", () => {
      expect(standingsIn({ openIssues: [askedFor("unused", { labelEvents: readdedLabels, comments: [readdNote] })] })).toMatchObject([
        { name: "not-started", since: READDED, stuckAt: "2026-11-08T23:00:00.000Z", detail: { silence: "trigger-readded", label: "agent:implement" } },
      ]);
    });

    it("is a plain trigger label again once the label came off and was added since the re-add", () => {
      const again = [...readdedLabels, aLabelAdded("agent:implement", "2026-11-08T19:40:00Z", { action: "unlabeled", actor: "operator" }), aLabelAdded("agent:implement", "2026-11-08T19:45:00Z", { actor: "operator" })];
      expect(standingsIn({ openIssues: [askedFor("unused", { labelEvents: again, comments: [readdNote] })] })).toMatchObject([
        { name: "not-started", since: "2026-11-08T19:45:00Z", detail: { silence: "trigger-label", label: "agent:implement" } },
      ]);
    });

    it("never reads a person's comment that quotes the marker as a re-add", () => {
      const quoted = aComment(readdNote.body, READDED, { author: "operator", byBot: false });
      expect(standingsIn({ openIssues: [askedFor("unused", { labelEvents: readdedLabels, comments: [quoted] })] })).toMatchObject([{ detail: { silence: "trigger-label" } }]);
    });
  });

  describe("each trigger label", () => {
    const AT = "2026-11-08T19:20:00Z";
    const labelled = (number: number, labels: readonly string[], label: string) =>
      anOpenIssue({ number, labels: [...labels, label], labelEvents: [aLabelAdded(label, AT)] });
    const whatIn = (standings: readonly Standing[]) =>
      standings.map(({ issue, pullRequest, work, place, name, awaits, detail }) => ({ issue, pullRequest, work, place, name, awaits, detail }));

    it("asks for its own role's run, on the issue or, for agent:review, on the pull request", () => {
      const standings = standingsIn({
        openIssues: [labelled(20, ["needs-design"], "agent:design"), labelled(21, ["wayfinder:research"], "agent:research"), labelled(22, [], "agent:replay")],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, labelEvents: [aLabelAdded("agent:review", AT)] })],
      });
      expect(whatIn(standings)).toEqual([
        { issue: 7, pullRequest: 50, work: "ticket", place: "review", name: "not-started", awaits: { role: "review", on: "pullRequest" }, detail: { silence: "trigger-label", label: "agent:review" } },
        { issue: 20, pullRequest: null, work: "design-session", place: "design", name: "not-started", awaits: { role: "design", on: "issue" }, detail: { silence: "trigger-label", label: "agent:design" } },
        { issue: 21, pullRequest: null, work: "research-decision", place: null, name: "not-started", awaits: { role: "research", on: "issue" }, detail: { silence: "trigger-label", label: "agent:research" } },
        { issue: 22, pullRequest: null, work: "replay", place: null, name: "not-started", awaits: { role: "replay", on: "issue" }, detail: { silence: "trigger-label", label: "agent:replay" } },
      ]);
    });

    it("leaves a pull request alone once agent:review came off it", () => {
      const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, labelEvents: [aLabelAdded("agent:review", AT), aLabelAdded("agent:review", "2026-11-08T19:25:00Z", { action: "unlabeled" })] });
      expect(standingsIn({ openPullRequests: [pullRequest] }).filter(({ name }) => name === "not-started")).toEqual([]);
    });
  });

  describe("with a run of its role in flight", () => {
    const LONG_AGO = "2026-11-06T08:00:00Z";
    const namesIn = (standings: readonly Standing[]) => standings.map(({ issue, pullRequest, name }) => ({ issue, pullRequest, name }));

    it("is running, never not-started or stuck, however old the label", () => {
      const standings = standingsIn(
        {
          openIssues: [
            askedFor(LONG_AGO),
            anOpenIssue({ number: 20, labels: ["needs-design", "agent:design"], labelEvents: [aLabelAdded("agent:design", LONG_AGO)] }),
            anOpenIssue({ number: 21, labels: ["wayfinder:research", "agent:research"], labelEvents: [aLabelAdded("agent:research", LONG_AGO)] }),
          ],
          openPullRequests: [anOpenPullRequest({ number: 51, ticket: 8, labelEvents: [aLabelAdded("agent:review", LONG_AGO)] })],
        },
        { kit: aKit([aRunInFlight({ issue: 7 }), aRunInFlight({ role: "design", issue: 20 }), aRunInFlight({ role: "research" }), aRunInFlight({ role: "review", pullRequest: 51 })]) },
      );
      expect(namesIn(standings)).toEqual([
        { issue: 7, pullRequest: null, name: "running" },
        { issue: 8, pullRequest: 51, name: "running" },
        { issue: 20, pullRequest: null, name: "running" },
        { issue: 21, pullRequest: null, name: "running" },
      ]);
    });

    it("is not-started still while the only run of its role is named for other work", () => {
      const standings = standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit: aKit([aRunInFlight({ issue: 9 })]) });
      expect(namesIn(standings)).toEqual([{ issue: 7, pullRequest: null, name: "not-started" }]);
    });

    it("is not-started still while the only run of its role is exact and names no work, since an exact run counts only for the work it names (#617)", () => {
      const standings = standingsIn({ openIssues: [askedFor("2026-11-08T19:20:00Z")] }, { kit: aKit([aRunInFlight({ exact: true })]) });
      expect(namesIn(standings)).toEqual([{ issue: 7, pullRequest: null, name: "not-started" }]);
    });

    it("has no not-started Standing for a Replay while a run with no number of the roles it starts is in flight, as the sweep counts it", () => {
      const replay = anOpenIssue({ number: 22, labels: ["agent:replay"], labelEvents: [aLabelAdded("agent:replay", LONG_AGO)] });
      expect(standingsIn({ openIssues: [replay] }, { kit: aKit([aRunInFlight({ role: "review" })]) })).toEqual([]);
    });

    it("takes no run as known with the runs unread, so the silence still turns Stuck at the bar", () => {
      expect(namesIn(standingsIn({ openIssues: [askedFor(LONG_AGO)] }, { kit: aKit("unread") }))).toEqual([{ issue: 7, pullRequest: null, name: "stuck" }]);
      expect(namesIn(standingsIn({ openIssues: [askedFor(LONG_AGO)] }, { kit: null }))).toEqual([{ issue: 7, pullRequest: null, name: "stuck" }]);
    });
  });
  describe("a Retry a Verdict announced", () => {
    const HEAD = "h".repeat(40);
    const FLAW = "2026-11-08T19:00:00Z";
    const flaw = aVerdictComment("execution-flaw", HEAD, FLAW);
    /** Ticket 7, given agent:implement by the Kit with the Verdict, and its agent draft #50 with these comments. */
    const retryFacts = (
      comments: readonly CommentFacts[] = [flaw],
      overrides: Parameters<typeof anOpenPullRequest>[0] = {},
      ticketLabels: readonly string[] = ["ready-for-agent", "agent:implement"],
    ): Partial<GitHubFacts> => ({
      openIssues: [anOpenIssue({ number: 7, labels: ticketLabels, labelEvents: [aLabelAdded("ready-for-agent", "2026-11-08T10:00:00Z"), aLabelAdded("agent:implement", FLAW)] })],
      openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, createdAt: "2026-11-08T12:00:00Z", comments, ...overrides })],
    });

    it("gives the Ticket and its draft not-started, at Implement, awaiting an Implement run on the pull request, from the Verdict", () => {
      expect(standingsIn(retryFacts())).toEqual([
        {
          schema: 1,
          repo: "owner/product",
          issue: 7,
          pullRequest: 50,
          work: "ticket",
          place: "implement",
          name: "not-started",
          move: "kit",
          yours: false,
          stopsWork: false,
          since: FLAW,
          stuckAt: "2026-11-08T22:30:00.000Z",
          awaits: { role: "implement", on: "pullRequest" },
          subscription: null,
          detail: { silence: "retry", label: null },
        },
      ]);
    });

    it("restarts the clock at the Kit's note that it added agent:implement again for the Retry, and is Stuck a full bar after it", () => {
      const restarted = aComment(`${RETRY_RESTARTED_MARKER}\nRetry 1 of 2 on #50 never started, so the Kit has added \`agent:implement\` to #7 again to start it.`, "2026-11-08T20:40:00Z");
      const [before] = standingsIn(retryFacts([flaw, restarted]), {}, "2026-11-08T23:00:00Z");
      expect(before).toMatchObject({ name: "not-started", since: FLAW, stuckAt: "2026-11-09T00:10:00.000Z", detail: { silence: "retry" } });
      expect(standingsIn(retryFacts([flaw, restarted]), {}, "2026-11-09T00:11:00Z")).toMatchObject([{ name: "stuck", detail: { was: "not-started", silence: "retry" } }]);
    });

    it("is running once the Retry is in flight", () => {
      expect(standingsIn(retryFacts(), { kit: aKit([aRunInFlight({ issue: 7, retry: 1, kind: "retry" })]) })).toMatchObject([{ name: "running", detail: { run: "retry", retry: 1 } }]);
    });

    it.each([
      ["the Retry pushed", [flaw, aComment(`${RETRY_PUSH_MARKER}\nThe Implementer pushed a fix.`, "2026-11-08T19:30:00Z")], {}],
      ["the Retry pushed, in a note from before its marker", [flaw, aComment(`${UNMARKED_RETRY_PUSH}#50.`, "2026-11-08T19:30:00Z")], {}],
      ["the Kit ended the Retry", [flaw, aComment(`${RETRY_ENDED_MARKER}\n@operator Retry 1 of 2 on #50 never started.`, "2026-11-08T19:30:00Z")], {}],
      ["the pull request is out of draft", [flaw], { draft: false }],
      ["the flaw found its Ticket not ready", [aComment(`${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, ticketNotReady: true, headSha: HEAD })}\nVerdict`, FLAW)], {}],
      [
        "the flaw gave way to the Operator's Request changes",
        [aComment(`${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, requestChangesFirst: [900], headSha: HEAD })}\nVerdict`, FLAW)],
        {},
      ],
      [
        "the Retries are used up",
        [aVerdictComment("execution-flaw", "a".repeat(40), "2026-11-08T15:00:00Z"), aVerdictComment("execution-flaw", "b".repeat(40), "2026-11-08T17:00:00Z"), flaw],
        {},
      ],
      ["the latest Verdict is a pass", [flaw, aVerdictComment("pass", HEAD, "2026-11-08T19:30:00Z")], { draft: false }],
    ] as const)("calls for no Retry once %s", (_, comments, overrides) => {
      expect(standingsIn(retryFacts(comments, overrides, ["ready-for-agent"])).filter(({ name }) => name === "not-started")).toEqual([]);
    });

    it("counts the Ticket's runs that landed nothing among its Retries", () => {
      const ticket = anOpenIssue({
        number: 7,
        labels: ["ready-for-agent"],
        comments: [aComment(`${EMPTY_DIFF_MARKER}\nNothing changed.`, "2026-11-08T11:00:00Z"), aComment(`${BROKEN_RUN_MARKER}\nBroken.`, "2026-11-08T11:30:00Z")],
      });
      expect(standingsIn({ ...retryFacts(), openIssues: [ticket] }).filter(({ name }) => name === "not-started")).toEqual([]);
    });
  });
  it("leaves a Ticket a held marker names held, never not-started or stuck, however old its label", () => {
    const held = aWeeklyLimitIssue(null, [{ role: "implement", issue: 7, label: "agent:implement" }], { commentedAt: ["2026-11-06T09:00:00Z"] });
    const standings = standingsIn({ openIssues: [askedFor("2026-11-06T08:00:00Z")], kitIssues: [held] });
    expect(standings.map(({ issue, name }) => ({ issue, name }))).toEqual([{ issue: 7, name: "held" }]);
  });
  describe("in words", () => {
    const ZONE = "Australia/Sydney";
    const RUNS = "[the Loop's runs](https://github.com/owner/product/actions)";
    const LABELLED = "2026-11-08T19:20:00Z";
    /** The one Standing these facts give at `now`, worded then. */
    const wordedAt = (github: Partial<GitHubFacts>, now: string) => {
      const [standing, ...rest] = standingsIn(github, {}, now);
      if (standing === undefined || rest.length > 0) throw new Error("expected one Standing");
      return wordStanding(standing, now, ZONE);
    };

    it("says a trigger label asked for a run that hasn't started, and that the Kit adds it again, then at the bar that nothing has run", () => {
      const facts = { openIssues: [askedFor(LABELLED)] };
      const remedy = `Check ${RUNS}, then add \`agent:implement\` again.`;
      expect(wordedAt(facts, "2026-11-08T20:00:00Z")).toEqual({
        pill: "Not started",
        sentence: "Asked for an Implement run 40 minutes ago; nothing has started. The Kit adds the label again at its next hourly check.",
        remedy,
      });
      expect(wordedAt(facts, "2026-11-08T23:20:00Z")).toEqual({ pill: "Stuck", sentence: "Nothing has run since the Kit asked for an Implement run 4 hours ago.", remedy });
    });

    it.each([
      ["agent:design", ["needs-design"], "a Design-session turn"],
      ["agent:research", ["wayfinder:research"], "a Research run"],
      ["agent:replay", [], "a Replay"],
    ] as const)("names the run %s asks for", (label, labels, run) => {
      const issue = anOpenIssue({ number: 20, labels: [...labels, label], labelEvents: [aLabelAdded(label, LABELLED)] });
      expect(wordedAt({ openIssues: [issue] }, "2026-11-08T20:00:00Z")).toMatchObject({
        sentence: `Asked for ${run} 40 minutes ago; nothing has started. The Kit adds the label again at its next hourly check.`,
        remedy: `Check ${RUNS}, then add \`${label}\` again.`,
      });
    });

    it("names a Review for agent:review on a pull request", () => {
      const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, labelEvents: [aLabelAdded("agent:review", LABELLED)] });
      expect(wordedAt({ openPullRequests: [pullRequest] }, "2026-11-08T20:00:00Z").sentence).toBe(
        "Asked for a Review 40 minutes ago; nothing has started. The Kit adds the label again at its next hourly check.",
      );
    });

    it("says the Kit added the label again after the sweep's re-add, and that it hands this over next, then at the bar that nothing has run since", () => {
      const READDED = "2026-11-08T19:30:00Z";
      const issue = askedFor("unused", {
        labelEvents: [aLabelAdded("agent:implement", "2026-11-08T17:00:00Z", { actor: "operator" }), aLabelAdded("agent:implement", READDED, { action: "unlabeled" }), aLabelAdded("agent:implement", READDED)],
        comments: [aComment(`${stuckTriggerReaddedMarker("agent:implement")}\nAdded again.`, READDED)],
      });
      const remedy = `Check ${RUNS}, then add \`agent:implement\` again.`;
      expect(wordedAt({ openIssues: [issue] }, "2026-11-08T20:00:00Z")).toEqual({
        pill: "Not started",
        sentence: "The Kit added `agent:implement` again 30 minutes ago; nothing has started. At its next hourly check it takes the label off and hands this to you.",
        remedy,
      });
      expect(wordedAt({ openIssues: [issue] }, "2026-11-08T23:30:00Z")).toEqual({ pill: "Stuck", sentence: "Nothing has run since the Kit added `agent:implement` again 4 hours ago.", remedy });
    });

    it("says an Execution flaw called for a Retry that hasn't started, and when the Kit adds agent:implement again, then at the bar that no Retry has started", () => {
      const facts = {
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] })],
        openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, comments: [aVerdictComment("execution-flaw", "h".repeat(40), LABELLED)] })],
      };
      const remedy = `Check ${RUNS}, then add \`agent:implement\` to #7.`;
      expect(wordedAt(facts, "2026-11-08T20:00:00Z")).toEqual({
        pill: "Not started",
        sentence: "An Execution flaw called for a Retry 40 minutes ago; nothing has started. The Kit adds `agent:implement` to #7 again once the Implement job's timeout has passed.",
        remedy,
      });
      expect(wordedAt(facts, "2026-11-08T23:20:00Z")).toEqual({ pill: "Stuck", sentence: "No Retry has started since the Execution flaw 4 hours ago.", remedy });
    });
  });
});
