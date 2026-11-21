// The join with checks (#622): a repo's kept rows settled against a fresh
// Required checks read, with no gather. A check finishing prompts only a checks
// read, and a Plain row's name hangs on its checks, so a Plain row moves to the
// Operator's when its last check passes; so does an agent row's at the Merge
// gate (#564), which turns red when a check fails there. Pure, no I/O. It
// agrees with the rule: for the same facts, the rows the rule gives with a
// later checks read (rowsOf) equal the kept rows joined with that read.
import { type Standing, standingAt } from "../kit/standing.ts";
import { joined, type MergeGatePass, mergeGateNameForChecks, nameForChecks } from "../kit/standingPlain.ts";
import { requiredChecksFactOf, type RequiredChecksRead } from "./requiredChecks.ts";
import { type Row, withOwnSettled } from "./rows.ts";

/**
 * The kept rows as they stand at `now`, ISO 8601, with the Required checks of
 * `read`, in the order they were kept. A Plain row that is neither a draft nor
 * in conflict takes the name the rule gives for the fresh checks on its head,
 * since the report that decided it; when no report did, as for a check never
 * reported or a branch requiring none, since the pull request's own time the
 * row carries (Row's `plainPullRequest`). A Pairing session's pull request
 * joined to its issue's row is settled the same way inside that row. An agent
 * row at the Merge gate, yours to merge or named for its checks, takes the name
 * the rule gives it for them (mergeGateNameForChecks, #564), going back to the
 * pass time it keeps once they pass again, and keeping the head the Reviewer
 * passed (#692) and which of its Unrelated failures the Kit is healing, so a
 * healing check that fails again is the Kit's again, turning Stuck when the
 * row kept that it would (#795); an agent draft, and one handed back
 * at the Merge gate, are left as they were. A head the read does not hold, or
 * holds as unread, leaves its row as it was. Every row is read at `now` as the
 * rule reads a kept Standing (standingAt).
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
  const pass = mergeGatePassOf(standing, head);
  if (pass !== null) {
    const name = mergeGateNameForChecks(checks, pass);
    return { ...standing, ...name, detail: { ...name.detail, head } } as Standing;
  }
  if (standing.work !== "plain" || standing.name === "draft" || standing.name === "conflicts" || !("plain" in standing.detail) || standing.detail.plain === null) return standing;
  const { name, decidedAt } = nameForChecks(standing.detail.plain, checks);
  return { ...standing, ...name, since: decidedAt ?? ownSinceOf(standing, plainPullRequest), detail: { ...name.detail, head } } as Standing;
}

/**
 * The pass a kept agent row at the Merge gate that is named by its checks
 * carries, on `head`: when the Reviewer passed, its own time when yours to
 * merge, else the time it keeps; the head it passed; and what it keeps of its
 * Unrelated failures (#795), one that turned Stuck while the Kit was healing
 * its check included. A row kept before #692 carries no passedHead: the rule
 * then counted a pass on its head alone. One kept before #795 carries no
 * Unrelated failures, and settles as it did. Null for any other row.
 */
function mergeGatePassOf(standing: Standing, head: string): MergeGatePass | null {
  if (standing.work !== "ticket" || standing.place !== "merge-gate") return null;
  const passOf = (passedAt: string, { passedHead = head, healing = [], mentioned = [] }: Partial<MergeGatePass>): MergeGatePass => ({ passedAt, passedHead, healing, mentioned });
  switch (standing.name) {
    case "yours-to-merge":
      return standing.detail.plain === null ? passOf(standing.since, standing.detail) : null;
    case "check-failing":
    case "waiting-on-checks":
      return standing.detail.passedAt === undefined ? null : passOf(standing.detail.passedAt, standing.detail);
    case "check-healing":
      return passOf(standing.detail.passedAt, standing.detail);
    case "stuck":
      return standing.detail.was === "check-healing" ? passOf(standing.detail.passedAt, standing.detail) : null;
    default:
      return null;
  }
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
  const { name, decidedAt } = nameForChecks("pairing", checks);
  const pairing = { ...standing, ...name, since: decidedAt ?? ownSinceOf(standing, plainPullRequest) } as Standing;
  const taken = joined(own, pairing);
  return { ...taken, detail: { ...taken.detail, head } } as Standing;
}
