// The candidate-sha overlay (#156): for a Replay arm whose variable is a
// candidate Kit sha, the candidate's prompts and its Base skills pin, and
// nothing else, are laid over the pinned Kit checkout before the agent job
// fetches its skills and builds its prompt. The workflow code, the Kit's own
// programs and the Scorers' rubrics stay the pinned release (ADR-0003's addendum).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allPages, type GitHub, GitHubError } from "../github/client.ts";
import { KIT_PROMPT_NAMES, kitPromptPath } from "../guard/trust-root.ts";
import { FULL_SHA, readSkillsLock, SKILLS_LOCK_PATH } from "../skills/lock.ts";
import { KIT_REPO } from "./caller.ts";

/** What the overlay reads of the Fabrik repo, through a read-only token. */
export type KitReader = Pick<GitHub, "rest" | "fileText">;

/**
 * The Kit files a candidate sha may change: the Kit's prompts, which the
 * agents load, and the lockfile pinning the Base skills. Never a rubric under
 * prompts/scorers/, Fabrik's own skills, or any workflow, action or program.
 */
export const OVERLAID_PATHS: readonly string[] = [...KIT_PROMPT_NAMES.map(kitPromptPath), SKILLS_LOCK_PATH];

/** What the overlay did: laid these paths at the candidate sha, or refused it, changing nothing. */
export type OverlayResult =
  | { readonly kind: "laid"; readonly sha: string; readonly paths: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

const [owner = "", name = ""] = KIT_REPO.split("/");
const KIT = { owner, name };

/**
 * Whether `sha` is a commit on a branch of the Fabrik repo: some branch's head
 * is it or descends from it. GitHub serves a fork's commits through the
 * repo it forked too, so a commit GitHub finds there may belong to anyone's
 * fork; only one a branch holds is the Fabrik repo's own.
 */
export async function isKitCommit(github: Pick<GitHub, "rest">, sha: string): Promise<boolean> {
  const branches = await allPages<{ name: string; commit: { sha: string } }>(github, `/repos/${KIT_REPO}/branches`);
  if (branches.some((branch) => branch.commit.sha === sha)) return true;
  for (const branch of branches) {
    const path = `/repos/${KIT_REPO}/compare/${sha}...${branch.commit.sha}?per_page=1`;
    const comparison = (await github.rest("GET", path, undefined, { allowNotFound: true }).catch((error: unknown) => {
      // GitHub answers a sha it has no commit for with a 404, or a 422.
      if (error instanceof GitHubError && error.status === 422) return null;
      throw error;
    })) as { status?: string } | null;
    if (comparison?.status === "ahead" || comparison?.status === "identical") return true;
  }
  return false;
}

/**
 * Lays the candidate sha's OVERLAID_PATHS, read from the Fabrik repo through
 * a read-only token, over the Kit checkout at `kitDir`. It refuses, changing
 * nothing, a sha that isn't a full commit sha or isn't a commit on a branch of
 * the Fabrik repo, so a replay never loads prompts from anywhere else.
 */
export async function overlayCandidate(kitDir: string, sha: string, github: KitReader): Promise<OverlayResult> {
  if (!FULL_SHA.test(sha)) return { kind: "refused", reason: `${JSON.stringify(sha)} isn't a full commit sha` };
  if (!(await isKitCommit(github, sha))) return { kind: "refused", reason: `${sha} isn't a commit on any branch of ${KIT_REPO}` };
  const read = await Promise.all(OVERLAID_PATHS.map(async (path) => ({ path, text: await github.fileText(KIT, path, sha) })));
  const files = overlayFiles(sha, read);
  if (!files.ok) return { kind: "refused", reason: files.reason };
  for (const { path, text } of files.files) {
    await mkdir(dirname(join(kitDir, path)), { recursive: true });
    await writeFile(join(kitDir, path), text);
  }
  return { kind: "laid", sha, paths: files.files.map(({ path }) => path) };
}

/**
 * The files to lay from the candidate `sha`, given each of OVERLAID_PATHS as
 * read there (null when the candidate lacks it), or why it can't be laid: a
 * path it lacks, which would leave its prompts mixed with the pinned ones, or
 * a skills pin that doesn't read, which the skills fetch would trip on. Pure.
 */
export function overlayFiles(
  sha: string,
  read: readonly { readonly path: string; readonly text: string | null }[],
): { readonly ok: true; readonly files: readonly { readonly path: string; readonly text: string }[] } | { readonly ok: false; readonly reason: string } {
  const files: { path: string; text: string }[] = [];
  for (const { path, text } of read) {
    if (text === null) return { ok: false, reason: `${sha} has no ${path}` };
    files.push({ path, text });
  }
  const lock = files.find(({ path }) => path === SKILLS_LOCK_PATH);
  try {
    if (lock !== undefined) readSkillsLock(lock.text);
  } catch (error) {
    return { ok: false, reason: `${sha}'s ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, files };
}
