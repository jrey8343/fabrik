import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG, type KitConfig, resolveKitConfig } from "../kit/config.ts";
import { aKitCheckout, LOCKED_SHA } from "../__fixtures__/skillsArchive.ts";
import { checkPicksAtPins, kitConfigErrors, type ReadManifest } from "./pinnedManifests.ts";

const BASE = { repository: "mattpocock/skills", sha: "b".repeat(40) };
const OPERATOR_SHA = "1".repeat(40);

const manifestListing = (...skills: string[]) => JSON.stringify({ name: "skills", skills });

function configPicking(picks: Record<string, readonly string[]>): KitConfig {
  const roles = Object.fromEntries(Object.entries(picks).map(([role, skills]) => [role, { skills }]));
  const result = resolveKitConfig({
    config: JSON.stringify({ roles }),
    skillsLock: JSON.stringify([{ repository: "jrey8343/skills", sha: OPERATOR_SHA }]),
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config;
}

/** Serves each `repository@sha`'s manifest from `manifests`, recording every read. */
function serving(manifests: Record<string, string | null>): { read: ReadManifest; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async (repository, sha) => {
      reads.push(`${repository}@${sha}`);
      return manifests[`${repository}@${sha}`] ?? null;
    },
  };
}

const BASE_MANIFEST = manifestListing("skills/engineering/tdd", "skills/engineering/grilling");

describe("Checking a Product repo's picks against each source's manifest at its pin, in the Kit job", () => {
  it("reads no manifest when the Product pins no Skills source", async () => {
    const { read, reads } = serving({});

    const errors = await checkPicksAtPins(DEFAULT_KIT_CONFIG, { baseLock: BASE, kitSkills: [], readManifest: read });

    expect(errors).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("finds nothing wrong with picks each manifest lists at its pin", async () => {
    const { read, reads } = serving({
      [`mattpocock/skills@${BASE.sha}`]: BASE_MANIFEST,
      [`jrey8343/skills@${OPERATOR_SHA}`]: manifestListing("skills/modelling/event-storming"),
    });

    const errors = await checkPicksAtPins(configPicking({ design: ["jrey8343/skills/event-storming"] }), {
      baseLock: BASE,
      kitSkills: ["fabrik-pair"],
      readManifest: read,
    });

    expect(errors).toEqual([]);
    expect(reads.sort()).toEqual([`jrey8343/skills@${OPERATOR_SHA}`, `mattpocock/skills@${BASE.sha}`]);
  });

  it("reports a pick the source doesn't list, one named like a Base skill, and one named like a Kit skill", async () => {
    const { read } = serving({
      [`mattpocock/skills@${BASE.sha}`]: BASE_MANIFEST,
      [`jrey8343/skills@${OPERATOR_SHA}`]: manifestListing("skills/x/tdd", "skills/x/fabrik-pair"),
    });

    const errors = await checkPicksAtPins(
      configPicking({ design: ["jrey8343/skills/sagas"], implement: ["jrey8343/skills/tdd", "jrey8343/skills/fabrik-pair"] }),
      { baseLock: BASE, kitSkills: ["fabrik-pair"], readManifest: read },
    );

    expect(errors).toEqual([
      'roles.design.skills[0] is "jrey8343/skills/sagas": jrey8343/skills at 1111111 lists no skill named sagas in .claude-plugin/plugin.json',
      'roles.implement.skills[0] is "jrey8343/skills/tdd": tdd is a Base skill, and an Extra skill can\'t replace it',
      'roles.implement.skills[1] is "jrey8343/skills/fabrik-pair": fabrik-pair is a Kit skill, and an Extra skill can\'t replace it',
    ]);
  });

  it("reports a source with no manifest at its pin", async () => {
    const { read } = serving({ [`mattpocock/skills@${BASE.sha}`]: BASE_MANIFEST });

    const errors = await checkPicksAtPins(configPicking({ review: ["jrey8343/skills/event-storming"] }), {
      baseLock: BASE,
      kitSkills: [],
      readManifest: read,
    });

    expect(errors).toEqual([
      ".fabrik/skills.lock.json[0] pins jrey8343/skills at 1111111, which has no readable .claude-plugin/plugin.json listing its skills",
    ]);
  });

  it("reports a Base manifest it can't read, rather than skipping the Base-name check", async () => {
    const { read } = serving({ [`jrey8343/skills@${OPERATOR_SHA}`]: manifestListing("skills/modelling/event-storming") });

    const errors = await checkPicksAtPins(configPicking({ design: ["jrey8343/skills/event-storming"] }), {
      baseLock: BASE,
      kitSkills: [],
      readManifest: read,
    });

    expect(errors).toEqual([
      "Fabrik's skills.lock.json pins mattpocock/skills at bbbbbbb, whose plugin manifest couldn't be read",
    ]);
  });

  it("reports a manifest read that fails, rather than crashing", async () => {
    const read: ReadManifest = async (repository) => {
      if (repository === "jrey8343/skills") throw new Error("Reading the manifest failed: 503");
      return BASE_MANIFEST;
    };

    const errors = await checkPicksAtPins(configPicking({ design: ["jrey8343/skills/event-storming"] }), {
      baseLock: BASE,
      kitSkills: [],
      readManifest: read,
    });

    expect(errors).toEqual([
      ".fabrik/skills.lock.json[0] pins jrey8343/skills at 1111111, whose plugin manifest couldn't be read: Reading the manifest failed: 503",
    ]);
  });
});

describe("The Kit job's check before it routes any agent run", () => {
  it("passes on the Kit config's own errors without reading any manifest", async () => {
    const { read, reads } = serving({});

    const errors = await kitConfigErrors(
      { ok: false, errors: ["roles.design.model is \"best\": nope"] },
      { kitDir: "/no/such/kit", readManifest: read },
    );

    expect(errors).toEqual(['roles.design.model is "best": nope']);
    expect(reads).toEqual([]);
  });

  it("reads neither the Base lock nor any manifest when the Product pins no Skills source", async () => {
    const { read, reads } = serving({});

    const errors = await kitConfigErrors({ ok: true, config: DEFAULT_KIT_CONFIG }, { kitDir: "/no/such/kit", readManifest: read });

    expect(errors).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("checks the picks against the Base skills this Kit checkout pins and its own skills", async () => {
    const kitDir = await aKitCheckout(LOCKED_SHA, { "skills/fabrik-pair/SKILL.md": "# pair" });
    const { read, reads } = serving({
      [`mattpocock/skills@${LOCKED_SHA}`]: BASE_MANIFEST,
      [`jrey8343/skills@${OPERATOR_SHA}`]: manifestListing("skills/x/tdd", "skills/x/fabrik-pair"),
    });

    const errors = await kitConfigErrors(
      { ok: true, config: configPicking({ implement: ["jrey8343/skills/tdd", "jrey8343/skills/fabrik-pair"] }) },
      { kitDir, readManifest: read },
    );

    expect(errors).toEqual([
      'roles.implement.skills[0] is "jrey8343/skills/tdd": tdd is a Base skill, and an Extra skill can\'t replace it',
      'roles.implement.skills[1] is "jrey8343/skills/fabrik-pair": fabrik-pair is a Kit skill, and an Extra skill can\'t replace it',
    ]);
    expect(reads).toContain(`mattpocock/skills@${LOCKED_SHA}`);
  });
});
