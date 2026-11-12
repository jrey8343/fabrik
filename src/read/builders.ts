// The Kit's fact builders: small builders of the facts the Kit reads, each
// saying only what its caller cares about, the rest at a plain default. The
// Kit's tests build their facts with them, and a program reading the Kit (the
// read library, ./index.ts) builds its fake data with them, so that data is the
// Kit's own facts. They import no test runner and nothing the read library's
// import walk refuses, and everything they build survives being written as
// JSON and read back.
import type { RunInFlightFact } from "../github/snapshot.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { type ReplayProgress, replayBody } from "../kit/replay.ts";
import type { ReplayRun, RunRecord } from "../kit/runRecord.ts";
import type { StandingFacts } from "../kit/standing.ts";
import type { MergedLastDayFacts } from "../kit/standingProduction.ts";
import type { StoreStandingFacts, WeeklySummaryIssueFacts } from "../kit/standingStore.ts";
import type {
  AgentPullRequestFacts,
  CommentFacts,
  CommitFacts,
  EscapeMarkerIssueFacts,
  FollowUpIssueFacts,
  GitHubFacts,
  LabelEvent,
  MonitorIssueFacts,
  OpenAuditFacts,
  OpenIssueFacts,
  OpenPullRequestFacts,
  OpenReplayFacts,
  OpenRetroFacts,
  PlainPullRequestFacts,
  ReviewFacts,
  SpecFacts,
  TicketFacts,
} from "../kit/weeklySummary.ts";
import { DESIGN_TURN_FAILED_MARKER, designRoundMarker, fromPullRequestLine, handBackMarker, MAP_CAP_REFUSAL_OPENING, REQUEST_CHANGES_RUN_MARKER, requestChangesAnswersMarker, verdictMarker } from "../loop/markers.ts";
import { type HeldRun, heldMarker } from "../loop/heldRun.ts";
import { resetsAtMarker } from "../loop/kitIssueMarks.ts";
import type { KitIssueSnapshot, Verdict } from "../loop/types.ts";
import type { DeploymentsRead, DeployOf } from "./deployments.ts";
import type { Facts } from "./gather.ts";
import type { RunInFlight, RunsRead } from "./runs.ts";

/** A passing first Implement run on Ticket 7 in `owner/product`, costing $1, ended at `endedAt`. */
export function aRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 8,
    kitSha: "f".repeat(40),
    repo: "owner/product",
    runId: 1000,
    runAttempt: 1,
    role: "implement",
    issue: 7,
    pullRequest: 50,
    endedAt: "2026-11-04T12:00:00Z",
    model: "claude-opus-5-5",
    effort: null,
    subscription: "Claude token",
    retry: 0,
    stepUp: false,
    stepUpReason: null,
    requestChanges: false,
    emptyDiff: false,
    keptBranch: false,
    prototype: false,
    replay: null,
    baseSha: "b".repeat(40),
    jobResult: "success",
    subtype: "success",
    isError: false,
    terminalReason: "completed",
    infrastructureFailure: null,
    brokenRun: null,
    verdict: null,
    durationMs: 90_000,
    apiDurationMs: 60_000,
    turns: 12,
    permissionDenials: 0,
    apiRetries: 0,
    totalCostUsd: 1,
    modelUsage: {},
    rateLimit: null,
    transcript: null,
    ...overrides,
  };
}

/** Replay 140's baseline arm of Ticket 7, Replay 140 being the Operator's `fabrik:replay` issue. */
export const A_REPLAY: ReplayRun = { issue: 140, arm: "baseline", ticket: 7, candidateSha: null };

/** The baseline arm's Implement run in Replay 140, re-running Ticket 7 (merged as PR 50), costing $1, ended at `endedAt`. */
export function aReplayRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return aRunRecord({ runId: 2000, replay: A_REPLAY, ...overrides });
}

/** An Auditor's run on Audit 90 in `owner/product`, costing $1. */
export function anAuditRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return aRunRecord({ role: "audit", issue: 90, pullRequest: null, ...overrides });
}

/** A Retro's run on Retro 120 in `owner/product`, costing $1. */
export function aRetroRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return aRunRecord({ role: "retro", issue: 120, pullRequest: null, ...overrides });
}

