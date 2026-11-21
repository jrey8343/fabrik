// The join with staging (#855, ADR-0038): a repo's kept rows settled against
// a fresh staging read, with no gather: the Deployments read of
// `staging.environment` (./deployments.ts) and the Main checks read of the
// commits it deployed (./mainChecks.ts). A staging deploy starting or
// finishing, or a Main check ending, prompts only those reads, and a merged
// agent pull request's row at Staging hangs on them. A production Deployment
// starting moves a row from Staging to Production, which is the join with
// Deployments' to see (./joinDeployments.ts), given production's read. Pure,
// no I/O. It agrees with the rule: for the same facts, the rows the rule
// gives with a staging read (rowsOf) equal the rows it gave with none, or
// with an earlier one, joined with that read.
import { standingAt, standingOrder } from "../kit/standing.ts";
import { deployIn } from "../kit/standingProduction.ts";
import { isMergedStanding, isTried, type MergedStanding, mergedStillStands, stagingStandingOf } from "../kit/standingStaging.ts";
import type { DeploymentsRead, MergeToRead } from "./deployments.ts";
import { refuseRowsOfOtherSchema } from "./keptRow.ts";
import type { CommitToCheck } from "./mainChecks.ts";
import { type Row, type StagingRead, withOwnSettled } from "./rows.ts";

/**
 * Which merges want a Deployments read of `staging.environment`, asked for
 * the newest success: the merge commit and merge time of every row at
 * Staging, in the rows' order, but one on staging that needs no Staging
 * trial, and one whose Staging trial has a result (#856), which are settled
 * and never asked about again. One on staging that needs a trial and has no
 * result is asked about on every read, so a later deploy whose Main check
 * goes red moves it back to deploy failed. A repo that declares no `staging`
 * has no such row. Rows holding a Standing of another schema are refused: a
 * kept row comes back through readRow (./keptRow.ts).
 */
export function stagingMergesToRead(rows: readonly Row[]): MergeToRead[] {
  refuseRowsOfOtherSchema(rows);
  return rows.flatMap(({ standing }) => {
    if (!isMergedStanding(standing) || standing.place !== "staging" || standing.detail.mergeCommit === null) return [];
    if (isTried(standing) || (standing.name === "on-staging" && !standing.detail.staging.trial.needed)) return [];
    return [{ mergeCommit: standing.detail.mergeCommit, mergedAt: standing.detail.mergedAt }];
  });
}

/**
 * Which commits want a Main checks read, with the Main checks to read on
 * each: for every row at Staging whose repo names Main checks and whose merge
 * `read`, a Deployments read of its staging environment, gives as succeeded,
 * the commit of the newest successful Deployment that contains it, or the
 * deciding one's where the read was not asked for the newest; each commit
 * once, in the rows' order. None where the repo names no Main checks or has
 * them off: a merge is then on staging on its Deployment alone. None for a
 * row whose Staging trial has a result (#856), which no check moves. Rows
 * holding a Standing of another schema are refused: a kept row comes back
 * through readRow (./keptRow.ts).
 */
export function commitsToCheck(rows: readonly Row[], read: DeploymentsRead): CommitToCheck[] {
  refuseRowsOfOtherSchema(rows);
  const asked = new Map<string, readonly string[]>();
  for (const { standing } of rows) {
    if (!isMergedStanding(standing) || standing.place !== "staging" || isTried(standing)) continue;
    const staging = standing.detail.staging;
    if (staging === undefined || staging.mainChecks.length === 0) continue;
    const deploy = deployIn(read, standing.repo, staging.environment, standing.detail.mergeCommit);
    if (deploy === "unread" || deploy.is !== "succeeded") continue;
    const commit = deploy.newest?.commit ?? deploy.commit;
    if (commit !== null && !asked.has(commit)) asked.set(commit, staging.mainChecks);
  }
  return [...asked].map(([commit, checks]) => ({ commit, checks }));
}

/**
 * The kept rows as they stand at `now`, ISO 8601, with the staging read
 * `read`, in the rule's order. A row at Staging takes the name, `since` and
 * detail the rule gives for the read; a merge its Deployments read leaves
 * out or gives as unread keeps its row, as does a read of another repo or
 * environment, or one with no Deployments read. A row whose Staging trial
 * has a result is left as it is (#856): a later deploy never moves it. A
 * merged pull request's row that no longer stands at `now` is left out
 * (mergedStillStands): at Staging, one past its `standsUntil`, which one
 * that waits on the Operator has none of; anywhere else, one whose 24 hours
 * from the merge have passed. Every row is read at `now` as the rule reads a
 * kept Standing (standingAt). In a repo that declares no `staging` no row
 * hangs on the read. Rows holding a Standing of another schema are refused,
 * one that would be left out among them: a kept row comes back through
 * readRow (./keptRow.ts).
 */
export function joinStaging(rows: readonly Row[], read: StagingRead, now: string): Row[] {
  refuseRowsOfOtherSchema(rows);
  const joined = rows.flatMap((row) => {
    const settled = isMergedStanding(row.standing) ? settledWith(row.standing, read, now) : row.standing;
    if (settled === null) return [];
    const standing = standingAt(settled, now);
    const plainPullRequest = withOwnSettled(row.plainPullRequest, (own) => standingAt(own, now));
    return standing === row.standing && plainPullRequest === row.plainPullRequest ? [row] : [{ ...row, standing, plainPullRequest }];
  });
  // A row at Staging takes its deploy's or its check's time, so the rows are put back in the rule's order.
  return joined.toSorted((a, b) => standingOrder(a.standing, b.standing));
}

/** A merged pull request's kept Standing with the fresh staging read, or as it was where it is not at Staging, its Staging trial has a result, or the read says nothing of it; null once it no longer stands. */
function settledWith(standing: MergedStanding, { deployments, mainChecks }: StagingRead, now: string): MergedStanding | null {
  const { repo, issue, pullRequest, place, detail } = standing;
  if (!mergedStillStands(standing, now)) return null;
  if (place !== "staging" || detail.staging === undefined || pullRequest === null || isTried(standing)) return standing;
  const deploy = deployIn(deployments, repo, detail.staging.environment, detail.mergeCommit);
  if (deploy === "unread") return standing;
  return stagingStandingOf(repo, { number: pullRequest, ticket: issue, mergeCommit: detail.mergeCommit, mergedAt: detail.mergedAt }, detail.staging, deploy, mainChecks);
}
