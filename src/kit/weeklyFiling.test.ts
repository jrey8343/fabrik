import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import { weeklyFailureOf, weeklyFilingOf } from "./weeklyFiling.ts";

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

describe("A failed Weekly summary run", () => {
  const RUN_URL = "https://github.com/operator/fabrik-runs/actions/runs/55/attempts/1";
  // A Product repo's facts query GitHub failed on, thrown out of the gathering.
  const gatherFailed = new GitHubError("GitHub GraphQL query failed: Bad Gateway", 502, { body: "Bad Gateway", request: "POST /graphql" });

  it("comments on last week's summary, mentioning the Operator, with the run link and what failed", () => {
    const failure = weeklyFailureOf(gatherFailed, [
      { number: 9, title: "Weekly summary: week of 2026-10-26", open: true },
      { number: 4, title: "Weekly summary: week of 2026-10-19", open: false },
    ], RUN_URL, "operator");

    expect(failure.filing).toEqual({ kind: "comment", issue: 9, body: expect.stringContaining("@operator **The Weekly summary failed**") });
    expect(failure.filing.body).toContain(`[run](${RUN_URL})`);
    expect(failure.filing.body).toContain("GitHub failed `POST /graphql` with a 502, its own failure rather than the Kit's: Bad Gateway");
    expect(failure.summary).toContain("GitHub failed `POST /graphql` with a 502");
    expect(failure.error).toBe("The Weekly summary failed: GitHub failed `POST /graphql` with a 502, its own failure rather than the Kit's: Bad Gateway");
  });

  it("files a short Weekly summary failed issue when no summary was ever filed", () => {
    const failure = weeklyFailureOf(new Error("FABRIK_STORE_DIR is not set"), [], RUN_URL, "operator");

    expect(failure.filing).toEqual({ kind: "file", title: "Weekly summary failed", body: expect.stringContaining("@operator **The Weekly summary failed**") });
    expect(failure.filing.body).toContain("The Kit failed: FABRIK_STORE_DIR is not set");
  });
});
