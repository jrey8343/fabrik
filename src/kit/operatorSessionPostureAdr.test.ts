// The ADR on an Operator session's posture (Spec #918, #946): found by the
// name after its number, under a number of its own, in the form the others
// take, with the short list and the sentences the Spec's other Tickets lean on.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const NAME =
  "an-operator-session-is-trusted-as-the-operator-up-to-a-short-list-of-acts-which-stop-at-a-pull-request-the-operator-merges-or-at-the-operators-own-hands.md";
const TITLE =
  "# An Operator session is trusted as the Operator up to a short list of acts, which stop at a pull request the Operator merges or at the Operator's own hands";
const SHORT_LIST =
  "a merge into a default branch, a production deploy, a release of the Kit, reading or writing a secret's value, deleting data or a resource, a DNS change, a message sent or a thing shared with someone as the Operator beyond GitHub, and anything that spends money";

const adrFiles = () => readdirSync(new URL("docs/adr/", root));
const found = () => adrFiles().filter((file) => file.slice(5) === NAME);
const adr = () => read(`docs/adr/${found()[0]}`);

describe("The ADR on an Operator session's posture (#946)", () => {
  it("is found by the name after its number, and its number is held by no other ADR", () => {
    expect(found()).toHaveLength(1);
    const [file = ""] = found();
    expect(file).toMatch(/^\d{4}-/);
    const number = file.slice(0, 4);
    expect(adrFiles().filter((other) => other.slice(0, 4) === number)).toEqual([file]);
  });

  it("has its title as its first line, and the two sections the others have", () => {
    expect(adr().split("\n")[0]).toBe(TITLE);
    expect(adr()).toContain("\n## Considered options\n");
    expect(adr()).toContain("\n## Consequences\n");
  });

  it("names all eight short-list acts, as written, in its first paragraph", () => {
    const firstParagraph = adr().split("\n\n")[1];

    expect(firstParagraph).toContain(`A short list of acts that can't be undone gets a stop the session can't make or fake: ${SHORT_LIST}.`);
  });

  it.each([
    "A session's merge is stopped by the Console check",
    "`.fabrik/operator-session.md`",
    "Held workflow",
    "no more than 15 minutes old when the first job reads it",
    "The Console's App has a private key",
    "](../../README.md#operator-sessions)",
  ])("holds %s as written", (sentence) => {
    expect(adr()).toContain(sentence);
  });

  it("never says the Console's App has no private key, nor that the terminal's Pairing session is unchanged", () => {
    expect(adr()).not.toContain("has no private key");
    expect(adr()).not.toMatch(/Pairing session in the Operator's terminal[^.]*is unchanged/);
  });
});
