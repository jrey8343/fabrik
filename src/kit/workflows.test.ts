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

  // What the Run record (src/kit/runRecord.ts) needs of how each run started.
  // Nothing in the push job reads them yet.
  it("loop.yml's Kit job passes out which run it planned: its Retry number, Step-up and Request changes", () => {
    const kit = jobOf("kit");

    expect(kit).toContain("retry: ${{ steps.route.outputs.retry }}");
    expect(kit).toContain("step-up: ${{ steps.route.outputs.step-up }}");
    expect(kit).toContain("request-changes: ${{ steps.route.outputs.request-changes }}");
  });

  it.each(["triage", "design", "implement", "review"])(
    "loop.yml's %s job passes out the model and effort it ran and the commit it started from",
    (job) => {
      const body = jobOf(job);

      expect(body).toMatch(/model: \$\{\{ steps\.agent\.outputs\.model \}\}/);
      expect(body).toMatch(/effort: \$\{\{ steps\.agent\.outputs\.effort \}\}/);
      expect(body).toMatch(/base-sha: \$\{\{ steps\.base\.outputs\.sha \}\}/);
      expect(body).toMatch(/id: agent\n\s+working-directory: product\n(?:.*\n)*?\s+run: node \.\.\/kit\/src\/agent\/run\.ts /);
      // Before the secrets load, so a run whose agent never started still names its commit.
      expect(body.indexOf("id: base")).toBeLessThan(body.indexOf("id: op"));
    },
  );

  it("loop.yml's push job reads none of the Run record's new outputs yet", () => {
    const push = jobOf("push");

    for (const output of ["retry", "step-up", "request-changes", "base-sha"]) expect(push).not.toContain(`outputs.${output}`);
  });
});

/** One job's section of loop.yml. */
function jobOf(job: string): string {
  const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${job}:\n`));
  if (body === undefined) throw new Error(`loop.yml has no ${job} job`);
  return body;
}
