import { describe, expect, it } from "vitest";
import { type KitConfig, resolveKitConfig } from "../kit/config.ts";
import { checkExtraSkills } from "./extra.ts";

const OPERATOR_SHA = "1111111111111111111111111111111111111111";

function configPicking(picks: Record<string, readonly string[]>): KitConfig {
  const roles = Object.fromEntries(Object.entries(picks).map(([role, skills]) => [role, { skills }]));
  const result = resolveKitConfig({
    config: JSON.stringify({ roles }),
    skillsLock: JSON.stringify([{ repository: "jrey8343/skills", sha: OPERATOR_SHA }]),
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config;
}

const manifestListing = (...skills: string[]) => JSON.stringify({ name: "jrey8343-skills", skills });

const OPERATOR_MANIFEST = manifestListing("skills/modelling/event-storming", "skills/modelling/deciders");

describe("Checking Extra skill picks against their sources' manifests", () => {
  it("finds nothing wrong with picks each source's manifest lists under a name no Base or Kit skill has", () => {
    const config = configPicking({ design: ["jrey8343/skills/event-storming"], implement: ["jrey8343/skills/deciders"] });

    expect(
      checkExtraSkills({
        config,
        manifests: new Map([["jrey8343/skills", OPERATOR_MANIFEST]]),
        baseSkills: ["tdd", "grilling"],
        kitSkills: ["fabrik-pair"],
      }),
    ).toEqual([]);
  });

  it("reports a pick the source's manifest doesn't list at the pinned SHA", () => {
    const config = configPicking({ design: ["jrey8343/skills/event-storming", "jrey8343/skills/sagas"] });

    expect(
      checkExtraSkills({
        config,
        manifests: new Map([["jrey8343/skills", OPERATOR_MANIFEST]]),
        baseSkills: [],
        kitSkills: [],
      }),
    ).toEqual([
      'roles.design.skills[1] is "jrey8343/skills/sagas": jrey8343/skills at 1111111 lists no skill named sagas in .claude-plugin/plugin.json',
    ]);
  });

  it("reports a source with no readable manifest once, naming its pin", () => {
    const config = configPicking({ design: ["jrey8343/skills/event-storming"], review: ["jrey8343/skills/deciders"] });

    for (const manifest of [null, "not json", JSON.stringify({ name: "no list" })]) {
      expect(
        checkExtraSkills({ config, manifests: new Map([["jrey8343/skills", manifest]]), baseSkills: [], kitSkills: [] }),
      ).toEqual([
        ".fabrik/skills.lock.json[0] pins jrey8343/skills at 1111111, which has no readable .claude-plugin/plugin.json listing its skills",
      ]);
    }
  });

  it("reports a pick named like a Base skill, since an Extra skill never overrides one", () => {
    const config = configPicking({ implement: ["jrey8343/skills/tdd"] });

    expect(
      checkExtraSkills({
        config,
        manifests: new Map([["jrey8343/skills", manifestListing("skills/engineering/tdd")]]),
        baseSkills: ["tdd"],
        kitSkills: [],
      }),
    ).toEqual(['roles.implement.skills[0] is "jrey8343/skills/tdd": tdd is a Base skill, and an Extra skill can\'t replace it']);
  });

  it("reports a pick named like a Kit skill, since an Extra skill never overrides one", () => {
    const config = configPicking({ review: ["jrey8343/skills/fabrik-pair"] });

    expect(
      checkExtraSkills({
        config,
        manifests: new Map([["jrey8343/skills", manifestListing("skills/fabrik-pair")]]),
        baseSkills: [],
        kitSkills: ["fabrik-pair"],
      }),
    ).toEqual([
      'roles.review.skills[0] is "jrey8343/skills/fabrik-pair": fabrik-pair is a Kit skill, and an Extra skill can\'t replace it',
    ]);
  });

  it("checks only the roles it's asked about, and only the sources whose manifests it's given", () => {
    const config = configPicking({ design: ["jrey8343/skills/sagas"], implement: ["jrey8343/skills/tdd"] });

    expect(
      checkExtraSkills({ config, roles: ["design"], manifests: new Map(), baseSkills: ["tdd"], kitSkills: [] }),
    ).toEqual([]);
  });
});
