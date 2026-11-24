// What the README tells a reader of the Kit about the Console check (#920):
// that the Required checks read leaves it out by its name, and hands it back
// as a fact of its own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONSOLE_CHECK } from "./index.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
/** The README's section on reading the Kit from another program. */
const section = readme.split("\n## Reading the Kit from another program\n")[1]?.split("\n## ")[0] ?? "";

const BULLET =
  "- **The Console check.** `readRequiredChecks` leaves the Console check, `CONSOLE_CHECK` (`Merge from the Console`), out of `required` and out of every head's list, by its name alone, wherever the branch requires it, in its protection or an active ruleset. Nothing a reader builds from the Required checks waits on it or names it as in the way, and a branch that requires nothing else reads as requiring nothing. The read hands it back as a fact of its own, `consoleCheck`: `required`, with `apps`, the id of the GitHub App GitHub expects it from in each place the branch requires it, the protection's first, or null where one names no App; `not-required`; or `unknown` when the branch couldn't be read. A reader that knows its own App's id can tell a covered repo whose branch doesn't require the check yet, and one that expects it from another App, whose heads it could never pass. Which repos the Console covers is the Kit config's `console.app_id` (see [Kit config](#kit-config)).";

describe("the README's section on reading the Kit from another program, on the Console check", () => {
  it("holds the Console check's bullet as written", () => {
    expect(section.split("\n")).toContain(BULLET);
  });

  it("puts it straight after the bullet on Runs in flight and the bullets under it", () => {
    const leads = section.split("\n").filter((line) => line.startsWith("- **"));

    expect(leads[leads.findIndex((line) => line.startsWith("- **Runs in flight.**")) + 1]).toBe(BULLET);
  });

  it("names the check as the read library's constant does", () => {
    expect(BULLET).toContain(`\`CONSOLE_CHECK\` (\`${CONSOLE_CHECK}\`)`);
  });
});
