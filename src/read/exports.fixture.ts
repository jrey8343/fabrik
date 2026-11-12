// The read library's interface fixture: every name the entry (./index.ts)
// exports, with a small call of each value made from built inputs, and one
// value of each type. ./index.test.ts holds the entry to it both ways, writes
// every value as JSON and reads it back, and runs every call with the one
// thing a Worker can't do made to throw. A Ticket that adds an export adds its
// entries here, under its own heading, one argument to a line.
import {
  A_REPLAY,
  aComment,
  aCommit,
  aDeploymentsRead,
  aDeployOf,
  aDesignRound,
  aDesignTurnFailedNotice,
  aFollowUpIssue,
  AGROUP_STATS,
  aLabelAdded,
  aMapCapRefusal,
  aMergedLastDay,
  aMergedPullRequest,
  aMonitorIssueBody,
  AN_UNKNOWN_COST,
  anAnswersComment,
  anAuditRunRecord,
  anEscapeMarkerIssue,
  anOpenAudit,
  anOpenIssue,
  anOpenMonitorIssue,
  anOpenPullRequest,
  anOpenReplay,
  anOpenRetro,
  aPlainPullRequest,
  aReplayBody,
  aReplayRunRecord,
  aRetroRunRecord,
  aReview,
  aRunInFlight,
  aRunRecord,
  aSpec,
  aSummaryIssue,
  aTicketTimeline,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  standingFactsOf,
  storeFactsOf,
  CAPTURE_RESULT_FILE,
  checkCallerWorkflow,
  costOf,
  costPerMergedPullRequestOf,
  DEFAULT_KIT_CONFIG,
  evidenceMarkerIn,
  gatherRepo,
  GitHub,
  GitHubError,
  gitHubMessageOf,
  hasUnknownCostBasis,
  headsToCheck,
  homeFactsOf,
  isLive,
  joinChecks,
  joinDeployments,
  joinRuns,
  KIT_SAID_VERSION,
  kitSaidIn,
  MERGED_STANDS_HOURS,
  mergesToRead,
  newerSchemaOf,
  NO_DEPLOY_SEEN_MINUTES,
  parseCaptureResult,
  productionPageUrl,
  readCaller,
  readDeployments,
  readOutcomes,
  readIssuesToRollIn,
  readKitConfigSources,
  readRunRecord,
  readRequiredChecks,
  readRound,
  readRuns,
  readSpend,
  refusalOf,
  requiredChecksFactOf,
  resolveKitConfig,
  roundLineIn,
  rowsOf,
  RUN_RECORD_SCHEMA,
  runnerTimeOf,
  runsInFlightFactOf,
  runwayOf,
  STANDING_NAMES,
  STANDING_SCHEMA,
  standingAt,
  standingsOf,
  stuckBarMinutes,
  subscriptionReadingsOf,
  TICK_DEAD_MINUTES,
  TICK_MINUTES,
  weeksEndingAt,
  wordStanding,
} from "./index.ts";
import type {
  ActionsStep,
  CallerCheck,
  CallerRead,
  CaptureResult,
  CaptureResultRead,
  CostFigure,
  DeploymentsRead,
  DeployOf,
  EvidenceMarker,
  Facts,
  HeadCheck,
  IssuesToRollIn,
  IssueToRollIn,
  KitConfig,
  KitConfigResult,
  KitConfigSources,
  KitSaid,
  MergedInWeek,
  MergedLastDayFacts,
  MergeToRead,
  OutcomesRead,
  ReadClient,
  RepoRead,
  Repo,
  RequiredChecksRead,
  Row,
  RunInFlight,
  RunKind,
  RunnerTime,
  RoundLine,
  RoundRead,
  RunRecord,
  RunsRead,
  Runway,
  SpendRead,
  Standing,
  StandingFacts,
  StandingName,
  StandingWords,
  StoreFacts,
  StoreStandingFacts,
  SubscriptionReading,
  Week,
  WorkOutcome,
} from "./index.ts";

/** A refusal for want of a permission, as GitHub answers an App that lacks one. */
const REFUSAL = new GitHubError("GitHub GET /repos/owner/product failed: 403", 403, {
  body: JSON.stringify({ message: "Resource not accessible by integration" }),
  request: "GET /repos/owner/product",
});

/** A client every call of which GitHub refuses, for want of a permission. */
export const REFUSING_CLIENT: ReadClient = {
  rest: () => Promise.reject(REFUSAL),
  graphql: () => Promise.reject(REFUSAL),
  fileText: () => Promise.reject(REFUSAL),
};

/** A client that answers `owner/product`'s files at `main` and nothing else. */
function clientWithFiles(files: Readonly<Record<string, string>>): ReadClient {
  return {
    rest: () => Promise.reject(REFUSAL),
    graphql: () => Promise.reject(REFUSAL),
    fileText: (repo, path, ref) => Promise.resolve(repo.owner === "owner" && repo.name === "product" && ref === "main" ? (files[path] ?? null) : null),
  };
}

const NOW = "2026-11-09T12:00:00Z";

