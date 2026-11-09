import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubError, type Repo } from "../github/client.ts";
import { type KitReader, overlayCandidate } from "./overlay.ts";

const PINNED_LOCK = JSON.stringify({ repository: "mattpocock/skills", sha: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" });
const CANDIDATE_LOCK = JSON.stringify({ repository: "mattpocock/skills", sha: "b".repeat(40) });
const CANDIDATE = "c".repeat(40);
const MAIN = "d".repeat(40);

/** The pinned Kit checkout: its prompts, rubrics and skills pin, and the workflow code that must never change. */
const PINNED: Record<string, string> = {
  "prompts/implement.md": "The pinned implement prompt\n",
  "prompts/review.md": "The pinned review prompt\n",
  "prompts/triage.md": "The pinned triage prompt\n",
  "prompts/design.md": "The pinned design prompt\n",
  "prompts/prototype.md": "The pinned prototype prompt\n",
  "prompts/audit.md": "The pinned audit prompt\n",
  "prompts/retro.md": "The pinned retro prompt\n",
  "prompts/research.md": "The pinned research prompt\n",
  "prompts/scorers/efficiency.md": "The pinned efficiency rubric\n",
  "skills.lock.json": PINNED_LOCK,
  "skills/fabrik-pair/SKILL.md": "The pinned pairing skill\n",
  "src/agent/run.ts": "// the pinned runner\n",
  ".github/workflows/loop.yml": "# the pinned Loop\n",
  ".github/actions/prepare-agent/action.yml": "# the pinned prepare-agent\n",
  "package.json": "{}\n",
};

async function aKitCheckout(): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "fabrik-overlay-kit-"));
  for (const [path, text] of Object.entries(PINNED)) {
    await mkdir(dirname(join(kit, path)), { recursive: true });
    await writeFile(join(kit, path), text);
  }
  return kit;
}

async function filesOf(kit: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.keys(PINNED).map(async (path) => [path, await readFile(join(kit, path), "utf8")])));
}

/**
 * The Fabrik repo as a read-only token reads it: the commits GitHub has in it,
 * read by sha, on a branch or not, and every file at the candidate, where the
 * candidate changed every one of them.
 */
function theFabrikRepo({
  commits = [MAIN, CANDIDATE],
  files = Object.fromEntries(Object.keys(PINNED).map((path) => [path, path === "skills.lock.json" ? CANDIDATE_LOCK : `The candidate's ${path}\n`])),
}: {
  commits?: string[];
  files?: Record<string, string>;
} = {}): KitReader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest: async (_method: string, path: string, _body?: unknown, options?: { allowNotFound?: boolean }) => {
      calls.push(path);
      const commit = /^\/repos\/jrey8343\/fabrik\/commits\/([0-9a-f]+)$/.exec(path);
      if (commit !== null) {
        if (commits.includes(commit[1]!)) return { sha: commit[1] };
        // GitHub answers a sha it has no commit for with a 422.
        throw new GitHubError("No commit found for SHA", 422, { request: `GET ${path}` });
      }
      if (options?.allowNotFound === true) return null;
      throw new Error(`unexpected REST call ${path}`);
    },
    fileText: async (repo: Repo, path: string, ref: string) => {
      calls.push(`${repo.owner}/${repo.name}:${path}@${ref}`);
      if (`${repo.owner}/${repo.name}` !== "jrey8343/fabrik" || ref !== CANDIDATE) return null;
      return files[path] ?? null;
    },
  };
}

