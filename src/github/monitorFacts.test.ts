import { describe, expect, it } from "vitest";
import { RED_MAIN_GREEN_MARKER } from "../loop/markers.ts";
import { GitHubError } from "./client.ts";
import { closingNotePosted, gatherMonitorFacts } from "./monitorFacts.ts";

const REPO = { owner: "acme", name: "shop" };
const APP = "fabrik-app[bot]";

/** GitHub's answer when the token has no requests left until its rate limit resets. */
function rateLimited(request: string): GitHubError {
  return new GitHubError(`GitHub ${request} failed: 403 API rate limit exceeded`, 403, {
    body: '{"message":"API rate limit exceeded"}',
    rateLimitRemaining: "0",
    request,
  });
}

/** A read-only GitHub that answers each GET by the first route whose pattern its path matches. */
function gitHubAnswering(routes: readonly [RegExp, (path: string) => unknown][]) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      const route = routes.find(([pattern]) => pattern.test(path));
      if (route === undefined) throw new Error(`Unexpected call: ${path}`);
      return route[1](path);
    },
  };
}

describe("The Monitor's read of its issues", () => {
  it("says GitHub's rate limit stopped it, rather than failing the run, as the read of the default branch's checks does", async () => {
    const github = gitHubAnswering([
      [
        /\/issues\?labels=/,
        () => {
          throw rateLimited("GET /repos/acme/shop/issues");
        },
      ],
      [/\/commits\?/, () => []],
    ]);

    const facts = await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, listedChecks: [], namedMainChecks: [] });

    expect(facts).toEqual({ kind: "rate-limited", error: "GitHub GET /repos/acme/shop/issues failed: 403 API rate limit exceeded" });
  });

  it("fails the run on any other error", async () => {
    const github = gitHubAnswering([
      [
        /\/issues\?labels=/,
        () => {
          throw new GitHubError("GitHub GET /repos/acme/shop/issues failed: 500 oops", 500);
        },
      ],
    ]);

    await expect(gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: false, listedChecks: [], namedMainChecks: [] })).rejects.toThrow("500 oops");
  });

  it("gives the issues and the default branch's checks it read", async () => {
    const github = gitHubAnswering([
      [/\/issues\?labels=/, () => []],
      [/\/commits\?/, () => []],
    ]);

    expect(await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, listedChecks: [], namedMainChecks: [] })).toEqual({
      kind: "read",
      issues: [],
      mainChecks: { kind: "read", commits: [] },
    });
  });
});

describe("The Monitor's read of the Main checks", () => {
  const SHA = "9148e44a1b2c3d4e5f60718293a4b5c6d7e8f901";
  const commits = () => [{ sha: SHA, html_url: `https://github.com/acme/shop/commit/${SHA}` }];
  const run = (id: number, name: string) => ({
    id,
    name,
    status: "completed",
    conclusion: "failure",
    completed_at: "2026-11-06T07:00:00Z",
    html_url: `https://github.com/acme/shop/runs/${id}`,
  });

  it("asks for each Main check by name beside the Required checks sandbox.checks lists", async () => {
    const asked: string[] = [];
    const github = gitHubAnswering([
      [/\/issues\?labels=/, () => []],
      [/\/commits\?/, commits],
      [
        /\/check-runs\?check_name=/,
        (path) => {
          const name = decodeURIComponent(/check_name=([^&]+)/.exec(path)?.[1] ?? "");
          asked.push(name);
          return { check_runs: [run(asked.length, name)] };
        },
      ],
    ]);

    const facts = await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, listedChecks: ["gate"], namedMainChecks: ["image (clinic)"] });

    expect(asked).toEqual(["gate", "image (clinic)"]);
    expect(facts.kind === "read" && facts.mainChecks?.kind === "read" && facts.mainChecks.commits[0]?.checkRuns.map((each) => each.name)).toEqual([
      "gate",
      "image (clinic)",
    ]);
  });

  it("reads whether the Monitor itself closed each Main check's newest issue, as it does red main's", async () => {
    const issue = (number: number, check: string) => ({
      number,
      state: "closed",
      state_reason: "completed",
      closed_at: "2026-11-06T08:00:00Z",
      labels: [{ name: "fabrik:monitor" }],
      user: { login: APP },
      body: `<!-- fabrik:monitor main-check:${check} -->\nThe Main check is failing.`,
    });
    const byMonitor = [{ event: "commented", user: { login: APP }, body: `${RED_MAIN_GREEN_MARKER}\nGreen at …` }, { event: "closed", actor: { login: APP } }];
    const byOperator = [{ event: "closed", actor: { login: "operator" } }];
    const github = gitHubAnswering([
      [/\/issues\?labels=/, () => [issue(50, "deploy"), issue(51, "smoke-check")]],
      [/\/commits\?/, () => []],
      [/\/issues\/50\/timeline/, () => byMonitor],
      [/\/issues\/51\/timeline/, () => byOperator],
    ]);

    const facts = await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, listedChecks: [], namedMainChecks: ["deploy", "smoke-check"] });

    expect(facts.kind === "read" && facts.issues.map(({ number, closedByMonitor }) => ({ number, closedByMonitor }))).toEqual([
      { number: 50, closedByMonitor: true },
      { number: 51, closedByMonitor: false },
    ]);
  });
});

describe("Whether the Monitor's closing note is already on an issue", () => {
  // A note in the words of an earlier Kit: the Monitor finds its notes by their marker, not their prose.
  const note = `${RED_MAIN_GREEN_MARKER}\nGreen at \`bbbbbbb\`: its gating checks passed, so the default branch is no longer red and the Monitor closes this issue as completed.`;
  const timeline = (entries: unknown[]) => gitHubAnswering([[/\/issues\/9\/timeline\?/, () => entries]]);
  const comment = (login: string, body: string) => ({ event: "commented", user: { login }, body });

  it("is so when a tick posted it and then failed before the close, even for another green commit", async () => {
    const github = timeline([comment("operator", "Looking."), comment(APP, `${RED_MAIN_GREEN_MARKER}\nGreen at \`aaaaaaa\`: …`)]);

    expect(await closingNotePosted(github, REPO, 9, note, APP)).toBe(true);
  });

  it("isn't so when there's no such note", async () => {
    expect(await closingNotePosted(timeline([comment("operator", "Looking.")]), REPO, 9, note, APP)).toBe(false);
  });

  it("isn't so when the note came before the issue was last reopened", async () => {
    const github = timeline([
      comment(APP, `${RED_MAIN_GREEN_MARKER}\nGreen at \`aaaaaaa\`: …`),
      { event: "closed", actor: { login: APP } },
      { event: "reopened", actor: { login: "operator" } },
    ]);

    expect(await closingNotePosted(github, REPO, 9, note, APP)).toBe(false);
  });

  it("isn't so when someone else posted it", async () => {
    expect(await closingNotePosted(timeline([comment("operator", note)]), REPO, 9, note, APP)).toBe(false);
  });
});
