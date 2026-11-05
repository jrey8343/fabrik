// A fake fabrik-runs store (RUN_STORE, src/kit/runStore.ts) for the tests of
// what writes to it: the record writer and the score-record job.
import { GitHubError } from "../github/client.ts";

/**
 * The fabrik-runs store through the Contents API: its visibility, the files it
 * already holds, how many parallel commits beat each write to a path, and the
 * paths it refuses (422) for some other reason. Its 422 for a file already
 * there says nothing of a `sha`: the writer looks rather than reading the text.
 * `held` maps each path to its base64 content (`"earlier"` for a file it held
 * from the start), and `writes` lists every PUT, retries included.
 */
export function storeWith(options: { private?: boolean; files?: string[]; conflicts?: Record<string, number>; refused?: string[] } = {}) {
  const held = new Map<string, string>((options.files ?? []).map((path) => [path, "earlier"]));
  const conflicts = { ...options.conflicts };
  const writes: string[] = [];
  return {
    held,
    writes,
    async rest(method: string, path: string, body?: unknown): Promise<unknown> {
      if (method === "GET" && path === "/repos/jrey8343/fabrik-runs") return { private: options.private ?? true };
      const contents = /^\/repos\/jrey8343\/fabrik-runs\/contents\/(.+)$/.exec(path);
      if (method === "GET" && contents !== null) {
        const file = decodeURIComponent(contents[1] ?? "");
        if (!held.has(file)) throw new GitHubError(`GET ${path} failed: 404 Not Found`, 404);
        return { path: file, sha: "s".repeat(40) };
      }
      const put = contents;
      if (method === "PUT" && put !== null) {
        const file = decodeURIComponent(put[1] ?? "");
        const { content, sha } = body as { content: string; sha?: string };
        writes.push(file);
        if ((conflicts[file] ?? 0) > 0) {
          conflicts[file] = (conflicts[file] ?? 0) - 1;
          throw new GitHubError(`PUT ${path} failed: 409 is at abc but expected def`, 409);
        }
        if ((held.has(file) && sha === undefined) || (options.refused ?? []).includes(file)) {
          throw new GitHubError(`PUT ${path} failed: 422 Invalid request.`, 422);
        }
        held.set(file, content);
        return { content: { path: file } };
      }
      throw new Error(`Unexpected call: ${method} ${path}`);
    },
  };
}

/** A wait that doesn't, for writes retried on conflict. */
export const noWait = async (): Promise<void> => {};
