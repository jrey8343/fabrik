// The join with Deployments (#634): a repo's kept rows settled against a fresh
// Deployments read (./deployments.ts), with no gather. A deploy starting or
// finishing prompts only a Deployments read, and a merged agent pull
// request's row at Production hangs on it. Pure, no I/O. It agrees with the
// rule: for the same facts, the rows the rule gives with a Deployments read
// (rowsOf) equal the rows it gave with none, or with an earlier read, joined
// with that read. In a repo that declares `staging` (#855, ADR-0038) the
// read of production's environment also moves a row from Staging to
// Production; the staging environment's own read is the join with staging's
// (./joinStaging.ts).
import { standingAt, standingOrder } from "../kit/standing.ts";
import { deployIn, productionStandingOf } from "../kit/standingProduction.ts";
import { isAtStaging, isMergedStanding, type MergedStanding, mergedStillStands, promotedStandingOf, stagingStandingOf } from "../kit/standingStaging.ts";
import type { DeploymentsRead, MergeToRead } from "./deployments.ts";
import { refuseRowsOfOtherSchema } from "./keptRow.ts";
import { type Row, withOwnSettled } from "./rows.ts";

/**
 * Which merges want a Deployments read: the merge commit and merge time of
 * every row at Production that is not Live, in the rows' order. A Live row is
 * settled and is never asked about again; a row in a repo that declares no
 * environment is at no place, and nothing is read for it. In a repo that
 * declares `staging`, every row at Staging wants production's read too,
 * where Kit config names production's environment: it is how a production
 * Deployment starting is seen. Rows holding a Standing of another schema are
 * refused: a kept row comes back through readRow (./keptRow.ts).
 */
export function mergesToRead(rows: readonly Row[]): MergeToRead[] {
  refuseRowsOfOtherSchema(rows);
  return rows.flatMap(({ standing }) =>
    isMergedStanding(standing) && wantsProductionRead(standing) && standing.detail.mergeCommit !== null
      ? [{ mergeCommit: standing.detail.mergeCommit, mergedAt: standing.detail.mergedAt }]
      : [],
  );
}

/** Whether a merged pull request's row hangs on a read of production's Deployments: at Production and not Live, or at Staging in a repo that tracks production's deploys. */
function wantsProductionRead(standing: MergedStanding): boolean {
  if (standing.place === "production") return standing.name !== "live";
  return isAtStaging(standing) && standing.detail.staging.productionEnvironment !== null;
}

/**
 * The kept rows as they stand at `now`, ISO 8601, with the Deployments of
 * `read`, in the rule's order. A row at Production takes the name,
 * `since` and detail the rule gives for the read; a merge the read leaves out
 * or gives as unread keeps its row, as does a read of another repo or
 * environment. A merged pull request's row whose 24 hours from its merge
 * have passed at `now` is left out, at Production or not. In a repo that
 * declares `staging`, a row at Staging stands as its own `standsUntil` says
 * (#856), and one that waits on the Operator is kept however old, at
 * Production too while the Deployment that contains it is running or has
 * failed: production has not taken it. Every other row at Production, and
 * a Live one, stands for 24 hours from the production Deployment that gave
 * it its name (#857), so one promoted days after its merge is Live for a
 * day from the Deployment that took it. Every row is read
 * at `now` as the rule reads a kept Standing (standingAt). Rows holding a
 * Standing of another schema are refused, one that would be left out among
 * them: a kept row comes back through readRow (./keptRow.ts).
 *
 * In a repo that declares `staging`, a read of production's environment
 * moves a row at Staging to Production, with production's names, once it
 * shows a Deployment that contains the merge has started, and leaves it at
 * Staging until then. One at Production that the read holds no Deployment
 * for any more goes back to Staging, its staging deploys unread until the
 * join with staging settles it.
 */
export function joinDeployments(rows: readonly Row[], read: DeploymentsRead, now: string): Row[] {
  refuseRowsOfOtherSchema(rows);
  // A row at Production takes its deploy's time, so the rows are put back in the rule's order.
  return joinMergedRows(rows, now, (standing) => settledWith(standing, read, now));
}

/**
 * The kept rows as they stand at `now`, in the rule's order, each merged
 * pull request's Standing as `settle` leaves it, its row left out where that
 * is null: what the join with Deployments and the join with staging
 * (./joinStaging.ts) both do, each with its own read. Every row is read at
 * `now` as the rule reads a kept Standing (standingAt), and one nothing
 * changed is the row it was.
 */
export function joinMergedRows(rows: readonly Row[], now: string, settle: (standing: MergedStanding) => MergedStanding | null): Row[] {
  const joined = rows.flatMap((row) => {
    const settled = isMergedStanding(row.standing) ? settle(row.standing) : row.standing;
    if (settled === null) return [];
    const standing = standingAt(settled, now);
    const plainPullRequest = withOwnSettled(row.plainPullRequest, (own) => standingAt(own, now));
    return standing === row.standing && plainPullRequest === row.plainPullRequest ? [row] : [{ ...row, standing, plainPullRequest }];
  });
  return joined.toSorted((a, b) => standingOrder(a.standing, b.standing));
}

/**
 * A merged pull request's kept Standing with the fresh read, or as it was
 * where the read says nothing of it; null once it no longer stands
 * (mergedStillStands), as the read leaves it. In a repo that declares
 * `staging`, one the read moves to Production stands by the production
 * Deployment that gave it its name (#857), however long it waited at
 * Staging and though its day there has ended since it was kept. In any
 * other repo a row stands by its merge, whatever the read says.
 */
function settledWith(standing: MergedStanding, read: DeploymentsRead, now: string): MergedStanding | null {
  const settled = withRead(standing, read);
  return mergedStillStands(settled, now) ? settled : null;
}

/** A merged pull request's kept Standing as the fresh read leaves it, or as it was where the read says nothing of it. */
function withRead(standing: MergedStanding, read: DeploymentsRead): MergedStanding {
  const { repo, issue, pullRequest, place, detail } = standing;
  if (pullRequest === null) return standing;
  const merge = { number: pullRequest, ticket: issue, mergeCommit: detail.mergeCommit, mergedAt: detail.mergedAt };
  if (detail.staging !== undefined) {
    const deploy = deployIn(read, repo, detail.staging.productionEnvironment, detail.mergeCommit);
    if (deploy === "unread") return standing;
    const promoted = promotedStandingOf(repo, merge, detail.staging, read);
    if (promoted !== null || place === "staging") return promoted ?? standing;
    // Back at Staging: with its result's name where its Staging trial has one (#856), else its staging deploys unread.
    return stagingStandingOf(repo, merge, detail.staging, "unread", null);
  }
  if (place !== "production") return standing;
  const deploy = deployIn(read, repo, detail.environment, detail.mergeCommit);
  if (deploy === "unread") return standing;
  return productionStandingOf(repo, merge, detail.environment, deploy);
}
