// The Kit's reusable workflows are wiring only. These hold the wiring to the
// files it names, since nothing runs the workflows before a release.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflows = [".github/workflows/loop.yml", ".github/workflows/schedule.yml", ".github/workflows/weekly-summary.yml"].map((path) => ({
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

  it.each(workflows)("$path leaves reading GitHub to the Kit's Node program, never inline gh calls", ({ text }) => {
    expect(text).not.toMatch(/\bgh (api|issue|pr|repo|release|run|workflow) /);
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
  // The write the Run record action reads them from the push job's FABRIK_NEEDS.
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

  // Run records (ADR-0009): written after the Loop has applied its plan, whatever
  // happened to it, and never able to fail or stall the push job.
  it("loop.yml's push job writes the Run record after Run the Loop, always, and never fails on it", () => {
    const steps = jobOf("push").split(/\n(?=      - )/);
    const loopStep = steps.findIndex((step) => step.includes("name: Run the Loop"));
    const recordStep = steps.findIndex((step) => step.includes("uses: ./kit/.github/actions/write-run-record"));
    const record = steps[recordStep] ?? "";

    expect(recordStep, "the push job has no write the Run record step").toBeGreaterThan(-1);
    expect(recordStep).toBeGreaterThan(loopStep);
    expect(loopStep).toBeGreaterThan(-1);
    expect(record).toContain("if: always()");
    expect(record).toContain("continue-on-error: true");
    expect(record).toContain("op-push-token: ${{ secrets.OP_PUSH_TOKEN }}");
    expect(record).toContain("role: ${{ needs.kit.outputs.route }}");
  });
});

describe("The write the Run record action", () => {
  const action = readFileSync(new URL(".github/actions/write-run-record/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const storeToken = steps.find((step) => step.includes("id: store"));

  it("builds and writes the record with the Kit's Node program, never inline gh calls", () => {
    const program = /run: node (src\/\S+)/.exec(action)?.[1];

    expect(program).toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    expect(action).not.toMatch(/\bgh (api|issue|pr|repo) /);
  });

  it("mints the store's token for fabrik-runs alone, with Contents write and nothing else", () => {
    expect(storeToken).toContain("uses: actions/create-github-app-token@");
    expect(storeToken).toMatch(/owner: jrey8343\n/);
    expect(storeToken).toMatch(/repositories: fabrik-runs\n/);
    expect([...storeToken!.matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`)).toEqual(["contents: write"]);
  });

  it("goes on when the store's token can't be minted, so the program can name the missing setup step", () => {
    expect(storeToken).toContain("continue-on-error: true");
  });

  it("takes the role's transcript, and a missing one is fine", () => {
    const download = steps.find((step) => step.includes("actions/download-artifact@"));

    expect(download).toContain("fabrik-transcript-");
    expect(download).toContain("continue-on-error: true");
  });
});

describe("The weekly summary workflow", () => {
  const weekly = workflows.find((workflow) => workflow.path.endsWith("weekly-summary.yml"))!.text;
  const action = readFileSync(new URL(".github/actions/file-weekly-summary/action.yml", root), "utf8");
  const steps = action.split(/\n(?=    - )/);
  const tokens = steps.filter((step) => step.includes("uses: actions/create-github-app-token@"));
  const permissionsOf = (step: string | undefined) =>
    [...(step ?? "").matchAll(/permission-([a-z-]+): (\S+)/g)].map((m) => `${m[1]}: ${m[2]}`).sort();

  it("is called from the fabrik-runs caller with its push service account, and runs the Kit's composite action", () => {
    expect(weekly).toMatch(/on:\n {2}workflow_call:\n {4}secrets:\n {6}OP_PUSH_TOKEN:/);
    expect(weekly).toContain("jrey8343/fabrik/.github/workflows/weekly-summary.yml@*)");
    expect(weekly).toContain("uses: ./kit/.github/actions/file-weekly-summary");
  });

  it("leaves reading and filing to the Kit's Node program, never inline gh calls", () => {
    const program = /run: node (src\/\S+)/.exec(action)?.[1];

    expect(program).toBeDefined();
    expect(existsSync(new URL(program!, root))).toBe(true);
    for (const text of [weekly, action]) expect(text).not.toMatch(/\bgh (api|issue|pr|repo) /);
  });

  it("holds only two Fabrik App tokens: Issues write and Contents read on fabrik-runs, and read-only on the Product repos", () => {
    const store = tokens.find((step) => step.includes("repositories: fabrik-runs"));
    const products = tokens.find((step) => step !== store);

    expect(tokens).toHaveLength(2);
    expect(store).toMatch(/owner: jrey8343\n/);
    expect(permissionsOf(store)).toEqual(["contents: read", "issues: write"]);
    expect(products).toMatch(/owner: jrey8343\n/);
    expect(products).not.toContain("repositories:");
    expect(permissionsOf(products)).toEqual(["contents: read", "issues: read", "pull-requests: read"]);
  });

  it("reads the store's records from a sparse checkout of runs/, never its transcripts", () => {
    const checkout = steps.find((step) => step.includes("uses: actions/checkout@"));

    expect(checkout).toContain("repository: jrey8343/fabrik-runs");
    expect(checkout).toMatch(/sparse-checkout: runs\n/);
    expect(checkout).toContain("sparse-checkout-cone-mode: true");
    expect(checkout).toContain("persist-credentials: false");
    expect(action).not.toContain("transcripts/");
  });
});

/** One job's section of loop.yml. */
function jobOf(job: string): string {
  const body = loop.split(/\n(?=  [a-z-]+:\n)/).find((section) => section.startsWith(`  ${job}:\n`));
  if (body === undefined) throw new Error(`loop.yml has no ${job} job`);
  return body;
}
