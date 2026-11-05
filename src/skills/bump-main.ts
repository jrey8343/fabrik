// The weekly skills bump's step (.github/workflows/skills-bump.yml). Reads
// upstream main through the public GitHub API, asks planSkillsBump what to do,
// and when upstream has moved rewrites skills.lock.json and writes the PR body.
// It never touches git or opens the PR itself; the workflow does that.
//   node src/skills/bump-main.ts <out dir>
// Writes step outputs: bump ("true" or "false"), branch, title, body-file.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { planSkillsBump } from "./bump.ts";
import { readSkillsLock, SKILLS_LOCK_PATH } from "./lock.ts";
import { publicGet, readUpstreamSkills } from "./upstream.ts";

async function main(outDir: string): Promise<void> {
  const kitDir = resolve(import.meta.dirname, "..", "..");
  const lockPath = join(kitDir, SKILLS_LOCK_PATH);
  const lock = readSkillsLock(await readFile(lockPath, "utf8"));
  const plan = planSkillsBump(lock, await readUpstreamSkills(publicGet(process.env["GH_TOKEN"]), lock, "main"));

  const outputs: Record<string, string> = { bump: String(plan.kind === "pull-request") };
  if (plan.kind === "pull-request") {
    await mkdir(outDir, { recursive: true });
    const bodyFile = join(outDir, "body.md");
    await writeFile(lockPath, plan.lockText);
    await writeFile(bodyFile, plan.body);
    Object.assign(outputs, { branch: plan.branch, title: plan.title, "body-file": bodyFile });
    console.log(plan.title);
  } else {
    console.log(`Upstream main is still ${lock.sha}; nothing to bump.`);
  }

  const outputFile = process.env["GITHUB_OUTPUT"];
  if (outputFile !== undefined && outputFile !== "") {
    await appendFile(
      outputFile,
      Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  }
}

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error("Usage: node src/skills/bump-main.ts <out dir>");
  process.exit(2);
}
main(outDir).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
