// The Trial steps' words and their decision (Spec #962), written down with
// the Implementer's `trial` and its marker (#963): the glossary's two terms,
// the ADR, and the line of ADR-0038 that points at it.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { trialStepsMarker } from "../loop/markers.ts";
import { FINDING_TAG_TEXT } from "../loop/verdict.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("The Trial steps' words and decision (#962)", () => {
  it("has its two terms in the glossary, after the Promote list, worded as the Spec words them", () => {
    const glossary = read("GLOSSARY.md");
    const evidenceTerms = glossary.slice(glossary.indexOf("**UI evidence**:"), glossary.indexOf("## Measuring the factory"));

    expect(evidenceTerms).toContain(
      [
        "_Avoid_: release list, changelog, deploy queue, release candidates",
        "",
        "**Trial steps**:",
        "The summary and ordered steps an Implementer writes for a pull request that asks for a Staging trial, each saying where to go, what to do and what should be seen.",
        "_Avoid_: test plan, test script, QA checklist, acceptance criteria (a Ticket's)",
        "",
        "**Trial session**:",
        "A Staging trial the Operator runs with an agent driving their own browser, which ends in the Operator's verdict.",
        "_Avoid_: Pairing session (works an issue, not a merged change), QA session, test run",
        "",
      ].join("\n"),
    );
  });

  it("has its ADR under a number of its own, in the form the others take, with the options the Spec rejected", () => {
    const name = "0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md";
    const numbers = readdirSync(new URL("docs/adr/", root)).map((file) => Number(file.slice(0, 4)));

    expect(numbers.filter((number) => number === 40)).toHaveLength(1);
    const adr = read(`docs/adr/${name}`);
    expect(adr.split("\n")[0]).toBe("# The Implementer writes a Staging trial's steps and the Reviewer judges them");
    expect(adr).toContain("\n## Considered options\n");
    expect(adr).toContain("\n## Consequences\n");
    expect(adr).toContain("Decided in [Spec: Trial steps, and a Staging trial paired with Claude in Chrome](https://github.com/jrey8343/fabrik/issues/962).");
    const options = adr.slice(adr.indexOf("\n## Considered options\n"), adr.indexOf("\n## Consequences\n"));
    for (const rejected of [
      "Steps derived from the Ticket's acceptance criteria.",
      "Steps written in the Design session.",
      "The pairing agent inferring what to test.",
      "A self-contained prompt composed by a reader.",
      "Records for Dynamic routes named in Kit config.",
      "A flow diagram.",
      "The agent accepting when every step matched.",
      "Pausing before steps that write.",
      "A recording on the Trial problem.",
    ]) {
      expect(options).toContain(`- **${rejected}**`);
    }
  });

  it("names in its ADR what the Implementer's output and the pull request's marker are called, as the code has them", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");

    const marker = trialStepsMarker({ summary: "A waitlist.", steps: [{ do: "Pick a full day.", expect: "A button shows." }] });

    for (const word of ["`trial`", "`summary`", "`steps`", "`route`", "`do`", "`expect`", "`staging`"]) expect(adr).toContain(word);
    // The marker as the writer opens and closes it, around JSON the ADR doesn't spell out.
    expect(adr).toContain(`\`${marker.slice(0, marker.indexOf("{"))}{…}${marker.slice(marker.lastIndexOf("}") + 1)}\``);
  });

  it("is pointed at from ADR-0038, in one line saying a label an agent puts on at the Operator's word, with the Operator's credential, is the Operator's", () => {
    const earlier = read("docs/adr/0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md");
    const pointing = earlier.split("\n").filter((line) => line.includes("](0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md)"));

    expect(pointing).toHaveLength(1);
    expect(pointing[0]).toContain("a label an agent puts on at the Operator's word, with the Operator's credential, is the Operator's");
    expect(pointing[0]).toContain("[ADR-0040]");
  });

  it("says in the README, under staging in Kit config, the one thing the Loop now does where the block is declared, in place of saying no prompt reads it", () => {
    const staging = read("README.md")
      .split("\n")
      .find((line) => line.startsWith("- `staging` (default `null`)"));

    expect(staging).toContain(
      "Nothing in the Loop waits on staging or reads its address or its deploys, which only a reader of the Kit acts on. The Loop asks only whether the block is there: where it is, the Implementer writes Trial steps for each pull request that will ask for a Staging trial, and the Kit keeps them on the pull request (ADR-0040).",
    );
    expect(staging).not.toContain("no Loop rule, job or prompt reads it");
    expect(staging).toContain("`null`, or leaving it out, declares none, and the repo reads exactly as it does without the block.");
  });

  it("says in the README, after it, that the Reviewer judges them on such a pull request (#964)", () => {
    const staging = read("README.md")
      .split("\n")
      .find((line) => line.startsWith("- `staging` (default `null`)"));

    expect(staging).toContain(
      "and the Kit keeps them on the pull request (ADR-0040). The Reviewer judges them against the diff before the merge, on such a pull request only. Kit config is a Trust-root file",
    );
  });

  it("says in its ADR how a finding about Trial steps is fixed: tagged as one about the body, by a run that gives trial again and commits nothing for it (#964)", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");
    const consequences = adr.slice(adr.indexOf("\n## Consequences\n"));

    expect(consequences).toContain(
      `- A finding about Trial steps is one about the pull request's body, where they are kept, so the Reviewer tags it \`${FINDING_TAG_TEXT["small-body"]}\`. The run that fixes it gives \`trial\` again and has nothing to commit for it, which a Touch-up whose findings are all about the body may do. A Retry may not, as one that commits nothing is an empty diff, so a finding about Trial steps reaches a Retry only beside a finding in the code.`,
    );
  });

  it("says in its ADR which labels a Trial session puts on with the Operator's credential, by the names ADR-0038 reads", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");

    expect(adr).toContain(`\`${TRIAL_ACCEPTED_LABEL}\``);
    expect(adr).toContain(`\`${TRIAL_PROBLEM_LABEL}\``);
    expect(adr).toContain("](0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md)");
  });
});
