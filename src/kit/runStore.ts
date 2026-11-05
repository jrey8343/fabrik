// Where Run records and the Weekly summary live (ADR-0009): one private repo
// shared by every Product repo. A Kit constant, like the Kit's own repo, not a
// Kit config field.
import { type GitHub, GitHubError } from "../github/client.ts";

export const RUN_STORE = { owner: "jrey8343", name: "fabrik-runs" } as const;

/** The store as `owner/name`. */
export const RUN_STORE_REPO = `${RUN_STORE.owner}/${RUN_STORE.name}`;

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