/** Agent pull request 50 for Ticket 7, merged on 2026-11-04, as GitHub's GraphQL answers it. */
const A_MERGED_PULL_REQUEST = {
  number: 50,
  url: "https://github.com/owner/product/pull/50",
  state: "MERGED",
  mergedAt: "2026-11-04T10:00:00Z",
  closedAt: "2026-11-04T10:00:00Z",
  headRefName: "fabrik/ticket-7",
  author: { login: "fabrik-app", __typename: "Bot" },
  closingIssuesReferences: { nodes: [{ number: 7 }] },
};

/** Ticket 7, closed by the merge of A_MERGED_PULL_REQUEST, as GitHub's GraphQL answers it. */
const A_MERGED_TICKET = {
  number: 7,
  title: "Build the thing",
  url: "https://github.com/owner/product/issues/7",
  state: "CLOSED",
  closedAt: "2026-11-04T10:00:00Z",
  author: { login: "operator", __typename: "User" },
  labels: { nodes: [{ name: "ready-for-agent" }] },
  subIssues: { nodes: [] },
  timelineItems: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [A_MERGED_PULL_REQUEST] },
};

/** Ticket 7, `ready-for-agent`, given `agent:implement` on 2026-11-08 at 19:20, with no run started on it since. */
const A_TICKET_WAITING = anOpenIssue({
  number: 7,
  title: "Build the thing",
  labels: ["ready-for-agent", "agent:implement"],
  labelEvents: [{ label: "agent:implement", action: "labeled", actor: "operator", at: "2026-11-08T19:20:00Z" }],
});

/** Ticket 7's Standing, its Implement run asked for and not started, as the rule kept it. */
const A_KEPT_STANDING = {
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
} as const satisfies Standing;

/** What the Kit job routed: a second Retry of the Implement run on Ticket 12, on its agent pull request 40. */
const A_KIT_SAID = {
  fabrik: 1,
  route: "implement",
  run: { role: "implement", issue: 12, pullRequest: 40, kind: "retry", retry: 2, model: "claude-opus-4-1" },
  held: [],
  replay: null,
} as const satisfies KitSaid;

/** The Kit job's closing step, completed, named for that line. */
const A_CLOSING_STEP = { name: JSON.stringify(A_KIT_SAID), status: "completed", conclusion: "success" } as const satisfies ActionsStep;

/** That run in flight in Actions run 7, its second attempt, its Implement job running. */
const A_RUN_IN_FLIGHT = {
  run: 7,
  attempt: 2,
  exact: true,
  role: "implement",
  issue: 12,
  pullRequest: 40,
  kind: "retry",
  retry: 2,
  model: "claude-opus-4-1",
  job: "running",
  createdAt: "2026-11-09T11:00:00Z",
  startedAt: "2026-11-09T11:02:00Z",
  url: "https://github.com/owner/product/actions/runs/7/job/3",
} as const satisfies RunInFlight;

/** `owner/product`'s Actions, read at NOW: that run in flight, and its Tick last started five minutes before. */
const A_RUNS_READ = {
  repo: "owner/product",
  readAt: NOW,
  runs: [A_RUN_IN_FLIGHT],
  tick: { lastStartedAt: "2026-11-09T11:55:00Z" },
} as const satisfies RunsRead;

/** `owner/product`'s Required checks read at NOW: `main` holds admins to its rules and requires `test`, which passed on Plain pull request 70's head. */
const A_CHECKS_READ = {
  repo: "owner/product",
  branch: "main",
  readAt: NOW,
  required: ["test"],
  holdsAdmins: "yes",
  heads: { ["p".repeat(40)]: [{ name: "test", is: "passed", url: "https://github.com/owner/product/runs/1", at: "2026-11-09T11:30:00Z" }] },
} as const satisfies RequiredChecksRead;

/** Agent pull request 50 for Ticket 7, merged at 11:30 with merge commit `m…`, in a repo declaring production in environment `production`. */
const A_MERGE_AT_PRODUCTION = homeFactsOf({
  kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } }, dispatch: null },
  mergedLastDay: [aMergedLastDay("2026-11-09T11:30:00Z")],
});

/** `owner/product`'s Deployments in `production` read at NOW: merge `m…` deploying since 11:40. */
const A_DEPLOYMENTS_READ = aDeploymentsRead({ ["m".repeat(40)]: aDeployOf({ is: "running", deployment: 901, commit: "m".repeat(40), at: "2026-11-09T11:40:00Z" }) }, NOW) satisfies DeploymentsRead;

/** A Run record as schema 7 wrote it, before Broken runs were recorded. */
function aSchema7Record(): unknown {
  const { brokenRun: _left, ...fields } = aRunRecord();
  return { ...fields, schema: 7 };
}

/**
 * `owner/product`, a Product repo whose caller pins v3.1.0 and whose Kit
 * config names no Operator, at head `d…d` of `main`; every query of its facts
 * GitHub refuses, for want of a permission.
 */
