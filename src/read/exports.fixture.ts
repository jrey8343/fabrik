// The read library's interface fixture: every name the entry (./index.ts)
// exports, with a small call of each value made from built inputs, and one
// value of each type. ./index.test.ts holds the entry to it both ways, writes
// every value as JSON and reads it back, and runs every call with the one
// thing a Worker can't do made to throw. A Ticket that adds an export adds its
// entries here, under its own heading, one argument to a line.
import { aRunRecord, anOpenIssue, factsOf, standingFactsOf, UNKNOWN_COST_BASIS } from "../__fixtures__/weeklySummary.ts";
import {
  checkCallerWorkflow,
  costOf,
  DEFAULT_KIT_CONFIG,
  GitHub,
  GitHubError,
  gitHubMessageOf,
  hasUnknownCostBasis,
  isLive,
  newerSchemaOf,
  readKitConfigSources,
  readRunRecord,
  refusalOf,
  resolveKitConfig,
  RUN_RECORD_SCHEMA,
  STANDING_NAMES,
  STANDING_SCHEMA,
  standingAt,
  standingsOf,
  stuckBarMinutes,
  TICK_MINUTES,
  weeksEndingAt,
  wordStanding,
} from "./index.ts";
import type {
  CallerCheck,
  CostFigure,
  KitConfig,
  KitConfigResult,
  KitConfigSources,
  ReadClient,
  Repo,
  RunRecord,
  Standing,
  StandingFacts,
  StandingName,
  StandingWords,
  StoreStandingFacts,
  Week,
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

  costOf: () =>
    costOf(
      [aRunRecord(), aRunRecord({ runId: 1001, ...UNKNOWN_COST_BASIS })],
    ),
  hasUnknownCostBasis: () =>
    hasUnknownCostBasis(
      aRunRecord(UNKNOWN_COST_BASIS),
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

  CostFigure: { usd: 1, unknownCost: 1 } satisfies CostFigure,
  Week: { start: Date.parse("2026-11-02T00:00:00Z"), end: Date.parse("2026-11-09T00:00:00Z"), monday: "2026-11-02" } satisfies Week,

  // The closing line and the runs read

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
