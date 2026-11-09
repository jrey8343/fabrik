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

    const facts = await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, gatingChecks: [] });

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

    await expect(gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: false, gatingChecks: [] })).rejects.toThrow("500 oops");
  });

  it("gives the issues and the default branch's checks it read", async () => {
    const github = gitHubAnswering([
      [/\/issues\?labels=/, () => []],
      [/\/commits\?/, () => []],
    ]);

    expect(await gatherMonitorFacts(github, REPO, { appLogin: APP, redMain: true, gatingChecks: [] })).toEqual({
      kind: "read",
      issues: [],
      mainChecks: { kind: "read", commits: [] },
    });
  });
});

describe("Whether the Monitor's closing note is already on an issue", () => {
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
