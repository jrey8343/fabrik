// Setup's command pipes setup.sh into bash beside the Operator's whole gh
// token, so it fetches setup.sh at the release it runs, never from main, which
// a cloud session can push to with no tag and no merge. Every command the Kit
// shows names its release in both places: in the URL and after the `--`. The
// ADRs and the release notes of released versions are records, and tests may
// name a branch to check it's gone.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, KIT, repoFiles } from "../__fixtures__/repoScan.ts";
import { EXACT_RELEASE } from "../kit/caller.ts";
import { setupCommand } from "./finish.ts";

/** Each fetch of setup.sh from Fabrik, capturing the ref it's fetched at. */
const FETCH = /raw\.githubusercontent\.com\/jrey8343\/fabrik\/([^/\s"'`]+)\/setup\.sh/g;

/** What `bash -s --` is handed first, quotes aside. */
const NAMED = /bash -s --\s+"?([^"\s`]+)"?/;

/** A ref that names a release: an exact tag, the latest form's `$v`, the placeholder `<release>`, or setupCommand's own parameter. */
const namesARelease = (path: string, ref: string): boolean =>
  EXACT_RELEASE.test(ref) || ref === "$v" || ref === "<release>" || (path === "src/setup/finish.ts" && ref === "${release}");

/** The latest form: the gh call that sets $v, then, on the next line, the fetch at $v that names $v. */
const LATEST =
  /^[#\s]*v=\$\(gh ([^)\n]+)\) &&\n[#\s]*curl -fsSL "https:\/\/raw\.githubusercontent\.com\/jrey8343\/fabrik\/\$v\/setup\.sh" \| bash -s -- "\$v"/m;

/** The named form: a fetch at an exact tag or at `<release>`, naming the same after the `--`. */
const NAMED_FORM =
  /curl -fsSL https:\/\/raw\.githubusercontent\.com\/jrey8343\/fabrik\/(v\d+\.\d+\.\d+|<release>)\/setup\.sh \| bash -s -- \1(\s|$)/m;

interface Fetch {
  /** `path:line: text`, for the failure message. */
  readonly where: string;
  readonly path: string;
  readonly ref: string;
  readonly line: string;
}

/** Every fetch of setup.sh in a file the Kit ships, records aside. */
async function fetches(): Promise<Fetch[]> {
  const found: Fetch[] = [];
  for (const path of repoFiles().filter((file) => !isRecord(file))) {
    const text = await readFile(join(KIT, path), "utf8").catch(() => "");
    text.split("\n").forEach((line, at) => {
      for (const [, ref = ""] of line.matchAll(FETCH)) found.push({ where: `${path}:${at + 1}: ${line.trim()}`, path, ref, line });
    });
  }
  return found;
}

/** The gh call setup.sh makes for Fabrik's latest release when no release is named. */
async function setupShAsksGh(): Promise<string | undefined> {
  return (await readFile(join(KIT, "setup.sh"), "utf8")).match(/release=\$\(gh ([^)]+?) 2>/)?.[1];
}

describe("Setup's bootstrap is fetched at the release it runs", () => {
  it("has setupCommand fetch setup.sh at the release's tag and name the release after the --", () => {
    expect(setupCommand("v1.4.2")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/v1.4.2/setup.sh | bash -s -- v1.4.2",
    );
  });

  it("has nothing the Kit ships fetch setup.sh from main or any other branch", async () => {
    const found = await fetches();

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(({ path, ref }) => !namesARelease(path, ref)).map(({ where }) => where)).toEqual([]);
  });

  it("names the release it fetches setup.sh at after the --, on the same line", async () => {
    const found = await fetches();

    expect(found.filter(({ ref, line }) => line.match(NAMED)?.[1] !== ref).map(({ where }) => where)).toEqual([]);
  });

  describe.each([
    { name: "README.md", read: async () => readFile(join(KIT, "README.md"), "utf8") },
    {
      name: "setup.sh's header",
      read: async () => {
        const script = await readFile(join(KIT, "setup.sh"), "utf8");
        return script.slice(0, script.indexOf("\nset -euo pipefail"));
      },
    },
  ])("$name", ({ read }) => {
    it("gives the command that names a release in both places", async () => {
      expect(await read()).toMatch(NAMED_FORM);
    });

    it("gives the command for the latest release, which asks gh for its tag as setup.sh does when no release is named", async () => {
      const asks = await setupShAsksGh();
      expect(asks).toBe("release view --repo jrey8343/fabrik --json tagName --jq .tagName");

      expect((await read()).match(LATEST)?.[1]).toBe(asks);
    });
  });
});
