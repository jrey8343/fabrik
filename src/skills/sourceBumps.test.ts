import { describe, expect, it } from "vitest";
import type { SkillsSource } from "../kit/config.ts";
import type { UpstreamSkills } from "./bump.ts";
import { pushSourceBumps } from "./sourceBumps.ts";

const repo = { owner: "acme", name: "shop" };
const LOCK = ".fabrik/skills.lock.json";
const CONFIG = ".fabrik/config.json";

const PIN = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const LATER = "3333333333333333333333333333333333333333";
const OTHER_PIN = "4444444444444444444444444444444444444444";
const OTHER_HEAD = "5555555555555555555555555555555555555555";

const lockText = (...pins: [string, string][]) =>
  `${JSON.stringify(
    pins.map(([repository, sha]) => ({ repository, sha })),
    null,
    2,
  )}\n`;

const config = JSON.stringify({
  roles: {
    design: { skills: ["jrey8343/skills/event-storming"] },
    implement: { skills: ["someone/kit/deciders"] },
  },
});

const manifest = (...skills: string[]) => JSON.stringify({ name: "skills", skills: skills.map((name) => `./skills/${name}`) });

const diffOf = (skill: string) =>
  [
    `diff --git a/skills/${skill}/SKILL.md b/skills/${skill}/SKILL.md`,
    `--- a/skills/${skill}/SKILL.md`,
    `+++ b/skills/${skill}/SKILL.md`,
    "@@ -1 +1 @@",
    "-Old.",
    "+New.",
    "",
  ].join("\n");

/** An upstream source that has moved from `pin` to `head`, changing `skill`'s folder. */
function moved(pin: string, head: string, skill: string): UpstreamSkills {
  return {
    head,
    status: "ahead",
    aheadBy: 1,
    commits: [{ sha: head, message: `Change ${skill}` }],
    diff: diffOf(skill),
    manifestAtPin: manifest("event-storming", "deciders"),
    manifestAtHead: manifest("event-storming", "deciders"),
  };
}

function upToDate(pin: string): UpstreamSkills {
  return { ...moved(pin, pin, "event-storming"), status: "identical", aheadBy: 0, commits: [], diff: "" };
}

interface PullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
}

/**
 * A Product repo on GitHub, as far as the bump reads and writes it: commits
 * holding files, branches pointing at them, and PRs. Writes go through the
 * git data API, as the runner makes them.
 */
class FakeProduct {
  readonly commits = new Map<string, { files: Record<string, string>; parents: string[]; message: string }>();
  readonly trees = new Map<string, Record<string, string>>();
  readonly branches = new Map<string, string>();
  readonly pulls: PullRequest[] = [];
  readonly writes: string[] = [];
  #next = 0;

  constructor(files: Record<string, string>) {
    this.branches.set("main", this.commit(files, [], "Initial"));
  }

  commit(files: Record<string, string>, parents: string[], message: string): string {
    const sha = `c${++this.#next}`;
    this.commits.set(sha, { files, parents, message });
    return sha;
  }

  /** Commits `files` on top of `branch`, as a merge or a push would. */
  push(branch: string, files: Record<string, string>): void {
    const parent = this.branches.get(branch) ?? this.branches.get("main")!;
    this.branches.set(branch, this.commit({ ...this.filesAt(parent), ...files }, [parent], "Push"));
  }

  filesAt(ref: string): Record<string, string> {
    const sha = this.branches.get(ref) ?? ref;
    const commit = this.commits.get(sha);
    if (commit === undefined) throw new Error(`No commit ${ref}`);
    return commit.files;
  }

  async fileText(_repo: unknown, path: string, ref: string): Promise<string | null> {
    if (!this.branches.has(ref) && !this.commits.has(ref)) return null;
    return this.filesAt(ref)[path] ?? null;
  }

