// Reads what a Skills source looks like upstream against its pin, through the
// GitHub API: the head of one branch, the compare, the diff, and the plugin
// manifest at both ends. Both weekly bumps use it: Fabrik's own reads `main`,
// a Product repo's reads each source's default branch. Sources are public, so
// this needs no credential.
import type { UpstreamSkills } from "./bump.ts";
import { PLUGIN_MANIFEST_PATH } from "./lock.ts";

/** A GET against the GitHub API with an `accept` type, throwing on any non-OK response. */
export type ApiGet = (path: string, accept?: string) => Promise<Response>;

/** A plain GET on the public API, with `token` when there is one. */
export function publicGet(token?: string, apiUrl = "https://api.github.com"): ApiGet {
  return async (path, accept = "application/vnd.github+json") => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${response.status} ${await response.text()}`);
    return response;
  };
}

/** The source's default branch, as its repository says. */
export async function defaultBranchOf(get: ApiGet, repository: string): Promise<string> {
  return ((await (await get(`/repos/${repository}`)).json()) as { default_branch: string }).default_branch;
}

/** Upstream `branch` of `repository` against the pinned `sha`. */
export async function readUpstreamSkills(
  get: ApiGet,
  pin: { readonly repository: string; readonly sha: string },
  branch: string,
): Promise<UpstreamSkills> {
  const repo = `/repos/${pin.repository}`;
  const head = (await (await get(`${repo}/commits/${encodeURIComponent(branch)}`, "application/vnd.github.sha")).text()).trim();
  const compare = (await (await get(`${repo}/compare/${pin.sha}...${head}`)).json()) as {
    status: UpstreamSkills["status"];
    ahead_by: number;
    commits: { sha: string; commit: { message: string } }[];
  };
  const manifest = async (sha: string) =>
    (await get(`${repo}/contents/${PLUGIN_MANIFEST_PATH}?ref=${sha}`, "application/vnd.github.raw+json")).text();

  // GitHub refuses a diff past its size limits; the compare link still works then.
  let diff: string;
  try {
    diff = await (await get(`${repo}/compare/${pin.sha}...${head}`, "application/vnd.github.diff")).text();
  } catch (error) {
    diff = `# GitHub returned no diff (${error instanceof Error ? error.message.split("\n")[0] : error}).\n# See the compare link.\n`;
  }

  return {
    head,
    status: compare.status,
    aheadBy: compare.ahead_by,
    commits: compare.commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    diff,
    manifestAtPin: await manifest(pin.sha),
    manifestAtHead: await manifest(head),
  };
}
