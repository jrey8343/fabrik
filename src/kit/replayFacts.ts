// What the scheduled tick's replay slice reads of the fabrik-runs store and
// of GitHub, put together for the replay step (#156, src/github/replaySlice.ts):
// the newest weekly-limit reading on each Subscription, which the
// spare-capacity gate weighs, and a waiting request's candidate Tickets,
// which the Replay module picks from (src/kit/replay.ts). Pure, no I/O.
import type { MergedFile, ReplayCandidate } from "./replay.ts";
import { isLive, type RateLimitReading, type RunRecord, WEEKLY_LIMIT } from "./runRecord.ts";

/** A Subscription's last weekly-limit reading, as a Run record kept it, with when it was read and when its week resets. */
export interface SubscriptionReading {
  /** The Subscription's name, as its Run records give it. */
  readonly subscription: string;
  /** How much of its weekly limit was used, from 0 to 1. */
  readonly share: number | null;
  /** The reading's own word, such as "allowed". */
  readonly said: string | null;
  /** When the run that read it ended, as its Run record gives it. */
  readonly readAt: string;
  /** When its week resets, ISO 8601. */
  readonly resetsAt: string | null;
}

/**
 * The newest weekly-limit reading on each Subscription among these Run
 * records, of every Product repo, a Replay run's included, from the store's
 * last two months: the month of `now` and the one before, by UTC, by
 * Subscription name. A record that read none, or only the five-hour limit's,
 * is skipped, so not every run reports one: a Subscription none read one for
 * isn't here, and a reading is as old as its `readAt`. A reading counts
 * everything run on its Subscription, not the factory's runs alone; whether
 * its week has reset since is the reader's to tell from `resetsAt`.
 */
export function subscriptionReadingsOf(records: readonly RunRecord[], now: string): SubscriptionReading[] {
  const from = lastMonthStart(now);
  const newest: Record<string, { readonly at: number; readonly record: RunRecord; readonly reading: RateLimitReading }> = {};
  for (const record of records) {
    const at = Date.parse(record.endedAt);
    const seen = newest[record.subscription];
    const reading = record.rateLimit;
    if (reading?.rateLimitType !== WEEKLY_LIMIT || at < from) continue;
    if (seen === undefined || at > seen.at) newest[record.subscription] = { at, record, reading };
  }
  return Object.values(newest)
    .map(({ record, reading }) => ({
      subscription: record.subscription,
      share: reading.utilization,
      said: reading.status,
      readAt: record.endedAt,
      resetsAt: resetTimeOf(reading.resetsAt),
    }))
    .toSorted((a, b) => (a.subscription < b.subscription ? -1 : a.subscription > b.subscription ? 1 : 0));
}

/** A reading's reset, in epoch seconds as the stream gives it, as a time; null for none, or one that is no time. */
function resetTimeOf(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const at = new Date(resetsAt * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The newest weekly-limit reading on each Subscription, raw, as the Replay
 * gate's spare-capacity check weighs it: subscriptionReadingsOf, by
 * Subscription.
 */
export function newestWeeklyLimits(records: readonly RunRecord[], now: string): Record<string, RateLimitReading> {
  return Object.fromEntries(
    subscriptionReadingsOf(records, now).map(({ subscription, share, said, resetsAt }): [string, RateLimitReading] => [
      subscription,
      { status: said, rateLimitType: WEEKLY_LIMIT, utilization: share, resetsAt: resetsAt === null ? null : Date.parse(resetsAt) / 1000 },
    ]),
  );
}

/**
 * What the scheduled tick checks out of the store for the replay step at
 * `now`, as git's non-cone sparse-checkout patterns: every Product repo's
 * Run records from the store's last two months, which newestWeeklyLimits
 * reads, and every one of this repo's, `repo` as `owner/name`, whatever
 * month, which a waiting request's candidates are read from. A record sits
 * under the month it ended, by UTC (runStoreName in src/kit/runRecord.ts).
 */
export function replayStorePaths(repo: string, now: string): string[] {
  const month = (at: number) => new Date(at).toISOString().slice(0, 7);
  return [`/runs/*/*/${month(Date.parse(now))}/`, `/runs/*/*/${month(lastMonthStart(now))}/`, `/runs/${repo}/`];
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
  const tickets = records.filter((record) => record.repo === repo && record.role === "implement" && isLive(record)).map(({ issue }) => issue);
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
