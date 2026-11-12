// The join with Deployments (#634): a repo's kept rows settled against a fresh
// Deployments read (./deployments.ts), with no gather. A deploy starting or
// finishing prompts only a Deployments read, and a merged agent pull
// request's row at Production hangs on it. Pure, no I/O. It agrees with the
// rule: for the same facts, the rows the rule gives with a Deployments read
// (rowsOf) equal the rows it gave with none, or with an earlier read, joined
// with that read.
import { standingAt } from "../kit/standing.ts";
import { deployIn, isProductionStanding, type ProductionStanding, productionStandingOf, stillStands } from "../kit/standingProduction.ts";
import type { DeploymentsRead, MergeToRead } from "./deployments.ts";
import { type Row, withOwnSettled } from "./rows.ts";

/**
 * Which merges want a Deployments read: the merge commit and merge time of
 * every row at Production that is not Live, in the rows' order. A Live row is
 * settled and is never asked about again; a row in a repo that declares no
 * environment is at no place, and nothing is read for it.
 */
export function mergesToRead(rows: readonly Row[]): MergeToRead[] {
  return rows.flatMap(({ standing }) =>
    isProductionStanding(standing) && standing.place === "production" && standing.name !== "live" && standing.detail.mergeCommit !== null
      ? [{ mergeCommit: standing.detail.mergeCommit, mergedAt: standing.detail.mergedAt }]
      : [],
  );
}

/**
 * The kept rows as they stand at `now`, ISO 8601, with the Deployments of
 * `read`, in the order they were kept. A row at Production takes the name,
 * `since` and detail the rule gives for the read; a merge the read leaves out
 * or gives as unread keeps its row, as does a read of another repo or
 * environment. A merged pull request's row whose 24 hours have passed at
 * `now` is left out, at Production or not. Every row is read at `now` as the
 * rule reads a kept Standing (standingAt).
 */
export function joinDeployments(rows: readonly Row[], read: DeploymentsRead, now: string): Row[] {
  return rows.flatMap((row) => {
    const settled = isProductionStanding(row.standing) ? settledWith(row.standing, read, now) : row.standing;
    if (settled === null) return [];
    const standing = standingAt(settled, now);
    const plainPullRequest = withOwnSettled(row.plainPullRequest, (own) => standingAt(own, now));
    return standing === row.standing && plainPullRequest === row.plainPullRequest ? [row] : [{ ...row, standing, plainPullRequest }];
  });
}

/** A merged pull request's kept Standing with the fresh read, or as it was where the read says nothing of it; null once its 24 hours have passed. */
function settledWith(standing: ProductionStanding, read: DeploymentsRead, now: string): ProductionStanding | null {
  const { repo, issue, pullRequest, place, detail } = standing;
  if (!stillStands(detail.mergedAt, now)) return null;
  if (place !== "production" || pullRequest === null) return standing;
  const deploy = deployIn(read, repo, detail.environment, detail.mergeCommit);
  if (deploy === "unread") return standing;
  return productionStandingOf(repo, { number: pullRequest, ticket: issue, mergeCommit: detail.mergeCommit, mergedAt: detail.mergedAt }, detail.environment, deploy);
}
