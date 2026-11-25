// The releasing guide cuts each release through the hold on `fabrik`'s tags
// (Spec #916, #937): it reads the hold before it uses it, pushes each tag
// with the release key through its host alias, and its one-time settings say
// what the hold is, with the commands that put it there (#866).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guide = readFileSync(new URL("../../docs/releasing.md", import.meta.url), "utf8");

/** The text under one `## ` heading, up to the next. */
const section = (heading: string) => {
  const start = guide.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`docs/releasing.md has no "## ${heading}"`);
  const end = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, end === -1 ? undefined : end);
};

/** "Cutting a release"'s numbered steps, each with the text indented under it. */
const cuttingSteps = () => {
  const steps = new Map<number, string>();
  let current: number | undefined;
  for (const line of section("Cutting a release").split("\n")) {
    const numbered = /^(\d+)\. /.exec(line);
    if (numbered) current = Number(numbered[1]);
    else if (line !== "" && !line.startsWith(" ")) current = undefined;
    if (current !== undefined) steps.set(current, `${steps.get(current) ?? ""}${line}\n`);
  }
  return steps;
};

const step = (n: number) => {
  const text = cuttingSteps().get(n);
  if (text === undefined) throw new Error(`"Cutting a release" has no step ${n}`);
  return text;
};

describe("The releasing guide cuts each release through the tag hold (#937)", () => {
  it("has step 1 read the two tag rulesets, the immutable releases setting and the count of deploy keys", () => {
    const first = step(1);

    expect(first).toContain("two tag rulesets, both `active`; `true`; `1`");
    expect(first).toContain(`gh api repos/jrey8343/fabrik/rulesets --jq '.[] | select(.target=="tag") | "\\(.name): \\(.enforcement)"'`);
    expect(first).toContain("gh api repos/jrey8343/fabrik/immutable-releases --jq .enabled");
    expect(first).toContain("gh api repos/jrey8343/fabrik/keys --jq length");
  });

  it("has step 3 push the tag with the release key, and no step push a tag to origin", () => {
    expect(step(3)).toContain("git push git@fabrik-release:jrey8343/fabrik.git v1.3.0\n");

    const pushes = [...cuttingSteps().values()].flatMap((text) => text.split("\n").filter((line) => /\bgit push\b/.test(line)));
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) expect(push).not.toMatch(/\bgit push\b(\s+-\S+)*\s+origin\b/);
  });

  it("has the one-time settings write both tag rulesets over every tag and switch immutable releases on", () => {
    const settings = section("One-time repository settings");
    type Ruleset = {
      target: string;
      enforcement: string;
      bypass_actors: { actor_type: string }[];
      conditions: { ref_name: { include: string[] } };
      rules: { type: string }[];
    };
    const rulesets = [...settings.matchAll(/gh api --method POST repos\/jrey8343\/fabrik\/rulesets --input - <<'EOF'\n([\s\S]*?)\n\s*EOF\n/g)].map(
      ([, body]) => JSON.parse(body ?? "") as Ruleset,
    );
    const ruleTypes = (ruleset: Ruleset) => ruleset.rules.map((rule) => rule.type).sort();

    expect(rulesets).toHaveLength(2);
    for (const ruleset of rulesets) {
      expect(ruleset.target).toBe("tag");
      expect(ruleset.enforcement).toBe("active");
      expect(ruleset.conditions.ref_name.include).toEqual(["~ALL"]);
    }
    const [noMove, creating] = [
      rulesets.find((ruleset) => ruleTypes(ruleset).includes("update")),
      rulesets.find((ruleset) => ruleTypes(ruleset).includes("creation")),
    ];
    expect(noMove && ruleTypes(noMove)).toEqual(["deletion", "update"]);
    expect(noMove?.bypass_actors).toEqual([]);
    expect(creating && ruleTypes(creating)).toEqual(["creation"]);
    expect(creating?.bypass_actors.map((actor) => actor.actor_type)).toEqual(["DeployKey"]);

    expect(settings).toContain("gh api --method PUT repos/jrey8343/fabrik/immutable-releases\n");
  });

  it("has the host alias the one-time settings write be the one step 3 pushes through", () => {
    const hosts = [...section("One-time repository settings").matchAll(/^\s*Host (\S+)$/gm)].map(([, host]) => host);
    const pushedThrough = [...step(3).matchAll(/git push git@([^:\s]+):jrey8343\/fabrik\.git /g)].map(([, host]) => host);

    expect(hosts).toEqual(["fabrik-release"]);
    expect(pushedThrough).toEqual(hosts);
  });
});
