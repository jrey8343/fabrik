import { describe, expect, it } from "vitest";
import { readSkillsLock, skillFolders } from "./lock.ts";

describe("the skills lockfile", () => {
  it("pins Matt Pocock's skills at a full commit SHA", () => {
    const lock = readSkillsLock(
      JSON.stringify({ repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" }),
    );

    expect(lock).toEqual({ repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" });
  });

  it.each(["main", "v1.3.2", "4ae2317"])("refuses %s, which is not a commit SHA", (sha) => {
    expect(() => readSkillsLock(JSON.stringify({ repository: "mattpocock/skills", sha }))).toThrow(
      /40-character commit SHA/,
    );
  });
});

describe("the skill folders the Kit installs", () => {
  it("flattens each skill the plugin manifest promotes into .claude/skills/<name>", () => {
    const manifest = JSON.stringify({
      name: "mattpocock-skills",
      skills: ["./skills/engineering/tdd", "./skills/productivity/grilling", "skills/engineering/triage/"],
    });

    expect(skillFolders(manifest)).toEqual([
      { from: "skills/engineering/tdd", name: "tdd" },
      { from: "skills/productivity/grilling", name: "grilling" },
      { from: "skills/engineering/triage", name: "triage" },
    ]);
  });

  it.each(["../outside", "/etc/passwd", "./skills/../../x", "./skills/engineering/.."])(
    "refuses a manifest path, %s, that leaves the skills folder",
    (path) => {
      expect(() => skillFolders(JSON.stringify({ skills: [path] }))).toThrow(/outside skills\//);
    },
  );

  it("refuses two skills that would land in the same folder", () => {
    const manifest = JSON.stringify({ skills: ["./skills/engineering/tdd", "./skills/misc/tdd"] });

    expect(() => skillFolders(manifest)).toThrow(/tdd/);
  });
});
