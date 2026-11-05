// The Weekly summary's GitHub side, beside the Loop's snapshot gatherer: which
// Product repos the summary covers, and the GitHub facts it reads of each
// (src/kit/weeklySummary.ts). Read-only. It holds no summary rules; those all
// live in the Weekly summary module.
import { fabrikRefsIn } from "../kit/caller.ts";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { CALLER_PATH } from "../setup/shims.ts";
import type { GitHub, Repo } from "./client.ts";

interface InstallationRepositories {
  total_count: number;
  repositories: { full_name: string; name: string; owner: { login: string }; default_branch: string }[];
}

/**
 * Every repo in the Fabrik App's installation whose default branch has the
 * Kit's caller workflow, apart from the store itself. A repo shows up without
 * any configuration once setup has written its caller.
 */
export async function productReposOf(github: Pick<GitHub, "rest" | "fileText">): Promise<Repo[]> {
  const listed: InstallationRepositories["repositories"] = [];
  for (let page = 1; ; page++) {
    const result = (await github.rest("GET", `/installation/repositories?per_page=100&page=${page}`)) as InstallationRepositories;
    listed.push(...result.repositories);
    if (result.repositories.length === 0 || listed.length >= result.total_count) break;
  }
  const candidates = listed.filter((repo) => repo.full_name.toLowerCase() !== RUN_STORE_REPO.toLowerCase());
  const callers = await Promise.all(
    candidates.map((repo) => github.fileText({ owner: repo.owner.login, name: repo.name }, CALLER_PATH, repo.default_branch)),
  );
  return candidates
    .filter((_, i) => {
      const caller = callers[i];
      return caller !== null && caller !== undefined && fabrikRefsIn(caller).length > 0;
    })
    .map((repo) => ({ owner: repo.owner.login, name: repo.name }));
}
