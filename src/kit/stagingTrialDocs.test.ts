// The Staging trial's words and its decision (Spec #814), written down with
// the Kit config block and the two labels: the glossary's three terms, the
// ADR, and the labels document's rows.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("The Staging trial's words and decision (#814)", () => {
  it("has its three terms in the glossary, with the Evidence terms, and leaves Follow-up the Reviewer's", () => {
    const glossary = read("GLOSSARY.md");
    const evidenceTerms = glossary.slice(glossary.indexOf("**UI evidence**:"), glossary.indexOf("## Measuring the factory"));

    expect(evidenceTerms).toContain(
      [
        "**Staging trial**:",
        "The Operator trying a merged change by hand on a Product repo's staging environment before they deploy it to production. Only the Operator does one, and nothing in the Loop waits on it.",
        "_Avoid_: QA, UAT, acceptance test, smoke test",
        "",
        "**Trial problem**:",
        "The issue the Operator files when a Staging trial finds a problem. The pull request it was found on is not accepted until the Trial problem's fix is on staging and accepted.",
        "_Avoid_: Follow-up (the Reviewer's), bug report, defect",
        "",
        "**Promote list**:",
        "Every pull request a production deployment of a Product repo would take, agent or Plain, each with its Staging trial's result, and a count of those not yet accepted. A pull request is on it from its merge until production takes it, which is when a production deployment that contains it has succeeded: it is promoted then, and unpromoted until. The list only tells the Operator what that deploy holds, and nothing deploys or refuses a deploy for it.",
        "_Avoid_: release list, changelog, deploy queue, release candidates",
        "",
      ].join("\n"),
    );
    expect(glossary).toContain(
      [
        "**Follow-up**:",
        "Work the Reviewer names on a pass that deserves its own issue but lies outside the Ticket's scope, left for the Operator to open as an issue or ignore.",
        "_Avoid_: nit, suggestion",
        "",
      ].join("\n"),
    );
  });

  it("has its ADR under a number of its own, in the form the others take, and ADR-0021 points at it", () => {
    const name = "0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md";
    const numbers = readdirSync(new URL("docs/adr/", root)).map((file) => Number(file.slice(0, 4)));

    expect(numbers.filter((number) => number === 38)).toHaveLength(1);
    const adr = read(`docs/adr/${name}`);
    expect(adr.split("\n")[0]).toBe("# A Staging trial's result is a label the Operator puts on the merged pull request");
    expect(adr).toContain("\n## Considered options\n");
    expect(adr).toContain("\n## Consequences\n");
    expect(adr).toContain(`\`${TRIAL_ACCEPTED_LABEL}\``);
    expect(adr).toContain(`\`${TRIAL_PROBLEM_LABEL}\``);
    expect(read("docs/adr/0021-live-is-read-from-github-deployments-in-an-environment-the-product-repo-declares.md")).toContain(`](${name})`);
  });

  it.each(["docs/agents/triage-labels.md", "templates/docs-agents/triage-labels.md"])("has both labels in the fabrik: table of %s, each marking a merged pull request", (path) => {
    const rows = read(path)
      .split("\n")
      .filter((line) => line.startsWith("| `fabrik:trial-"));

    expect(rows.map((row) => /^\| `([^`]+)`/.exec(row)?.[1])).toEqual([TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL]);
    for (const row of rows) expect(row).toContain("on a merged pull request");
  });
});
