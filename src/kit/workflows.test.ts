// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflows = [".github/workflows/loop.yml", ".github/workflows/schedule.yml"].map((path) => ({
  path,
  text: readFileSync(new URL(path, root), "utf8"),
}));
const loop = workflows.find((workflow) => workflow.path.endsWith("loop.yml"))!.text;

describe("The Kit's workflows", () => {
  it.each(workflows)("$path checks the Kit out at kit/ in every job", ({ text }) => {
    const kitCheckouts = [...text.matchAll(/repository: jrey8343\/fabrik\n(?:.*\n){1,2}?\s+path: (\S+)/g)].map((match) => match[1]);

    expect(kitCheckouts.length).toBeGreaterThan(0);
    expect(new Set(kitCheckouts)).toEqual(new Set(["kit"]));
  });

  it.each(workflows)("$path uses only composite actions the Kit ships", ({ text }) => {
    const local = [...text.matchAll(/uses: \.\/kit\/(\S+)/g)].map((match) => match[1]!);

    expect(local.length).toBeGreaterThan(0);
    for (const action of local) expect(existsSync(new URL(`${action}/action.yml`, root)), action).toBe(true);
  });

  it("loop.yml leaves reading GitHub to the Kit's Node program, never inline gh calls", () => {
    expect(loop).not.toMatch(/\bgh (api|issue|pr) /);
  });

  // Kept for reading a failed or timed-out run. Never fabrik-agent-*: the push job
  // downloads those, and reads an empty download as a timeout.
  it.each(["triage", "design", "implement", "review"])(
    "loop.yml's %s job always uploads its gzipped transcript, apart from the push job's artifacts",
    (job) => {
      const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${job}:\n`))!;
      const upload = body.split(/\n(?=      - )/).find((step) => step.includes(`name: fabrik-transcript-${job}`));

      expect(upload, `${job} has no transcript upload`).toBeDefined();
      expect(upload).toContain("if: always()");
      expect(upload).toContain("continue-on-error: true");
      expect(upload).toMatch(/path: .*transcript\.jsonl\.gz/);
      expect(upload).toContain("if-no-files-found: ignore");
      expect(upload).toContain("retention-days: 7");
      expect(body).toMatch(/if: always\(\)\n\s+continue-on-error: true\n\s+run: .*gzip.*transcript\.jsonl/);
    },
  );
});

/** A job's section of loop.yml, from its key to the next job's. */
function job(name: string): string {
  const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${name}:\n`));
  if (body === undefined) throw new Error(`loop.yml has no ${name} job`);
  return body;
}

describe("loop.yml's Design queue job", () => {
  const queue = (): string => job("design-queue");

  it("runs a Design queue check when the push job's plan asked for one", () => {
    expect(queue()).toContain("needs.push.outputs.design-queue == 'true'");
    expect(job("push")).toContain("design-queue: ${{ steps.loop.outputs.design-queue }}");
    expect(queue()).toContain('FABRIK_DESIGN_QUEUE_CHECK: "true"');
  });

  it("runs queue checks one at a time in a per-repo concurrency group, so two can't fill the same free slot", () => {
    expect(queue()).toMatch(/concurrency:\n\s+group: fabrik-design-queue\n\s+cancel-in-progress: false\n/);
  });

  it("reads Design-session turns in progress with its own read-only token", () => {
    expect(queue()).toMatch(/permissions:\n(?:\s+#.*\n)*\s+actions: read\n/);
    expect(queue()).toContain("actions-token: ${{ github.token }}");
  });
});

describe("loop.yml's claim job", () => {
  it("takes agent:design off as the Design session's first turn starts, as it takes agent:implement off", () => {
    expect(job("implement-claim")).toContain(
      "if: needs.kit.outputs.route == 'implement' || (needs.kit.outputs.route == 'design' && github.event.label.name == 'agent:design')",
    );
  });
});
