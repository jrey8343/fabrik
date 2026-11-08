import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fabrikUsesIn } from "./caller.ts";
import { callerChangeErrors, checkCallerPermissions } from "./callerPermissions.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** A caller whose `tick` job grants `grants` to the called workflow at `uses`. */
function callerWith(uses: string, grants: readonly string[]): string {
  return [
    "name: Fabrik",
    "on:",
    "  schedule:",
    '    - cron: "17 * * * *"',
    "permissions: {}",
    "jobs:",
    "  tick:",
    "    if: github.event_name == 'schedule'",
    `    uses: ${uses}`,
    "    permissions:",
    ...grants.map((grant) => `      ${grant}`),
    "    secrets:",
    "      OP_PUSH_TOKEN: ${{ secrets.FABRIK_OP_PUSH_TOKEN }}",
    "",
  ].join("\n");
}

/** A called workflow whose jobs each ask for the permissions given. */
function calledWith(jobs: Readonly<Record<string, readonly string[] | string>>): string {
  return [
    "name: Fabrik scheduled tick",
    "on:",
    "  workflow_call:",
    "permissions: {}",
    "jobs:",
    ...Object.entries(jobs).flatMap(([job, asks]) => [
      `  ${job}:`,
      "    runs-on: ubuntu-latest",
      ...(typeof asks === "string"
        ? [`    permissions: ${asks}`]
        : ["    permissions:", "      # Why the job needs each", ...asks.map((ask) => `      ${ask}`)]),
      "    steps:",
      "      - run: echo",
    ]),
    "",
  ].join("\n");
}

const SCHEDULE = "jrey8343/fabrik/.github/workflows/schedule.yml@v1.0.0";
const caller = { path: ".github/workflows/fabrik.yml", text: "" };

describe("A caller workflow's grants against what the pinned workflows' jobs ask for", () => {
  // #387 asked the tick job for actions: read; v1.0.0's bump PR merged with a caller that granted id-token: write only.
  it("names the job and the missing line when a called job asks for a permission the caller's job doesn't grant", () => {
    const text = callerWith(SCHEDULE, ["id-token: write"]);
    const called = calledWith({ kit: ["id-token: write"], tick: ["actions: read"] });

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([
      ".github/workflows/fabrik.yml: the tick job's permissions: lacks `actions: read`, which the tick job of " +
        "jrey8343/fabrik/.github/workflows/schedule.yml@v1.0.0 asks for. GitHub checks every uses: job of a workflow before any job's if:, " +
        "so until the line is added every run of this workflow fails at startup, whatever the event. Add `actions: read` under the tick job's permissions: before merging.",
    ]);
  });

  it("says to raise a line the caller has at a lower level than the called job asks", () => {
    const text = callerWith(SCHEDULE, ["id-token: write", "contents: read"]);
    const called = calledWith({ push: ["contents: write"] });

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([
      expect.stringMatching(/^\.github\/workflows\/fabrik\.yml: the tick job's permissions: grants `contents: read`, but it needs `contents: write`, which the push job of .* Raise it to `contents: write` under the tick job's permissions: before merging\.$/),
    ]);
  });

  it("passes a caller whose job grants every line its called workflow's jobs ask for, at the level asked or above", () => {
    const text = callerWith(SCHEDULE, ["id-token: write", "actions: read", "contents: write"]);
    const called = calledWith({ kit: ["id-token: write"], tick: ["actions: read"], push: ["contents: read"], quiet: "{}" });

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([]);
  });

  it("asks nothing for a called job with no permissions: of its own, which takes the caller's", () => {
    const text = callerWith(SCHEDULE, ["id-token: write"]);
    const called = calledWith({ kit: ["id-token: write"] }).replace("permissions: {}\n", "") + "  inherits:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([]);
  });

  it("reads a caller job without permissions: of its own as granting the workflow's top-level permissions:", () => {
    const text = callerWith(SCHEDULE, []).replace(/^ {4}permissions:\n/m, "").replace("permissions: {}", "permissions:\n  id-token: write");
    expect(text).not.toContain("    permissions:");
    const called = calledWith({ kit: ["id-token: write"], tick: ["actions: read"] });

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([
      expect.stringContaining("the tick job's permissions: lacks `actions: read`"),
    ]);
  });

  it("names every line a called workflow asks for when the caller sets no permissions: anywhere, since GitHub's defaults never grant id-token: write", () => {
    const text = callerWith(SCHEDULE, []).replace(/^ {4}permissions:\n/m, "").replace("permissions: {}\n", "");
    expect(text).not.toContain("permissions:");
    const called = calledWith({ kit: ["id-token: write"], tick: ["actions: read"], push: ["id-token: write", "actions: write"] });

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: called }])).toEqual([
      ".github/workflows/fabrik.yml: the tick job has no permissions: of its own, and the workflow none at the top, so it gets the repo's default token permissions, " +
        "which never include `id-token: write`. The jobs of jrey8343/fabrik/.github/workflows/schedule.yml@v1.0.0 ask for `id-token: write` and `actions: write`. " +
        "GitHub checks every uses: job of a workflow before any job's if:, so until they're granted every run of this workflow fails at startup, whatever the event. " +
        "Add a permissions: block with those lines under the tick job before merging.",
    ]);
  });

  it("leaves alone a caller job whose uses: names no workflow it was given, such as a composite action", () => {
    const text = callerWith("jrey8343/fabrik/.github/actions/fetch-skills@v1.0.0", []);

    expect(checkCallerPermissions({ ...caller, text }, [{ uses: SCHEDULE, text: calledWith({ tick: ["actions: read"] }) }])).toEqual([]);
  });

  // The check that would have caught #387 before v1.0.0 shipped: the shipped templates against the Kit's own workflows.
  describe("the caller templates the Kit ships, against the workflows this Kit holds", () => {
    const workflowsAt = (callerText: string) =>
      [...new Set(fabrikUsesIn(callerText))]
        .filter((uses) => uses.includes("/.github/workflows/"))
        .map((uses) => ({ uses, text: read(uses.slice("jrey8343/fabrik/".length, uses.lastIndexOf("@"))) }));

    it.each(["templates/fabrik.yml", "templates/fabrik-runs-caller.yml"])("%s grants every line the workflows it pins ask for", (path) => {
      const text = read(path);
      const workflows = workflowsAt(text);

      expect(workflows.length).toBeGreaterThan(0);
      expect(checkCallerPermissions({ path, text }, workflows)).toEqual([]);
    });

    it("would fail templates/fabrik.yml with the tick job's actions: read taken away, as v1.0.0's bump PR left it", () => {
      const path = "templates/fabrik.yml";
      const text = read(path).replace(/^ {6}actions: read\n(?=    secrets:\n {6}OP_PUSH_TOKEN)/m, "");
      expect(text).not.toBe(read(path));

      const errors = checkCallerPermissions({ path, text }, workflowsAt(text));

      // The tick and the Dispatch check both read workflow runs, so both jobs of schedule.yml ask for it.
      expect(errors.map((error) => /which the (\S+) job of/.exec(error)?.[1])).toEqual(["tick", "dispatch"]);
      for (const error of errors) expect(error).toContain("the tick job's permissions: lacks `actions: read`");
    });
  });
});

