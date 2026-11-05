import { describe, expect, it } from "vitest";
import { isSkillsBumpTick, planSkillsBump, planSourceBump, type UpstreamSkills } from "./bump.ts";
import type { SkillsSource } from "../kit/config.ts";
import type { SkillsLock } from "./lock.ts";

const OLD = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";
const NEW = "9f0c1e2d3b4a59687766554433221100ffeeddcc";
const lock: SkillsLock = { repository: "mattpocock/skills", sha: OLD };

const manifest = (...skills: string[]) =>
  JSON.stringify({ name: "mattpocock-skills", skills: skills.map((name) => `./skills/engineering/${name}`) });

const DIFF = [
  "diff --git a/skills/engineering/tdd/SKILL.md b/skills/engineering/tdd/SKILL.md",
  "--- a/skills/engineering/tdd/SKILL.md",
  "+++ b/skills/engineering/tdd/SKILL.md",
  "@@ -1 +1 @@",
  "-Red then green.",
  "+Red, then green.",
  "",
].join("\n");

function upstream(overrides: Partial<UpstreamSkills> = {}): UpstreamSkills {
  return {
    head: NEW,
    status: "ahead",
    aheadBy: 2,
    commits: [
      { sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "Tighten the tdd wording\n\nLonger body." },
      { sha: NEW, message: "Thanks @someone for #12" },
    ],
    diff: DIFF,
    manifestAtPin: manifest("tdd", "triage"),
    manifestAtHead: manifest("tdd", "triage"),
    ...overrides,
  };
}

function pullRequest(input: UpstreamSkills) {
  const plan = planSkillsBump(lock, input);
  if (plan.kind !== "pull-request") throw new Error(`expected a pull request, got ${plan.kind}`);
  return plan;
}

