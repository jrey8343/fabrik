import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesignTurnOutput } from "../loop/designOutput.ts";
import { readPullRequestRunOutput } from "../loop/implementOutput.ts";
import { CONSIDERED_PREFIX, FOLLOW_UPS_PREFIX, parseVerdict } from "../loop/verdict.ts";
import { OPERATOR_COMMENTS_HEADING } from "./operatorComments.ts";

const prompt = (role: string) => readFile(join(import.meta.dirname, "..", "..", "prompts", `${role}.md`), "utf8");

/** The body of a prompt's `## <heading>` section, up to the next `## ` heading. */
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

describe("The prompts of the runs that read an agent PR", () => {
  it.each(["review", "implement", "design"])("%s names the section the Operator's comments arrive under", async (role) => {
    // The prompt's weighing rules point at the section the run's context sets the comments out under.
    expect(await prompt(role)).toContain(`"${OPERATOR_COMMENTS_HEADING}"`);
  });

  it("review describes the line that names the Operator comments it weighed, as the Kit reads it", async () => {
    const text = await prompt("review");
    expect(text).toContain(CONSIDERED_PREFIX);
    // Its example reply parses, naming what it weighed.
    const example = /<review>\n([\s\S]*?)\n<\/review>/.exec(text)?.[1] ?? "";
    expect(parseVerdict(example)).toMatchObject({ ok: true, considered: ["conversation-3"] });
  });

  it("review allows no nits on a pass: the cases that used to pass as nits are Execution flaws", async () => {
    const text = await prompt("review");
    expect(text).not.toMatch(/\bnits?\b/i);
    const verdict = section(text, "Your Verdict");
    expect(verdict).toContain("an acceptance criterion the PR says it skipped");
    expect(verdict).toContain("only CI can confirm");
    expect(verdict).toContain("a PR body that is out of date with the branch");
    expect(verdict).toContain("a behaviour change beyond what the Ticket or Spec asks");
  });

  it("review describes a pass's Checked part and Follow-ups block, as the Kit reads it", async () => {
    const text = await prompt("review");
    expect(text).toContain(FOLLOW_UPS_PREFIX);
    const examples = [...text.matchAll(/<review>\n([\s\S]*?)\n<\/review>/g)].map((match) => parseVerdict(match[1] ?? ""));
    expect(examples).toContainEqual(
      expect.objectContaining({ ok: true, verdict: "pass", followUps: [expect.objectContaining({ title: expect.any(String) })] }),
    );
  });

  it("implement describes the output field that names the Operator comments it weighed, which its example carries", async () => {
    const text = await prompt("implement");
    const example: unknown = JSON.parse(/<implement>\n([\s\S]*?)\n<\/implement>/.exec(text)?.[1] ?? "null");
    expect(readPullRequestRunOutput(example)).toMatchObject({ ok: true, output: { operatorCommentsConsidered: ["conversation-3"] } });
    expect(text).toContain("- `operatorCommentsConsidered`");
  });

  it("design describes the output field that names the Operator comments it weighed, which its round example carries", async () => {
    const text = await prompt("design");
    const example: unknown = JSON.parse(/<design>\n([\s\S]*?)\n<\/design>/.exec(text)?.[1] ?? "null");
    expect(readDesignTurnOutput(example)).toMatchObject({ ok: true, output: { kind: "round", operatorCommentsConsidered: ["conversation-3"] } });
    expect(text).toContain("- `operatorCommentsConsidered`");
  });
});

describe("The Coding standards", () => {
  it("review judges against CODING_STANDARDS.md if the repo has one, in place of its review instructions", async () => {
    const how = section(await prompt("review"), "How to review");
    expect(how).toContain("then against `CODING_STANDARDS.md` if the repo has one.");
    expect(how).not.toContain("review instructions");
  });

  it("triage's fifth Fast-path test counts a Ticket touching CODING_STANDARDS.md as touching a trust root", async () => {
    const fifth = /^5\. .*$/m.exec(section(await prompt("triage"), "The decision"))?.[0] ?? "";
    expect(fifth).toContain("trust-root file");
    expect(fifth).toContain("`CODING_STANDARDS.md` at the repo root");
  });

  it("design names CODING_STANDARDS.md among the trust-root files an Implementer can't change", async () => {
    const turn = section(await prompt("design"), "Your turn");
    const list = turn.split("the trust-root files, which are ")[1]?.split(" The Kit refuses")[0] ?? "";
    expect(list).toContain("`CODING_STANDARDS.md` at the repo root");
  });
});

describe("Questions for the Operator", () => {
  it("the Implementer is told to ask them under one fixed heading in its summary", async () => {
    expect(section(await prompt("implement"), "Your output")).toContain('"Questions for the Operator"');
  });

  it("a retry or Request-changes run is told to drop the questions the Operator has answered", async () => {
    expect(section(await prompt("implement"), "The Operator's comments")).toContain('"Questions for the Operator"');
  });

  it("the Reviewer is told an Operator comment may answer them", async () => {
    expect(section(await prompt("review"), "The Operator's comments")).toContain('"Questions for the Operator"');
  });
});
