// The read of what a head holds, as far as a Digest's places ask (DigestHead,
// src/loop/digestPlaces.ts): the text at the head of each file a place names,
// and the pull request's files with their patches, as GitHub's API gives
// them. Kit code checks each place against it before a Digest lands, so a
// Digest points at real lines and nothing a model retyped.
//
// It is read through the three-call client (ReadClient), never the Kit's
// client class, and this module imports no package and no Node built-in, so
// a reader outside the Kit's jobs can make the same read with its own client.
import { type DigestHead, isRepoPath } from "../loop/digestPlaces.ts";
import { allPages, GitHubError, type ReadClient, type Repo, refusalOf } from "./client.ts";

/** A file of a pull request, as GitHub's REST API lists it: `patch` is left out of a binary file's and of one whose diff is too large. */
interface RestFile {
  readonly filename: string;
  readonly patch?: string;
}

/**
 * Whether GitHub refused the file itself, which a second try would not
 * change: any refusal of the request but a rate limit, such as a file too
 * large for the API to give. GitHub's own failures and a call it never
 * answered say nothing of the file.
 */
function refusedTheFile(error: unknown): boolean {
  return error instanceof GitHubError && error.status >= 400 && error.status < 500 && refusalOf(error) !== "rate-limited";
}

/**
 * What the head `headSha` of `pullRequest` holds of `paths`, the files a
 * Digest's places name: each one's text there, read once however often it is
 * named, and the pull request's files with their patches. With no path
 * named, nothing is asked of GitHub.
 *
 * A file reads as not there, and its places are dropped, when the head has
 * none at that path, a directory or a submodule there being no file (the
 * client's `fileText` gives null for one, never GitHub's listing of it),
 * when GitHub refuses to give it, and when the path is no
 * file's path in a repo (isRepoPath), which is never asked for: a path is an
 * agent's word, and one that climbs out of the repo would be read from
 * wherever it lands.
 */
export async function readDigestHead(
  github: Pick<ReadClient, "rest" | "fileText">,
  repo: Repo,
  pullRequest: number,
  headSha: string,
  paths: readonly string[],
): Promise<DigestHead> {
  const named = [...new Set(paths)];
  if (named.length === 0) return { files: [], changed: [] };
  const textOf = async (path: string): Promise<string | null> => {
    if (!isRepoPath(path)) return null;
    try {
      return await github.fileText(repo, path, headSha);
    } catch (error) {
      if (refusedTheFile(error)) return null;
      throw error;
    }
  };
  const [changed, texts] = await Promise.all([
    allPages<RestFile>(github, `/repos/${repo.owner}/${repo.name}/pulls/${pullRequest}/files`),
    Promise.all(named.map(textOf)),
  ]);
  return {
    files: named.map((path, index) => ({ path, text: texts[index] ?? null })),
    changed: changed.map(({ filename, patch }) => ({ path: filename, patch: patch ?? null })),
  };
}
