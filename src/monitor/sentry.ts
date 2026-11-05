// The Sentry translator: Sentry API JSON into the group facts the Monitor core
// works from. Pure, no I/O. It reads only the fields a Monitor issue shows, each
// by name, so what else Sentry sends (request data, breadcrumbs, user, tags,
// contexts, frame variables) never reaches the facts, and can't reach an issue
// by accident.

/** A Sentry issue group, as the Monitor reads it. */
export interface GroupFacts {
  /** Sentry's id for the group, which a Monitor issue's marker names. */
  readonly id: string;
  /** Such as `CLINIC-3`. */
  readonly shortId: string;
  /** Sentry's title for the group. It can quote the error message. */
  readonly title: string;
  /** The exception's type, such as `TypeError`, or null for a group with no exception, such as a logged message. */
  readonly exceptionType: string | null;
  /** Where Sentry says it happened, such as a route or a function, or null when it doesn't say. */
  readonly culprit: string | null;
  /** As Sentry gives it: `fatal`, `error`, `warning`, `info` or `debug`. */
  readonly level: string;
  /** As Sentry gives it: `unresolved`, `resolved` or `ignored`. */
  readonly status: string;
  /** Events in the last 24 hours, summed from the group's hourly stats. */
  readonly events24h: number;
  readonly usersAffected: number;
  /** ISO 8601. */
  readonly firstSeen: string;
  /** ISO 8601. */
  readonly lastSeen: string;
  /** The group's page in Sentry. */
  readonly permalink: string;
  /** What the group's latest event adds, or null until it's read (see withLatestEvent). */
  readonly latestEvent: LatestEventFacts | null;
}

/** What a group's latest event adds to its facts. */
export interface LatestEventFacts {
  /** The release's version, or null when the event names no release. */
  readonly release: string | null;
  /** The in-app stack frames, newest first. */
  readonly frames: readonly FrameFacts[];
}

/** An in-app stack frame: file, line and function, and nothing else. */
export interface FrameFacts {
  readonly file: string | null;
  readonly line: number | null;
  readonly function: string | null;
}

/**
 * A group in Sentry's issue listing (`GET /api/0/projects/{org}/{project}/issues/`
 * with `statsPeriod=24h`), as its API schema documents it: only the fields the
 * translator reads.
 */
export interface RawSentryGroup {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly culprit: string | null;
  readonly level: string;
  readonly status: string;
  readonly userCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly permalink: string;
  /** An exception group's names its `type`; a message group's has only a `title`. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Hourly `[unix seconds, events]` buckets. */
  readonly stats?: { readonly "24h"?: readonly (readonly number[])[] };
}

/** One page of Sentry's issue listing, translated. Each group's latest event is still to be read. */
export function groupFactsOf(listing: readonly RawSentryGroup[]): GroupFacts[] {
  return listing.map((group) => ({
    id: group.id,
    shortId: group.shortId,
    title: group.title,
    exceptionType: textOrNull(group.metadata["type"]),
    culprit: textOrNull(group.culprit),
    level: group.level,
    status: group.status,
    events24h: (group.stats?.["24h"] ?? []).reduce((sum, [, events]) => sum + (events ?? 0), 0),
    usersAffected: group.userCount,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    permalink: group.permalink,
    latestEvent: null,
  }));
}

/**
 * A group's latest event (`GET /api/0/organizations/{org}/issues/{id}/events/latest/`),
 * as its API schema documents it: only the fields the translator reads.
 */
export interface RawSentryEvent {
  /** Typed blocks: `exception`, `breadcrumbs`, `request`, `message` and more. Only `exception` is read. */
  readonly entries: readonly { readonly type: string; readonly data?: unknown }[];
  readonly release?: { readonly version: string } | null;
}

/** An `exception` entry's data: its exceptions, chained ones oldest first. */
interface RawExceptionData {
  readonly values?: readonly RawException[] | null;
}

interface RawException {
  readonly stacktrace?: { readonly frames?: readonly RawFrame[] | null } | null;
}

/** A stack frame. Its `vars`, `context` and the rest are never read. */
interface RawFrame {
  readonly filename?: string | null;
  readonly lineNo?: number | null;
  readonly function?: string | null;
  readonly inApp?: boolean | null;
}

/** The group's facts with what its latest event adds: the release and the in-app frames. */
export function withLatestEvent(group: GroupFacts, event: RawSentryEvent): GroupFacts {
  return { ...group, latestEvent: { release: event.release?.version ?? null, frames: inAppFramesOf(event) } };
}

/**
 * The in-app frames of every exception in the event, newest first. Sentry lists
 * chained exceptions, and each stack's frames, oldest first, so both are read
 * backwards: the frame that raised the newest exception leads.
 */
function inAppFramesOf(event: RawSentryEvent): FrameFacts[] {
  const exceptions = event.entries
    .filter((entry) => entry.type === "exception")
    .flatMap((entry) => (entry.data as RawExceptionData | undefined)?.values ?? []);
  return exceptions.toReversed().flatMap((exception) =>
    (exception.stacktrace?.frames ?? [])
      .filter((frame) => frame.inApp === true)
      .toReversed()
      .map((frame) => ({ file: frame.filename ?? null, line: frame.lineNo ?? null, function: frame.function ?? null })),
  );
}

/** A string that says something, or null for an empty or missing one. */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