const A_PRODUCT_REPO_REFUSING_ITS_FACTS: ReadClient = {
  rest: () => Promise.reject(REFUSAL),
  graphql: <T,>(query: string) =>
    query.includes("defaultBranchRef { name target { oid } }") && !query.includes("issues(")
      ? Promise.resolve({ repository: { owner: { login: "owner" }, defaultBranchRef: { name: "main", target: { oid: "d".repeat(40) } } } } as T)
      : Promise.reject(REFUSAL),
  fileText: (_repo, path) =>
    Promise.resolve(path === ".github/workflows/fabrik.yml" ? "jobs:\n  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v3.1.0\n" : null),
};

/** A weekly-limit reading, 42% used, its week resetting on 2026-11-13 at 04:00 UTC. */
const A_WEEKLY_READING = { status: "allowed", rateLimitType: "seven_day", utilization: 0.42, resetsAt: Date.parse("2026-11-13T04:00:00Z") / 1000 };

/**
 * A client over issue 21 of `owner/product`, open in a Design session with no
 * parent, its comments these, as the Round read asks for them, and no Map open.
 */
function aDesignSessionOf(comments: readonly ReturnType<typeof aComment>[]): ReadClient {
  const nodes = comments.map(({ body, at, author, byBot }, index) => ({
    databaseId: 5001 + index,
    url: `https://github.com/owner/product/issues/21#issuecomment-${5001 + index}`,
    body,
    createdAt: at,
    author: byBot ? { __typename: "Bot", login: author.replace(/\[bot\]$/, "") } : { __typename: "User", login: author },
  }));
  return {
    rest: () => Promise.reject(REFUSAL),
    fileText: () => Promise.reject(REFUSAL),
    graphql: <T,>(_query: string, variables: Record<string, unknown>) =>
      Promise.resolve(
        (variables["map"] === undefined
          ? { repository: { issue: { state: "OPEN", labels: { nodes: [{ name: "needs-design" }] }, parent: null, comments: { nodes } } } }
          : { repository: { issues: { nodes: [] } } }) as T,
      ),
  };
}

/** The Operator's reply on issue 21 at `at`. */
const anOperatorReply = (at: string) => aComment("The cart.", at, { author: "owner", byBot: false });

/** A Round's line: the second Round of a session, asking one question and whether to chart a Map instead. */
const A_ROUND_LINE = {
  v: 1,
  kind: "round",
  round: 2,
  intro: "One thing to settle.",
  questions: [{ question: "Which page first?", recommendation: "The cart, as it's where people stop." }],
  asksMap: true,
} as const satisfies RoundLine;

/** A UI pull request's evidence marker, as the push job writes it and the preview step completes it. */
const A_UI_EVIDENCE_MARKER = {
  run: 4410,
  artifact: 901,
  failure: null,
  routes: ["/book?when=today", "/"],
  preview: { is: "linked", url: "https://fabrik-ticket-7.shop.example.dev/" },
  missed: [{ route: "/", viewport: "desktop", side: "before" }],
} as const satisfies EvidenceMarker;

/** The body of a UI pull request the Fabrik App opened, its evidence section closed by its marker. */
const A_UI_PULL_REQUEST_BODY = [
  "The Implementer built the booking page.",
  "",
  "<!-- fabrik:ui-evidence-start -->",
  "## UI evidence",
  `<!-- fabrik:ui-evidence ${JSON.stringify(A_UI_EVIDENCE_MARKER)} -->`,
].join("\n");

/** A prototype round as the Fabrik App posts it: the Round's marker, the prototype round's, then its line. */
const A_PROTOTYPE_ROUND = [
  "<!-- fabrik:design-round 2 -->",
  "<!-- fabrik:prototype-round -->",
  `<!-- fabrik:round-line ${JSON.stringify({
    v: 1,
    kind: "prototype",
    round: 2,
    intro: "Two takes on the booking page.",
    questions: [{ question: "Which variant?", recommendation: "B, as it shows the price first." }],
    route: "/book",
    recommended: "B",
    variants: [
      { letter: "A", summary: "The calendar first.", component: "https://github.com/owner/product/blob/b1/src/BookA.tsx", preview: null },
      { letter: "B", summary: "The price first.", component: "https://github.com/owner/product/blob/b1/src/BookB.tsx", preview: null },
    ],
    captures: { run: 4420, artifact: 902 },
  })} -->`,
  "Two takes on the booking page.",
].join("\n");

