// What the scheduled tick's replay slice reads of the fabrik-runs store and
// of GitHub, put together for the replay step (#156, src/github/replaySlice.ts):
// the newest weekly-limit reading on each Subscription, which the
// spare-capacity gate weighs, and a waiting request's candidate Tickets,
// which the Replay module picks from (src/kit/replay.ts). Pure, no I/O.
import type { MergedFile, ReplayCandidate } from "./replay.ts";
import { type RateLimitReading, type RunRecord, WEEKLY_LIMIT } from "./runRecord.ts";

/**
 * The newest weekly-limit reading on each Subscription among these Run
 * records, of every Product repo, a Replay run's included, from the store's
 * last two months: the month of `now` and the one before, by UTC. A record
 * that read none, or only the five-hour limit's, is skipped. A Subscription
 * none read one for isn't here.
 */
export function newestWeeklyLimits(records: readonly RunRecord[], now: string): Record<string, RateLimitReading> {
  const from = lastMonthStart(now);
  const read = records.filter((record) => record.rateLimit?.rateLimitType === WEEKLY_LIMIT && Date.parse(record.endedAt) >= from);
  const newest: Record<string, { readonly at: number; readonly reading: RateLimitReading }> = {};
  for (const record of read) {
    const at = Date.parse(record.endedAt);
    const seen = newest[record.subscription];
    if (record.rateLimit !== null && (seen === undefined || at > seen.at)) newest[record.subscription] = { at, reading: record.rateLimit };
  }
  return Object.fromEntries(Object.entries(newest).map(([subscription, { reading }]) => [subscription, reading]));
}

/** 00:00 UTC on the first of the month before `now`'s, in ms. */
function lastMonthStart(now: string): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1);
}

/**
 * The Tickets a Replay might run in the Product repo `repo`, as `owner/name`:
 * each one a live Implement run of it there left a record of, lowest first.
 * Never another repo's, since Ticket numbers repeat across Product repos.
 */
export function replayTicketsIn(records: readonly RunRecord[], repo: string): number[] {
  const tickets = records.filter((record) => record.repo === repo && record.role === "implement" && record.replay === null).map(({ issue }) => issue);
  return [...new Set(tickets)].toSorted((a, b) => a - b);
}

/** An agent PR that merged, with what the Weekly summary's metrics read of it (mergedAgentPullRequestsIn). */
export interface MergedTicketFacts {
  /** The Ticket its `Closes #n` names. */
  readonly ticket: number;
  readonly number: number;
  /** ISO 8601. */
  readonly mergedAt: string;
  /** Whether a revert since its merge reverted it. */
  readonly reverted: boolean;
  readonly humanTouches: number;
}

/** What a waiting request's candidates are put together from. */
export interface CandidateFacts {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  /** The store's Run records, of any repo: only `repo`'s count. */
  readonly records: readonly RunRecord[];
  /** The repo's merged agent PRs, in any order. */
  readonly merged: readonly MergedTicketFacts[];
  /** Every file each merged PR changed, by its number. */
  readonly files: Readonly<Record<number, readonly MergedFile[]>>;
  /** When each Ticket and its Spec were last edited, by the Ticket's number. */
  readonly lastEdited: Readonly<Record<number, ReplayCandidate["lastEdited"]>>;
}

/**
 * Each Ticket replayTicketsIn names, as the Replay module's pick weighs it:
 * its last merged agent PR, if one merged, with whether it was reverted, its
 * files and its Human touches; every one of `repo`'s records of it; and when
 * it and its Spec were last edited.
 */
export function replayCandidatesOf({ repo, records, merged, files, lastEdited }: CandidateFacts): ReplayCandidate[] {
  return replayTicketsIn(records, repo).map((ticket): ReplayCandidate => {
    const last = merged.filter((each) => each.ticket === ticket).toSorted((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)).at(-1);
    return {
      ticket,
      merged: last === undefined ? null : { number: last.number, mergedAt: last.mergedAt, reverted: last.reverted, files: files[last.number] ?? [] },
      records: records.filter((record) => record.repo === repo && record.issue === ticket),
      humanTouches: last?.humanTouches ?? 0,
      lastEdited: lastEdited[ticket] ?? { ticket: null, spec: null },
    };
  });
}