describe("The caller workflow a pull request proposes", () => {
  const repo = { owner: "acme", name: "shop" };
  const path = ".github/workflows/fabrik.yml";
  const base = callerWith("jrey8343/fabrik/.github/workflows/schedule.yml@v0.9.0", ["id-token: write"]);
  const head = callerWith(SCHEDULE, ["id-token: write"]);
  const tickAsksActions = calledWith({ kit: ["id-token: write"], tick: ["actions: read"] });

  /** A reader over `files`, keyed `owner/name:path@ref`, that notes every read. */
  function readerOf(files: Readonly<Record<string, string>>) {
    const reads: string[] = [];
    return {
      reads,
      fileText: (at: { owner: string; name: string }, filePath: string, ref: string) => {
        const key = `${at.owner}/${at.name}:${filePath}@${ref}`;
        reads.push(key);
        return Promise.resolve(files[key] ?? null);
      },
    };
  }

  it("is read at the PR's head, and its gaps against the workflows at the release it pins are the errors", async () => {
    const files = readerOf({ [`acme/shop:${path}@abc123`]: head, "jrey8343/fabrik:.github/workflows/schedule.yml@v1.0.0": tickAsksActions });

    const errors = await callerChangeErrors(files, repo, { path, baseText: base, headSha: "abc123" });

    expect(errors).toEqual([expect.stringContaining("the tick job's permissions: lacks `actions: read`, which the tick job of jrey8343/fabrik/.github/workflows/schedule.yml@v1.0.0 asks for")]);
    expect(files.reads).toEqual([`acme/shop:${path}@abc123`, "jrey8343/fabrik:.github/workflows/schedule.yml@v1.0.0"]);
  });

  it("has nothing wrong, and reads no Kit workflow, when the PR leaves the caller as the base branch has it", async () => {
    const files = readerOf({ [`acme/shop:${path}@abc123`]: base });

    expect(await callerChangeErrors(files, repo, { path, baseText: base, headSha: "abc123" })).toEqual([]);
    expect(files.reads).toEqual([`acme/shop:${path}@abc123`]);
  });

  it("has nothing wrong when the PR's head has no caller workflow", async () => {
    expect(await callerChangeErrors(readerOf({}), repo, { path, baseText: base, headSha: "abc123" })).toEqual([]);
  });

  it("passes a head whose jobs grant what the pinned workflows ask", async () => {
    const granted = callerWith(SCHEDULE, ["id-token: write", "actions: read"]);
    const files = readerOf({ [`acme/shop:${path}@abc123`]: granted, "jrey8343/fabrik:.github/workflows/schedule.yml@v1.0.0": tickAsksActions });

    expect(await callerChangeErrors(files, repo, { path, baseText: base, headSha: "abc123" })).toEqual([]);
  });

  it("fails a head whose pins don't pass the release check, before reading any workflow", async () => {
    const mixed = `${head}  loop:\n    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.1.0\n`;
    const files = readerOf({ [`acme/shop:${path}@abc123`]: mixed });

    expect(await callerChangeErrors(files, repo, { path, baseText: base, headSha: "abc123" })).toEqual([
      `${path}: The caller workflow pins more than one Fabrik release (v1.0.0, v1.1.0); every uses: line must pin the same one`,
    ]);
    expect(files.reads).toHaveLength(1);
  });

  it("names a pinned workflow the release doesn't hold", async () => {
    const files = readerOf({ [`acme/shop:${path}@abc123`]: head });

    expect(await callerChangeErrors(files, repo, { path, baseText: base, headSha: "abc123" })).toEqual([
      `${path}: ${SCHEDULE} names a workflow jrey8343/fabrik has no .github/workflows/schedule.yml for at v1.0.0`,
    ]);
  });
});
