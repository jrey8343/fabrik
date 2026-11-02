// The weekly skills bump's step (.github/workflows/skills-bump.yml). Reads
// upstream main through the public GitHub API, asks planSkillsBump what to do,
// and when upstream has moved rewrites skills.lock.json and writes the PR body.
// It never touches git or opens the PR itself; the workflow does that.
//   node src/skills/bump-main.ts <out dir>
// Writes step outputs: bump ("true" or "false"), branch, title, body-file.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { planSkillsBump, type UpstreamSkills } from "./bump.ts";
import { readSkillsLock, SKILLS_LOCK_PATH, type SkillsLock } from "./lock.ts";

const API = "https://api.github.com";
const MANIFEST = ".claude-plugin/plugin.json";

function headers(accept: string): Record<string, string> {
  const token = process.env["GH_TOKEN"];
  return {
    accept,
    "x-github-api-version": "2022-11-28",
    ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const response = await fetch(`${API}${path}`, { headers: headers(accept) });
  if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${response.status} ${await response.text()}`);
  return response;
}

async function upstreamSkills(lock: SkillsLock): Promise<UpstreamSkills> {
  const repo = `/repos/${lock.repository}`;
  const head = (await (await get(`${repo}/commits/main`, "application/vnd.github.sha")).text()).trim();
  const compare = (await (await get(`${repo}/compare/${lock.sha}...${head}`)).json()) as {
    status: UpstreamSkills["status"];
    ahead_by: number;
    commits: { sha: string; commit: { message: string } }[];
  };
  const manifest = async (sha: string) =>
    (await get(`${repo}/contents/${MANIFEST}?ref=${sha}`, "application/vnd.github.raw+json")).text();

  // GitHub refuses a diff past its size limits; the compare link still works then.
  let diff: string;
  try {
    diff = await (await get(`${repo}/compare/${lock.sha}...${head}`, "application/vnd.github.diff")).text();
  } catch (error) {
    diff = `# GitHub returned no diff (${error instanceof Error ? error.message.split("\n")[0] : error}).\n# See the compare link.\n`;
  }

  return {
    head,
    status: compare.status,
    aheadBy: compare.ahead_by,
    commits: compare.commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    diff,
    manifestAtPin: await manifest(lock.sha),
    manifestAtHead: await manifest(head),
  };
}

async function main(outDir: string): Promise<void> {
  const kitDir = resolve(import.meta.dirname, "..", "..");
  const lockPath = join(kitDir, SKILLS_LOCK_PATH);
  const lock = readSkillsLock(await readFile(lockPath, "utf8"));
  const plan = planSkillsBump(lock, await upstreamSkills(lock));

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
