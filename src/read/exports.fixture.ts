// The read library's interface fixture: every name the entry (./index.ts)
// exports, with a small call of each value made from built inputs, and one
// value of each type. ./index.test.ts holds the entry to it both ways, writes
// every value as JSON and reads it back, and runs every call with the one
// thing a Worker can't do made to throw. A Ticket that adds an export adds its
// entries here, under its own heading, one argument to a line.
import { aRunRecord, anOpenIssue, factsOf, standingFactsOf } from "../__fixtures__/weeklySummary.ts";
import {
  checkCallerWorkflow,
  DEFAULT_KIT_CONFIG,
  GitHub,
  GitHubError,
  gitHubMessageOf,
  KIT_SAID_VERSION,
  kitSaidIn,
  newerSchemaOf,
  readKitConfigSources,
  readRunRecord,
  readRuns,
  refusalOf,
  resolveKitConfig,
  RUN_RECORD_SCHEMA,
  runsInFlightFactOf,
  STANDING_NAMES,
  STANDING_SCHEMA,
  standingAt,
  standingsOf,
  stuckBarMinutes,
  TICK_DEAD_MINUTES,
  TICK_MINUTES,
  wordStanding,
} from "./index.ts";
import type {
  ActionsStep,
  CallerCheck,
  KitConfig,
  KitConfigResult,
  KitConfigSources,
  KitSaid,
  ReadClient,
  Repo,
  RunInFlight,
  RunKind,
  RunRecord,
  RunsRead,
  Standing,
  StandingFacts,
  StandingName,
  StandingWords,
  StoreStandingFacts,
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

/** A Run record as schema 7 wrote it, before Broken runs were recorded. */
function aSchema7Record(): unknown {
  const { brokenRun: _left, ...fields } = aRunRecord();
  return { ...fields, schema: 7 };
}

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

  // The join with runs

  // The Required checks

  // The caller read

  // Spend

  // The runway

  // The issues to roll in by hand

  // Outcomes
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

  // The closing line and the runs read

  ActionsStep: A_CLOSING_STEP satisfies ActionsStep,
  KitSaid: A_KIT_SAID satisfies KitSaid,
  RunKind: "retry" satisfies RunKind,
  RunInFlight: A_RUN_IN_FLIGHT satisfies RunInFlight,
  RunsRead: A_RUNS_READ satisfies RunsRead,

  // The gather and the rows

  // The join with runs

  // The Required checks

  // The caller read

  // Spend

  // The runway

  // The issues to roll in by hand

  // Outcomes
};

/**
 * The exports that are not plain data, by name: the client, which is calls,
 * and the two classes, whose calls make instances. Everything else in the
 * fixture, and everything a call of anything else returns, survives being
 * written as JSON and read back.
 */
export const NOT_DATA: readonly string[] = ["GitHub", "GitHubError", "ReadClient"];