describe("the weekly skills bump", () => {
  it("opens no PR when upstream main is still the pinned commit", () => {
    expect(planSkillsBump(lock, upstream({ head: OLD, status: "identical", aheadBy: 0, commits: [], diff: "" }))).toEqual({
      kind: "up-to-date",
    });
  });

  it("opens no PR when the pin is already ahead of upstream main", () => {
    expect(planSkillsBump(lock, upstream({ status: "behind", aheadBy: 0, commits: [], diff: "" }))).toEqual({
      kind: "up-to-date",
    });
  });

  it("bumps the lockfile to upstream main's commit when upstream has moved", () => {
    const plan = pullRequest(upstream());

    expect(plan.lockText).toBe(
      '{\n  "repository": "mattpocock/skills",\n  "sha": "9f0c1e2d3b4a59687766554433221100ffeeddcc"\n}\n',
    );
    expect(plan.title).toBe("Bump Matt Pocock's skills to 9f0c1e2");
    expect(plan.branch).toBe("fabrik/skills-bump");
  });

  it("shows the compare link, the commits and the upstream diff in the PR body", () => {
    const { body } = pullRequest(upstream());

    expect(body).toContain("https://github.com/mattpocock/skills/compare/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d...9f0c1e2d3b4a59687766554433221100ffeeddcc");
    expect(body).toContain("```text\n1111111 Tighten the tdd wording\n9f0c1e2 Thanks @someone for #12\n```");
    expect(body).toContain("```diff\n" + DIFF + "```");
    expect(body).not.toContain("Longer body.");
  });

  it("fences a diff that itself holds a code fence with a longer fence", () => {
    const diff = "+```ts\n+const x = 1;\n+```\n";

    const { body } = pullRequest(upstream({ diff }));

    expect(body).toContain("````diff\n" + diff + "````");
  });

  it("cuts a diff too long for a PR body at a line and points to the compare link", () => {
    const line = "+" + "x".repeat(99);
    const diff = Array.from({ length: 2000 }, () => line).join("\n") + "\n";

    const { body } = pullRequest(upstream({ diff }));

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain(`${line}\n\`\`\`\n\nThe diff is cut short here; the compare link has all of it.`);
  });

  it("says how many commits the list leaves out when upstream returned only some", () => {
    const { body } = pullRequest(upstream({ aheadBy: 300 }));

    expect(body).toContain("…and 298 more commits.");
  });

  it("warns when upstream main no longer contains the pinned commit", () => {
    const { body } = pullRequest(upstream({ status: "diverged" }));

    expect(body).toContain("Upstream main no longer contains the pinned commit");
  });

  it("names the skills the bump adds and removes", () => {
    const { body } = pullRequest(upstream({ manifestAtHead: manifest("tdd", "wizard") }));

    expect(body).toContain("Skills added: `wizard`.");
    expect(body).toContain("Skills removed: `triage`.");
  });

  it("refuses to bump to a commit whose plugin manifest the Kit could not install", () => {
    expect(() =>
      planSkillsBump(lock, upstream({ manifestAtHead: JSON.stringify({ skills: ["../outside"] }) })),
    ).toThrow(/outside skills\//);
  });
});

describe("Fabrik's own skills bump, once the planner is shared", () => {
  it("keeps its PR title, branch, lockfile and body exactly as before", () => {
    const plan = pullRequest(upstream({ status: "diverged", aheadBy: 3, manifestAtHead: manifest("tdd", "wizard") }));

    expect(plan.branch).toBe("fabrik/skills-bump");
    expect(plan.title).toBe("Bump Matt Pocock's skills to 9f0c1e2");
    expect(plan.lockText).toMatchInlineSnapshot(`
      "{
        "repository": "mattpocock/skills",
        "sha": "9f0c1e2d3b4a59687766554433221100ffeeddcc"
      }
      "
    `);
    expect(plan.body).toMatchInlineSnapshot(`
      "Bumps Matt Pocock's skills (\`mattpocock/skills\`) from \`4ae2317\` to \`9f0c1e2\` in \`skills.lock.json\`.

      Compare on GitHub: https://github.com/mattpocock/skills/compare/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d...9f0c1e2d3b4a59687766554433221100ffeeddcc

      > [!WARNING]
      > Upstream main no longer contains the pinned commit, so its history was rewritten. The diff below runs from their merge base.

      Skills added: \`wizard\`.
      Skills removed: \`triage\`.

      ### Commits (3)

      \`\`\`text
      1111111 Tighten the tdd wording
      9f0c1e2 Thanks @someone for #12
      \`\`\`

      …and 1 more commits.

      ### Upstream diff
      \`\`\`diff
      diff --git a/skills/engineering/tdd/SKILL.md b/skills/engineering/tdd/SKILL.md
      --- a/skills/engineering/tdd/SKILL.md
      +++ b/skills/engineering/tdd/SKILL.md
      @@ -1 +1 @@
      -Red then green.
      +Red, then green.
      \`\`\`"
    `);
  });
});

const PIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ELSEWHERE = "cccccccccccccccccccccccccccccccccccccccc";
const source: SkillsSource = { repository: "jrey8343/skills", sha: PIN };
const picked = ["event-storming", "decider"];
const productLock = [
  "[",
  `  { "repository": "jrey8343/skills", "sha": "${PIN}" },`,
  `  { "repository": "someone/else", "sha": "${ELSEWHERE}" }`,
  "]",
  "",
].join("\n");

const sourceManifest = (...paths: string[]) => JSON.stringify({ name: "jrey8343-skills", skills: paths });
const SOURCE_MANIFEST = sourceManifest("./skills/modeling/event-storming", "./skills/modeling/decider", "./skills/misc/other");

const fileDiff = (from: string, to = from) =>
  [`diff --git a/${from} b/${to}`, `--- a/${from}`, `+++ b/${to}`, "@@ -1 +1 @@", `-old ${from}`, `+new ${to}`, ""].join("\n");

function sourceUpstream(overrides: Partial<UpstreamSkills> = {}): UpstreamSkills {
  return {
    head: HEAD,
    status: "ahead",
    aheadBy: 1,
    commits: [{ sha: HEAD, message: "Sharpen event storming, thanks @someone for #3" }],
    diff: fileDiff("skills/modeling/event-storming/SKILL.md") + fileDiff("skills/misc/other/SKILL.md"),
    manifestAtPin: SOURCE_MANIFEST,
    manifestAtHead: SOURCE_MANIFEST,
    ...overrides,
  };
}

const planSource = (input: UpstreamSkills) => planSourceBump(source, picked, input, productLock);

function sourcePullRequest(input: UpstreamSkills) {
  const plan = planSource(input);
  if (plan.kind !== "pull-request") throw new Error(`expected a pull request, got ${plan.kind}`);
  return plan;
}

describe("a Product repo's weekly bump of one Skills source", () => {
  it("opens no PR when the source's default branch is still the pinned commit", () => {
    expect(planSource(sourceUpstream({ head: PIN, status: "identical", aheadBy: 0, commits: [], diff: "" }))).toEqual({
      kind: "up-to-date",
    });
  });

  it("opens no PR when upstream moved but no picked skill's folder changed", () => {
    const diff = fileDiff("skills/misc/other/SKILL.md") + fileDiff("README.md") + fileDiff("skills/modeling/event-storming-extra/SKILL.md");

    expect(planSource(sourceUpstream({ diff }))).toEqual({ kind: "up-to-date" });
  });

  it("opens a PR on the source's own branch, titled for the source, when a picked skill changed", () => {
    const plan = sourcePullRequest(sourceUpstream());

    expect(plan.branch).toBe("fabrik/skills-bump/jrey8343-skills");
    expect(plan.title).toBe("Bump the jrey8343/skills Skills source to bbbbbbb");
  });

  it("changes only that source's SHA in the Product repo's lockfile", () => {
    const plan = sourcePullRequest(sourceUpstream());

    expect(plan.lockText).toBe(
      [
        "[",
        `  { "repository": "jrey8343/skills", "sha": "${HEAD}" },`,
        `  { "repository": "someone/else", "sha": "${ELSEWHERE}" }`,
        "]",
        "",
      ].join("\n"),
    );
  });

  it("shows the diff of the picked skills' folders only, including a picked folder that moved", () => {
    const moved =
      fileDiff("skills/modeling/decider/SKILL.md", "skills/events/decider/SKILL.md") +
      fileDiff("skills/events/decider/EXAMPLES.md");
    const diff = fileDiff("skills/modeling/event-storming/SKILL.md") + fileDiff("skills/misc/other/SKILL.md") + moved;

    const { body } = sourcePullRequest(
      sourceUpstream({
        diff,
        manifestAtHead: sourceManifest("./skills/modeling/event-storming", "./skills/events/decider", "./skills/misc/other"),
      }),
    );

    expect(body).toContain("```diff\n" + fileDiff("skills/modeling/event-storming/SKILL.md") + moved + "```");
    expect(body).not.toContain("+new skills/misc/other/SKILL.md");
  });

  it("lists the other changed upstream paths on one fenced line", () => {
    const diff = fileDiff("skills/modeling/event-storming/SKILL.md") + fileDiff("skills/misc/other/SKILL.md") + fileDiff("README.md");

    const { body } = sourcePullRequest(sourceUpstream({ diff }));

    expect(body).toContain("Other upstream changes, outside the picked skills:\n\n```text\nskills/misc/other/SKILL.md README.md\n```");
  });

  it("flags a picked skill the source's manifest no longer lists as breaking", () => {
    const diff = fileDiff("skills/misc/other/SKILL.md");

    const { body } = sourcePullRequest(
      sourceUpstream({ diff, manifestAtHead: sourceManifest("./skills/modeling/event-storming", "./skills/misc/other") }),
    );

    expect(body).toContain("> [!CAUTION]\n> Breaking: the source's plugin manifest at `bbbbbbb` no longer lists `decider`, which this repo picks.");
  });

  it.each([
    ["has no plugin manifest at head", null],
    ["has a plugin manifest at head it can't read", "{ not json"],
  ])("flags every picked skill as breaking when the source %s", (_, manifestAtHead) => {
    const { body } = sourcePullRequest(sourceUpstream({ diff: fileDiff("README.md"), manifestAtHead }));

    expect(body).toContain(
      "> [!CAUTION]\n> Breaking: the source's plugin manifest at `bbbbbbb` no longer lists `event-storming`, `decider`, which this repo picks.",
    );
  });

  it("keeps the PR body within GitHub's limit however many other upstream paths changed", () => {
    const others = Array.from({ length: 5000 }, (_, i) => fileDiff(`docs/refactor/a-fairly-long-folder-name/file-${i}.md`)).join("");
    const diff = fileDiff("skills/modeling/event-storming/SKILL.md") + others;

    const { body } = sourcePullRequest(sourceUpstream({ diff }));

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("docs/refactor/a-fairly-long-folder-name/file-0.md");
    expect(body).toMatch(/…and \d+ more paths; see the compare link\./);
    expect(body).toContain("+new skills/modeling/event-storming/SKILL.md");
  });

  it("names the source, its pin and head, and the compare link", () => {
    const { body } = sourcePullRequest(sourceUpstream());

    expect(body).toContain(
      "Bumps the `jrey8343/skills` Skills source from `aaaaaaa` to `bbbbbbb` in `.fabrik/skills.lock.json`.",
    );
    expect(body).toContain(`https://github.com/jrey8343/skills/compare/${PIN}...${HEAD}`);
  });

  it("warns when the source's default branch no longer contains the pinned commit", () => {
    const { body } = sourcePullRequest(sourceUpstream({ status: "diverged" }));

    expect(body).toContain("> [!WARNING]\n> The source's default branch no longer contains the pinned commit");
  });

  it("keeps upstream commit messages and the diff inside code fences", () => {
    const diff = fileDiff("skills/modeling/event-storming/SKILL.md") + "+```ts\n+thanks @someone, see #4\n+```\n";

    const { body } = sourcePullRequest(sourceUpstream({ diff }));

    expect(body).toContain("```text\nbbbbbbb Sharpen event storming, thanks @someone for #3\n```");
    expect(body).toContain("````diff\n" + diff + "````");
  });

  it("cuts a picked-skills diff too long for a PR body at a line", () => {
    const line = "+" + "x".repeat(99);
    const diff = fileDiff("skills/modeling/event-storming/SKILL.md") + Array.from({ length: 2000 }, () => line).join("\n") + "\n";

    const { body } = sourcePullRequest(sourceUpstream({ diff }));

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain(`${line}\n\`\`\`\n\nThe diff is cut short here; the compare link has all of it.`);
  });

  it("shows a diff it can't split into files whole, rather than calling the source up to date", () => {
    const diff = "# GitHub returned no diff (too big).\n# See the compare link.\n";

    const { body } = sourcePullRequest(sourceUpstream({ diff }));

    expect(body).toContain("### Upstream diff\n```diff\n" + diff + "```");
  });
});


describe("the weekly gate on a Product repo's skills bump", () => {
  it("acts on the Monday tick in the 04:00 UTC hour", () => {
    expect(isSkillsBumpTick(new Date("2026-11-09T04:00:00Z"))).toBe(true);
    expect(isSkillsBumpTick(new Date("2026-11-09T04:59:59Z"))).toBe(true);
  });

  it("lets every other tick pass, so a dropped Monday tick waits a week", () => {
    expect(isSkillsBumpTick(new Date("2026-11-09T03:59:59Z"))).toBe(false);
    expect(isSkillsBumpTick(new Date("2026-11-09T05:00:00Z"))).toBe(false);
    expect(isSkillsBumpTick(new Date("2026-11-10T04:15:00Z"))).toBe(false);
    // 04:30 on Monday in Sydney is still Sunday in UTC.
    expect(isSkillsBumpTick(new Date("2026-11-09T04:30:00+11:00"))).toBe(false);
  });
});