  async rest(method: string, path: string, body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
    const base = "/repos/acme/shop";
    const input = body as Record<string, unknown>;
    if (method !== "GET") this.writes.push(`${method} ${path.slice(base.length)}`);
    if (method === "GET" && path === base) return { default_branch: "main" };
    let match = /^\/repos\/acme\/shop\/git\/ref\/heads\/(.+)$/.exec(path);
    if (method === "GET" && match !== null) {
      const sha = this.branches.get(match[1]!);
      if (sha === undefined) {
        if (options.allowNotFound === true) return null;
        throw new Error("GitHub GET failed: 404");
      }
      return { object: { sha } };
    }
    match = /^\/repos\/acme\/shop\/git\/commits\/(\w+)$/.exec(path);
    if (method === "GET" && match !== null) {
      const sha = match[1]!;
      this.trees.set(`t-${sha}`, this.filesAt(sha));
      return { sha, tree: { sha: `t-${sha}` } };
    }
    if (method === "POST" && path === `${base}/git/trees`) {
      const files = { ...this.trees.get(input["base_tree"] as string) };
      for (const entry of input["tree"] as { path: string; content: string; mode: string; type: string }[]) {
        expect(entry).toMatchObject({ mode: "100644", type: "blob" });
        files[entry.path] = entry.content;
      }
      const sha = `t${this.trees.size + 1}`;
      this.trees.set(sha, files);
      return { sha };
    }
    if (method === "POST" && path === `${base}/git/commits`) {
      const files = this.trees.get(input["tree"] as string)!;
      return { sha: this.commit(files, input["parents"] as string[], input["message"] as string) };
    }
    if (method === "POST" && path === `${base}/git/refs`) {
      const name = (input["ref"] as string).replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) throw new Error("GitHub POST failed: 422 Reference already exists");
      this.branches.set(name, input["sha"] as string);
      return {};
    }
    match = /^\/repos\/acme\/shop\/git\/refs\/heads\/(.+)$/.exec(path);
    if (method === "PATCH" && match !== null) {
      expect(input["force"]).toBe(true);
      this.branches.set(match[1]!, input["sha"] as string);
      return {};
    }
    match = /^\/repos\/acme\/shop\/pulls\?head=([^&]+)&base=main&state=open$/.exec(path);
    if (method === "GET" && match !== null) {
      const head = decodeURIComponent(match[1]!).replace(/^acme:/, "");
      return this.pulls.filter((pull) => pull.head === head && pull.state === "open");
    }
    if (method === "POST" && path === `${base}/pulls`) {
      const pull: PullRequest = {
        number: 100 + this.pulls.length,
        head: input["head"] as string,
        base: input["base"] as string,
        title: input["title"] as string,
        body: input["body"] as string,
        state: "open",
      };
      this.pulls.push(pull);
      return { number: pull.number };
    }
    match = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(path);
    if (method === "PATCH" && match !== null) {
      Object.assign(this.pulls.find((pull) => pull.number === Number(match![1]))!, input);
      return {};
    }
    throw new Error(`Unexpected call: ${method} ${path}`);
  }
}

/** Upstream as each source's default branch has it now; counts every call. */
function upstreamOf(sources: Record<string, UpstreamSkills | Error>) {
  const calls: string[] = [];
  return {
    calls,
    read: async (source: SkillsSource): Promise<UpstreamSkills> => {
      calls.push(source.repository);
      const upstream = sources[source.repository];
      if (upstream === undefined) throw new Error(`No upstream for ${source.repository}`);
      if (upstream instanceof Error) throw upstream;
      return upstream;
    },
  };
}

const BRANCH = "fabrik/skills-bump/jrey8343-skills";
const OTHER_BRANCH = "fabrik/skills-bump/someone-kit";

function product(): FakeProduct {
  return new FakeProduct({
    [CONFIG]: config,
    [LOCK]: lockText(["jrey8343/skills", PIN], ["someone/kit", OTHER_PIN]),
    "src/app.ts": "export {};\n",
  });
}

const run = (github: FakeProduct, upstream: ReturnType<typeof upstreamOf>) =>
  pushSourceBumps(github, repo, upstream.read);