/** A UI pull request's capture result, as the Implement job's capture step writes it: a Before and an After of one route, signed in. */
const A_CAPTURE_RESULT = {
  outcome: "captured",
  headSha: "h".repeat(40),
  captures: [
    { route: "/book", reason: "ticket", viewport: "mobile", side: "before", status: 200, image: "before-mobile-book.png", identity: "owner" },
    { route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png", identity: "owner" },
  ],
} as const satisfies CaptureResult;

/** A Prototype's capture result, as the prototype job writes it: variant A with its video, variant B whose video wasn't recorded. */
const A_PROTOTYPE_CAPTURE_RESULT = {
  outcome: "captured",
  headSha: "b".repeat(40),
  captures: [
    { route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" },
    { route: "/book", variant: "B", viewport: "mobile", status: 200, image: "variant-b-mobile.png" },
  ],
} as const satisfies CaptureResult;

/** One small call of every value the entry exports, keyed by its name: a constant is returned as it is. */
export const EXPORT_CALLS: Readonly<Record<string, () => unknown>> = {
  // The client and its errors

  GitHub: () =>
    new GitHub(
      "a-token",
    ),
  GitHubError: () =>
    new GitHubError(
      "GitHub GET /repos/owner/product failed: 404",
      404,
    ),
  gitHubMessageOf: () =>
    gitHubMessageOf(
      REFUSAL,
    ),
  refusalOf: () =>
    refusalOf(
      REFUSAL,
    ),

  // Run records

  RUN_RECORD_SCHEMA: () => RUN_RECORD_SCHEMA,
  readRunRecord: () =>
    readRunRecord(
      aSchema7Record(),
      ["Claude token"],
    ),
  newerSchemaOf: () =>
    newerSchemaOf(
      { schema: RUN_RECORD_SCHEMA + 1 },
    ),

  // Kit config and the caller's pin

  checkCallerWorkflow: () =>
    checkCallerWorkflow(
      "jobs:\n  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3\n",
    ),
  DEFAULT_KIT_CONFIG: () => DEFAULT_KIT_CONFIG,
  readKitConfigSources: () =>
    readKitConfigSources(
      clientWithFiles({ ".fabrik/config.json": '{ "max_in_flight": 3 }' }),
      { owner: "owner", name: "product" },
      "main",
    ),
  resolveKitConfig: () =>
    resolveKitConfig(
      { config: '{ "max_in_flight": 3 }' },
    ),

  // The Standing

  STANDING_NAMES: () => STANDING_NAMES,
  STANDING_SCHEMA: () => STANDING_SCHEMA,
  standingAt: () =>
    standingAt(
      A_KEPT_STANDING,
      NOW,
    ),
  standingsOf: () =>
    standingsOf(
      standingFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }) }),
      NOW,
    ),
  stuckBarMinutes: () =>
    stuckBarMinutes(
      DEFAULT_KIT_CONFIG,
    ),
  TICK_MINUTES: () => TICK_MINUTES,
  wordStanding: () =>
    wordStanding(
      A_KEPT_STANDING,
      NOW,
      "Europe/London",
    ),

  // Fact builders and cost functions

  A_REPLAY: () => A_REPLAY,
  aComment: () =>
    aComment(
      "Thanks, merging.",
      "2026-11-08T19:00:00Z",
      { author: "operator", byBot: false },
    ),
  aCommit: () =>
    aCommit(
      "2026-11-08T19:00:00Z",
    ),
  aDesignRound: () =>
    aDesignRound(
      2,
      "2026-11-08T19:00:00Z",
    ),
  aDesignTurnFailedNotice: () =>
    aDesignTurnFailedNotice(
      "2026-11-08T19:00:00Z",
    ),
  aFollowUpIssue: () =>
    aFollowUpIssue(
      50,
      "Split the cart module",
    ),
  AGROUP_STATS: () => AGROUP_STATS,
  aLabelAdded: () =>
    aLabelAdded(
      "agent:implement",
      "2026-11-08T19:20:00Z",
    ),
  aMapCapRefusal: () =>
    aMapCapRefusal(
      "2026-11-08T19:00:00Z",
    ),
  aMergedPullRequest: () =>
    aMergedPullRequest(
      "2026-11-04T12:00:00Z",
    ),
  aMonitorIssueBody: () => aMonitorIssueBody(),
  AN_UNKNOWN_COST: () => AN_UNKNOWN_COST,
  anAnswersComment: () =>
    anAnswersComment(
      900,
      { reviewMiss: true, amendsTicket: false },
      "2026-11-08T19:00:00Z",
    ),
  anAuditRunRecord: () => anAuditRunRecord(),
  anEscapeMarkerIssue: () =>
    anEscapeMarkerIssue(
      "Worth a deeper module.",
    ),
  anOpenAudit: () => anOpenAudit(),
  anOpenIssue: () => anOpenIssue(),
  anOpenMonitorIssue: () => anOpenMonitorIssue(),
  anOpenPullRequest: () =>
    anOpenPullRequest(
      { commits: [{ at: "2026-11-08T19:00:00Z" }] },
    ),
  anOpenReplay: () => anOpenReplay(),
  anOpenRetro: () => anOpenRetro(),
  aPlainPullRequest: () => aPlainPullRequest(),
  aReplayBody: () =>
    aReplayBody(
      { state: "done", run: 2000 },
    ),
  aReplayRunRecord: () => aReplayRunRecord(),
  aRetroRunRecord: () => aRetroRunRecord(),
  aReview: () =>
    aReview(
      "2026-11-08T19:00:00Z",
    ),
  aRunInFlight: () => aRunInFlight(),
  aRunRecord: () => aRunRecord(),
  aSpec: () =>
    aSpec(
      [{ label: "ready-for-agent", action: "labeled", actor: "operator", at: "2026-11-01T00:00:00Z" }],
    ),
  aSummaryIssue: () => aSummaryIssue(),
  aTicketTimeline: () =>
    aTicketTimeline(
      [{ label: "agent:implement", action: "labeled", actor: "operator", at: "2026-11-08T19:20:00Z" }],
    ),
  aVerdictComment: () =>
    aVerdictComment(
      "pass",
      "h".repeat(40),
      "2026-11-08T19:00:00Z",
    ),
  aWeeklyLimitIssue: () =>
    aWeeklyLimitIssue(
      "2026-11-10T00:00:00Z",
      [{ role: "implement", issue: 7, label: "agent:implement" }],
    ),
  factsOf: () => factsOf(),
  standingFactsOf: () => standingFactsOf(),
  storeFactsOf: () => storeFactsOf(),
  costOf: () =>
    costOf(
      [aRunRecord(), aRunRecord({ runId: 1001, ...AN_UNKNOWN_COST })],
    ),
  hasUnknownCostBasis: () =>
    hasUnknownCostBasis(
      aRunRecord(AN_UNKNOWN_COST),
    ),
  isLive: () =>
    isLive(
      aRunRecord(),
    ),
  weeksEndingAt: () =>
    weeksEndingAt(
      Date.parse(NOW),
      "Europe/London",
    ),

  // The closing line and the runs read

  KIT_SAID_VERSION: () => KIT_SAID_VERSION,
  kitSaidIn: () =>
    kitSaidIn(
      [A_CLOSING_STEP],
    ),
  readRuns: () =>
    readRuns(
      REFUSING_CLIENT,
      "owner/product",
      NOW,
    ),
  runsInFlightFactOf: () =>
    runsInFlightFactOf(
      A_RUNS_READ,
    ),
  TICK_DEAD_MINUTES: () => TICK_DEAD_MINUTES,

  // The gather and the rows

  gatherRepo: () =>
    gatherRepo(
      A_PRODUCT_REPO_REFUSING_ITS_FACTS,
      "owner/product",
      NOW,
      "fabrik-app[bot]",
    ),
  homeFactsOf: () =>
    homeFactsOf(
      { github: factsOf({ openIssues: [A_TICKET_WAITING] }) },
    ),
  rowsOf: () =>
    rowsOf(
      homeFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }) }),
      A_RUNS_READ,
      A_CHECKS_READ,
      A_DEPLOYMENTS_READ,
      NOW,
    ),

  // The join with runs

  joinRuns: () =>
    joinRuns(
      [{ standing: A_KEPT_STANDING, title: "Build the thing", lastWord: null, related: [], mentions: [], relatedTo: null, followUps: [], ticketClosed: null, plainPullRequest: null, evidence: null, production: null, prototype: null, digest: null }],
      { ...A_RUNS_READ, runs: [{ ...A_RUN_IN_FLIGHT, issue: 7, pullRequest: null, kind: "first", retry: null }] },
      NOW,
    ),

  // The Required checks

  headsToCheck: () =>
    headsToCheck(
      rowsOf(homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest()] }) }), null, null, null, NOW),
    ),
  joinChecks: () =>
    joinChecks(
      rowsOf(homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest()] }) }), null, null, null, NOW),
      A_CHECKS_READ,
      NOW,
    ),
  readRequiredChecks: () =>
    readRequiredChecks(
      REFUSING_CLIENT,
      "owner/product",
      ["p".repeat(40)],
      NOW,
    ),
  requiredChecksFactOf: () =>
    requiredChecksFactOf(
      A_CHECKS_READ,
      "p".repeat(40),
    ),

  // The caller read

  readCaller: () =>
    readCaller(
      {
        rest: () => Promise.resolve({ head: { sha: "abc123" }, base: { ref: "main" } }),
        fileText: (repo, path, ref) =>
          Promise.resolve(
            repo.owner === "owner"
              ? `jobs:\n  tick:\n    uses: jrey8343/fabrik/.github/workflows/schedule.yml@${ref === "main" ? "v1.0.0" : "v1.1.0"}\n    permissions:\n      id-token: write\n`
              : path === ".github/workflows/schedule.yml" && ref === "v1.1.0"
                ? "on:\n  workflow_call:\njobs:\n  tick:\n    permissions:\n      id-token: write\n      actions: read\n"
                : null,
          ),
      },
      "owner/product",
      42,
    ),

  // Spend

  readSpend: () =>
    readSpend(
      {
        rest: (_method, path) =>
          Promise.resolve({
            truncated: false,
            tree: path.endsWith("/HEAD")
              ? [{ path: "runs", type: "tree", sha: "runs" }]
              : path.endsWith("/runs")
                ? [{ path: "owner", type: "tree", sha: "owner" }]
                : path.endsWith("/owner")
                  ? [{ path: "product", type: "tree", sha: "product" }]
                  : path.endsWith("/product")
                    ? [{ path: "2026-11", type: "tree", sha: "2026-11" }]
                    : [{ path: "1000-1-implement.json", type: "blob", sha: "a-blob" }],
          }),
        fileText: (_repo, path) =>
          Promise.resolve(path.startsWith("runs/") ? JSON.stringify(aSchema7Record()) : '    - cron: "0 8 * * 1"\n      timezone: "Europe/London"\n'),
      },
      ["2026-11"],
      (path) => path.endsWith("/999-1-implement.json"),
      NOW,
    ),
  subscriptionReadingsOf: () =>
    subscriptionReadingsOf(
      [aRunRecord({ endedAt: "2026-11-08T19:00:00Z", rateLimit: A_WEEKLY_READING })],
      NOW,
    ),
  runnerTimeOf: () =>
    runnerTimeOf(
      [aRunRecord({ durationMs: 61_000 }), aRunRecord({ runId: 1001, durationMs: null })],
    ),

  // The runway

  runwayOf: () =>
    runwayOf(
      [
        aRunRecord({ endedAt: "2026-11-08T09:00:00Z", rateLimit: { ...A_WEEKLY_READING, utilization: 0.32 } }),
        aRunRecord({ endedAt: "2026-11-08T19:00:00Z", rateLimit: A_WEEKLY_READING }),
      ],
      [],
      NOW,
    ),

  // The issues to roll in by hand

  readIssuesToRollIn: () =>
    readIssuesToRollIn(
      REFUSING_CLIENT,
      "owner/product",
      { standing: { ...A_KEPT_STANDING, pullRequest: 50 }, related: [], mentions: [{ issue: 40, title: "The cart is slow" }] },
      1,
      "fabrik-app[bot]",
    ),

  // Outcomes

  readOutcomes: () =>
    readOutcomes(
      { graphql: <T>(query: string) => Promise.resolve((query.includes("search(") ? { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [A_MERGED_PULL_REQUEST] } } : { repository: { i7: A_MERGED_TICKET } }) as T) },
      "owner/product",
      weeksEndingAt(Date.parse(NOW), "UTC").thisWeek,
      [7],
      NOW,
    ),
  costPerMergedPullRequestOf: () =>
    costPerMergedPullRequestOf(
      weeksEndingAt(Date.parse(NOW), "UTC").thisWeek,
      [aRunRecord({ totalCostUsd: 3 }), aReplayRunRecord({ totalCostUsd: 40 })],
      [{ repo: "owner/product", ticket: 7 }, { repo: "owner/product", ticket: null }],
    ),

  // The Deployments read

  readDeployments: () =>
    readDeployments(
      REFUSING_CLIENT,
      "owner/product",
      "production",
      [{ mergeCommit: "m".repeat(40), mergedAt: "2026-11-12T08:00:00Z" }],
      NOW,
    ),

  // The Standing at Production

  aDeploymentsRead: () =>
    aDeploymentsRead(
      A_DEPLOYMENTS_READ.merges,
      NOW,
    ),
  aDeployOf: () =>
    aDeployOf(
      { is: "succeeded", deployment: 900, commit: "m".repeat(40), at: "2026-11-09T11:40:00Z" },
    ),
  aMergedLastDay: () =>
    aMergedLastDay(
      "2026-11-09T11:30:00Z",
      { title: "Build the thing" },
    ),
  joinDeployments: () =>
    joinDeployments(
      rowsOf(A_MERGE_AT_PRODUCTION, null, null, null, NOW),
      A_DEPLOYMENTS_READ,
      NOW,
    ),
  mergesToRead: () =>
    mergesToRead(
      rowsOf(A_MERGE_AT_PRODUCTION, null, null, null, NOW),
    ),
  MERGED_STANDS_HOURS: () => MERGED_STANDS_HOURS,
  NO_DEPLOY_SEEN_MINUTES: () => NO_DEPLOY_SEEN_MINUTES,

  // The Round read

  readRound: () =>
    Promise.all([
      readRound(
        aDesignSessionOf([aDesignRound(1, "2026-11-09T09:00:00Z")]),
        "owner/product",
        21,
        { ok: true, config: DEFAULT_KIT_CONFIG },
        "owner",
        "fabrik-app[bot]",
        NOW,
      ),
      readRound(
        aDesignSessionOf([aDesignRound(1, "2026-11-09T09:00:00Z"), anOperatorReply("2026-11-09T10:00:00Z"), aDesignTurnFailedNotice("2026-11-09T11:00:00Z", 9100)]),
        "owner/product",
        21,
        { ok: true, config: DEFAULT_KIT_CONFIG },
        "owner",
        "fabrik-app[bot]",
        NOW,
      ),
      readRound(
        aDesignSessionOf([aDesignRound(1, "2026-11-09T09:00:00Z"), anOperatorReply("2026-11-09T10:00:00Z")]),
        "owner/product",
        21,
        { ok: true, config: DEFAULT_KIT_CONFIG },
        "owner",
        "fabrik-app[bot]",
        NOW,
      ),
      readRound(
        REFUSING_CLIENT,
        "owner/product",
        21,
        { ok: true, config: DEFAULT_KIT_CONFIG },
        "owner",
        "fabrik-app[bot]",
        NOW,
      ),
    ]),

  // Captured routes and Prototypes on rows

  evidenceMarkerIn: () =>
    evidenceMarkerIn(
      A_UI_PULL_REQUEST_BODY,
    ),
  roundLineIn: () =>
    roundLineIn(
      A_PROTOTYPE_ROUND,
    ),

  // Capture results and production addresses

  CAPTURE_RESULT_FILE: () => CAPTURE_RESULT_FILE,
  parseCaptureResult: () => [
    parseCaptureResult(
      `${JSON.stringify(A_CAPTURE_RESULT, null, 2)}\n`,
    ),
    parseCaptureResult(
      `${JSON.stringify(A_PROTOTYPE_CAPTURE_RESULT, null, 2)}\n`,
    ),
    parseCaptureResult(
      "<html>Not Found</html>",
    ),
  ],
  productionPageUrl: () =>
    productionPageUrl(
      { url: "https://shop.example", environment: "production" },
      "/book?when=today",
    ),
};

