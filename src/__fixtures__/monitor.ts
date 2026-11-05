// Small builders for the Monitor core's tests (src/monitor/core.ts), matching
// anIssue and snapshotOf (./snapshots.ts): say only what a test cares about.
import { DEFAULT_KIT_CONFIG, type MonitorErrors } from "../kit/config.ts";
import type { MonitorInput } from "../monitor/core.ts";
import type { MonitorIssue } from "../monitor/issues.ts";
import type { GroupFacts } from "../monitor/sentry.ts";

/** Production errors on, read from Sentry's `acme/clinic` project, with the default threshold of 3 events in 24 hours. */
export const SENTRY_ON: MonitorErrors = {
  provider: "sentry",
  org: "acme",
  project: "clinic",
  url: "https://sentry.io",
  minEvents: 3,
};

/**
 * Group 4504 (CLINIC-7): an unresolved `error`-level TypeError in `POST
 * /api/book` with 9 events in the last 24 hours from 4 users, all of them (or
 * as many as `events24h` says) in the hour from 06:00 UTC on the day the tick
 * runs, its latest event read: release `clinic@1.4.0` and two in-app frames.
 */
export function aGroup(overrides: Partial<GroupFacts> = {}): GroupFacts {
  const events24h = overrides.events24h ?? 9;
  return {
    id: "4504",
    shortId: "CLINIC-7",
    title: "TypeError: Cannot read properties of undefined (reading 'slots')",
    exceptionType: "TypeError",
    culprit: "POST /api/book",
    level: "error",
    status: "unresolved",
    events24h,
    eventsByHour: events24h === 0 ? [] : [{ start: "2026-11-06T06:00:00.000Z", events: events24h }],
    usersAffected: 4,
    firstSeen: "2026-11-01T09:30:00.000000Z",
    lastSeen: "2026-11-06T06:15:00.000000Z",
    permalink: "https://acme.sentry.io/issues/4504/",
    latestEvent: {
      release: "clinic@1.4.0",
      frames: [
        { file: "/app/src/lib/booking.ts", line: 42, function: "loadSlots" },
        { file: "/app/src/pages/api/book.ts", line: 18, function: "POST" },
      ],
    },
    ...overrides,
  };
}

/** The stats block's lines for aGroup()'s stats, as the Monitor writes them. */
export const AGROUP_STATS: readonly string[] = [
  "- Events in the last 24 hours: 9",
  "- Users affected: 4",
  "- Last seen: 2026-11-06 06:15 UTC",
  "- Release: `clinic@1.4.0`",
];

/** A Monitor issue's body for group 4504, its stats block holding these lines. */
export function aMonitorIssueBody(stats: readonly string[] = AGROUP_STATS): string {
  return [
    "<!-- fabrik:monitor sentry:4504 -->",
    "Sentry reports a production error in this repo, `CLINIC-7`.",
    "",
    "- Culprit: `POST /api/book`",
    "<!-- fabrik:monitor-stats -->",
    ...stats,
    "<!-- /fabrik:monitor-stats -->",
    "",
    "[The group in Sentry](https://acme.sentry.io/issues/4504/)",
  ].join("\n");
}

/**
 * Open issue 40, filed by the Fabrik App for group 4504 and labelled
 * fabrik:monitor, its stats block showing aGroup()'s stats.
 */
export function aMonitorIssue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return {
    number: 40,
    open: true,
    stateReason: null,
    closedAt: null,
    labels: ["fabrik:monitor", "bug", "ready-for-agent"],
    byApp: true,
    body: aMonitorIssueBody(),
    closedByMonitor: false,
    ...overrides,
  };
}

/**
 * `count` open error issues the Fabrik App filed, numbered from 40 up, one
 * each for groups 4601 and up, which Sentry doesn't list this tick: each takes
 * a slot under the cap, its stats block showing aGroup()'s stats.
 */
export function openErrorIssues(count: number): MonitorIssue[] {
  return Array.from({ length: count }, (_, i) =>
    aMonitorIssue({ number: 40 + i, body: aMonitorIssueBody().replace("sentry:4504", `sentry:${4601 + i}`) }),
  );
}

/** Issue 40 closed as completed on 2026-11-03 at 10:00 UTC, by its fix merging. */
export function aClosedMonitorIssue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return aMonitorIssue({ open: false, stateReason: "completed", closedAt: "2026-11-03T10:00:00Z", ...overrides });
}

/** A tick with production errors on and Sentry read, giving these groups and no Monitor issues, and the default branch not read. */
export function monitorInput(groups: readonly GroupFacts[], overrides: Partial<MonitorInput> = {}): MonitorInput {
  return {
    monitor: { ...DEFAULT_KIT_CONFIG.monitor, errors: SENTRY_ON },
    sentry: { kind: "read", groups, groupsWithoutStats: 0 },
    issues: [],
    gatingChecks: [],
    mainChecks: null,
    now: "2026-11-06T08:00:00Z",
    ...overrides,
  };
}
