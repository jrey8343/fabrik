import { describe, expect, it } from "vitest";
import { endedHeldLine, heldLineOn, heldRunName, isHeldLine, waitingHeldLineRole } from "./heldLine.ts";
import { heldRunsIn } from "./heldRun.ts";

const held = { role: "implement", issue: 12, label: "agent:implement" } as const;

describe("A held line (#471)", () => {
  it("is read back as waiting on its role's hold until it is edited to say the hold ended", () => {
    const line = heldLineOn(held, heldRunName("implement"), 41, { until: "2026-11-09T04:00:00.000Z", reset: true, timeZone: null });
    if (line.kind !== "comment") throw new Error("expected a plain comment");

    expect(line.issue).toBe(12);
    expect(waitingHeldLineRole(line.body)).toBe("implement");
    const ended = endedHeldLine("implement", 41, { kind: "resumed" }, "2026-11-09T04:05:00.000Z", null);
    expect(ended).toBe('<!-- fabrik:on-hold-ended {"role":"implement"} -->\nWas held on #41 · resumed 2026-11-09 04:05 UTC');
    expect(waitingHeldLineRole(ended)).toBeNull();
    expect([line.body, ended].every(isHeldLine)).toBe(true);
  });

  it("is never read as a held marker, which only a weekly-limit issue's comments carry", () => {
    const line = heldLineOn(held, heldRunName("implement"), 41, { until: null, reset: true, timeZone: null });

    expect(line.kind === "comment" ? heldRunsIn(line.body) : null).toEqual([]);
  });

  it("goes on the agent PR an Implement run on one says it's held on, not its Ticket", () => {
    expect(heldLineOn({ ...held, issue: 7, lineOn: 50 }, heldRunName("implement", { retry: 1 }), 41, { until: null, reset: true, timeZone: null })).toMatchObject({
      kind: "comment",
      issue: 50,
      body: expect.stringContaining("The Implement run (Retry 1 of 2) is held on #41"),
    });
  });

  it("on a usage-credits or token-rotation carrier, which has no reset, says closing an issue blocking a Subscription frees one (#470)", () => {
    expect(heldLineOn(held, heldRunName("implement"), 63, { until: null, reset: false, timeZone: null })).toEqual({
      kind: "comment",
      issue: 12,
      body: '<!-- fabrik:on-hold {"role":"implement"} -->\nThe Implement run is held on #63: every Subscription is used up, so it waits until one is free again. Closing #63, or another issue blocking a Subscription, once it\'s dealt with frees one. The Kit restarts the run by itself then, so there\'s nothing to do.',
    });
  });

  it.each([
    [{ prototype: { route: "/book" } }, "The prototype turn"],
    [{ conflict: { main: "a" } }, "The conflict-only run"],
    [{ requestChanges: { review: 777 } }, "The Request-changes run"],
    [{}, "The Implement run"],
  ])("names the run as the Kit's other notes do: %j is %s", (kind, name) => {
    expect(heldRunName("implement", kind)).toBe(name);
  });

  it("reads nothing but its own first line as a held line's role", () => {
    expect(waitingHeldLineRole('Quoting:\n<!-- fabrik:on-hold {"role":"implement"} -->')).toBeNull();
    expect(waitingHeldLineRole('<!-- fabrik:on-hold {"role":"nobody"} -->')).toBeNull();
    expect(waitingHeldLineRole("<!-- fabrik:on-hold not json -->")).toBeNull();
  });
});
