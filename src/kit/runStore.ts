// Where Run records and the Weekly summary live (ADR-0009): one private repo
// shared by every Product repo. A Kit constant, like the Kit's own repo, not a
// Kit config field; so are the judge's model and timeout, which score the runs
// recorded there.
import { type GitHub, GitHubError } from "../github/client.ts";

export const RUN_STORE = { owner: "jrey8343", name: "fabrik-runs" } as const;

/** The store as `owner/name`. */
export const RUN_STORE_REPO = `${RUN_STORE.owner}/${RUN_STORE.name}`;

/** A file in the store, on its default branch, by its path there. */
export function storeFileUrl(path: string): string {
  return `https://github.com/${RUN_STORE_REPO}/blob/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The model the judge scores runs with (#149): Sonnet, at its default effort.
 * A Kit constant, like the store, so scores stay comparable across Product
 * repos: Kit config can't change it, and it moves only with a Kit release.
 */
export const JUDGE_MODEL = "claude-sonnet-5-5";

/**
 * How long the judge job may run, in minutes: a Kit constant, not Kit config.
 * One read of a transcript digest held to its budget (DIGEST_BUDGET in
 * src/kit/scorerPrompt.ts), and at most one retry for a malformed answer.
 */
export const JUDGE_TIMEOUT_MINUTES = 15;

/**
 * Whether the Fabrik App is installed on the store, asked as the App itself
 * (its JWT). A 404 means the store doesn't exist yet or the App isn't on it:
 * setup isn't done, which is no failure.
 */
export async function storeInstalled(app: Pick<GitHub, "rest">): Promise<boolean> {
  try {
    await app.rest("GET", `/repos/${RUN_STORE.owner}/${RUN_STORE.name}/installation`);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Whether the store is private, read with a token scoped to it. Records hold
 * Product repos' issues and transcripts their code, so a store others can
 * read is never written to, and a Retro never reads one.
 */
export async function storeIsPrivate(store: Pick<GitHub, "rest">): Promise<boolean> {
  const repo = (await store.rest("GET", `/repos/${RUN_STORE.owner}/${RUN_STORE.name}`)) as { private?: unknown };
  return repo.private === true;
}