describe("pushing a Product repo's weekly skills bumps", () => {
  it("makes no upstream calls and writes nothing in a repo with no Skills sources lockfile", async () => {
    const github = new FakeProduct({ [CONFIG]: "{}" });
    const upstream = upstreamOf({});

    expect(await run(github, upstream)).toEqual({ ok: true, sources: [] });
    expect(upstream.calls).toEqual([]);
    expect(github.writes).toEqual([]);
  });

  it("opens nothing for a source whose upstream hasn't moved", async () => {
    const github = product();
    const upstream = upstreamOf({ "jrey8343/skills": upToDate(PIN), "someone/kit": upToDate(OTHER_PIN) });

    const result = await run(github, upstream);

    expect(result).toEqual({
      ok: true,
      sources: [
        { repository: "jrey8343/skills", outcome: "up-to-date" },
        { repository: "someone/kit", outcome: "up-to-date" },
      ],
    });
    expect(github.writes).toEqual([]);
  });

  it("opens a PR whose one commit, on the default branch head, changes only that source's SHA", async () => {
    const github = product();
    const upstream = upstreamOf({ "jrey8343/skills": moved(PIN, HEAD, "event-storming"), "someone/kit": upToDate(OTHER_PIN) });
    const main = github.branches.get("main")!;

    const result = await run(github, upstream);

    expect(result).toEqual({
      ok: true,
      sources: [
        { repository: "jrey8343/skills", outcome: "opened", pullRequest: 100 },
        { repository: "someone/kit", outcome: "up-to-date" },
      ],
    });
    const tip = github.commits.get(github.branches.get(BRANCH)!)!;
    expect(tip.parents).toEqual([main]);
    expect(tip.message).toBe("Bump the jrey8343/skills Skills source to 2222222");
    expect(tip.files).toEqual({
      ...github.filesAt("main"),
      [LOCK]: lockText(["jrey8343/skills", HEAD], ["someone/kit", OTHER_PIN]),
    });
    expect(github.pulls).toEqual([
      expect.objectContaining({ head: BRANCH, base: "main", title: "Bump the jrey8343/skills Skills source to 2222222", state: "open" }),
    ]);
    expect(github.pulls[0]!.body).toContain("### Diff of the picked skills");
  });

  it("leaves the open PR, its branch and its review untouched in a week the source hasn't moved since", async () => {
    const github = product();
    const upstream = upstreamOf({ "jrey8343/skills": moved(PIN, HEAD, "event-storming"), "someone/kit": upToDate(OTHER_PIN) });
    await run(github, upstream);
    const branchBefore = github.branches.get(BRANCH);
    github.writes.length = 0;

    const result = await run(github, upstream);

    expect(result.ok && result.sources[0]).toEqual({ repository: "jrey8343/skills", outcome: "unchanged", pullRequest: 100 });
    expect(github.branches.get(BRANCH)).toBe(branchBefore);
    expect(github.writes).toEqual([]);
  });

  it("refreshes the open PR onto the default branch head when upstream moves again", async () => {
    const github = product();
    await run(github, upstreamOf({ "jrey8343/skills": moved(PIN, HEAD, "event-storming"), "someone/kit": upToDate(OTHER_PIN) }));

    const result = await run(
      github,
      upstreamOf({ "jrey8343/skills": moved(PIN, LATER, "event-storming"), "someone/kit": upToDate(OTHER_PIN) }),
    );

    expect(result.ok && result.sources[0]).toEqual({ repository: "jrey8343/skills", outcome: "refreshed", pullRequest: 100 });
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]!.title).toBe("Bump the jrey8343/skills Skills source to 3333333");
    const tip = github.commits.get(github.branches.get(BRANCH)!)!;
    expect(tip.parents).toEqual([github.branches.get("main")]);
    expect(tip.files[LOCK]).toBe(lockText(["jrey8343/skills", LATER], ["someone/kit", OTHER_PIN]));
  });

  it("rebuilds a PR left behind by another source's merged bump on the default branch head", async () => {
    const github = product();
    const both = upstreamOf({
      "jrey8343/skills": moved(PIN, HEAD, "event-storming"),
      "someone/kit": moved(OTHER_PIN, OTHER_HEAD, "deciders"),
    });
    await run(github, both);
    // The Operator merges someone/kit's bump.
    github.push("main", { [LOCK]: github.filesAt(OTHER_BRANCH)[LOCK]! });
    github.pulls.find((pull) => pull.head === OTHER_BRANCH)!.state = "closed";

    const result = await run(
      github,
      upstreamOf({ "jrey8343/skills": moved(PIN, HEAD, "event-storming"), "someone/kit": upToDate(OTHER_HEAD) }),
    );

    expect(result).toEqual({
      ok: true,
      sources: [
        { repository: "jrey8343/skills", outcome: "refreshed", pullRequest: 100 },
        { repository: "someone/kit", outcome: "up-to-date" },
      ],
    });
    const tip = github.commits.get(github.branches.get(BRANCH)!)!;
    expect(tip.parents).toEqual([github.branches.get("main")]);
    expect(tip.files[LOCK]).toBe(lockText(["jrey8343/skills", HEAD], ["someone/kit", OTHER_HEAD]));
  });

  it("opens nothing again for a bump PR the Operator closed unmerged, until upstream moves", async () => {
    const github = product();
    const same = upstreamOf({ "jrey8343/skills": moved(PIN, HEAD, "event-storming"), "someone/kit": upToDate(OTHER_PIN) });
    await run(github, same);
    github.pulls[0]!.state = "closed";
    github.writes.length = 0;

    const closed = await run(github, same);

    expect(closed.ok && closed.sources[0]).toEqual({ repository: "jrey8343/skills", outcome: "closed-unmerged" });
    expect(github.writes).toEqual([]);

    const later = await run(
      github,
      upstreamOf({ "jrey8343/skills": moved(PIN, LATER, "event-storming"), "someone/kit": upToDate(OTHER_PIN) }),
    );

    expect(later.ok && later.sources[0]).toEqual({ repository: "jrey8343/skills", outcome: "opened", pullRequest: 101 });
  });

  it("reports a source that fails and still bumps the others", async () => {
    const github = product();
    const upstream = upstreamOf({
      "jrey8343/skills": new Error("GitHub GET /repos/jrey8343/skills failed: 404"),
      "someone/kit": moved(OTHER_PIN, OTHER_HEAD, "deciders"),
    });

    const result = await run(github, upstream);

    expect(result).toEqual({
      ok: true,
      sources: [
        { repository: "jrey8343/skills", outcome: "failed", error: "GitHub GET /repos/jrey8343/skills failed: 404" },
        { repository: "someone/kit", outcome: "opened", pullRequest: 100 },
      ],
    });
    expect(github.branches.has(BRANCH)).toBe(false);
    expect(github.filesAt(OTHER_BRANCH)[LOCK]).toBe(lockText(["jrey8343/skills", PIN], ["someone/kit", OTHER_HEAD]));
  });

  it("reports an invalid Kit config and makes no upstream calls", async () => {
    const github = new FakeProduct({ [CONFIG]: config, [LOCK]: lockText(["jrey8343/skills", PIN]) });
    const upstream = upstreamOf({});

    const result = await run(github, upstream);

    expect(result.ok).toBe(false);
    expect(upstream.calls).toEqual([]);
    expect(github.writes).toEqual([]);
  });
});
