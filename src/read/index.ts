// The read library's entry: everything a program reading the Kit may use, and
// nothing else. It is the one address the Kit promises (README.md, "Reading the
// Kit from another program"). It holds re-exports only; its interface fixture
// (./exports.fixture.ts) names every one, and removing one, or changing what it
// means, makes the release a major (docs/releasing.md).

// The client and its errors

export { GitHub, GitHubError, gitHubMessageOf, refusalOf } from "../github/client.ts";
export type { ReadClient, Repo } from "../github/client.ts";

// Run records

export { newerSchemaOf, readRunRecord, RUN_RECORD_SCHEMA } from "../kit/runRecord.ts";
export type { RunRecord } from "../kit/runRecord.ts";

// Kit config and the caller's pin

export { checkCallerWorkflow } from "../kit/caller.ts";
export { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
export { readKitConfigSources } from "../github/snapshot.ts";
export type { CallerCheck } from "../kit/caller.ts";
export type { KitConfig, KitConfigResult, KitConfigSources } from "../kit/config.ts";

// The Standing

export { STANDING_NAMES, STANDING_SCHEMA, standingAt, standingsOf } from "../kit/standing.ts";
export { wordStanding } from "../kit/standingWording.ts";
export { stuckBarMinutes, TICK_MINUTES } from "../loop/recoveryWaits.ts";
export type { Standing, StandingFacts, StandingName } from "../kit/standing.ts";
export type { StoreStandingFacts } from "../kit/standingStore.ts";
export type { StandingWords } from "../kit/standingWording.ts";

// Fact builders and cost functions

export { isLive } from "../kit/runRecord.ts";
export { costOf, hasUnknownCostBasis, weeksEndingAt } from "../kit/weeklySummary.ts";
export type { CostFigure, Week } from "../kit/weeklySummary.ts";

// The closing line and the runs read

// The gather and the rows

// The join with runs

// The Required checks

// The caller read

// Spend

// The runway

// The issues to roll in by hand

// Outcomes
