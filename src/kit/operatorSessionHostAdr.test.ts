// The ADR on where an Operator session runs (Spec #918, #947): found by the
// name after its number, under a number of its own, in the form the others
// take, with the sentences the Spec's other Tickets lean on.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const NAME = "an-operator-session-runs-in-a-claude-code-cloud-session-started-by-a-link-and-the-console-draws-no-chat.md";
const TITLE = "# An Operator session runs in a Claude Code cloud session, started by a link, and the Console draws no chat";

const adrFiles = () => readdirSync(new URL("docs/adr/", root));
const found = () => adrFiles().filter((file) => file.slice(5) === NAME);

describe("The ADR on where an Operator session runs (#947)", () => {
  it("is found by the name after its number, and its number is held by no other ADR", () => {
    expect(found()).toHaveLength(1);
    const [file = ""] = found();
    expect(file).toMatch(/^\d{4}-/);
    const number = file.slice(0, 4);
    expect(adrFiles().filter((other) => other.slice(0, 4) === number)).toEqual([file]);
  });

  it("has its title as its first line, and the two sections the others have", () => {
    const adr = read(`docs/adr/${found()[0]}`);

    expect(adr.split("\n")[0]).toBe(TITLE);
    expect(adr).toContain("\n## Considered options\n");
    expect(adr).toContain("\n## Consequences\n");
  });

  it.each([
    "**No fallback is built.**",
    "`operator-sessions` for the bare one",
    "`console.session_environment`",
    "`FABRIK_SESSION_ENVIRONMENT`",
    "`fabrik-operator-session`",
    "by a shallow git fetch from `github.com`",
  ])("holds %s as written", (sentence) => {
    expect(read(`docs/adr/${found()[0]}`)).toContain(sentence);
  });
});
