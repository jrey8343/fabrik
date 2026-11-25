// Held workflows and the Start check in the docs (Spec #917): the README's shapes
// for a workflow that holds a role, its place after the Merge gate, the Held
// workflow's step as it ran on trial, held to the Start check's name and minutes
// the read library exports, and Setup's line; the glossary's two terms after the
// Promote list; and ADR-0038's two sentences on whose word production takes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headingAnchor } from "../__fixtures__/headingAnchor.ts";
import { START_CHECK_MINUTES, startCheckName } from "../read/index.ts";
import { CALLER_FILE } from "../setup/shims.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const readme = read("README.md");
const lines = readme.split("\n");

/** The README's `##` section of this title, from its heading to the next `##` heading. */
function section(title: string): string {
  return readme.split(`\n## ${title}\n`)[1]?.split("\n## ")[0] ?? "";
}
/** A `###` part of a section, from its heading to the next `###` heading. */
function part(text: string, title: string): string {
  return text.split(`\n### ${title}\n`)[1]?.split("\n### ")[0] ?? "";
}
/** The first fenced YAML block in a text, without its fences. */
function firstYaml(text: string): string {
  return /\n```yaml\n([\s\S]*?)\n```\n/.exec(text)?.[1] ?? "";
}
/** The lines indented under the line `key:` at `indent` spaces, as written. */
function under(yaml: string, key: string, indent: number): string[] {
  const rows = yaml.split("\n");
  const start = rows.indexOf(`${" ".repeat(indent)}${key}:`);
  if (start === -1) return [];
  const end = rows.findIndex((row, i) => i > start && row.trim() !== "" && row.length - row.trimStart().length <= indent);
  return rows.slice(start + 1, end === -1 ? undefined : end);
}

const holdsARole = section("Workflows that hold a role");
const held = part(holdsARole, "Held workflows");
const step = firstYaml(held);
const jobs = under(step, "jobs", 0);
/** Each job of the step's example by its id, as its lines under the id. */
const job = (id: string) => under(jobs.join("\n"), id, 2);

