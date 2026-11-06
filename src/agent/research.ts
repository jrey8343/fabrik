// A Researcher run's own context and branch (#154): after the research
// Decision's issue, its Map, as the agent-inputs step read the issue's parent
// into spec.json (src/agent/inputs.ts), then the one findings file the Kit
// names from the Decision's number and title (src/loop/researchPaths.ts), in
// sections prompts/research.md names. The runner cuts the Decision's
// throwaway branch, also named from them, before the agent runs, and commits
// what the run left to it after, as the Fabrik Researcher, never the agent.
// The Researcher holds no GitHub credential and runs none of the code.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { findingsPathFor, researchBranchFor } from "../loop/researchPaths.ts";

/** The heading over the research Decision's own issue in the Researcher's prompt. */
export const RESEARCH_ISSUE_HEADING = "The research Decision";

/** The heading each of the Researcher's other inputs is set out under, in the order the prompt reads them. */
export const RESEARCH_SECTIONS = {
  map: "The Map",
  findingsFile: "The findings file",
} as const;

/**
 * Who commits a research branch's findings: the Kit, in the Research job,
 * which holds no Sandbox secrets, so the identity is its own, not the
 * Implementer's from 1Password.
 */
export const RESEARCHER_AUTHOR = { name: "Fabrik Researcher", email: "fabrik-researcher@users.noreply.github.com" } as const;

const json = (value: unknown): string[] => ["```json", JSON.stringify(value, null, 2), "```"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What the Researcher's prompt carries after the research Decision's issue,
 * the findings file it names, the one file the run may write, and the
 * Decision's throwaway branch the runner commits it to. `mapFile` holds the
 * Decision's parent, its Map; `decision` is the issue as FABRIK_ISSUE_FILE holds it.
 */
export async function researchContext(
  mapFile: string,
  decision: unknown,
): Promise<{ branch: string; findingsPath: string; parts: string[] }> {
  if (!isObject(decision) || typeof decision["number"] !== "number" || typeof decision["title"] !== "string") {
    throw new Error("The research Decision has no number and title to name its findings file from");
  }
  const map: unknown = JSON.parse(await readFile(mapFile, "utf8"));
  if (!isObject(map) || typeof map["number"] !== "number" || typeof map["title"] !== "string" || typeof map["body"] !== "string") {
    throw new Error(`${mapFile} holds no Map with its number, title and body: a research Decision is a sub-issue of one`);
  }
  const subject = { number: decision["number"], title: decision["title"] };
  const findingsPath = findingsPathFor(subject);
  return {
    branch: researchBranchFor(subject),
    findingsPath,
    parts: [
      `## ${RESEARCH_SECTIONS.map}`,
      ...json(map),
      `## ${RESEARCH_SECTIONS.findingsFile}`,
      `Write your findings to \`${findingsPath}\`, from the repo root, and change no other file.`,
    ],
  };
}

const run = promisify(execFile);

/**
 * Commits everything the run left in the checkout, as the Fabrik Researcher,
 * on the branch it's on. Every path goes in, not only the findings file, so
 * the push job, which refuses a branch that changes any other, sees each one
 * the run touched; what the repo ignores, such as the fetched skills, stays
 * out. A run that left nothing gets no commit. No hook runs, whatever the run
 * left in the checkout's git directory.
 */
export async function commitResearch(productDir: string, decision: number): Promise<void> {
  const git = async (...args: string[]) =>
    (
      await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        cwd: productDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: RESEARCHER_AUTHOR.name,
          GIT_AUTHOR_EMAIL: RESEARCHER_AUTHOR.email,
          GIT_COMMITTER_NAME: RESEARCHER_AUTHOR.name,
          GIT_COMMITTER_EMAIL: RESEARCHER_AUTHOR.email,
        },
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout.trim();
  if ((await git("status", "--porcelain")) === "") return;
  await git("add", "--all");
  await git("commit", "--quiet", "--no-verify", "-m", `The Researcher's findings on #${decision}`);
}
