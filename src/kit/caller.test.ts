import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALLER_JOBS, callerWorkflowPath, checkCallerWorkflow, checkKit } from "./caller.ts";
import { resolveKitConfig } from "./config.ts";
import { AUDIT_LABEL, DESIGN_LABEL, DISPATCH_LABEL, KIT_ISSUE_LABELS, NEEDS_DESIGN, RESEARCH_LABEL, REPLAY_TRIGGER_LABEL, RETRO_LABEL, REVIEW_LABEL } from "../loop/labels.ts";

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

  // #304: a push to main may leave an agent PR conflicting with it, whatever it touches, so no path filter.
  it("the caller template runs the Loop on every push to the default branch, a Kit config change among them, and never for a tag or the Kit's own branches", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");
    const push = /^ {2}push:\n((?: {4}.*\n)+)/m.exec(template)?.[1] ?? "";

    expect(push).toBe('    branches-ignore: ["fabrik/**", "prototype/**", "research/**"]\n');
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

  // #477: GitHub names a run from the caller workflow alone, never from the reusable workflow it calls.
  describe("the caller template's run-name, which names each run on the Actions tab for what started it", () => {
    const template = readFileSync(new URL("../../templates/fabrik.yml", import.meta.url), "utf8");
    const runName = /^run-name: >-\n((?: {2}.*\n)+)/m.exec(template)?.[1] ?? "";
    const cases = runName.split("\n").map((line) => line.trim());

    it("is one expression, a case a line, ending in the event itself when no case fits", () => {
      expect(cases[0]).toBe("${{");
      expect(cases.at(-2)).toBe("}}");
      expect(cases.at(-3)).toBe("format('{0} {1}', github.event_name, github.event.action)");
      expect(cases.slice(1, -3).every((line) => line.endsWith(" ||"))).toBe(true);
    });

    it("names the hourly tick, and a push for its branch", () => {
      expect(cases).toContain("github.event_name == 'schedule' && 'Tick' ||");
      expect(cases).toContain("github.event_name == 'push' && format('Push to {0}', github.ref_name) ||");
    });

    it.each([
      [DISPATCH_LABEL, "Implement"],
      [DESIGN_LABEL, "Design-session turn"],
      [RESEARCH_LABEL, "Research"],
      [REPLAY_TRIGGER_LABEL, "Replay"],
    ])("names the run %s starts on an issue for its role and the issue: %s #<n>", (label, role) => {
      expect(cases).toContain(
        `github.event_name == 'issues' && github.event.label.name == '${label}' && format('${role} #{0}', github.event.issue.number) ||`,
      );
    });

    it("names the run agent:review starts, and one a push to an agent PR starts, for the Review of the PR", () => {
      expect(cases).toContain(
        `github.event_name == 'pull_request_target' && github.event.label.name == '${REVIEW_LABEL}' && format('Review PR #{0}', github.event.pull_request.number) ||`,
      );
      expect(cases).toContain(
        "github.event_name == 'pull_request_target' && contains(fromJSON('[\"opened\", \"synchronize\", \"reopened\"]'), github.event.action) && startsWith(github.event.pull_request.head.ref, 'fabrik/') && format('Review PR #{0}', github.event.pull_request.number) ||",
      );
    });

    it("names a new issue's run for Triage, but an Audit's and a Retro's for theirs, and the Kit's other issues' for the opening alone", () => {
      const opened = "github.event_name == 'issues' && github.event.action == 'opened'";
      expect(cases).toContain(`${opened} && contains(github.event.issue.labels.*.name, '${AUDIT_LABEL}') && format('Audit #{0}', github.event.issue.number) ||`);
      expect(cases).toContain(`${opened} && contains(github.event.issue.labels.*.name, '${RETRO_LABEL}') && format('Retro #{0}', github.event.issue.number) ||`);
      const others = KIT_ISSUE_LABELS.filter((label) => label !== AUDIT_LABEL && label !== RETRO_LABEL);
      expect(cases).toContain(
        `${opened} && (${others.map((label) => `contains(github.event.issue.labels.*.name, '${label}')`).join(" || ")}) && format('Opened #{0}', github.event.issue.number) ||`,
      );
      expect(cases).toContain(`${opened} && format('Triage #{0}', github.event.issue.number) ||`);
      // Most specific first: Triage only once no Kit issue's case fits.
      expect(cases.findIndex((line) => line.includes("'Triage #{0}'"))).toBeGreaterThan(cases.findIndex((line) => line.includes("'Opened #{0}'")));
    });

    it("names a reply on a needs-design issue for the Design-session turn it starts, and the Operator's Request changes for its PR", () => {
      expect(cases).toContain(
        `github.event_name == 'issue_comment' && !github.event.issue.pull_request && contains(github.event.issue.labels.*.name, '${NEEDS_DESIGN}') && format('Design-session turn #{0}', github.event.issue.number) ||`,
      );
      expect(cases).toContain(
        "github.event_name == 'pull_request_review' && github.event.review.state == 'changes_requested' && format('Request changes PR #{0}', github.event.pull_request.number) ||",
      );
    });
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
