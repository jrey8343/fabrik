import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALLER_JOBS, callerWorkflowPath, checkCallerWorkflow, checkKit } from "./caller.ts";
import { resolveKitConfig } from "./config.ts";

function callerWith(...uses: string[]): string {
  return [
    "name: Fabrik",
    "on:",
    "  issues:",
    "    types: [opened]",
    "jobs:",
    ...uses.flatMap((ref, i) => [`  job${i}:`, `    uses: ${ref}`]),
    "",
  ].join("\n");
}

describe("Caller workflow release check", () => {
  it("passes a caller whose uses: lines all pin the same exact release", () => {
    const text = callerWith(
      "jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3",
      "jrey8343/fabrik/.github/workflows/review.yml@v1.2.3",
    );

    expect(checkCallerWorkflow(text)).toEqual({ ok: true, release: "v1.2.3" });
  });

  it("rejects a caller whose release refs disagree, naming each ref", () => {
    const text = callerWith(
      "jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3",
      "jrey8343/fabrik/.github/workflows/review.yml@v1.3.0",
    );

    expect(checkCallerWorkflow(text)).toEqual({
      ok: false,
      error: "The caller workflow pins more than one Fabrik release (v1.2.3, v1.3.0); every uses: line must pin the same one",
    });
  });

  it.each(["main", "v1", "v1.2", "3d3c42e5aac5ba805825da76410c181273ba90b1"])(
    "rejects a ref that isn't an exact release: %s",
    (ref) => {
      const text = callerWith(`jrey8343/fabrik/.github/workflows/loop.yml@${ref}`);

      expect(checkCallerWorkflow(text)).toEqual({
        ok: false,
        error: `The caller workflow pins Fabrik at ${ref}, which isn't an exact release tag such as v1.2.3`,
      });
    },
  );

  it("rejects a caller that doesn't use Fabrik at all", () => {
    expect(checkCallerWorkflow(callerWith("someone/else/.github/workflows/x.yml@v1.0.0"))).toEqual({
      ok: false,
      error: "The caller workflow has no uses: line that pins a Fabrik release",
    });
  });

  it("reads quoted refs and ignores other actions and comments", () => {
    const text = [
      "# uses: jrey8343/fabrik/.github/workflows/loop.yml@v0.0.1",
      "jobs:",
      "  loop:",
      `    uses: "jrey8343/fabrik/.github/workflows/loop.yml@v2.0.0-pre.1" # pinned by Dependabot`,
      "  other:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: 'jrey8343/fabrik/actions/fetch-skills@v2.0.0-pre.1'",
    ].join("\n");

    expect(checkCallerWorkflow(text)).toEqual({ ok: true, release: "v2.0.0-pre.1" });
  });

  it("passes the caller template the Kit ships", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");

    expect(checkCallerWorkflow(template).ok).toBe(true);
  });

  it("the caller template runs the scheduled Kit workflow on a schedule, pinned to the same release as the Loop", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");
    const check = checkCallerWorkflow(template);
    if (!check.ok) throw new Error(check.error);

    expect(template).toMatch(/^\s+schedule:\n\s+- cron: /m);
    expect(template).toContain(`uses: jrey8343/fabrik/.github/workflows/loop.yml@${check.release}`);
    expect(template).toContain(`uses: jrey8343/fabrik/.github/workflows/schedule.yml@${check.release}`);
  });

  it("the caller template runs the Loop when a push to the default branch changes the Kit config, and never for a tag", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");

    expect(template).toMatch(/^\s+push:\n\s+branches: \["\*\*"\]\n\s+paths: \[\.fabrik\/config\.json\]$/m);
    expect(template).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  it("the caller template runs the Loop on a new issue comment only, never an edited or deleted one", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");

    expect(template).toMatch(/^ {2}issue_comment:\n {4}types: \[created\]$/m);
  });

  it("the caller template's job keys are the ones the Kit knows its own check runs by", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");
    const jobs = template.slice(template.indexOf("\njobs:\n"));

    expect([...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((match) => match[1])).toEqual([...CALLER_JOBS]);
  });

  it("the scheduled Kit workflow ships beside the Loop as a reusable workflow", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/schedule.yml", import.meta.url), "utf8");

    expect(workflow).toMatch(/^on:\n\s+workflow_call:/m);
  });
});

describe("Every run's Kit check, before any agent starts", () => {
  const caller = { path: ".github/workflows/fabrik.yml", text: callerWith("jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3") };
  const noConfig = resolveKitConfig({ config: null, instructions: {} });

  it("passes a valid Kit config and a caller that pins one exact release", () => {
    const check = checkKit(noConfig, caller);

    expect(check.ok).toBe(true);
  });

  it("fails a caller whose pins disagree, even with a valid Kit config", () => {
    const check = checkKit(noConfig, {
      ...caller,
      text: callerWith("jrey8343/fabrik/.github/workflows/loop.yml@v1.2.3", "jrey8343/fabrik/.github/workflows/schedule.yml@v1.3.0"),
    });

    expect(check).toEqual({ ok: false, errors: [expect.stringMatching(/^\.github\/workflows\/fabrik\.yml: The caller workflow pins more than one Fabrik release/)] });
  });

  it("fails a missing caller workflow", () => {
    expect(checkKit(noConfig, { ...caller, text: null })).toEqual({
      ok: false,
      errors: [".github/workflows/fabrik.yml was not found"],
    });
  });

  it("names every problem at once, the Kit config's and the caller's", () => {
    const check = checkKit(resolveKitConfig({ config: "{ not json", instructions: {} }), { ...caller, text: "jobs: {}" });

    expect(check.ok ? [] : check.errors).toHaveLength(2);
  });

  it("reads the caller workflow's path from GITHUB_WORKFLOW_REF", () => {
    expect(callerWorkflowPath("acme/shop/.github/workflows/fabrik.yml@refs/heads/main", { owner: "acme", name: "shop" })).toBe(
      ".github/workflows/fabrik.yml",
    );
    expect(() => callerWorkflowPath("other/repo/.github/workflows/fabrik.yml@main", { owner: "acme", name: "shop" })).toThrow();
  });
});
