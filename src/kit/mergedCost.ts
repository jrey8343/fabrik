// What a merged pull request cost (#668), and the sums it is worked out by:
// the Weekly summary's figure, moved out of it so a reader of the read
// library works it out by the same code from its outcomes reads
// (src/read/outcomes.ts). Pure, no I/O.
import type { CostFigure, Week } from "./weeklySummary.ts";
import { isLive, type RunRecord, UNKNOWN_COST_BASIS } from "./runRecord.ts";

/**
 * The roles whose runs build a Ticket: Implement (Retries and Step-ups among
 * them), Review, and Digest, whose run writes the account the Ticket's pull
 * request reaches the Merge gate with (ADR-0022).
 */
export const BUILD_ROLES: readonly RunRecord["role"][] = ["implement", "review", "digest"];

/**
 * What a pull request merged in `week` cost on average, with how many merged:
 * for each of `merged`, the summed cost of every Implement, Review and Digest record
 * on the Ticket it names, in its repo, that ended before the week did,
 * whatever week it ended in. A pull request that names no Ticket counts as
 * merged at no cost, and a Ticket with two merged in the week has its records
 * counted for each. A Replay arm's record is left out here, so `records` may
 * be every record a reader holds.
 */
export function costPerMergedPullRequestOf(
  week: Week,
  records: readonly RunRecord[],
  merged: readonly { readonly repo: string; readonly ticket: number | null }[],
): CostFigure & { readonly merged: number } {
  const ended = endedBy(week, records.filter(isLive));
  const perPullRequest = merged.map(({ repo, ticket }) =>
    ended.filter((record) => record.repo === repo && ticket !== null && record.issue === ticket && BUILD_ROLES.includes(record.role)),
  );
  return { ...averageCostOf(perPullRequest), merged: merged.length };
}

/** Each group's summed cost, averaged over the groups, or null for no groups. */
export function averageCostOf(groups: readonly (readonly RunRecord[])[]): CostFigure {
  const total = costOf(groups.flat());
  return { usd: groups.length === 0 ? null : total.usd / groups.length, unknownCost: total.unknownCost };
}

/** The records that ended before the week did, whatever week they ended in. */
export function endedBy(week: Week, records: readonly RunRecord[]): RunRecord[] {
  return records.filter((record) => Date.parse(record.endedAt) < week.end);
}

/**
 * The summed cost of these records, leaving out (and counting) those whose
 * cost basis is unknown. A run with no cost figure at all, one that ended
 * without a result, such as a timeout, adds nothing and isn't counted.
 */
export function costOf(records: readonly RunRecord[]): CostFigure & { readonly usd: number } {
  return {
    usd: records.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    unknownCost: records.filter(hasUnknownCostBasis).length,
  };
}

/** Whether any of the run's models has an unknown cost basis, which leaves the run with no total (src/kit/runRecord.ts). */
export function hasUnknownCostBasis(record: RunRecord): boolean {
  return Object.values(record.modelUsage).some((usage) => usage.costBasis === UNKNOWN_COST_BASIS);
}
