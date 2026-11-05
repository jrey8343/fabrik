// The manifest check on a Product repo's Extra skill picks (#144): the checks
// that need each Skills source's plugin manifest at its pin, beyond the ones
// Kit config resolution makes from the Product's two files alone. The Kit job
// runs it before routing any agent run, and the skills fetch runs it again as a
// backstop. Pure, no I/O.
import { type KitConfig, type Phase, PHASES, picksIn, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { foldersIn, PLUGIN_MANIFEST_PATH, type SkillFolder, shortSha } from "./lock.ts";

export interface ExtraSkillsCheckInput {
  /** The resolved Kit config, its pins and picks already consistent with each other. */
  readonly config: KitConfig;
  /**
   * Each source's `.claude-plugin/plugin.json` text at its pin, keyed by
   * repository; null when it has none. A source left out isn't checked
   * against its manifest.
   */
  readonly manifests: ReadonlyMap<string, string | null>;
  /** The names the Base skills install as, from the Base manifest at the Base pin. */
  readonly baseSkills: readonly string[];
  /** The names the Kit's own skills install as. */
  readonly kitSkills: readonly string[];
  /** The roles whose picks to check; every pickable role unless named. */
  readonly roles?: readonly Phase[];
}

/** What's wrong with the picks, given the sources' manifests; empty when nothing is. */
export function checkExtraSkills({
  config,
  manifests,
  baseSkills,
  kitSkills,
  roles = PHASES,
}: ExtraSkillsCheckInput): readonly string[] {
  const errors: string[] = [];
  const listed = new Map<string, readonly SkillFolder[] | null>();
  const pickedFrom = new Set(picksIn(config, roles).map((pick) => pick.source));
  config.skillsSources.forEach((source, i) => {
    if (!pickedFrom.has(source.repository) || !manifests.has(source.repository)) return;
    const folders = foldersIn(manifests.get(source.repository) ?? null);
    listed.set(source.repository, folders);
    if (folders === null) {
      errors.push(
        `${SKILLS_SOURCES_LOCK_PATH}[${i}] pins ${source.repository} at ${shortSha(source.sha)}, which has no readable ${PLUGIN_MANIFEST_PATH} listing its skills`,
      );
    }
  });
  const shaOf = new Map(config.skillsSources.map((source) => [source.repository, source.sha]));
  for (const role of roles) {
    config.extraSkills[role].forEach(({ source, name }, i) => {
      const fail = (reason: string) => errors.push(`roles.${role}.skills[${i}] is ${JSON.stringify(`${source}/${name}`)}: ${reason}`);
      if (baseSkills.includes(name)) return fail(`${name} is a Base skill, and an Extra skill can't replace it`);
      if (kitSkills.includes(name)) return fail(`${name} is a Kit skill, and an Extra skill can't replace it`);
      const folders = listed.get(source);
      if (folders && !folders.some((folder) => folder.name === name)) {
        fail(`${source} at ${shortSha(shaOf.get(source) ?? "")} lists no skill named ${name} in ${PLUGIN_MANIFEST_PATH}`);
      }
    });
  }
  return errors;
}
