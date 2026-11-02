import { describe, expect, it } from "vitest";
import { planSkillsBump, type UpstreamSkills } from "./bump.ts";
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
