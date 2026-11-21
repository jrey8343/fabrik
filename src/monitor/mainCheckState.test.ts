import { describe, expect, it } from "vitest";
import { aCheckRun } from "../__fixtures__/redMain.ts";
import { mainCheckOn } from "./mainCheckState.ts";

describe("how a commit's check runs decide a Main check", () => {
  it("is green when its run there succeeded, and red when it failed or timed out, with that run", () => {
    const passed = aCheckRun({ id: 901, name: "e2e", conclusion: "success" });
    const failed = aCheckRun({ id: 902, name: "e2e", conclusion: "failure" });
    const timedOut = aCheckRun({ id: 903, name: "e2e", conclusion: "timed_out" });

    expect(mainCheckOn("e2e", [passed])).toEqual({ is: "green", run: passed });
    expect(mainCheckOn("e2e", [failed])).toEqual({ is: "red", run: failed });
    expect(mainCheckOn("e2e", [timedOut])).toEqual({ is: "red", run: timedOut });
  });

  it("is undecided with no run of that name there, with one still under way, and with one that ended any other way", () => {
    const other = aCheckRun({ id: 900, name: "build", conclusion: "failure" });
    const running = aCheckRun({ id: 901, name: "e2e", status: "in_progress", conclusion: null, completedAt: null });

    expect(mainCheckOn("e2e", [other])).toEqual({ is: "undecided", run: null });
    expect(mainCheckOn("e2e", [running])).toEqual({ is: "undecided", run: running });
    for (const conclusion of ["cancelled", "skipped", "neutral", "action_required", "stale"]) {
      const ended = aCheckRun({ id: 901, name: "e2e", conclusion });
      expect(mainCheckOn("e2e", [ended]), conclusion).toEqual({ is: "undecided", run: ended });
    }
  });

  it("reads the newest run of that name, so a re-run replaces the run before it", () => {
    const failed = aCheckRun({ id: 901, name: "e2e", conclusion: "failure" });
    const rerun = aCheckRun({ id: 905, name: "e2e", conclusion: "success" });

    expect(mainCheckOn("e2e", [rerun, failed])).toEqual({ is: "green", run: rerun });
  });
});
