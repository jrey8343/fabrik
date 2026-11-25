// What the README tells a reader of the Kit about Session environments (#950):
// the bare one's name, and which one a repo's Operator sessions open in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BARE_SESSION_ENVIRONMENT } from "./index.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
/** The README's section on reading the Kit from another program. */
const section = readme.split("\n## Reading the Kit from another program\n")[1]?.split("\n## ")[0] ?? "";

const BULLET =
  "- **Session environments.** `BARE_SESSION_ENVIRONMENT` is `operator-sessions`, the name of the bare Session environment every repo that attaches nothing shares. `sessionEnvironmentOf` takes a repo's resolved Kit config, or null, and gives the name of the Session environment its Operator sessions open in: its `console.session_environment`, or the bare one's where it names none, and where the Kit config wasn't read, is invalid or isn't there. A reader works out no name from a repo's name.";

describe("the README's section on reading the Kit from another program, on Session environments", () => {
  it("holds the Session environments' bullet as written", () => {
    expect(section.split("\n")).toContain(BULLET);
  });

  it("puts it straight after the bullet on reading back what you kept and the bullets under it", () => {
    const leads = section.split("\n").filter((line) => line.startsWith("- **"));

    expect(leads[leads.findIndex((line) => line.startsWith("- **Read back what you kept.**")) + 1]).toBe(BULLET);
  });

  it("leaves the bullets under reading back what you kept under that bullet, not under this one", () => {
    const lines = section.split("\n");

    expect(lines[lines.indexOf(BULLET) + 1]).not.toMatch(/^ {2}- /);
  });

  it("names the bare one as the read library's constant does", () => {
    expect(BULLET).toContain(`\`BARE_SESSION_ENVIRONMENT\` is \`${BARE_SESSION_ENVIRONMENT}\``);
  });
});