/** One value of every type the entry exports, keyed by its name. */
export const EXPORT_SHAPES: Readonly<Record<string, unknown>> = {
  // The client and its errors

  ReadClient: REFUSING_CLIENT satisfies ReadClient,
  Repo: { owner: "owner", name: "product" } satisfies Repo,

  // Run records

  RunRecord: aRunRecord() satisfies RunRecord,

  // Kit config and the caller's pin

  CallerCheck: { ok: true, release: "v1.2.3" } satisfies CallerCheck,
  KitConfig: { ...DEFAULT_KIT_CONFIG, maxInFlight: 3 } satisfies KitConfig,
  KitConfigResult: { ok: false, errors: ["maxInFlight is not a Kit config field"] } satisfies KitConfigResult,
  KitConfigSources: {
    config: '{ "max_in_flight": 3 }',
    skillsLock: null,
    instructions: { implement: "Run the tests before you push." },
  } satisfies KitConfigSources,

  // The Standing

  Standing: A_KEPT_STANDING satisfies Standing,
  StandingFacts: standingFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }) }) satisfies StandingFacts,
  StandingName: "not-started" satisfies StandingName,
  StandingWords: {
    pill: "Not started",
    sentence: "Asked for an Implement run 16 hours ago; nothing has started. The Kit adds the label again at its next hourly check.",
    remedy: "Check [the Loop's runs](https://github.com/owner/product/actions), then add `agent:implement` again.",
  } satisfies StandingWords,
  StoreStandingFacts: { kind: "store", summaries: [], failedSummaryIssues: [], readyForHuman: [] } satisfies StoreStandingFacts,

  // Fact builders and cost functions

  CostFigure: { usd: 1, unknownCost: 1 } satisfies CostFigure,
  Week: { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-09T00:00:00Z"), monday: "2026-11-02" } satisfies Week,

  // The closing line and the runs read

  ActionsStep: A_CLOSING_STEP satisfies ActionsStep,
  KitSaid: A_KIT_SAID satisfies KitSaid,
  RunKind: "retry" satisfies RunKind,
  RunInFlight: A_RUN_IN_FLIGHT satisfies RunInFlight,
  RunsRead: A_RUNS_READ satisfies RunsRead,

  // The gather and the rows

  Facts: homeFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }), issueBodies: [{ issue: 7, body: "From PR #50" }] }) satisfies Facts,
  RepoRead: {
    repo: "owner/product",
    product: true,
    release: "v3.1.0",
    operator: "owner",
    kitConfig: { ok: true, config: DEFAULT_KIT_CONFIG },
    uiBlock: "no",
    facts: homeFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }) }),
    unread: null,
  } satisfies RepoRead,
  Row: {
    standing: A_KEPT_STANDING,
    title: "Build the thing",
    lastWord: { text: "The Kit added `agent:implement` again.", at: "2026-11-08T21:20:00Z", url: "https://github.com/owner/product/issues/7#issuecomment-1" },
    related: [{ issue: 30, title: "Cache the prices", kind: "candidate" }],
    mentions: [{ issue: 40, title: "The cart is slow" }],
    relatedTo: 51,
    followUps: [{ title: "Cache the prices", body: "The prices are read on every request.", filedAs: 30 }],
    ticketClosed: null,
    plainPullRequest: null,
    evidence: {
      run: 4410,
      artifact: 901,
      failure: "timeout",
      preview: "linked",
      pages: [{ route: "/book?when=today", preview: "https://fabrik-ticket-7.shop.example.dev/book?when=today" }],
      failureSentence: "Capture failed: it ran out of time.",
      missed: [{ route: "/book?when=today", viewport: "mobile", side: "before" }],
    },
    production: { site: "https://shop.example", tracked: true, pages: [{ route: "/book?when=today", url: "https://shop.example/book?when=today" }] },
    prototype: { round: 2, comment: 5003, postedAt: "2026-11-08T21:00:00Z", waiting: true, route: "/book", captures: { run: 4420, artifact: 902 } },
    digest: null,
  } satisfies Row,
  StoreFacts: {
    kind: "store",
    appLogin: "fabrik-app[bot]",
    summaries: [
      {
        number: 9,
        title: "Weekly summary: 2 to 9 November",
        open: true,
        bodyWrittenAt: "2026-11-09T07:00:00Z",
        appComments: [{ body: "Re-ran.", at: "2026-11-09T08:00:00Z", url: "https://github.com/jrey8343/fabrik-runs/issues/9#issuecomment-1" }],
      },
    ],
    failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [] }],
    readyForHuman: [anOpenIssue({ number: 12, labels: ["ready-for-human"] })],
  } satisfies StoreFacts,

  // The join with runs

  // The Required checks

  HeadCheck: { name: "test", is: "never-reported", url: null, at: null } satisfies HeadCheck,
  RequiredChecksRead: A_CHECKS_READ satisfies RequiredChecksRead,

  // The caller read

  CallerRead: {
    changes: true,
    from: "v1.0.0",
    to: "v1.1.0",
    errors: [
      ".github/workflows/fabrik.yml: the tick job's permissions: lacks `actions: read`, which the tick job of jrey8343/fabrik/.github/workflows/schedule.yml@v1.1.0 asks for. " +
        "GitHub checks every uses: job of a workflow before any job's if:, so until the line is added every run of this workflow fails at startup, whatever the event. " +
        "Add `actions: read` under the tick job's permissions: before merging.",
    ],
  } satisfies CallerRead,

  // Spend

  SpendRead: {
    kind: "read",
    records: { "runs/owner/product/2026-11/1000-1-implement.json": aRunRecord() },
    unreadable: { count: 1, newestSchema: RUN_RECORD_SCHEMA + 1 },
    timeZone: "Europe/London",
  } satisfies SpendRead,
  SubscriptionReading: {
    subscription: "Claude token",
    share: 0.42,
    said: "allowed",
    readAt: "2026-11-08T19:00:00Z",
    resetsAt: "2026-11-13T04:00:00.000Z",
  } satisfies SubscriptionReading,
  RunnerTime: { minutes: 3, uncounted: 1 } satisfies RunnerTime,

  // The runway

  Runway: { kind: "runs-out", at: "2026-11-11T05:00:00.000Z", heldUntil: "2026-11-13T04:00:00.000Z" } satisfies Runway,

  // The issues to roll in by hand

  IssuesToRollIn: {
    page: 1,
    issues: [
      { issue: 40, title: "The cart is slow", mentions: true },
      { issue: 41, title: "Round the totals", mentions: false },
    ],
    more: false,
  } satisfies IssuesToRollIn,
  IssueToRollIn: { issue: 40, title: "The cart is slow", mentions: true } satisfies IssueToRollIn,

  // Outcomes

  OutcomesRead: {
    repo: "owner/product",
    readAt: NOW,
    work: [{ issue: 7, title: "Build the thing", is: "merged", pullRequest: 50, at: "2026-11-04T10:00:00Z", url: "https://github.com/owner/product/pull/50" }],
    merged: [{ pullRequest: 50, ticket: 7, mergedAt: "2026-11-04T10:00:00Z" }],
    unread: null,
  } satisfies OutcomesRead,
  WorkOutcome: {
    issue: 8,
    title: "Fix the other thing",
    is: "never-merged",
    pullRequest: 51,
    at: "2026-11-05T10:00:00Z",
    url: "https://github.com/owner/product/pull/51",
  } satisfies WorkOutcome,
  MergedInWeek: { pullRequest: 52, ticket: null, mergedAt: "2026-11-06T10:00:00Z" } satisfies MergedInWeek,

  // The Deployments read

  DeploymentsRead: {
    repo: "owner/product",
    environment: "production",
    readAt: NOW,
    merges: {
      ["m".repeat(40)]: { is: "succeeded", deployment: 900, commit: "n".repeat(40), at: "2026-11-12T08:06:00Z", log: null },
      ["o".repeat(40)]: "unread",
    },
  } satisfies DeploymentsRead,
  DeployOf: {
    is: "failed",
    deployment: 901,
    commit: "o".repeat(40),
    at: "2026-11-12T09:09:00Z",
    log: "https://github.com/owner/product/actions/runs/40/job/41",
  } satisfies DeployOf,
  MergeToRead: { mergeCommit: "m".repeat(40), mergedAt: "2026-11-12T08:00:00Z" } satisfies MergeToRead,

  // The Standing at Production

  MergedLastDayFacts: { number: 50, title: "Build the thing", ticket: 7, mergeCommit: "m".repeat(40), mergedAt: "2026-11-09T11:30:00Z" } satisfies MergedLastDayFacts,

  // The Round read

  RoundLine: A_ROUND_LINE satisfies RoundLine,
  RoundRead: {
    repo: "owner/product",
    issue: 21,
    readAt: NOW,
    waits: "round",
    round: { comment: 5002, url: "https://github.com/owner/product/issues/21#issuecomment-5002", postedAt: "2026-11-09T11:00:00Z", round: 2, waiting: true, line: A_ROUND_LINE },
    failedTurn: null,
    mapMayBeOffered: true,
  } satisfies RoundRead,

  // Captured routes and Prototypes on rows

  EvidenceMarker: A_UI_EVIDENCE_MARKER satisfies EvidenceMarker,

  // Capture results and production addresses

  CaptureResult: A_PROTOTYPE_CAPTURE_RESULT satisfies CaptureResult,
  CaptureResultRead: { ok: true, result: A_CAPTURE_RESULT } satisfies CaptureResultRead,
};

/**
 * The exports that are not plain data, by name: the client, which is calls,
 * and the two classes, whose calls make instances. Everything else in the
 * fixture, and everything a call of anything else returns, survives being
 * written as JSON and read back.
 */
export const NOT_DATA: readonly string[] = ["GitHub", "GitHubError", "ReadClient"];
