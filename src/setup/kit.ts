// What the setup skill installs, read from a Fabrik checkout at the release
// being set up: the caller workflow, the stable shims and the starters.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SetupKit {
  /** The exact Fabrik release the caller workflow will pin, such as v1.2.3. */
  readonly release: string;
  readonly templates: {
    /** templates/fabrik.yml, pinned at whatever release it was last cut with. */
    readonly caller: string;
    /** templates/claude-settings.json: the SessionStart hook entry and the plugin switch. */
    readonly claudeSettings: string;
    readonly dependabot: string;
    readonly kitConfig: string;
    readonly agentSkills: string;
    readonly docsAgents: Readonly<Record<string, string>>;
  };
}

const DOCS_AGENTS = ["issue-tracker.md", "triage-labels.md", "domain.md"];

export async function loadSetupKit(kitDir: string, release: string): Promise<SetupKit> {
  const template = (path: string) => readFile(join(kitDir, "templates", path), "utf8");
  const docs = await Promise.all(DOCS_AGENTS.map(async (name) => [name, await template(`docs-agents/${name}`)] as const));
  return {
    release,
    templates: {
      caller: await template("fabrik.yml"),
      claudeSettings: await template("claude-settings.json"),
      dependabot: await template("dependabot.yml"),
      kitConfig: await template("fabrik-config.json"),
      agentSkills: await template("agent-skills.md"),
      docsAgents: Object.fromEntries(docs),
    },
  };
}