/** A run's cost fields when one of its models has an unknown cost basis: no figure for it, and no total. */
export const AN_UNKNOWN_COST: Pick<RunRecord, "totalCostUsd" | "modelUsage"> = {
  totalCostUsd: null,
  modelUsage: {
    "claude-unpriced": { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: null, costBasis: "unknown" },
  },
};

/** An agent PR the Fabrik App opened for Ticket 7, merged at `mergedAt`. */
export function aMergedPullRequest(mergedAt: string, overrides: Partial<AgentPullRequestFacts> = {}): AgentPullRequestFacts {
  return {
    number: 50,
    ticket: 7,
    title: "Build the thing",
    mergedAt,
    mergeSha: "c".repeat(40),
    commits: [],
    reviews: [],
    comments: [],
    labelEvents: [],
    changedPaths: [],
    ...overrides,
  };
}

/** The Operator requesting changes at `at`, saying nothing more. */
export function aReview(at: string, overrides: Partial<ReviewFacts> = {}): ReviewFacts {
  const id = overrides.id ?? 900;
  return { id, url: `https://github.com/owner/product/pull/50#pullrequestreview-${id}`, author: "operator", state: "changes-requested", body: "", comments: [], at, ...overrides };
}

/** A commit the Operator made at `at`, its patch unread; the Fabrik App's with `{ byApp: true }`. */
export function aCommit(at: string, overrides: Partial<CommitFacts> = {}): CommitFacts {
  const byApp = overrides.byApp ?? false;
  return { sha: "d".repeat(40), byApp, author: byApp ? "fabrik-implementer" : "operator", message: "A commit", patch: null, at, ...overrides };
}

/** The App adding `label` at `at`. */
export function aLabelAdded(label: string, at: string, overrides: Partial<LabelEvent> = {}): LabelEvent {
  return { label, action: "labeled", actor: "fabrik-app[bot]", at, ...overrides };
}

/** Ticket 7, still open, with this label timeline, blocked by nothing. */
export function aTicketTimeline(labelEvents: readonly LabelEvent[], overrides: Partial<TicketFacts> = {}): TicketFacts {
  return { number: 7, labelEvents, closedAt: null, blockedBy: [], ...overrides };
}

/** Spec 3, the parent of Ticket 7, with this label timeline. */
export function aSpec(labelEvents: readonly LabelEvent[], overrides: Partial<SpecFacts> = {}): SpecFacts {
  return { number: 3, labelEvents, tickets: [7], ...overrides };
}

/** The GitHub facts of `owner/product`, with nothing in them unless a test says so. */
export function factsOf(overrides: Partial<GitHubFacts> = {}): GitHubFacts {
  return {
    repo: "owner/product",
    pullRequests: [],
    tickets: [],
    specs: [],
    defaultBranchCommits: [],
    mergedPullRequestTitles: [],
    openIssues: [],
    openPullRequests: [],
    plainPullRequests: [],
    designQueue: { issues: [], designTurnsInProgress: [] },
    monitorIssues: [],
    escapeMarkerIssues: [],
    followUpIssues: [],
    openAudits: [],
    openRetros: [],
    audits: [],
    retros: [],
    openReplays: [],
    openMaps: [],
    kitIssues: [],
    ...overrides,
  };
}

/** Issue 80, "Make the cart module deeper", which the Operator opened on 2026-11-03 with `body`, still open. */
export function anEscapeMarkerIssue(body: string, overrides: Partial<EscapeMarkerIssueFacts> = {}): EscapeMarkerIssueFacts {
  return { number: 80, title: "Make the cart module deeper", author: "operator", createdAt: "2026-11-03T00:00:00Z", state: "open", body, ...overrides };
}

/** Issue 90, which the Operator opened from a Follow-up on PR `pullRequest` through its Open as issue link, titled as the link prefilled it. */
export function aFollowUpIssue(pullRequest: number, title: string, overrides: Partial<FollowUpIssueFacts> = {}): FollowUpIssueFacts {
  return { number: 90, title, author: "operator", body: `Worth its own issue.\n\n${fromPullRequestLine(pullRequest)}`, ...overrides };
}

/** Audit 90, which the Fabrik App opened on 2026-11-01 and nobody has closed. */
export function anOpenAudit(overrides: Partial<OpenAuditFacts> = {}): OpenAuditFacts {
  return { number: 90, title: "Audit: week of 2026-10-26", author: "fabrik-app[bot]", createdAt: "2026-11-01T00:00:00Z", ...overrides };
}

