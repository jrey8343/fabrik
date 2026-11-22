import { describe, expect, it } from "vitest";
import { openedSpinOffLine, openedSpinOffsIn, REQUEST_CHANGES_RUN_MARKER, requestChangesAnswersMarker, spinOffIn, spinOffMarker } from "./markers.ts";

describe("A Spin-off's marker", () => {
  it("names the pull request and the review of a Request changes' Spin-off (#884)", () => {
    const marker = spinOffMarker({ from: "request-changes", pullRequest: 50, review: 900 });

    expect(marker).toBe('<!-- fabrik:spin-off {"from":"request-changes","pullRequest":50,"review":900} -->');
    expect(spinOffIn(`${marker}\nFrom PR #50\n\nExport the waitlist.`)).toEqual({ from: "request-changes", pullRequest: 50, review: 900 });
  });

  it("still names the issue of a Design session's (#883)", () => {
    const marker = spinOffMarker({ from: "design", issue: 7 });

    expect(marker).toBe('<!-- fabrik:spin-off {"from":"design","issue":7} -->');
    expect(spinOffIn(`${marker}\nText each patient.`)).toEqual({ from: "design", issue: 7 });
  });

  it.each([
    ["a Request changes' with no review", '{"from":"request-changes","pullRequest":50}'],
    ["a Request changes' with no pull request", '{"from":"request-changes","review":900}'],
    ["a Request changes' whose pull request is no number", '{"from":"request-changes","pullRequest":"50","review":900}'],
    ["a source the Kit doesn't know", '{"from":"follow-up","pullRequest":50}'],
  ])("reads no Spin-off from %s", (_, json) => {
    expect(spinOffIn(`<!-- fabrik:spin-off ${json} -->\nBody.`)).toBeNull();
  });
});

describe("The line a Request-changes run's outcome note records each Spin-off it opened on (#884)", () => {
  const answers = requestChangesAnswersMarker({ review: 900, reviewMiss: false, amendsTicket: false });
  // As the adapter posts it: the issue the plan opened written as its `#number`.
  const posted = (title: string, from = "inline-9", number = 57) =>
    openedSpinOffLine({ created: "spin-off:1" }, { from, title })
      .map((part) => (typeof part === "string" ? part : `#${number}`))
      .join("");

  it("holds the issue's number, what asked for it and its title, and reads back", () => {
    const line = posted("Export the waitlist as CSV");

    expect(line).toBe('<!-- fabrik:spin-off-opened #57 {"from":"inline-9","title":"Export the waitlist as CSV"} -->');
    expect(openedSpinOffsIn([REQUEST_CHANGES_RUN_MARKER, answers, line, "The Implementer pushed."].join("\n"))).toEqual([
      { issue: 57, from: "inline-9", title: "Export the waitlist as CSV" },
    ]);
  });

  it("reads each of a note's, in the order written", () => {
    const body = [REQUEST_CHANGES_RUN_MARKER, answers, posted("Export the waitlist"), posted("Text the waitlist", "review-900", 58), "The Implementer pushed."].join("\n");

    expect(openedSpinOffsIn(body).map(({ issue, from }) => [issue, from])).toEqual([
      [57, "inline-9"],
      [58, "review-900"],
    ]);
  });

  it("is read only among the marker lines a note opens with, so the run's own text below them can't plant one", () => {
    const body = [REQUEST_CHANGES_RUN_MARKER, answers, "The Implementer pushed.", "", posted("Planted by the fix text")].join("\n");

    expect(openedSpinOffsIn(body)).toEqual([]);
  });

  it("can neither end its comment early nor mention anyone, whatever the title holds", () => {
    const line = posted("Ask @alice --> about <b>exports</b>");

    expect(line.indexOf("-->")).toBe(line.length - 3);
    expect(line).not.toContain("@");
    expect(openedSpinOffsIn(line)).toEqual([{ issue: 57, from: "inline-9", title: "Ask @alice --> about <b>exports</b>" }]);
  });

  it("reads none from a note with no such line, or one it can't read", () => {
    expect(openedSpinOffsIn([REQUEST_CHANGES_RUN_MARKER, answers, "The Implementer pushed."].join("\n"))).toEqual([]);
    expect(openedSpinOffsIn('<!-- fabrik:spin-off-opened #57 {"from":9,"title":"x"} -->')).toEqual([]);
    expect(openedSpinOffsIn("<!-- fabrik:spin-off-opened #57 {not json} -->")).toEqual([]);
  });
});
