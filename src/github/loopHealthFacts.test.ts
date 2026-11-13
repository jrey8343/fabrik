import { describe, expect, it } from "vitest";
import { GitHubError } from "./client.ts";
import { tickHealthOf } from "../kit/loopHealth.ts";
import { readCallerRuns } from "./loopHealthFacts.ts";

const REPO = { owner: "acme", name: "shop" };
const SINCE = "2026-10-31T00:00:00Z";

const aRun = (i: number, conclusion: string | null = "success", event = "schedule") => ({ id: i, conclusion, created_at: "2026-11-05T03:00:00Z", event });

describe("Reading a Product repo's caller runs for the Weekly summary", () => {
  it("lists every page of fabrik.yml's runs created since the window opened", async () => {
    const calls: string[] = [];
    const pages = [Array.from({ length: 100 }, (_, i) => aRun(i)), [aRun(100, "startup_failure", "issues"), aRun(101, null)]];
    const github = {
      async rest(method: string, path: string): Promise<unknown> {
        expect(method).toBe("GET");
        calls.push(path);
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
        return { total_count: 102, workflow_runs: pages[page - 1] ?? [] };
      },
    };

    const read = await readCallerRuns(github, REPO, SINCE);

    expect(calls[0]).toBe(`/repos/acme/shop/actions/workflows/fabrik.yml/runs?created=${encodeURIComponent(">=2026-10-31T00:00:00Z")}&exclude_pull_requests=true&per_page=100&page=1`);
    expect(read.kind === "read" && read.runs.length).toBe(102);
    expect(read.kind === "read" && read.runs.at(-2)).toEqual({ conclusion: "startup_failure", createdAt: "2026-11-05T03:00:00Z", event: "issues" });
  });

  it("says why when GitHub refuses the read, so the summary still files", async () => {
    const github = {
      async rest(): Promise<unknown> {
        throw new GitHubError("Forbidden", 403, { body: '{"message":"Resource not accessible by integration"}' });
      },
    };

    const read = await readCallerRuns(github, REPO, SINCE);

    expect(read).toEqual({ kind: "unread", why: expect.stringContaining("Resource not accessible by integration") });
  });

  it("reads a repo with no fabrik.yml as having no runs", async () => {
    const github = {
      async rest(): Promise<unknown> {
        throw new GitHubError("Not Found", 404, { body: '{"message":"Not Found"}' });
      },
    };

    expect(await readCallerRuns(github, REPO, SINCE)).toEqual({ kind: "read", runs: [] });
  });
});

describe("A Product repo's Tick, as the health line reads it", () => {
  const lastTick = { at: "2026-11-08T19:00:00Z", url: "https://github.com/acme/shop/actions/runs/9", release: "v1.2.0" };

  it("names the Fabrik App's open Dead-tick issue, and only the App's", () => {
    const issues = [
      { number: 3, body: "quoting <!-- fabrik:dead-tick -->", byApp: false },
      { number: 7, body: "<!-- fabrik:dead-tick -->", byApp: true },
    ];
    const read = tickHealthOf({ repo: "acme/shop", kind: "read", facts: { callerSince: SINCE, lastTick, release: "v1.2.0", issues } });

    expect(read).toEqual({ kind: "read", callerSince: SINCE, lastTick, deadTickIssue: 7 });
  });

  it("says why a Tick couldn't be read", () => {
    expect(tickHealthOf({ repo: "acme/shop", kind: "refused", error: "Not Found" })).toEqual({ kind: "unread", why: "Not Found" });
  });
});
