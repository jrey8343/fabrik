import { describe, expect, it } from "vitest";
import { CLINIC_1_LATEST_EVENT, CLINIC_3_LATEST_EVENT, PROJECT_ISSUES_24H } from "../__fixtures__/sentry.ts";
import { groupFactsOf, withLatestEvent } from "./sentry.ts";

describe("Translating Sentry's issue listing into group facts", () => {
  it("gives each group's facts, with its events in the last 24 hours summed from the hourly stats", () => {
    expect(groupFactsOf(PROJECT_ISSUES_24H)[0]).toEqual({
      id: "6031250812",
      shortId: "CLINIC-3",
      title: "Error: Couldn't load the booking slots",
      exceptionType: "Error",
      culprit: "POST /api/book",
      level: "error",
      status: "unresolved",
      events24h: 9,
      usersAffected: 4,
      firstSeen: "2026-10-29T03:12:44.104000Z",
      lastSeen: "2026-11-06T08:41:09.512000Z",
      permalink: "https://acme.sentry.io/issues/6031250812/",
      latestEvent: null,
    });
  });

  it("translates a logged message's group, which has no exception, with no exception type and no culprit", () => {
    expect(groupFactsOf(PROJECT_ISSUES_24H)[1]).toEqual({
      id: "6031244470",
      shortId: "CLINIC-1",
      title: "Nookal returned no practitioners",
      exceptionType: null,
      culprit: null,
      level: "error",
      status: "unresolved",
      events24h: 3,
      usersAffected: 0,
      firstSeen: "2026-10-31T22:05:17.880000Z",
      lastSeen: "2026-11-05T12:18:52.031000Z",
      permalink: "https://acme.sentry.io/issues/6031244470/",
      latestEvent: null,
    });
  });

  it("gives every group on the page, in Sentry's order", () => {
    expect(groupFactsOf(PROJECT_ISSUES_24H).map((group) => group.shortId)).toEqual(["CLINIC-3", "CLINIC-1"]);
  });
});

describe("Adding a group's latest event to its facts", () => {
  const [bookingGroup, messageGroup] = groupFactsOf(PROJECT_ISSUES_24H);

  it("adds the release and the in-app frames alone, as file, line and function, newest first", () => {
    expect(withLatestEvent(bookingGroup!, CLINIC_3_LATEST_EVENT)).toEqual({
      ...bookingGroup,
      latestEvent: {
        release: "clinic@2026.11.05+3f9c2a1",
        frames: [
          { file: "/app/src/lib/booking.ts", line: 42, function: "loadSlots" },
          { file: "/app/src/pages/api/book.ts", line: 18, function: "POST" },
          { file: "/app/src/lib/nookal.ts", line: 57, function: "availableSlots" },
        ],
      },
    });
  });

  it("adds no frames and no release from an event with no exception that names no release", () => {
    expect(withLatestEvent(messageGroup!, CLINIC_1_LATEST_EVENT)).toEqual({
      ...messageGroup,
      latestEvent: { release: null, frames: [] },
    });
  });

  // A value found only in each part of the event a Monitor issue must never show.
  it.each([
    ["request data", "Request body fixture symptoms"],
    ["request cookies", "session-cookie-fixture"],
    ["breadcrumbs", "nookal-key-fixture"],
    ["user", "203.0.113.7"],
    ["tags", "ip-10-0-1-23.ap-southeast-2.compute.internal"],
    ["contexts", "booking-reference-fixture"],
    ["frame variables", "nookal-var-key-fixture"],
  ])("carries nothing from the event's %s", (_part, value) => {
    expect(JSON.stringify(CLINIC_3_LATEST_EVENT)).toContain(value);

    expect(JSON.stringify(withLatestEvent(bookingGroup!, CLINIC_3_LATEST_EVENT))).not.toContain(value);
  });
});
