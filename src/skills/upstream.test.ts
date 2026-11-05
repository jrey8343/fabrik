import { describe, expect, it } from "vitest";
import { type ApiGet, GitHubGetError, readUpstreamSkills } from "./upstream.ts";

const PIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const MANIFEST = JSON.stringify({ skills: ["skills/modeling/event-storming"] });

/** A fake API serving these paths, and a 404 for any other. */
function serving(responses: Record<string, string>): ApiGet {
  return async (path) => {
    const text = responses[path];
    if (text === undefined) throw new GitHubGetError(`GitHub GET ${path} failed: 404 Not Found`, 404);
    return new Response(text);
  };
}

const repo = "/repos/jrey8343/skills";
const upstreamAt = (extra: Record<string, string>) =>
  serving({
    [`${repo}/commits/main`]: HEAD,
    [`${repo}/compare/${PIN}...${HEAD}`]: JSON.stringify({ status: "ahead", ahead_by: 0, commits: [] }),
    [`${repo}/contents/.claude-plugin/plugin.json?ref=${PIN}`]: MANIFEST,
    ...extra,
  });

describe("reading a Skills source upstream", () => {
  it("reads a head with no plugin manifest as none, rather than failing", async () => {
    const upstream = await readUpstreamSkills(upstreamAt({}), { repository: "jrey8343/skills", sha: PIN }, "main");

    expect(upstream.manifestAtPin).toBe(MANIFEST);
    expect(upstream.manifestAtHead).toBeNull();
  });

  it("still fails on any other error reading the head manifest", async () => {
    const get: ApiGet = async (path, accept) => {
      if (path.endsWith(`?ref=${HEAD}`)) throw new GitHubGetError(`GitHub GET ${path} failed: 500`, 500);
      return upstreamAt({})(path, accept);
    };

    await expect(readUpstreamSkills(get, { repository: "jrey8343/skills", sha: PIN }, "main")).rejects.toThrow(/500/);
  });
});