describe("The candidate-sha overlay", () => {
  it("lays the candidate's prompts and Base skills pin over the Kit, and changes no rubric, workflow, action or source file", async () => {
    const kit = await aKitCheckout();

    const result = await overlayCandidate(kit, CANDIDATE, theFabrikRepo());

    expect(result).toMatchObject({ kind: "laid", sha: CANDIDATE });
    const after = await filesOf(kit);
    expect(after["prompts/implement.md"]).toBe("The candidate's prompts/implement.md\n");
    expect(after["prompts/review.md"]).toBe("The candidate's prompts/review.md\n");
    expect(after["prompts/prototype.md"]).toBe("The candidate's prompts/prototype.md\n");
    expect(after["skills.lock.json"]).toBe(CANDIDATE_LOCK);
    const unchanged = Object.keys(PINNED).filter((path) => !path.startsWith("prompts/") || path.startsWith("prompts/scorers/"));
    expect(unchanged.filter((path) => path !== "skills.lock.json").map((path) => [path, after[path]])).toEqual(
      unchanged.filter((path) => path !== "skills.lock.json").map((path) => [path, PINNED[path]]),
    );
  });

  it("lays a candidate no branch of the Fabrik repo holds any more, as a squash-merged Retro proposal's once its branch is deleted", async () => {
    const kit = await aKitCheckout();

    const result = await overlayCandidate(kit, CANDIDATE, theFabrikRepo());

    expect(result.kind).toBe("laid");
    expect(await readFile(join(kit, "prompts/review.md"), "utf8")).toBe("The candidate's prompts/review.md\n");
  });

  it.each([
    ["a short sha", CANDIDATE.slice(0, 7)],
    ["an uppercase sha", CANDIDATE.toUpperCase()],
    ["a branch name", "main"],
  ])("refuses %s before reading anything, changing nothing", async (_, sha) => {
    const kit = await aKitCheckout();
    const fabrik = theFabrikRepo();

    const result = await overlayCandidate(kit, sha, fabrik);

    expect(result).toEqual({ kind: "refused", reason: `${JSON.stringify(sha)} isn't a full commit sha` });
    expect(fabrik.calls).toEqual([]);
    expect(await filesOf(kit)).toEqual(PINNED);
  });

  it("refuses a candidate that lacks a Kit prompt, rather than mix its prompts with the pinned ones, changing nothing", async () => {
    const kit = await aKitCheckout();
    const { "prompts/prototype.md": _, ...files } = Object.fromEntries(
      Object.keys(PINNED).map((path) => [path, path === "skills.lock.json" ? CANDIDATE_LOCK : `The candidate's ${path}\n`]),
    );

    const result = await overlayCandidate(kit, CANDIDATE, theFabrikRepo({ files }));

    expect(result).toEqual({ kind: "refused", reason: `${CANDIDATE} has no prompts/prototype.md` });
    expect(await filesOf(kit)).toEqual(PINNED);
  });

  it("refuses a candidate whose Base skills pin doesn't read, changing nothing", async () => {
    const kit = await aKitCheckout();
    const files = Object.fromEntries(
      Object.keys(PINNED).map((path) => [path, path === "skills.lock.json" ? JSON.stringify({ repository: "mattpocock/skills", sha: "main" }) : `The candidate's ${path}\n`]),
    );

    const result = await overlayCandidate(kit, CANDIDATE, theFabrikRepo({ files }));

    expect(result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/^c{40}'s skills\.lock\.json: sha must be a 40-character commit SHA/) });
    expect(await filesOf(kit)).toEqual(PINNED);
  });

  it("refuses a sha GitHub has no commit for in the Fabrik repo, reading no file, changing nothing", async () => {
    const kit = await aKitCheckout();
    const fabrik = theFabrikRepo({ commits: [MAIN] });

    const result = await overlayCandidate(kit, CANDIDATE, fabrik);

    expect(result).toEqual({ kind: "refused", reason: `${CANDIDATE} isn't a commit in jrey8343/fabrik` });
    expect(fabrik.calls.some((call) => call.includes(":"))).toBe(false);
    expect(await filesOf(kit)).toEqual(PINNED);
  });

  it("refuses a sha GitHub answers with a 404, as for a repo it can't read, changing nothing", async () => {
    const kit = await aKitCheckout();
    const fabrik = theFabrikRepo();
    const unknown = {
      ...fabrik,
      rest: async (method: string, path: string, body?: unknown, options?: { allowNotFound?: boolean }) =>
        path.includes("/commits/") ? (options?.allowNotFound === true ? null : Promise.reject(new Error("404"))) : fabrik.rest(method, path, body, options),
    };

    const result = await overlayCandidate(kit, CANDIDATE, unknown);

    expect(result).toEqual({ kind: "refused", reason: `${CANDIDATE} isn't a commit in jrey8343/fabrik` });
    expect(await filesOf(kit)).toEqual(PINNED);
  });
});
