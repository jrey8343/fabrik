import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPullRequestRunOutput } from "../loop/implementOutput.ts";
import { CONSIDERED_PREFIX, parseVerdict } from "../loop/verdict.ts";
import { OPERATOR_COMMENTS_HEADING } from "./operatorComments.ts";

const prompt = (role: string) => readFile(join(import.meta.dirname, "..", "..", "prompts", `${role}.md`), "utf8");

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

  it("implement describes the output field that names the Operator comments it weighed, which its example carries", async () => {
    const text = await prompt("implement");
    const example: unknown = JSON.parse(/<implement>\n([\s\S]*?)\n<\/implement>/.exec(text)?.[1] ?? "null");
    expect(readPullRequestRunOutput(example)).toMatchObject({ ok: true, output: { operatorCommentsConsidered: ["conversation-3"] } });
    expect(text).toContain("- `operatorCommentsConsidered`");
  });
});
