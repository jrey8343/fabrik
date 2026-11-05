import { describe, expect, it } from "vitest";
import { productReposOf } from "./facts.ts";

const CALLER = "jobs:\n  fabrik:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.2.0\n";

/** A read-only installation holding these repos, each with its files on its default branch. */
function installationWith(repos: { fullName: string; files?: Record<string, string> }[], pageSize = 100) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      const listed = /^\/installation\/repositories\?per_page=100&page=(\d+)$/.exec(path);
      if (listed === null) throw new Error(`Unexpected call: ${path}`);
      const page = Number(listed[1]);
      return {
        total_count: repos.length,
        repositories: repos.slice((page - 1) * pageSize, page * pageSize).map(({ fullName }) => ({
          full_name: fullName,
          name: fullName.split("/")[1],
          owner: { login: fullName.split("/")[0] },
          default_branch: "main",
        })),
      };
    },
    async fileText(repo: { owner: string; name: string }, path: string, ref: string): Promise<string | null> {
      expect(ref).toBe("main");
      return repos.find((r) => r.fullName === `${repo.owner}/${repo.name}`)?.files?.[path] ?? null;
    },
  };
}

describe("Finding the Product repos the Weekly summary covers", () => {
  it("is every repo in the Fabrik App's installation with the Kit's caller workflow", async () => {
    const github = installationWith([
      { fullName: "jrey8343/shop", files: { ".github/workflows/fabrik.yml": CALLER } },
      { fullName: "jrey8343/notes" },
      { fullName: "jrey8343/blog", files: { ".github/workflows/fabrik.yml": "name: Something else\n" } },
    ]);

    expect(await productReposOf(github)).toEqual([{ owner: "jrey8343", name: "shop" }]);
  });

  it("leaves out fabrik-runs, the store itself", async () => {
    const github = installationWith([
      { fullName: "jrey8343/fabrik-runs", files: { ".github/workflows/fabrik.yml": CALLER } },
      { fullName: "jrey8343/shop", files: { ".github/workflows/fabrik.yml": CALLER } },
    ]);

    expect(await productReposOf(github)).toEqual([{ owner: "jrey8343", name: "shop" }]);
  });

  it("reads every page of the installation's repos", async () => {
    const github = installationWith(
      [
        { fullName: "jrey8343/a", files: { ".github/workflows/fabrik.yml": CALLER } },
        { fullName: "jrey8343/b" },
        { fullName: "jrey8343/c", files: { ".github/workflows/fabrik.yml": CALLER } },
      ],
      2,
    );

    expect(await productReposOf(github)).toEqual([
      { owner: "jrey8343", name: "a" },
      { owner: "jrey8343", name: "c" },
    ]);
  });
});
