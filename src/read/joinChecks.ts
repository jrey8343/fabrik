// The join with checks (#622): a repo's kept rows settled against a fresh
// Required checks read, with no gather. A check finishing prompts only a
// checks read, and a Plain row's name hangs on its checks, so a Plain row
// moves to the Operator's when its last check passes. Pure, no I/O. It agrees
// with the rule: for the same facts, the rows the rule gives with a later
// checks read (rowsOf) equal the kept rows joined with that read.
import { type Standing, standingAt } from "../kit/standing.ts";
import { joined, plainNameForChecks } from "../kit/standingPlain.ts";
import { requiredChecksFactOf, type RequiredChecksRead } from "./requiredChecks.ts";
import { type Row, withOwnSettled } from "./rows.ts";

/**
 * The kept rows as they stand at `now`, ISO 8601, with the Required checks of
 * `read`, in the order they were kept. A Plain row that is neither a draft nor
 * in conflict takes the name the rule gives for the fresh checks on its head,
 * since the report that decided it; when no report did, as for a check never
 * reported or a branch requiring none, since the pull request's own time the
 * row carries (Row's `plainPullRequest`). A Pairing session's pull request joined to its
 * issue's row is settled the same way inside that row. A head the read does
 * not hold, or holds as unread, leaves its row as it was, and so does every
 * agent row: a red check at the Merge gate changes no Standing. Every row is
 * read at `now` as the rule reads a kept Standing (standingAt).
 */
export function joinChecks(rows: readonly Row[], read: RequiredChecksRead, now: string): Row[] {
  return rows.map((row) => {
    const standing = standingAt(settledWith(row, read), now);
    const plainPullRequest = withOwnSettled(row.plainPullRequest, (own) => standingAt(own, now));
    return standing === row.standing && plainPullRequest === row.plainPullRequest ? row : { ...row, standing, plainPullRequest };
  });
}

/** A kept row's Standing with the fresh checks on its head, or as it was when they leave it so. */
function settledWith({ standing, plainPullRequest }: Row, read: RequiredChecksRead): Standing {
  const { head } = standing.detail;
  if (head === undefined) return standing;
  const checks = requiredChecksFactOf(read, head);
  if (checks === "unread") return standing;
  if (standing.detail.pullRequest !== undefined) return pairingSettled(standing, checks, head, plainPullRequest);
  if (standing.work !== "plain" || standing.name === "draft" || standing.name === "conflicts" || !("plain" in standing.detail) || standing.detail.plain === null) return standing;
  const { name, decidedAt } = plainNameForChecks(standing.detail.plain, checks);
  return { ...standing, ...name, since: decidedAt ?? ownSinceOf(standing, plainPullRequest), detail: { ...name.detail, head } } as Standing;
}

/** The time the rule gives a Plain pull request's name when no report decides it: the pull request's own, or, on a row that does not carry it, the time the row had. */
function ownSinceOf(standing: Standing, plainPullRequest: Row["plainPullRequest"]): string {
  return plainPullRequest?.since ?? standing.since;
}

/**
 * An issue's own Standing joined with its Pairing session's pull request,
 * settled as the rule joins them: the issue's own Standing carrying the pull
 * request's new name, until that name is yours to merge, which it then takes.
 * One the pull request already took over goes back to the issue's own
 * Standing the row carries once the name no longer is; a row that does not
 * carry it, and one whose pull request is a draft or in conflict, are left as
 * they were.
 */
function pairingSettled(standing: Standing, checks: Exclude<ReturnType<typeof requiredChecksFactOf>, "unread">, head: string, plainPullRequest: Row["plainPullRequest"]): Standing {
  const was = standing.detail.pullRequest;
  if (was === "draft" || was === "conflicts") return standing;
  const own = was === "yours-to-merge" ? (plainPullRequest?.own ?? null) : standing;
  if (own === null) return standing;
  const { name, decidedAt } = plainNameForChecks("pairing", checks);
  const pairing = { ...standing, ...name, since: decidedAt ?? ownSinceOf(standing, plainPullRequest) } as Standing;
  const taken = joined(own, pairing);
  return { ...taken, detail: { ...taken.detail, head } } as Standing;
}