describe("the README's section on workflows that hold a role", () => {
  it("is the section straight after the Merge gate, before the Audit", () => {
    const headings = lines.filter((line) => line.startsWith("## "));
    const at = headings.indexOf("## Workflows that hold a role");

    expect(headings[at - 1]).toBe("## Merge gate");
    expect(at).toBeLessThan(headings.indexOf("## Audit"));
  });

  it("has the shape of a workflow that holds a role, Held workflows, a deploy on every merge, runs from before the step and Setup's line, in that order", () => {
    expect(holdsARole.split("\n").filter((line) => line.startsWith("### "))).toEqual([
      "### The shape of a workflow that holds a role",
      "### Held workflows",
      "### A deploy on every merge",
      "### Runs from before the step",
      "### Setup's line",
    ]);
  });

  it("has every link in it, and every link to Held workflows in the README, resolve to a heading", () => {
    const anchors = new Set(lines.filter((line) => /^#{2,6} /.test(line)).map((line) => headingAnchor(line.replace(/^#+ /, ""))));
    const linked = (text: string) => [...text.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);

    expect(linked(holdsARole)).toEqual(expect.arrayContaining(["kit-config", "merge-gate"]));
    for (const target of linked(holdsARole)) expect(anchors).toContain(target);
    expect(linked(readme).filter((target) => target === "held-workflows").length).toBeGreaterThanOrEqual(2);
    expect(anchors).toContain("held-workflows");
  });
});

describe("the Held workflow's step in the README", () => {
  it("is promote.yml's, on the default branch", () => {
    expect(step.split("\n")[0]).toBe("# .github/workflows/promote.yml, on the default branch");
  });

  it("reads the Start check by the name the read library gives promote.yml's", () => {
    expect(step).toContain(`-f check_name='${startCheckName("promote.yml")}'`);
    expect(step.match(/check_name=/g)).toHaveLength(1);
  });

  it("holds the check to the read library's minutes, in seconds", () => {
    expect(step).toContain(`now - (.completed_at | fromdateiso8601) <= ${START_CHECK_MINUTES * 60}'`);
    expect(step.match(/<= \d+/g)).toEqual([`<= ${START_CHECK_MINUTES * 60}`]);
  });

  it("asks for checks: read and nothing else in the job that reads the check, and the deploy needs that job", () => {
    const reader = jobs.find((row) => /^ {2}[\w-]+:$/.test(row) && job(row.trim().slice(0, -1)).some((line) => line.includes("check-runs")));
    const readerId = reader?.trim().slice(0, -1) ?? "";

    expect(readerId).toBe("start-check");
    expect(step).toContain("\npermissions: {}\n");
    expect(under(job(readerId).join("\n"), "permissions", 4)).toEqual(["      checks: read"]);
    expect(job("deploy")).toContain(`    needs: ${readerId}`);
  });

  it("writes the App's id in the workflow file as a quoted number, and never reads Kit config", () => {
    expect(step).toMatch(/\n {10}APP_ID: "\d+" # the Console's App, Kit config's console\.app_id\n/);
    expect(step).not.toContain(".fabrik/config.json");
    expect(step).not.toContain("actions/checkout");
  });
});

describe("the README's part on Setup's line", () => {
  it("names the Kit's caller workflow as the one workflow it leaves out, by the name Setup holds", () => {
    const setupsLine = part(holdsARole, "Setup's line");

    expect(setupsLine).toContain(`leaves out the Kit's own caller workflow, \`${CALLER_FILE}\`, by name`);
    expect(setupsLine.match(/`[^`]+\.ya?ml`/g)).toEqual([`\`${CALLER_FILE}\``]);
  });
});

describe("the glossary's Held workflow and Start check", () => {
  // The Trial steps' two terms (#962) stand straight after the Promote list, so
  // these two follow them, after the Promote list and last before Measuring the factory.
  it("has both terms, as written, after the Promote list and straight before Measuring the factory", () => {
    const glossary = read("GLOSSARY.md");
    const terms = [
      "",
      "**Held workflow**:",
      "A workflow on a Product repo's main branch that does an act only the Operator may start, such as a production deploy the Operator promotes by hand, and so reads a Start check before it takes a role. The Product repo lists it in Kit config.",
      "_Avoid_: gated workflow, protected workflow, approved deploy",
      "",
      "**Start check**:",
      "The check only the Console can report that a Held workflow reads before it takes a role, made at the Operator's tap on the main branch's head for that one workflow and good only for a run that begins soon after. It is neither a Required check nor the Console check, and GitHub requires it of nothing.",
      "_Avoid_: approval, deploy check, the Console's go-ahead",
      "",
      "## Measuring the factory",
    ].join("\n");

    expect(glossary.indexOf(terms)).toBeGreaterThan(glossary.indexOf("**Promote list**:"));
  });
});

describe("ADR-0038 on whose word production takes", () => {
  const adr = read("docs/adr/0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md");

  it("says the Operator's tap is the word where the production workflow is a Held workflow", () => {
    expect(adr).toContain(
      "\n- **It is advisory from end to end.** No Loop rule waits on staging, and neither the Kit nor the Console deploys production or refuses a deploy for a Staging trial's result. The word that production takes what is merged is the Operator's alone: their own dispatch of the production workflow, or, where that workflow is a Held workflow, their tap in the Console, which makes the Start check it reads (the ADR on an Operator session's posture). The Promote list, every pull request a production deployment would take with its result, only tells them what that deploy holds.\n",
    );
    expect(adr).not.toContain("The Operator's own dispatch of their production workflow is the approval.");
  });

  it("has the considered option say a Start check carries the Operator's word and no judgement of the Promote list", () => {
    expect(adr).toContain(
      "\n- **The Kit or the Console deploying production, or refusing a deploy on a Staging trial's result.** The Operator's word is the approval. A Start check carries that word and no judgement of the Promote list.\n",
    );
    expect(adr).not.toContain("The Operator's own dispatch is the approval.");
  });
});
