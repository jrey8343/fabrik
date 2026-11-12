import { describe, expect, it } from "vitest";
import { type CheckDetail, rerunOutcome, redChecksOf, settledChecksOutcome, whyNotRerun } from "./rerun.ts";

const actions = (name: string, bucket: CheckDetail["bucket"], run: number, startedAt = "2026-11-11T10:00:00Z"): CheckDetail => ({
  name,
  bucket,
  link: `https://github.com/o/r/actions/runs/${run}/job/${run * 10}`,
  workflow: "CI",
  startedAt,
});
const outside = (name: string, bucket: CheckDetail["bucket"]): CheckDetail => ({
  name,
  bucket,
  link: "https://vercel.com/o/r/deployments/1",
  workflow: "",
  startedAt: "2026-11-11T10:00:00Z",
});

describe("The red checks the Kit re-runs", () => {
  it("are the GitHub Actions ones, by their workflow runs, each run once", () => {
    const checks = [actions("unit", "fail", 7), actions("e2e", "cancel", 7), actions("lint", "fail", 8), actions("build", "pass", 9)];
    expect(redChecksOf(checks, ["unit", "e2e", "lint"])).toEqual({
      rerun: [
        { name: "unit", link: "https://github.com/o/r/actions/runs/7/job/70", run: 7 },
        { name: "e2e", link: "https://github.com/o/r/actions/runs/7/job/70", run: 7 },
        { name: "lint", link: "https://github.com/o/r/actions/runs/8/job/80", run: 8 },
      ],
      outside: [],
    });
  });

  it("leave out the ones from an outside service, which only their owner can re-run", () => {
    expect(redChecksOf([outside("Vercel", "fail"), actions("unit", "fail", 7)], ["Vercel", "unit"])).toEqual({
      rerun: [{ name: "unit", link: "https://github.com/o/r/actions/runs/7/job/70", run: 7 }],
      outside: ["Vercel"],
    });
  });

  it("take a check whose link names no workflow run as an outside one", () => {
    const odd: CheckDetail = { ...actions("unit", "fail", 7), link: "https://github.com/o/r/runs/123" };
    expect(redChecksOf([odd], ["unit"])).toEqual({ rerun: [], outside: ["unit"] });
  });
});

describe("The checks after the Kit re-ran the red ones", () => {
  const rerunAt = "2026-11-11T11:00:00Z";

  it("are still pending while a re-run check reads as it did before the re-run", () => {
    const checks = [actions("unit", "fail", 7, "2026-11-11T10:00:00Z"), actions("build", "pass", 9)];
    expect(settledChecksOutcome(checks, [], { rerun: ["unit"], rerunAt })).toEqual({ kind: "pending", unreported: [], running: ["unit"] });
  });

  it("wait for every re-run check, even with an outside check still red", () => {
    const checks = [outside("Vercel", "fail"), actions("unit", "pending", 7, "2026-11-11T11:01:00Z")];
    expect(settledChecksOutcome(checks, [], { rerun: ["unit"], rerunAt })).toEqual({ kind: "pending", unreported: [], running: ["unit"] });
  });

  it("are red once every one has finished and one didn't pass", () => {
    const checks = [outside("Vercel", "fail"), actions("unit", "pass", 7, "2026-11-11T11:01:00Z")];
    expect(settledChecksOutcome(checks, [], { rerun: ["unit"], rerunAt })).toEqual({ kind: "red", failed: ["Vercel"] });
  });

  it("are green once every re-run check passed", () => {
    const checks = [actions("unit", "pass", 7, "2026-11-11T11:01:00Z"), actions("build", "pass", 9)];
    expect(settledChecksOutcome(checks, [], { rerun: ["unit"], rerunAt })).toEqual({ kind: "green", ranNothing: [] });
  });
});

describe("What a re-run came to", () => {
  it("names the re-run checks that failed again, and the flaky ones with both their runs", () => {
    const red = [
      { name: "unit", link: "https://github.com/o/r/actions/runs/7/job/70", run: 7 },
      { name: "e2e", link: "https://github.com/o/r/actions/runs/7/job/71", run: 7 },
    ];
    const after = [actions("unit", "fail", 7, "2026-11-11T11:01:00Z"), { ...actions("e2e", "pass", 7, "2026-11-11T11:01:00Z"), link: "https://github.com/o/r/actions/runs/7/job/99" }];
    expect(rerunOutcome(red, after)).toEqual({
      failedAgain: ["unit"],
      flaky: [{ name: "e2e", red: "https://github.com/o/r/actions/runs/7/job/71", green: "https://github.com/o/r/actions/runs/7/job/99" }],
    });
  });
});

describe("Why the Kit couldn't re-run red checks", () => {
  it("names the caller workflow's missing grant when GitHub refuses the token", () => {
    expect(whyNotRerun("gh: Resource not accessible by integration (HTTP 403)")).toBe(
      "GitHub refused the workflow token (Resource not accessible by integration). Add `actions: write` under the `loop` job's `permissions:` in `.github/workflows/fabrik.yml`",
    );
  });

  it("gives GitHub's own words for any other refusal", () => {
    expect(whyNotRerun("gh: Unable to retry this workflow run because it was created over a month ago (HTTP 403)\n")).toBe(
      "GitHub refused: Unable to retry this workflow run because it was created over a month ago",
    );
  });
});