/** Retro 120, which the Fabrik App opened on Saturday 2026-11-07 and nobody has closed. */
export function anOpenRetro(overrides: Partial<OpenRetroFacts> = {}): OpenRetroFacts {
  return { number: 120, title: "Retro: week of 2026-11-02", author: "fabrik-app[bot]", createdAt: "2026-11-07T00:00:00Z", ...overrides };
}

/**
 * Replay issue 140's body once the tick accepted its request, review.effort:
 * high on Ticket 7 (merged as PR 50), with Ticket 7's replay `progress`.
 */
export function aReplayBody(progress: ReplayProgress): string {
  const settings = { model: "claude-opus-5-5", effort: null };
  const baseline = { implement: settings, review: settings, candidateSha: null };
  const arms = { baseline, variant: { ...baseline, review: { ...settings, effort: "high" } } };
  const plan = { variable: { kind: "effort", role: "review", effort: "high" }, tickets: [{ ticket: 7, pullRequest: 50, baseSha: "b".repeat(40), flags: [], arms }], leftOut: [] } as const;
  return replayBody("```replay\nreview.effort: high\ntickets: 7\n```\n", { plan, progress: [{ ticket: 7, ...progress }] });
}

/** Replay issue 140, which the Operator opened on 2026-11-01, its one Ticket done and its results written on 2026-11-06. */
export function anOpenReplay(overrides: Partial<OpenReplayFacts> = {}): OpenReplayFacts {
  return {
    number: 140,
    title: "Replay review.effort: high",
    author: "operator",
    createdAt: "2026-11-01T00:00:00Z",
    lastEditedAt: "2026-11-06T20:00:00Z",
    body: aReplayBody({ state: "done", run: 2000 }),
    ...overrides,
  };
}

/** The Fabrik App's comment `body` at `at`; a person's with `{ author, byBot: false }`. */
export function aComment(body: string, at: string, overrides: Partial<CommentFacts> = {}): CommentFacts {
  return { url: "https://github.com/owner/product/pull/50#issuecomment-1", author: "fabrik-app[bot]", byBot: true, body, at, ...overrides };
}

/** The Fabrik App's note of a Request-changes run's push at `at`, holding its answers about review `review` (#369). */
export function anAnswersComment(
  review: number,
  { reviewMiss, amendsTicket }: { readonly reviewMiss: boolean; readonly amendsTicket: boolean },
  at: string,
  overrides: Partial<CommentFacts> = {},
): CommentFacts {
  return aComment(
    [REQUEST_CHANGES_RUN_MARKER, requestChangesAnswersMarker({ review, reviewMiss, amendsTicket }), "The Implementer pushed the Operator's requested changes."].join("\n"),
    at,
    { url: `https://github.com/owner/product/pull/50#issuecomment-${review}1`, ...overrides },
  );
}

/** The Fabrik App's Design round `round` at `at`. */
export function aDesignRound(round: number, at: string): CommentFacts {
  return aComment(`${designRoundMarker(round)}\nWhich of these should it do?`, at);
}

/**
 * The Fabrik App's failure notice for a Design-session turn, at `at`; when
 * `run` is given, its hidden line names that Actions run, as this release
 * writes it, and else it has none, as an earlier release's.
 */
export function aDesignTurnFailedNotice(at: string, run?: number): CommentFacts {
  const said = `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn on #12 failed: it timed out.\n\nReply on this issue to run the turn again.`;
  return aComment(run === undefined ? said : `${said}\n${handBackMarker({ kind: "design-turn-failed", role: "design", failure: "timeout", run })}`, at);
}

/** The Fabrik App's refusal of a Map the Map cap holds, at `at`. */
export function aMapCapRefusal(at: string): CommentFacts {
  return aComment(
    `${DESIGN_TURN_FAILED_MARKER}\n${MAP_CAP_REFUSAL_OPENING} the Map cap is full: #5 is the open Map, and \`caps.maps\` is 1. The Kit left #21 as it is, and the Design session carries on: reply to finish it another way, or close #5 first and ask for the Map again.`,
    at,
  );
}

/** The Fabrik App's Verdict comment on `headSha` at `at`. */
export function aVerdictComment(verdict: Verdict, headSha: string, at: string, overrides: Partial<CommentFacts> = {}): CommentFacts {
  return aComment(`${verdictMarker({ verdict, source: "reviewer", requestChanges: false, headSha })}\nVerdict: ${verdict}`, at, overrides);
}

