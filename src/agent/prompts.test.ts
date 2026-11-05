import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATOR_COMMENTS_HEADING } from "./operatorComments.ts";

const prompt = (role: string) => readFile(join(import.meta.dirname, "..", "..", "prompts", `${role}.md`), "utf8");

describe("The prompts of the runs that read an agent PR", () => {
  it.each(["review", "implement", "design"])("%s names the section the Operator's comments arrive under", async (role) => {
    // The prompt's weighing rules point at the section the run's context sets the comments out under.
    expect(await prompt(role)).toContain(`"${OPERATOR_COMMENTS_HEADING}"`);
  });
});
