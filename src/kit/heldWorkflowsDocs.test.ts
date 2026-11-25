// The README's shapes for a workflow that holds a role (Spec #917): its place
// after the Merge gate, the Held workflow's step as it ran on trial, held to the
// Start check's name and minutes the read library exports, and Setup's line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { START_CHECK_MINUTES, startCheckName } from "../read/index.ts";
import { CALLER_FILE } from "../setup/shims.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
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
/** GitHub's anchor for a heading: lower case, punctuation but `-` and `_` dropped, spaces as `-`. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
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
    const anchors = new Set(lines.filter((line) => /^#{2,6} /.test(line)).map((line) => anchor(line.replace(/^#+ /, ""))));
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