/** Open issue 12, opened on 2026-10-01, with no labels, comments, label events or sub-issues unless a test says so. */
export function anOpenIssue(overrides: Partial<OpenIssueFacts> = {}): OpenIssueFacts {
  return { number: 12, title: "An open issue", author: "someone", labels: [], createdAt: "2026-10-01T00:00:00Z", comments: [], labelEvents: [], subIssues: [], ...overrides };
}

/**
 * Open agent PR 50, a draft for Ticket 7 at head `h…h` opened on 2026-10-01,
 * merging cleanly, with nothing on it unless a test says so. A commit given only its time is the
 * Operator's, as aCommit makes it.
 */
export function anOpenPullRequest(
  { commits = [], ...overrides }: Omit<Partial<OpenPullRequestFacts>, "commits"> & { readonly commits?: readonly (Partial<CommitFacts> & Pick<CommitFacts, "at">)[] } = {},
): OpenPullRequestFacts {
  return {
    number: 50,
    ticket: 7,
    title: "Build the thing",
    draft: true,
    headSha: "h".repeat(40),
    createdAt: "2026-10-01T00:00:00Z",
    commits: commits.map((commit) => aCommit(commit.at, commit)),
    reviews: [],
    comments: [],
    labelEvents: [],
    mergeable: true,
    draftEvents: [],
    ...overrides,
  };
}

/**
 * Open Plain pull request 70, a Kit bump: Dependabot's, on the branch its
 * `fabrik` group names (as a real one's), out of draft, merging cleanly,
 * closing nothing, opened with its head on 2026-11-06 at 20:00.
 */
export function aPlainPullRequest(overrides: Partial<PlainPullRequestFacts> = {}): PlainPullRequestFacts {
  return {
    number: 70,
    title: "fabrik: bump the fabrik group with 2 updates",
    author: "dependabot[bot]",
    headRef: "dependabot/github_actions/fabrik-d03f57835c",
    headSha: "p".repeat(40),
    headCommittedAt: "2026-11-06T20:00:00Z",
    draft: false,
    mergeable: true,
    closes: [],
    draftChangedAt: null,
    createdAt: "2026-11-06T20:00:00Z",
    ...overrides,
  };
}

/**
 * Open weekly-limit issue 20, the Fabrik App's, whose limit resets at
 * `resetsAt` (none said when null), holding these runs with a held marker each.
 */
export function aWeeklyLimitIssue(resetsAt: string | null, held: readonly HeldRun[] = [], overrides: Partial<KitIssueSnapshot> = {}): KitIssueSnapshot {
  return {
    number: 20,
    labels: ["fabrik:weekly-limit"],
    body: ["The weekly usage limit is reached.", ...(resetsAt === null ? [] : ["", resetsAtMarker(resetsAt)])].join("\n"),
    comments: held.map((run) => `The run is held.\n\n${heldMarker(run)}`),
    ...overrides,
  };
}

/** The stats block's lines for Sentry group 4504's stats (the Monitor fixtures' aGroup()), as the Monitor writes them. */
export const AGROUP_STATS: readonly string[] = [
  "- Events in the last 24 hours: 9",
  "- Users affected: 4",
  "- Last seen: 2026-11-06 06:15 UTC",
  "- Release: `clinic@1.4.0`",
];

/** A Monitor issue's body for group 4504, its stats block holding these lines. */
export function aMonitorIssueBody(stats: readonly string[] = AGROUP_STATS): string {
  return [
    "<!-- fabrik:monitor sentry:4504 -->",
    "Sentry reports a production error in this repo, `CLINIC-7`.",
    "",
    "- Culprit: `POST /api/book`",
    "<!-- fabrik:monitor-stats -->",
    ...stats,
    "<!-- /fabrik:monitor-stats -->",
    "",
    "[The group in Sentry](https://acme.sentry.io/issues/4504/)",
  ].join("\n");
}

/** Open issue 41, the Fabrik App's Monitor error issue for Sentry group 4504, its stats block holding no held line unless a test's body says so. */
export function anOpenMonitorIssue(overrides: Partial<MonitorIssueFacts> = {}): MonitorIssueFacts {
  return { number: 41, author: "fabrik-app[bot]", body: aMonitorIssueBody(), ...overrides };
}

