// What the README tells a reader of the Kit about Staging (Spec #814, #858):
// the reads, the joins and their order, the trial's labels and the promote
// list, each by the name the read library's entry gives it; what the kept
// rows' functions refuse; and what each declaration in Kit config gets.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { A_ROW_KEPT_AT_V3_4_1, A_STANDING_KEPT_AT_SCHEMA_1, EXPORT_CALLS, EXPORT_SHAPES } from "./exports.fixture.ts";
import { MERGED_STANDS_HOURS, TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL, trialProblemLine } from "./index.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const readme = read("README.md");
/** The README's section on reading the Kit from another program. */
const section = readme.split("\n## Reading the Kit from another program\n")[1]?.split("\n## ")[0] ?? "";
/** The section's bullet that opens with `lead` in bold, with the bullets under it. */
function bullet(lead: string): string {
  const lines = section.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`- **${lead}**`));
  return at === -1 ? "" : [lines[at], ...lines.slice(at + 1).filter((line, index, rest) => rest.slice(0, index + 1).every((under) => under.startsWith("  - ")))].join("\n");
}
/** Everything `text` writes as code. */
const written = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
const EXPORTED = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];

describe("the README's section on reading the Kit from another program, on Staging", () => {
  const staging = bullet("Staging.");

  it("has a bullet of its own for it, after the owed Roll-in's, that names ADR-0038 and says a repo with no staging block is read as before", () => {
    const leads = section.split("\n").filter((line) => line.startsWith("- **"));

    expect(leads.findIndex((line) => line.startsWith("- **Staging.**"))).toBeGreaterThan(leads.findIndex((line) => line.startsWith("- **An owed Roll-in.**")));
    expect(staging).toContain("(ADR-0038)");
    expect(staging).toContain("A repo that declares none is read exactly as before");
  });

  it("names the staging read a reader makes and hands to the rows: the Deployments read asked for the newest success, the Main checks read, and the rows' sixth argument", () => {
    for (const named of ["rowsOf", "StagingRead", "readDeployments", "readMainChecks", "DeployOf", "MainChecksRead"]) expect(staging, named).toContain(`\`${named}\``);
    expect(staging).toContain("`rowsOf` takes it as its sixth argument");
    expect(staging).toContain("`{ newest: true }` as its sixth argument");
    expect(staging).toContain("`deployments`");
    expect(staging).toContain("`mainChecks`");
    expect(staging).toContain("needs Checks read");
  });

  it("names the join with staging and what asks for its reads, and gives the order of the joins: production's read first", () => {
    for (const named of ["joinStaging", "stagingMergesToRead", "commitsToCheck", "joinDeployments", "mergesToRead"]) expect(staging, named).toContain(`\`${named}\``);
    expect(staging).toContain("Join production's read first, with `joinDeployments`, then staging's, with `joinStaging`");
  });

  it("names the two labels, the Trial problem's line with its writer and its reader, and whose label counts", () => {
    for (const named of ["TRIAL_ACCEPTED_LABEL", "TRIAL_PROBLEM_LABEL", "trialProblemLine", "trialProblemIn", TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL, trialProblemLine(50)]) {
      expect(staging, named).toContain(`\`${named}\``);
    }
    expect(staging).toContain("with the Operator's own credential");
  });

  it("names the promote list, what it is worked out from and what it holds", () => {
    for (const named of ["promoteListOf", "PromoteList", "PromoteEntry", "production.workflow"]) expect(staging, named).toContain(`\`${named}\``);
    for (const key of Object.keys(EXPORT_SHAPES["PromoteList"] as object)) expect(staging, key).toContain(`\`${key}\``);
  });

  it("names every export the entry has for Staging, and no export the entry lacks", () => {
    const forStaging = ["readMainChecks", "joinStaging", "stagingMergesToRead", "commitsToCheck", "MainChecksRead", "MainCheckOf", "CommitToCheck", "StagingRead", "TRIAL_ACCEPTED_LABEL", "TRIAL_PROBLEM_LABEL", "trialProblemLine", "trialProblemIn", "promoteListOf", "PromoteList", "PromoteEntry"];

    expect(forStaging.filter((name) => !EXPORTED.includes(name))).toEqual([]);
    expect(forStaging.filter((name) => !staging.includes(`\`${name}\``))).toEqual([]);
    // Every name the bullet writes with a capital in it is an export of the entry, or one of these fields of what an export gives.
    const fields = ["deployments", "mainChecks", "newest", "site", "pages", "shots", "toTry", "notAccepted", "leftOut", "dispatchPage", "checksUnread", "standsUntil"];
    const names = written(staging).filter((name) => /^[A-Za-z_]+$/.test(name) && /[A-Z]/.test(name));
    expect(names.filter((name) => !EXPORTED.includes(name) && !fields.includes(name))).toEqual([]);
  });
});

