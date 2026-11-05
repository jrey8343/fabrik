// Small builders for the Monitor core's tests (src/monitor/core.ts), matching
// anIssue and snapshotOf (./snapshots.ts): say only what a test cares about.
import { DEFAULT_KIT_CONFIG, type MonitorErrors } from "../kit/config.ts";
import type { MonitorInput, MonitorIssue } from "../monitor/core.ts";
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
 * /api/book` with 9 events in the last 24 hours from 4 users, its latest event
 * read: release `clinic@1.4.0` and two in-app frames.
 */
export function aGroup(overrides: Partial<GroupFacts> = {}): GroupFacts {
  return {
    id: "4504",
    shortId: "CLINIC-7",
    title: "TypeError: Cannot read properties of undefined (reading 'slots')",
    exceptionType: "TypeError",
    culprit: "POST /api/book",
    level: "error",
    status: "unresolved",
    events24h: 9,
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

/** Open issue 40, filed by the Fabrik App for group 4504 and labelled fabrik:monitor. */
export function aMonitorIssue(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return {
    number: 40,
    open: true,
    stateReason: null,
    closedAt: null,
    labels: ["fabrik:monitor", "bug", "ready-for-agent"],
    byApp: true,
    body: "<!-- fabrik:monitor sentry:4504 -->\nSentry reports a production error.",
    ...overrides,
  };
}

/** A tick with production errors on and Sentry read, giving these groups and no Monitor issues. */
export function monitorInput(groups: readonly GroupFacts[], overrides: Partial<MonitorInput> = {}): MonitorInput {
  return {
    monitor: { ...DEFAULT_KIT_CONFIG.monitor, errors: SENTRY_ON },
    sentry: { kind: "read", groups, groupsWithoutStats: 0 },
    issues: [],
    now: "2026-11-06T08:00:00Z",
    ...overrides,
  };
}