/** What the Standing rule reads of `owner/product`: its GitHub facts, nothing in them unless a test says so, no Kit config read, and the Operator and the Fabrik App by login. */
export function standingFactsOf(overrides: Partial<Omit<StandingFacts, "kind">> = {}): StandingFacts {
  return { kind: "product", github: factsOf(), kit: null, operator: "operator", appLogin: "fabrik-app[bot]", runsEnded: [], ...overrides };
}

/**
 * What a gather shaped for Home reads of `owner/product` (./gather.ts): its
 * Kit config the default at `main`, nothing for Dispatch to weigh, the
 * Operator `operator`, the Fabrik App `fabrik-app[bot]`, and no GitHub facts,
 * issue bodies, merges, cross-references, Tickets' states or evidence markers unless a test
 * says so.
 */
export function homeFactsOf(overrides: Partial<Omit<Facts, "kind">> = {}): Facts {
  return {
    kind: "product",
    github: factsOf(),
    kit: { repo: "owner/product", branch: "main", config: { ok: true, config: DEFAULT_KIT_CONFIG }, dispatch: null },
    operator: "operator",
    appLogin: "fabrik-app[bot]",
    issueBodies: [],
    mergedLastDay: [],
    crossReferences: [],
    ticketStates: [],
    evidenceMarkers: [],
    ...overrides,
  };
}

/** Agent pull request 50, titled "Build the thing", closing Ticket 7, merged at `mergedAt` with merge commit `m…`: one of the agent pull requests merged in the last 24 hours a gather keeps. */
export function aMergedLastDay(mergedAt: string, overrides: Partial<MergedLastDayFacts> = {}): MergedLastDayFacts {
  return { number: 50, title: "Build the thing", ticket: 7, mergeCommit: "m".repeat(40), mergedAt, ...overrides };
}

/** How one merge's deploy stands: none started, unless a test says otherwise. */
export function aDeployOf(overrides: Partial<DeployOf> = {}): DeployOf {
  return { is: "none", deployment: null, commit: null, at: null, log: null, ...overrides };
}

/** A Deployments read of `owner/product`'s `production` environment at the filing's time, holding these merges by merge commit. */
export function aDeploymentsRead(merges: DeploymentsRead["merges"], readAt = "2026-11-08T20:00:00Z"): DeploymentsRead {
  return { repo: "owner/product", environment: "production", readAt, merges };
}

/** An Implement run in flight on no Ticket the job names, told by its job's name, running, its workflow run (1, first attempt) created an hour before the filing, with no start read, unless a test says otherwise. */
export function aRunInFlight(overrides: Partial<RunInFlightFact> = {}): RunInFlightFact {
  return { role: "implement", issue: null, pullRequest: null, retry: null, kind: null, job: "running", createdAt: "2026-11-08T19:00:00Z", exact: false, run: 1, attempt: 1, startedAt: null, ...overrides };
}

/** The runs read's run in flight, with aRunInFlight's defaults, no model, and the run's page as its link, unless a test says otherwise. */
export function aRunRead(overrides: Partial<RunInFlight> = {}): RunInFlight {
  const run = overrides.run ?? 1;
  return { ...aRunInFlight(), model: null, url: `https://github.com/owner/product/actions/runs/${run}`, ...overrides };
}

/** A read of `owner/product`'s Actions at the filing's time with these runs in flight, and a Tick that started at the top of the hour. */
export function aRunsRead(runs: readonly RunInFlight[] | "unread", readAt = "2026-11-08T20:00:00Z"): RunsRead {
  return { repo: "owner/product", readAt, runs, tick: { lastStartedAt: "2026-11-08T20:00:00Z" } };
}

/** What the Standing rule reads of the store: nothing in it unless a test says so. */
export function storeFactsOf(overrides: Partial<Omit<StoreStandingFacts, "kind">> = {}): StoreStandingFacts {
  return { kind: "store", summaries: [], failedSummaryIssues: [], readyForHuman: [], ...overrides };
}

/** Weekly summary issue 9, open, its body written on 2026-11-09 at 07:00 UTC, with no comments of the Fabrik App's unless a test says so. */
export function aSummaryIssue(overrides: Partial<WeeklySummaryIssueFacts> = {}): WeeklySummaryIssueFacts {
  return { number: 9, open: true, bodyWrittenAt: "2026-11-09T07:00:00Z", appComments: [], ...overrides };
}
