import { describe, expect, it } from "vitest";
import { weeklyFilingOf } from "./weeklyFiling.ts";

const summary = { kind: "summary", title: "Weekly summary: week of 2026-11-02", body: "Body\n\n@operator" } as const;

describe("Filing the Weekly summary", () => {
  it("files this week's summary and closes last week's open one", () => {
    const filing = weeklyFilingOf(summary, [{ number: 4, title: "Weekly summary: week of 2026-10-26", open: true }]);

    expect(filing).toEqual({
      kind: "file",
      title: "Weekly summary: week of 2026-11-02",
      body: "Body\n\n@operator",
      close: [4],
    });
  });

  it("leaves summaries already closed alone", () => {
    const filing = weeklyFilingOf(summary, [{ number: 4, title: "Weekly summary: week of 2026-10-26", open: false }]);

    expect(filing).toMatchObject({ kind: "file", close: [] });
  });

  it("updates this week's summary in place on a re-run, never filing a second", () => {
    const filing = weeklyFilingOf(summary, [
      { number: 9, title: "Weekly summary: week of 2026-11-02", open: true },
      { number: 4, title: "Weekly summary: week of 2026-10-26", open: false },
    ]);

    expect(filing).toEqual({ kind: "update", issue: 9, body: "Body\n\n@operator", close: [] });
  });

  it("updates this week's summary even after the Operator closed it", () => {
    const filing = weeklyFilingOf(summary, [{ number: 9, title: "Weekly summary: week of 2026-11-02", open: false }]);

    expect(filing).toMatchObject({ kind: "update", issue: 9 });
  });

  it("files nothing in a skipped week, closing nothing", () => {
    const filing = weeklyFilingOf({ kind: "skip" }, [{ number: 4, title: "Weekly summary: week of 2026-10-26", open: true }]);

    expect(filing).toEqual({ kind: "nothing" });
  });
});
