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
  aDigestComment,
  aDesignRound,
  aDesignTurnFailedNotice,
  aFollowUpIssue,
  AGROUP_STATS,
  aLabelAdded,
  aMainChecksRead,
  aMapCapRefusal,
  aMergedLastDay,
  aMergedPullRequest,
  aMonitorIssueBody,
  aNoDigestLine,
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
  aRollInComment,
  aReview,
  aRunInFlight,
  aRunRecord,
  aSpec,
  aStagingFacts,
  aStagingRead,
  aSummaryIssue,
  aTicketTimeline,
  aVerdictComment,
  aWeeklyLimitIssue,
  factsOf,
  standingFactsOf,
  storeFactsOf,
  CAPTURE_RESULT_FILE,
  checkCallerWorkflow,
  commitsToCheck,
  costOf,
  costPerMergedPullRequestOf,
  DEFAULT_KIT_CONFIG,
  DEFAULT_SHOTS_ARTIFACT,
  DROP_REASONS,
  droppedShotSentence,
  evidenceMarkerIn,
  gatherRepo,
  GitHub,
  GitHubError,
  gitHubMessageOf,
  hasUnknownCostBasis,
  headsToCheck,
  homeFactsOf,
  isLive,
  isShotName,
  joinChecks,
  joinDeployments,
  joinRuns,
  joinStaging,
  KIT_SAID_VERSION,
  kitSaidIn,
  MERGED_STANDS_HOURS,
  mergesToRead,
  namedShots,
  newerSchemaOf,
  newerStandingSchemaOf,
  owedRollInsOf,
  NO_DEPLOY_SEEN_MINUTES,
  parseCaptureResult,
  producedNamedShots,
  productionPageUrl,
  promoteListOf,
  readCaller,
  readDeployments,
  readDigestPlaces,
  readFiles,
  readOutcomes,
  readIssuesToRollIn,
  readKitConfigSources,
  readMainChecks,
  readRunRecord,
  readRequiredChecks,
  readRound,
  readRow,
  readRuns,
  readShotsManifest,
  readSpend,
  readStanding,
  refusalOf,
  requiredChecksFactOf,
  resolveKitConfig,
  roundLineIn,
  rowsOf,
  RUN_RECORD_SCHEMA,
  runnerTimeOf,
  runsInFlightFactOf,
  runwayOf,
  SHOT_IMAGE_MAX_BYTES,
  SHOT_LIMIT,
  SHOT_NAME_MAX_LENGTH,
  SHOT_NAME_RULE,
  shotMissSentence,
  SHOTS_FAILURES,
  SHOTS_MANIFEST_FILE,
  SHOTS_MANIFEST_VERSION,
  shotsFailureSentence,
  shotsMarkerIn,
  STANDING_NAMES,
  STANDING_SCHEMA,
  stagingMergesToRead,
  standingAt,
  standingsOf,
  stuckBarMinutes,
  subscriptionReadingsOf,
  TICK_DEAD_MINUTES,
  TICK_MINUTES,
  TRIAL_ACCEPTED_LABEL,
  TRIAL_PROBLEM_LABEL,
  trialProblemIn,
  trialProblemLine,
  weeksEndingAt,
  wordStanding,
} from "./index.ts";
import type {
  ActionsStep,
  ArtifactFile,
  BadManifest,
  CallerCheck,
  CallerRead,
  CaptureResult,
  CaptureResultRead,
  CommitToCheck,
  CostFigure,
  DeploymentsRead,
  DeployOf,
  DigestData,
  DigestRead,
  DropReason,
  DroppedNames,
  DroppedShot,
  EvidenceMarker,
  EvidenceShot,
  Facts,
  FilesRead,
  HeadCheck,
  HealingCheck,
  IssuesToRollIn,
  IssueToRollIn,
  KitConfig,
  KitConfigResult,
  KitConfigSources,
  KitSaid,
  MainCheckOf,
  MainChecksRead,
  MergedInWeek,
  MergedLastDayFacts,
  MergeToRead,
  NamedShot,
  NamedShotAnswer,
  NamedShots,
  OutcomesRead,
  OwedRollIn,
  PlaceShown,
  PromoteEntry,
  PromoteList,
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
  ShotMiss,
  ShotNotProduced,
  ShotsFailure,
  ShotSize,
  ShotsManifest,
  ShotsManifestRead,
  ShotsMarker,
  SpendRead,
  StagingRead,
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

/**
 * GitHub's answer to a query of objects by `ref:path` expressions, as the
 * files read asks (#895), over these files of `owner/product` at `ref`: each
 * a file, a directory any of them is in, with its entries, or nothing.
 * Null for any other query.
 */
function filesQueryAnswer(files: Readonly<Record<string, string>>, ref: string, query: string, variables: Record<string, unknown>): unknown {
  const objects = [...query.matchAll(/(\w+): object\(expression: \$(\w+)\)/g)];
  if (objects.length === 0 || variables["owner"] !== "owner" || variables["name"] !== "product") return null;
  const objectAt = (expression: string) => {
    const [at = "", path = ""] = expression.split(/:(.*)/s);
    const text = files[path];
    if (at !== ref) return null;
    if (text !== undefined) return { __typename: "Blob", text, isBinary: false, isTruncated: false };
    const under = Object.keys(files).flatMap((held) => (path === "" || held.startsWith(`${path}/`) ? [held.slice(path === "" ? 0 : path.length + 1)] : []));
    const names = [...new Set(under.map((rest) => rest.split("/")[0] ?? ""))];
    return names.length === 0 ? null : { __typename: "Tree", entries: names.map((name) => ({ name, mode: under.includes(name) ? 33188 : 16384 })) };
  };
  return { repository: Object.fromEntries(objects.map(([, alias = "", variable = ""]) => [alias, objectAt(String(variables[variable]))])) };
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

/** Issue 9, `ready-for-human`, blocked by issue 3 of `a/b` and one issue the Fabrik App can't read (#771). */
export const A_BLOCKED_ISSUE = anOpenIssue({
  number: 9,
  title: "Sign the contract",
  labels: ["ready-for-human"],
  blockers: [{ repo: "a/b", number: 3 }],
  hiddenBlockers: 1,
});

/** Ticket 7, `ready-for-agent`, given `agent:implement` on 2026-11-08 at 19:20, with no run started on it since. */
const A_TICKET_WAITING = anOpenIssue({
  number: 7,
  title: "Build the thing",
  labels: ["ready-for-agent", "agent:implement"],
  labelEvents: [{ label: "agent:implement", action: "labeled", actor: "operator", at: "2026-11-08T19:20:00Z" }],
});

/** Ticket 7's Standing, its Implement run asked for and not started, as the rule kept it. */
const A_KEPT_STANDING = {
  schema: 2,
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

/**
 * Agent pull request 50 for Ticket 7, merged at 11:30 with merge commit `m…`
 * and carrying UI evidence of two routes, in a repo declaring production in
 * environment `production` and staging in `staging`, and naming the Main
 * check `e2e`.
 */
const A_MERGE_AT_STAGING = homeFactsOf({
  kit: {
    repo: "owner/product",
    branch: "main",
    config: {
      ok: true,
      config: {
        ...DEFAULT_KIT_CONFIG,
        production: { url: "https://shop.example", environment: "production" },
        staging: { url: "https://staging.shop.example", environment: "staging" },
        monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: ["e2e"] },
      },
    },
    dispatch: null,
  },
  mergedLastDay: [aMergedLastDay("2026-11-09T11:30:00Z")],
  evidenceMarkers: [{ pullRequest: 50, marker: { run: 4410, artifact: 901, failure: null, routes: ["/book", "/patients/[patientId]/notes"] } }],
});

/** `owner/product`'s Main checks read at NOW: `e2e` green on commit `d…`. */
const A_MAIN_CHECKS_READ = aMainChecksRead(
  { ["d".repeat(40)]: [{ name: "e2e", is: "green", url: "https://github.com/owner/product/actions/runs/7/job/901", at: "2026-11-09T11:55:00Z" }] },
  NOW,
) satisfies MainChecksRead;

/**
 * What a reader read of `owner/product`'s staging at NOW: its Deployments in
 * `staging`, asked for the newest success, with merge `m…` deployed at 11:36
 * and the newest deploy that contains it, of commit `d…`, at 11:50; and that
 * Main checks read.
 */
const A_STAGING_READ = aStagingRead(
  {
    ["m".repeat(40)]: aDeployOf({
      is: "succeeded",
      deployment: 900,
      commit: "m".repeat(40),
      at: "2026-11-09T11:36:00Z",
      newest: { deployment: 905, commit: "d".repeat(40), at: "2026-11-09T11:50:00Z" },
    }),
  },
  A_MAIN_CHECKS_READ,
  NOW,
) satisfies StagingRead;

/** That read's Deployments read of `staging`. */
const A_STAGING_DEPLOYMENTS_READ = A_STAGING_READ.deployments satisfies DeploymentsRead;

/**
 * A_MERGE_AT_STAGING's repo as a gather reads it past the last day (#857),
 * its production block naming the workflow `deploy-production.yml`:
 * production last deployed by Deployment 880 of commit `p…`, which succeeded
 * on 2026-11-08 at 09:15, and since then agent pull request 50 and
 * Dependabot's Kit bump 51 merged.
 */
const A_REPO_TO_PROMOTE = {
  ...A_MERGE_AT_STAGING,
  kit: {
    repo: "owner/product",
    branch: "main",
    config: {
      ok: true,
      config: {
        ...DEFAULT_KIT_CONFIG,
        production: { url: "https://shop.example", environment: "production", workflow: "deploy-production.yml" },
        staging: { url: "https://staging.shop.example", environment: "staging" },
        monitor: { ...DEFAULT_KIT_CONFIG.monitor, mainChecks: ["e2e"] },
      },
    },
    dispatch: null,
  },
  staging: aStagingFacts({
    since: { from: "production", deployment: 880, commit: "p".repeat(40), cutAt: "2026-11-08T09:00:00Z", deployedAt: "2026-11-08T09:15:00Z" },
    unpromoted: [aMergedLastDay("2026-11-09T11:30:00Z")],
    plain: [{ number: 51, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-09T10:00:00Z", author: "dependabot[bot]", headRef: "dependabot/github_actions/fabrik-3.2.0", closes: [] }],
    mergedSince: 2,
  }),
} satisfies Facts;

/**
 * Agent pull request 50's Standing at Staging in that repo at NOW, with
 * A_STAGING_READ: on staging since its first deploy at 11:36, the Operator's
 * move and stopping no work, with no result, so with no time it stands until.
 */
const AN_UNTRIED_STANDING = {
  schema: STANDING_SCHEMA,
  repo: "owner/product",
  issue: 7,
  pullRequest: 50,
  work: "ticket",
  place: "staging",
  name: "on-staging",
  move: "operator",
  yours: true,
  stopsWork: false,
  since: "2026-11-09T11:36:00Z",
  stuckAt: null,
  awaits: null,
  subscription: null,
  detail: {
    mergeCommit: "m".repeat(40),
    mergedAt: "2026-11-09T11:30:00Z",
    environment: "staging",
    noDeployAt: null,
    deployment: 905,
    log: null,
    deploysUnread: false,
    staging: {
      environment: "staging",
      productionEnvironment: "production",
      trial: { needed: true, why: "ui-evidence" },
      result: null,
      standsUntil: null,
      mainChecks: ["e2e"],
      check: null,
      checksUnread: false,
    },
  },
} satisfies Standing;

/** Agent pull request 50's entry in that repo's Promote list: on staging, carrying UI evidence of two routes, and untried. */
const AN_UNTRIED_ENTRY = {
  is: "agent",
  pullRequest: 50,
  title: "Build the thing",
  ticket: 7,
  mergedAt: "2026-11-09T11:30:00Z",
  evidence: {
    run: 4410,
    artifact: 901,
    failure: null,
    preview: "unknown",
    pages: [
      { route: "/book", preview: null },
      { route: "/patients/[patientId]/notes", preview: null },
    ],
    failureSentence: null,
    missed: null,
  },
  shots: null,
  staging: {
    site: "https://staging.shop.example",
    pages: [
      { route: "/book", url: "https://staging.shop.example/book" },
      { route: "/patients/[patientId]/notes", url: "https://staging.shop.example" },
    ],
    shots: [],
    toTry: ["/book", "/patients/[patientId]/notes"],
  },
  trial: { needed: true, why: "ui-evidence" },
  result: { is: "untried" },
  standing: AN_UNTRIED_STANDING,
} as const satisfies PromoteEntry;

/** AN_UNTRIED_STANDING as another pull request's, for another Ticket: nobody's move, since `since`, before its own name and what it carries are given. */
function nobodysAtStaging(pullRequest: number, issue: number, since: string) {
  return { ...AN_UNTRIED_STANDING, pullRequest, issue, move: "nobody", yours: false, since } as const;
}

/** What AN_UNTRIED_STANDING carries at Staging. */
const ITS_STAGING_DETAIL = AN_UNTRIED_STANDING.detail.staging;

/** The Kit bump's entry: a Plain pull request's, with its kind and nothing more. */
const A_PLAIN_ENTRY = { is: "plain", pullRequest: 51, title: "Bump the Kit to v3.2.0", mergedAt: "2026-11-09T10:00:00Z", kind: "kit-bump" } as const satisfies PromoteEntry;

/** That repo's Promote list at NOW, with A_STAGING_READ. */
const A_PROMOTE_LIST = {
  repo: "owner/product",
  start: { from: "production", deployment: 880, commit: "p".repeat(40), deployedAt: "2026-11-08T09:15:00Z" },
  entries: [AN_UNTRIED_ENTRY, A_PLAIN_ENTRY],
  notAccepted: 1,
  leftOut: 0,
  dispatchPage: "https://github.com/owner/product/actions/workflows/deploy-production.yml",
} as const satisfies PromoteList;

/** A Run record as schema 7 wrote it, before Broken runs were recorded. */
function aSchema7Record(): unknown {
  const { brokenRun: _left, landing: _landing, ...fields } = aRunRecord();
  return { ...fields, schema: 7 };
}

/**
 * `owner/product`, a Product repo whose caller pins v3.1.0 and whose Kit
 * config names no Operator, at head `d…d` of `main`; every query of its facts
 * GitHub refuses, for want of a permission.
 */
const A_PRODUCT_REPO_REFUSING_ITS_FACTS: ReadClient = {
  rest: () => Promise.reject(REFUSAL),
  graphql: <T,>(query: string, variables: Record<string, unknown>) => {
    if (query.includes("defaultBranchRef { name target { oid } }") && !query.includes("issues(")) {
      return Promise.resolve({ repository: { owner: { login: "owner" }, defaultBranchRef: { name: "main", target: { oid: "d".repeat(40) } } } } as T);
    }
    // Its caller workflow and Kit files, read in one query at that head.
    const files = filesQueryAnswer({ ".github/workflows/fabrik.yml": "jobs:\n  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v3.1.0\n" }, "d".repeat(40), query, variables);
    return files === null ? Promise.reject(REFUSAL) : Promise.resolve(files as T);
  },
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
          ? { repository: { issue: { state: "OPEN", labels: { nodes: [{ name: "needs-design" }] }, parent: null, body: "The cart.", author: { __typename: "User", login: "owner" }, comments: { nodes } } } }
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

/** The first 8 bytes of every PNG file. */
const PNG_START = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An Evidence shots artifact's files beside its manifest: three small PNGs. */
const SHOTS_ARTIFACT_FILES = [
  { name: "draft.mobile.png", size: 20_480, start: PNG_START },
  { name: "draft.desktop.png", size: 40_960, start: PNG_START },
  { name: "inbox.mobile.png", size: 10_240, start: PNG_START },
] as const satisfies readonly ArtifactFile[];

/** An Evidence shots manifest: a shot at both sizes with its Journey and path, one at mobile alone, and one whose name breaks the rule. */
const A_SHOTS_MANIFEST = JSON.stringify({
  version: 1,
  shots: [
    { name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new", images: { mobile: "draft.mobile.png", desktop: "draft.desktop.png" } },
    { name: "inbox: empty", images: { mobile: "inbox.mobile.png" } },
    { name: "@octocat", images: { mobile: "inbox.mobile.png" } },
  ],
});

/** That manifest as it reads against those files. */
const A_SHOTS_READING = {
  ok: true,
  shots: [
    { name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new", images: { mobile: "draft.mobile.png", desktop: "draft.desktop.png" } },
    { name: "inbox: empty", images: { mobile: "inbox.mobile.png" } },
  ],
  dropped: [{ at: 2, name: "@octocat", reason: "name-bad-character" }],
  ambiguous: [],
  pastLimit: 0,
} as const satisfies ShotsManifest;

/** A shots marker once the Review's jobs read the `e2e` check's artifact at the head: three names, one missed and one lacking its desktop size. */
const A_SHOTS_MARKER = {
  source: "shots",
  head: "c".repeat(40),
  run: 9300,
  artifact: 9301,
  failure: null,
  routes: [],
  named: [{ name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new" }, { name: "inbox: empty" }, { name: "sign in: form" }],
  missed: [
    { name: "inbox: empty", viewport: "desktop", why: "size-missing" },
    { name: "sign in: form", why: "not-produced" },
  ],
  preview: { is: "linked", url: "https://fabrik-ticket-7.shop.example.dev/" },
  implementRun: 9100,
  pushed: "c".repeat(40),
} as const satisfies ShotsMarker;

/** The body of a UI pull request whose evidence is Evidence shots, its section closed by its shots marker. */
const A_SHOTS_PULL_REQUEST_BODY = [
  "The Implementer built the drafts.",
  "",
  "<!-- fabrik:ui-evidence-start -->",
  "## UI evidence",
  `<!-- fabrik:ui-evidence ${JSON.stringify(A_SHOTS_MARKER)} -->`,
].join("\n");

/** Pull request 50 merged half an hour before NOW, in a repo with a production site, its shots marker held. */
const A_MERGED_SHOTS_PULL_REQUEST = homeFactsOf({
  kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, production: { url: "https://shop.example", environment: "production" } } }, dispatch: null },
  mergedLastDay: [aMergedLastDay("2026-11-09T11:30:00Z")],
  shotsMarkers: [{ pullRequest: 50, marker: A_SHOTS_MARKER }],
});

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

/**
 * A Digest's top as data: one thing that is the Operator's to judge,
 * pointing at a line of the saved-basket rule inside the diff and at the
 * words an End user reads, outside it, and one Follow-up.
 */
const A_DIGEST_DATA = {
  v: 1,
  items: [
    {
      kind: "yours-to-judge",
      claim: "Prices hold for 24 hours.",
      sentence: "The Ticket said for a while, and the Implementer chose a day.",
      places: [
        { path: "src/basket/save.ts", start: 3, end: 3, as: "code", inDiff: true, fingerprint: "6c4e64d92082" },
        { path: "src/basket/copy.ts", start: 2, end: 2, as: "words", inDiff: false, fingerprint: "d600dea859bb" },
      ],
      picture: null,
      suggestedRequest: null,
    },
  ],
  whatItDoes: "A shopper can now save their basket from /basket.",
  howItGotHere: "One Review passed it at the first head.",
  followUps: [{ title: "Share a saved basket by link", url: "https://github.com/owner/product/issues/new?title=Share+a+saved+basket+by+link" }],
  faults: [{ title: "The saved-basket test is skipped" }],
} as const satisfies DigestData;

/** The folds of a Digest, as a reader renders them: the comment's Markdown from the folds line down, the run's link last. */
const A_DIGESTS_FOLDS = ["<details>", "<summary>Walk me through it</summary>", "", "1. The basket page's Save button.", "", "</details>", "", "[The run](https://github.com/owner/product/actions/runs/42/attempts/1)"].join("\n");

/** The Digest of pull request 50's head, read back from the comment aDigestComment writes of it. */
const A_READABLE_DIGEST = {
  is: "readable",
  head: "h".repeat(40),
  carriedFrom: null,
  at: "2026-11-09T11:05:00Z",
  url: "https://github.com/owner/product/pull/50#issuecomment-9",
  data: A_DIGEST_DATA,
  folds: A_DIGESTS_FOLDS,
} as const satisfies DigestRead;

/** The place of that Digest's that is code inside the diff, as its diff hunk: the line as the head has it, under the line it replaced. */
const A_PLACE_SHOWN = {
  item: 0,
  place: 0,
  path: "src/basket/save.ts",
  start: 3,
  end: 3,
  as: "code",
  inDiff: true,
  show: "hunk",
  text: "-  store.expire(basket.id, HOUR);\n+  store.expire(basket.id, DAY);",
} as const satisfies PlaceShown;

/**
 * A client over `owner/product` at that Digest's head: the two files its
 * places name, and pull request 50's files, the saved-basket rule with its
 * patch.
 */
const A_HEAD_WITH_THE_DIGESTS_PLACES: ReadClient = {
  graphql: () => Promise.reject(REFUSAL),
  rest: (_method, path) =>
    path.startsWith("/repos/owner/product/pulls/50/files?")
      ? Promise.resolve([
          {
            filename: "src/basket/save.ts",
            patch: "@@ -1,4 +1,4 @@\n-export const HOUR = 60 * 60;\n+export const DAY = 24 * 60 * 60;\n export function save(basket) {\n-  store.expire(basket.id, HOUR);\n+  store.expire(basket.id, DAY);\n }",
          },
        ])
      : Promise.reject(REFUSAL),
  fileText: (_repo, path, ref) =>
    Promise.resolve(
      ref !== "h".repeat(40)
        ? null
        : ({
            "src/basket/save.ts": "export const DAY = 24 * 60 * 60;\nexport function save(basket) {\n  store.expire(basket.id, DAY);\n}\n",
            "src/basket/copy.ts": 'export const copy = {\n  saved: "Saved for 24 hours",\n};\n',
          }[path] ?? null),
    ),
};

/** What a Design session settled with the Operator, to be built on pull request 50. */
const A_ROLL_IN_TEXT = {
  summary: "Read the prices once per page, in `src/prices.ts`, so a page of forty products asks for them once.",
  acceptanceCriteria: ["A page that shows forty products reads the prices once.", "A price changed between two pages shows on the second."],
};

/** The Roll-in settled on issue 30, "Cache the prices", owed on pull request 50. */
const AN_OWED_ROLL_IN = {
  issue: 30,
  pullRequest: 50,
  title: "Cache the prices",
  at: "2026-11-09T10:00:00Z",
  url: "https://github.com/owner/product/issues/30#issuecomment-301",
  text: A_ROLL_IN_TEXT,
} satisfies OwedRollIn;

/** A Roll-in whose closing comment holds no text this release can read: still owed, on pull request 50. */
const AN_OWED_ROLL_IN_WITH_NO_TEXT = {
  issue: 33,
  pullRequest: 50,
  title: "Sort the basket",
  at: "2026-11-09T11:00:00Z",
  url: "https://github.com/owner/product/issues/33#issuecomment-331",
  text: null,
} satisfies OwedRollIn;

/**
 * A repo whose open agent pull request 50 has a Roll-in owed on it: GitHub
 * cross-references issue 30, closed as not planned, whose latest comment is
 * the Fabrik App's closing comment of a session that settled one onto it.
 */
const A_REPO_WITH_AN_OWED_ROLL_IN = homeFactsOf({
  github: factsOf({ openIssues: [A_TICKET_WAITING], openPullRequests: [anOpenPullRequest()] }),
  crossReferences: [{ pullRequest: 50, issue: 30, title: "Cache the prices", open: false, closedAs: "not_planned", repo: "owner/product" }],
  closedIssueComments: [
    {
      issue: 30,
      comments: [aRollInComment(50, "2026-11-09T10:00:00Z", { issue: 30, text: A_ROLL_IN_TEXT }, { url: "https://github.com/owner/product/issues/30#issuecomment-301" })],
    },
  ],
}) satisfies Facts;

/** Ticket 12 of `acme/shop`, blocked by its own repo's #9 and #7, as a reader kept its Standing at v3.4.1: schema 1, its Blockers by number alone. */
export const A_STANDING_KEPT_AT_SCHEMA_1 = {
  schema: 1,
  repo: "acme/shop",
  issue: 12,
  pullRequest: null,
  work: "ticket",
  place: "implement",
  name: "blocked",
  move: "nobody",
  yours: false,
  stopsWork: false,
  since: "2026-11-08T12:00:00Z",
  stuckAt: null,
  awaits: { role: "implement", on: "issue" },
  subscription: null,
  detail: { blockers: [9, 7] },
} as const;

/** That Ticket's row as a reader kept it at v3.4.1: its Standing at schema 1, and no `shots`, which a row gained at v4.1.0. */
export const A_ROW_KEPT_AT_V3_4_1 = {
  standing: A_STANDING_KEPT_AT_SCHEMA_1,
  title: "Sign the contract",
  lastWord: null,
  related: [],
  mentions: [],
  relatedTo: null,
  followUps: [],
  ticketClosed: null,
  plainPullRequest: null,
  evidence: null,
  production: null,
  prototype: null,
  digest: null,
} as const;

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
      standingFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING, A_BLOCKED_ISSUE] }) }),
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
  rowsOf: () => [
    rowsOf(
      homeFactsOf({ github: factsOf({ openIssues: [A_TICKET_WAITING] }) }),
      A_RUNS_READ,
      A_CHECKS_READ,
      A_DEPLOYMENTS_READ,
      NOW,
    ),
    rowsOf(
      A_MERGED_SHOTS_PULL_REQUEST,
      null,
      null,
      A_DEPLOYMENTS_READ,
      NOW,
    ),
  ],

  // The files read

  readFiles: () =>
    readFiles(
      {
        ...clientWithFiles({}),
        graphql: <T,>(query: string, variables: Record<string, unknown>) => Promise.resolve(filesQueryAnswer({ ".fabrik/config.json": '{ "max_in_flight": 3 }', ".fabrik/implement.md": "Run the tests before you push." }, "d".repeat(40), query, variables) as T),
      },
      "owner/product",
      "d".repeat(40),
      [".fabrik/config.json", ".fabrik/review.md", ".fabrik"],
    ),

  // The join with runs

  joinRuns: () =>
    joinRuns(
      [{ standing: A_KEPT_STANDING, title: "Build the thing", lastWord: null, related: [], mentions: [], relatedTo: null, followUps: [], ticketClosed: null, plainPullRequest: null, evidence: null, shots: null, production: null, prototype: null, digest: null }],
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

  // The Standing at Staging

  aMainChecksRead: () =>
    aMainChecksRead(
      A_MAIN_CHECKS_READ.commits,
      NOW,
    ),
  aStagingFacts: () =>
    aStagingFacts(
      { unpromoted: [aMergedLastDay("2026-11-09T11:30:00Z")], mergedSince: 1 },
    ),
  aStagingRead: () =>
    aStagingRead(
      A_STAGING_DEPLOYMENTS_READ.merges,
      A_MAIN_CHECKS_READ,
      NOW,
    ),
  commitsToCheck: () =>
    commitsToCheck(
      rowsOf(A_MERGE_AT_STAGING, null, null, null, NOW),
      A_STAGING_DEPLOYMENTS_READ,
    ),
  joinStaging: () =>
    joinStaging(
      rowsOf(A_MERGE_AT_STAGING, null, null, null, NOW),
      A_STAGING_READ,
      NOW,
    ),
  readMainChecks: () =>
    readMainChecks(
      REFUSING_CLIENT,
      "owner/product",
      [{ commit: "d".repeat(40), checks: ["e2e"] }],
      NOW,
    ),
  stagingMergesToRead: () =>
    stagingMergesToRead(
      rowsOf(A_MERGE_AT_STAGING, null, null, null, NOW),
    ),

  // The Staging trial

  TRIAL_ACCEPTED_LABEL: () => TRIAL_ACCEPTED_LABEL,
  TRIAL_PROBLEM_LABEL: () => TRIAL_PROBLEM_LABEL,
  trialProblemIn: () =>
    trialProblemIn(
      "The cart total reads 0 on staging.\n\nFrom Staging trial of PR #50",
    ),
  trialProblemLine: () =>
    trialProblemLine(
      50,
    ),

  // The Promote list

  promoteListOf: () =>
    promoteListOf(
      A_REPO_TO_PROMOTE,
      A_STAGING_READ,
      NOW,
    ),

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

  // Evidence shots

  DEFAULT_SHOTS_ARTIFACT: () => DEFAULT_SHOTS_ARTIFACT,
  SHOTS_MANIFEST_FILE: () => SHOTS_MANIFEST_FILE,
  SHOTS_MANIFEST_VERSION: () => SHOTS_MANIFEST_VERSION,
  SHOT_LIMIT: () => SHOT_LIMIT,
  SHOT_IMAGE_MAX_BYTES: () => SHOT_IMAGE_MAX_BYTES,
  SHOT_NAME_MAX_LENGTH: () => SHOT_NAME_MAX_LENGTH,
  SHOT_NAME_RULE: () => SHOT_NAME_RULE,
  DROP_REASONS: () => DROP_REASONS,
  SHOTS_FAILURES: () => SHOTS_FAILURES,
  readShotsManifest: () => [
    readShotsManifest(
      A_SHOTS_MANIFEST,
      SHOTS_ARTIFACT_FILES,
    ),
    readShotsManifest(
      null,
      [],
    ),
  ],
  namedShots: () =>
    namedShots(
      A_SHOTS_READING,
      ["composer: draft ready", "inbox: empty", "@octocat", "sign in: form"],
    ),
  isShotName: () =>
    isShotName(
      "composer: draft ready",
    ),
  droppedShotSentence: () =>
    droppedShotSentence(
      "image-too-large",
    ),
  shotsMarkerIn: () =>
    shotsMarkerIn(
      A_SHOTS_PULL_REQUEST_BODY,
    ),
  producedNamedShots: () =>
    producedNamedShots(
      A_SHOTS_MARKER,
    ),
  shotMissSentence: () =>
    shotMissSentence(
      { name: "sign in: form", why: "not-produced" },
      "e2e",
    ),
  shotsFailureSentence: () =>
    shotsFailureSentence(
      "no-artifact",
      { check: "e2e", artifact: DEFAULT_SHOTS_ARTIFACT },
    ),

  // The Digest read

  aDigestComment: () =>
    aDigestComment(
      "h".repeat(40),
      "2026-11-09T11:05:00Z",
      { data: A_DIGEST_DATA, folds: A_DIGESTS_FOLDS },
      { url: "https://github.com/owner/product/pull/50#issuecomment-9" },
    ),
  aNoDigestLine: () =>
    aNoDigestLine(
      "h".repeat(40),
      "timed-out",
      "2026-11-09T11:05:00Z",
    ),
  readDigestPlaces: () =>
    readDigestPlaces(
      A_HEAD_WITH_THE_DIGESTS_PLACES,
      "owner/product",
      50,
      A_READABLE_DIGEST,
    ),

  // Owed Roll-ins

  aRollInComment: () =>
    aRollInComment(
      50,
      "2026-11-09T10:00:00Z",
      { issue: 30, text: A_ROLL_IN_TEXT },
      { url: "https://github.com/owner/product/issues/30#issuecomment-301" },
    ),
  owedRollInsOf: () =>
    owedRollInsOf(
      rowsOf(A_REPO_WITH_AN_OWED_ROLL_IN, A_RUNS_READ, A_CHECKS_READ, A_DEPLOYMENTS_READ, NOW),
    ),

  // Kept Standings and rows read back

  readStanding: () =>
    readStanding(
      A_STANDING_KEPT_AT_SCHEMA_1,
    ),
  newerStandingSchemaOf: () =>
    newerStandingSchemaOf(
      { ...A_STANDING_KEPT_AT_SCHEMA_1, schema: STANDING_SCHEMA + 1 },
    ),
  readRow: () =>
    readRow(
      A_ROW_KEPT_AT_V3_4_1,
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

  HealingCheck: { check: "test", rerun: "asked", issue: 91, stuckAt: null } satisfies HealingCheck,
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

  // With a Roll-in owed on pull request 50: the cross-reference from its closed issue, and that issue's comments.
  Facts: {
    ...A_REPO_WITH_AN_OWED_ROLL_IN,
    issueBodies: [{ issue: 7, body: "From PR #50" }],
    // What a merged pull request's comments say of its Follow-ups (#885): its last pass's, and the fault the Kit opened as issue 101.
    mergedFollowUps: [
      {
        pullRequest: 48,
        named: [{ title: "The saved-basket test is skipped", body: "`src/basket/save.test.ts:3` is `it.skip`.", kind: "fault" }],
        opened: [{ issue: 101, title: "The saved-basket test is skipped" }],
      },
    ],
  } satisfies Facts,
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
    // A candidate, an owed Roll-in with the text its session gave, and one whose text could not be read.
    related: [
      { issue: 31, title: "Round the totals", kind: "candidate" },
      { issue: 30, title: "Cache the prices", kind: "owed", at: AN_OWED_ROLL_IN.at, url: AN_OWED_ROLL_IN.url, text: A_ROLL_IN_TEXT },
      { issue: 33, title: "Sort the basket", kind: "owed", at: AN_OWED_ROLL_IN_WITH_NO_TEXT.at, url: AN_OWED_ROLL_IN_WITH_NO_TEXT.url, text: null },
    ],
    mentions: [{ issue: 40, title: "The cart is slow" }],
    relatedTo: 51,
    // An idea the Operator opened from its link, and a fault, whose issue is the one the Kit opens when the pull request merges (#885).
    followUps: [
      { title: "Cache the prices", body: "The prices are read on every request.", kind: "idea", filedAs: 30 },
      { title: "The saved-basket test is skipped", body: "`src/basket/save.test.ts:3` is `it.skip`.", kind: "fault", filedAs: null },
    ],
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
    shots: null,
    production: { site: "https://shop.example", tracked: true, pages: [{ route: "/book?when=today", url: "https://shop.example/book?when=today" }] },
    prototype: { round: 2, comment: 5003, postedAt: "2026-11-08T21:00:00Z", waiting: true, route: "/book", captures: { run: 4420, artifact: 902 } },
    digest: A_READABLE_DIGEST,
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

  // The files read

  FilesRead: { ".fabrik/config.json": '{ "max_in_flight": 3 }', ".fabrik/review.md": null } satisfies FilesRead,

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

  // The Standing at Staging

  CommitToCheck: { commit: "d".repeat(40), checks: ["e2e", "smoke"] } satisfies CommitToCheck,
  MainCheckOf: { name: "smoke", is: "red", url: "https://github.com/owner/product/actions/runs/7/job/903", at: "2026-11-09T11:58:00Z" } satisfies MainCheckOf,
  MainChecksRead: {
    repo: "owner/product",
    readAt: NOW,
    commits: {
      ["d".repeat(40)]: [
        { name: "e2e", is: "green", url: "https://github.com/owner/product/actions/runs/7/job/901", at: "2026-11-09T11:55:00Z" },
        { name: "smoke", is: "undecided", url: null, at: null },
      ],
      ["e".repeat(40)]: "unread",
    },
  } satisfies MainChecksRead,
  StagingRead: A_STAGING_READ satisfies StagingRead,

  // The Promote list

  PromoteList: A_PROMOTE_LIST satisfies PromoteList,
  PromoteEntry: [
    AN_UNTRIED_ENTRY,
    {
      ...AN_UNTRIED_ENTRY,
      pullRequest: 44,
      ticket: 3,
      result: { is: "accepted", at: "2026-11-09T11:00:00Z", fix: [61], problems: [{ issue: 70, title: "The cart total reads 0", open: false }] },
      standing: {
        ...nobodysAtStaging(44, 3, "2026-11-09T11:00:00Z"),
        name: "trial-accepted",
        detail: {
          ...AN_UNTRIED_STANDING.detail,
          deployment: null,
          staging: { ...ITS_STAGING_DETAIL, result: { is: "accepted", at: "2026-11-09T11:00:00Z", fix: [61], problems: [{ issue: 70, open: false }] }, standsUntil: "2026-11-10T11:00:00.000Z" },
        },
      },
    },
    {
      ...AN_UNTRIED_ENTRY,
      pullRequest: 45,
      ticket: 4,
      result: { is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 71, title: "The basket loses its last line", open: true }] },
      standing: {
        ...nobodysAtStaging(45, 4, "2026-11-09T08:00:00Z"),
        name: "trial-problem",
        detail: {
          ...AN_UNTRIED_STANDING.detail,
          deployment: null,
          staging: { ...ITS_STAGING_DETAIL, result: { is: "problem", at: "2026-11-09T08:00:00Z", problems: [{ issue: 71, open: true }] }, standsUntil: "2026-11-10T08:00:00.000Z" },
        },
      },
    },
    {
      ...AN_UNTRIED_ENTRY,
      pullRequest: 46,
      ticket: 5,
      result: { is: "not-on-staging", name: "deploy-failed", unread: false },
      standing: { ...nobodysAtStaging(46, 5, "2026-11-09T11:38:00Z"), name: "deploy-failed", detail: { ...AN_UNTRIED_STANDING.detail, deployment: 899 } },
    },
    {
      ...AN_UNTRIED_ENTRY,
      pullRequest: 47,
      ticket: 6,
      evidence: null,
      staging: { site: "https://staging.shop.example", pages: [], shots: [], toTry: [] },
      trial: { needed: false, why: "no-screen" },
      result: { is: "no-screen" },
      standing: {
        ...nobodysAtStaging(47, 6, "2026-11-09T11:36:00Z"),
        detail: { ...AN_UNTRIED_STANDING.detail, staging: { ...ITS_STAGING_DETAIL, trial: { needed: false, why: "no-screen" }, standsUntil: "2026-11-10T11:30:00.000Z" } },
      },
    },
    A_PLAIN_ENTRY,
  ] satisfies readonly PromoteEntry[],

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

  // Evidence shots

  ArtifactFile: SHOTS_ARTIFACT_FILES[0] satisfies ArtifactFile,
  EvidenceShot: A_SHOTS_READING.shots[0] satisfies EvidenceShot,
  ShotSize: "mobile" satisfies ShotSize,
  DropReason: "duplicate-name" satisfies DropReason,
  DroppedShot: A_SHOTS_READING.dropped[0] satisfies DroppedShot,
  ShotsManifest: A_SHOTS_READING satisfies ShotsManifest,
  BadManifest: { ok: false, failure: "bad-manifest", why: "the artifact has no manifest.json" } satisfies BadManifest,
  // One of each: read, and not.
  ShotsManifestRead: [A_SHOTS_READING, { ok: false, failure: "bad-manifest", why: "manifest.json's version must be 1" }] satisfies readonly ShotsManifestRead[],
  ShotNotProduced: "refused" satisfies ShotNotProduced,
  // One of each: produced, and not.
  NamedShotAnswer: [
    { name: "inbox: empty", produced: true, shot: A_SHOTS_READING.shots[1], sizes: ["mobile"] },
    { name: "@octocat", produced: false, why: "refused" },
  ] satisfies readonly NamedShotAnswer[],
  ShotMiss: A_SHOTS_MARKER.missed satisfies readonly ShotMiss[],
  NamedShots: { answers: [{ name: "sign in: form", produced: false, why: "not-produced" }], missed: [{ name: "sign in: form", why: "not-produced" }] } satisfies NamedShots,
  ShotsMarker: A_SHOTS_MARKER satisfies ShotsMarker,
  NamedShot: A_SHOTS_MARKER.named[0] satisfies NamedShot,
  DroppedNames: { pastFour: 1, broken: 0 } satisfies DroppedNames,
  ShotsFailure: "bad-manifest" satisfies ShotsFailure,

  // The Digest read

  DigestData: A_DIGEST_DATA satisfies DigestData,
  // One of each kind: readable, unreadable, not written, and none.
  DigestRead: [
    A_READABLE_DIGEST,
    {
      is: "unreadable",
      why: "edited",
      url: "https://github.com/owner/product/pull/50#issuecomment-9",
      markdown: "**Digest** of #50, written as of `hhhhhhh`.\n\n### Needs your eyes\n\nNothing, I think.",
    },
    { is: "not-written", how: "timed-out", url: "https://github.com/owner/product/pull/50#issuecomment-10" },
    { is: "none" },
  ] satisfies readonly DigestRead[],
  PlaceShown: A_PLACE_SHOWN satisfies PlaceShown,

  // Owed Roll-ins

  // One with the text the session gave, and one whose text could not be read.
  OwedRollIn: [AN_OWED_ROLL_IN, AN_OWED_ROLL_IN_WITH_NO_TEXT] satisfies readonly OwedRollIn[],
};

/**
 * The exports that are not plain data, by name: the client, which is calls,
 * the two classes, whose calls make instances, and a file of an Evidence
 * shots artifact, which a reader hands in with its first bytes. Everything
 * else in the fixture, and everything a call of anything else returns,
 * survives being written as JSON and read back.
 */
export const NOT_DATA: readonly string[] = ["GitHub", "GitHubError", "ReadClient", "ArtifactFile"];
