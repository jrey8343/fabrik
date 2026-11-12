import { describe, expect, it } from "vitest";
import { PAST_HAND_BACK_NOTICES } from "../__fixtures__/handBackWordings.ts";
import { handBackMarker } from "../loop/markers.ts";
import { handBackOfNotice } from "./standingHandBacks.ts";

describe("reading which hand-back a notice is", () => {
  it("reads the hidden line, wherever it is", () => {
    const body = ["<!-- fabrik:implement-run-failed -->", "@operator The Implement run on #7 failed: it crashed.", "", handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "crash" })].join("\n");
    expect(handBackOfNotice(body)).toEqual({ kind: "infrastructure-failure", role: "implement", failure: "crash" });
  });

  it.each(PAST_HAND_BACK_NOTICES.map((notice) => [notice.release, notice.handBack, notice.role ?? "no role", notice] as const))(
    "reads a notice as %s wrote it as %s, by %s, as its marked successor names it, but the failure",
    (_release, handBack, _role, { role, body }) => {
      expect(handBackOfNotice(body)).toEqual({ kind: handBack, ...(role === undefined ? {} : { role }) });
    },
  );

  it("holds one past wording of every hand-back the Kit's notices have handed back by", () => {
    expect(new Set(PAST_HAND_BACK_NOTICES.map(({ handBack }) => handBack))).toEqual(
      new Set([
        "infrastructure-failure",
        "broken-run-no-retry",
        "trigger-swept",
        "retry-never-started",
        "landing-failed",
        "request-changes-empty",
        "conflict-run-unlanded",
        "request-changes-unlanded",
        "closed-by-hand",
        "kept-branch-gone",
        "research-failed",
        "design-turn-failed",
      ]),
    );
  });

  it.each([
    ["a counted Broken run, an Execution flaw the Kit re-runs itself", "<!-- fabrik:broken-run -->\nThe Implement run on #7 was a Broken run, and the Kit opened no PR: it crashed. A Broken run is an Execution flaw: retry 1 of 2 starts now."],
    ["a Request-changes run that committed nothing on a head that moved", "<!-- fabrik:request-changes-run-empty -->\nThe Request-changes run on #50 committed nothing to `fabrik/ticket-7` on top of aaaaaaa, the head it started on, which moved to bbbbbbb while it worked. Review runs on bbbbbbb, and its Verdict decides what's next. No retry was used."],
    ["the sweep's first strike", "<!-- fabrik:stuck-trigger-readded agent:implement -->\n`agent:implement` sat 40 minutes with no run behind it, so the Kit added it again."],
    ["a failed Audit run, which the tick tries again", "@operator The Audit run on #30 failed: it crashed.\n\nThis is an Infrastructure failure, so the Loop won't retry it. The next scheduled tick opens a new Audit."],
    ["a person's word", "Any news on this?"],
  ])("reads nothing from %s", (_what, body) => {
    expect(handBackOfNotice(body)).toBeNull();
  });
});