describe("what a reader kept, as the README and ADR-0020 say it once Staging has shipped", () => {
  const kept = bullet("Read back what you kept.");
  const REFUSAL = /schema 1 .*schema 2.*readStanding/;
  /** Whether a call is refused for the schema of the Standing it was given. A call that fails any other way is not. */
  const isRefused = (call: () => unknown): boolean => {
    try {
      call();
      return false;
    } catch (error) {
      return error instanceof Error && REFUSAL.test(error.message);
    }
  };

  it("lists every export that refuses a Standing of another schema, the three that take kept rows for Staging among them", async () => {
    const entry = (await import("./index.ts")) as unknown as Record<string, unknown>;
    // Each refuses before it reads anything else, so what it is given beside the kept row or Standing doesn't matter.
    // A read of GitHub is left alone: none takes anything a reader kept, and each would be asked of a client that isn't one.
    const refusing = Object.entries(entry).flatMap(([name, value]) => {
      if (typeof value !== "function" || value.constructor.name === "AsyncFunction") return [];
      const call = value as (kept: unknown) => unknown;
      return isRefused(() => call([A_ROW_KEPT_AT_V3_4_1])) || isRefused(() => call(A_STANDING_KEPT_AT_SCHEMA_1)) ? [name] : [];
    });
    const listed = written(/Every export that takes a kept Standing or kept rows \(([^)]*)\)/.exec(kept)?.[1] ?? "");

    expect(refusing).toEqual(expect.arrayContaining(["joinStaging", "stagingMergesToRead", "commitsToCheck"]));
    expect(listed.toSorted()).toEqual(refusing.toSorted());
  });

  it("says a row kept before the staging key has none, and reads as it was kept", () => {
    const readRow = kept.split("\n").find((line) => line.startsWith("  - **`readRow`**")) ?? "";

    expect(readRow).toContain("`shots` is null on a row kept before v4.1.0");
    expect(readRow).toContain("`staging` is an optional key, on a row only in a repo whose Kit config declares `staging`, so a row kept before it has none and reads as it was kept");
  });

  it("has ADR-0020 amended to name the three, beside the ones its amendment for kept Standings names", () => {
    const adr = read(`docs/adr/${readdirSync(new URL("docs/adr/", root)).find((file) => file.startsWith("0020-"))}`);
    const amended = adr.split("\n").find((line) => line.startsWith("**Amended (#814):**")) ?? "";

    expect(adr.indexOf("**Amended (#814):**")).toBeGreaterThan(adr.indexOf("**Amended (#793):**"));
    for (const named of ["joinStaging", "stagingMergesToRead", "commitsToCheck"]) expect(amended, named).toContain(`\`${named}\``);
    expect(amended).toContain("ADR-0038");
  });
});

describe("the README's Kit config section, on what declaring staging gets a repo", () => {
  const kitConfig = readme.slice(readme.indexOf("\n## Kit config\n"), readme.indexOf("\n### Extra skills\n"));
  const staging = kitConfig.slice(kitConfig.indexOf("\n- `staging` (default `null`)"), kitConfig.indexOf("\n- `operator` is"));
  const production = kitConfig.slice(kitConfig.indexOf("\n- `production` (default `null`)"), kitConfig.indexOf("\n- `staging` (default `null`)"));
  const row = (block: string, declared: string): string => block.split("\n").find((line) => line.startsWith(`    | ${declared} |`)) ?? "";

  it("has a table of what each declaration gets from a reader of the Kit, as production's block has, pointing at the read library's account", () => {
    expect(staging).toContain("\n  - **What each declaration gets**, from a reader of the Kit (see [Reading the Kit from another program](#reading-the-kit-from-another-program)):\n\n    | Declared | A reader of the Kit gets |\n    |---|---|\n");
    expect(row(staging, "No `staging`")).toContain("nothing of Staging");
  });

  it("says what staging gets with no tracked production: a Standing at Staging, the Operator's move until they label it, and nothing that moves it to Production", () => {
    const untracked = row(staging, "`staging`, and no `production.environment`");

    expect(untracked).toContain("`staging.environment`");
    expect(untracked).toContain("`monitor.main_checks`");
    expect(untracked).toContain("is the Operator's move until they label it");
    expect(untracked).toContain("Nothing moves it to Production");
    expect(untracked).toContain("The promote list starts at the first successful staging Deployment");
  });

  it("says what it gets beside a tracked production: at Production from the deployment, for 24 hours from it, and a promote list from production's newest success", () => {
    const tracked = row(staging, "`staging` and `production.environment`");

    expect(tracked).toContain("until a production deployment that contains the pull request has started");
    expect(tracked).toContain(`for ${MERGED_STANDS_HOURS} hours from that Deployment, not from its merge`);
    expect(tracked).toContain("The promote list starts at the newest successful production Deployment");
  });

  it("says what production.workflow gets: the promote list's dispatch page, and nothing dispatched", () => {
    const workflow = row(staging, "`production.workflow` too");

    expect(workflow).toContain("dispatch page");
    expect(workflow).toContain("Nothing dispatches it");
  });

  it("has production's own table say a repo that declares staging is followed there first", () => {
    expect(row(production, "`production.url` and `environment`")).toContain("A repo that also declares `staging` is followed there first");
  });
});
