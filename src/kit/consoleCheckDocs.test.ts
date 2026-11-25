// What the Console check is, written down (Spec #914, #924): ADR-0019's
// paragraphs on why the Merge gate holds a covered repo's merges to the
// Console and what that costs, the glossary's three terms, and the README's
// Merge gate section. Each is held as the Ticket wrote it, and every name it
// gives is the code's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONSOLE_CHECK } from "./consoleCheck.ts";
import { resolveKitConfig } from "./config.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const ADR = "docs/adr/0019-the-merge-gate-holds-the-operator-to-the-required-checks.md";

/** The ADR's paragraphs and bullets, each one line of the file. */
const linesOf = (text: string) => text.split("\n").filter((line) => line !== "");

const WAY_PAST =
  "The way past is by hand on github.com: in the branch's settings, switch off \"Do not allow bypassing the above settings\", or take a check that can no longer report off the required list; merge; then run Setup, which puts enforcement back. That is how the Operator merges past a check on purpose, and the only way out when a Required check can never report again, as after a CI job is renamed, when the pull request that corrects the Kit config's list can't itself go green. On a repo the Console covers it is also the only way to merge while the Console is down.";

const NO_KIT_MADE_CHECK_ENDS =
  "So Setup requires what the Kit config lists, plus any check the branch already required, plus the Console check where the Kit config names the Console's App, and never a check the Kit makes.";

const COVERED_REPO =
  "On a Product repo the Console covers, the Merge gate holds a merge to the Console. Setup requires one more check there, the Console check: a check run named `Merge from the Console`, expected from the Console's own GitHub App, whose id the Kit config gives as `console.app_id`. The Console makes it at the Operator's tap of Merge, on the head the screen named, and merges naming that head. GitHub refuses a merge at any head the App has not passed, from an Operator session, the Operator's terminal and github.com alike. It is there because an Operator session acts as the Operator and as the repo's admin, can make its own Required checks green by changing the workflow its branch runs, and was let through by auto mode when it sent the merge as an MCP tool call ([Try a merge stop on GitHub that a cloud session can't pass](https://github.com/jrey8343/fabrik/issues/815)). It is not a Required check and not a Kit-made one: the Kit's read of the branch's list leaves it out by name, so nothing waits on it, re-runs it or names it as in the way. The key says which repos the Console covers, since Setup can't ask GitHub; it is not a choice to leave a covered repo unheld. Decided with the Operator on 2026-11-21 ([How does a Required check only the Console can pass hold a session's merge?](https://github.com/jrey8343/fabrik/issues/842)).";

const OPTIONS = [
  "- **The Console's App as the ruleset's bypass actor, or a commit status expected from the App.** Both refused the Console as well as a session.",
  "- **Taking the Console check back after every merge.** It would close the replay below, and every merged pull request would read as failed on github.com.",
  "- **A deny rule on a session's merge tool.** It sits in settings a session can edit and stops applying once the session has a second repo.",
  "- **A second way past for when the Console is down.** Any way that needs less than Administration is one a session or a leaked token pair has too.",
];

const CONSEQUENCES = [
  "- On a repo the Console covers, every merge goes through the Console, the Operator's own included. github.com's button and `gh pr merge` are refused, and every open pull request shows the Console check there as expected and not yet reported.",
  "- The Console's health is a condition of merging in every repo it covers. `fabrik-console` is outside the Merge gate, so the Console's own fix merges without the Console. The day it comes under the gate, the objection above to a Kit-made check applies to this one, and the by-hand way past is the answer.",
  "- A head the Console has passed is open to anyone who can merge until it is merged or the check is taken back. That is a head the Operator tapped Merge on. The Console takes the check back when GitHub refuses the merge, and takes back any it finds on an open pull request's head.",
  "- The check stays on a merged head. The Console squash-merges, so that head stays outside the default branch, and if the Operator later reverts the change a session could merge the same head again. It could bring back only what the Operator once merged.",
  "- Setup can't tell whether the Console is ready. A repo given the key before the Console can pass a head merges only by hand.",
  "- A repo already on the Kit gets the check when its Kit config gains the key and Setup runs. Until then the Console merges there as before and shows a warning row. A first setup is unchanged: the template has no key.",
  "- `fabrik` and `fabrik-console` are not Product repos under the Merge gate, and nothing here holds a merge into either.",
];

describe("ADR-0019 on the Console check (#924)", () => {
  const lines = linesOf(read(ADR));
  const at = (opening: string) => lines.findIndex((line) => line.startsWith(opening));

  it("keeps its title, its first two paragraphs and the one on reversing it as they stand", () => {
    expect(lines[0]).toBe("# The Merge gate holds the Operator to the Required checks");
    expect(lines[1]).toMatch(/^The Merge gate was two things Setup applied/);
    expect(lines[2]).toMatch(/^So Setup holds admins to the default branch's rules/);
    expect(lines[3]).toMatch(/^The way past is by hand on github\.com/);
    expect(lines[4]).toMatch(/^It is cheap to reverse in code/);
  });

  it("says the by-hand way past is also the only way to merge a covered repo while the Console is down", () => {
    expect(lines[at("The way past is by hand on github.com")]).toBe(WAY_PAST);
  });

  it("ends the paragraph on Kit-made checks with the Console check Setup requires where the Kit config names the App", () => {
    const paragraph = lines[at("No Kit-made check is a Required check")] ?? "";

    expect(paragraph.endsWith(` ${NO_KIT_MADE_CHECK_ENDS}`)).toBe(true);
    expect(paragraph).not.toContain("plus any check the branch already required, and never a check the Kit makes.");
  });

  it("adds the paragraph on a covered repo straight after that one, before the Considered options", () => {
    expect(lines[at("No Kit-made check is a Required check") + 1]).toBe(COVERED_REPO);
    expect(lines[at("No Kit-made check is a Required check") + 2]).toBe("## Considered options");
  });

  it("adds four Considered options after the one on loop / Kit, closing the section", () => {
    const after = at("- **`loop / Kit`, or a new Kit-made check, as a Required check.** Above.");

    expect(lines.slice(after + 1, after + 1 + OPTIONS.length)).toEqual(OPTIONS);
    expect(lines[after + 1 + OPTIONS.length]).toBe("## Consequences");
  });

  it("adds seven Consequences before the one on what was not tried, which still closes the ADR", () => {
    const last = at("- Not tried when this was written");

    expect(lines.slice(last - CONSEQUENCES.length, last)).toEqual(CONSEQUENCES);
    expect(lines[last - CONSEQUENCES.length - 1]).toMatch(/^- The Review can pass a pull request while a check the branch requires/);
    expect(last).toBe(lines.length - 1);
  });

  it("names the check and the key as the code does", () => {
    expect(COVERED_REPO).toContain(`a check run named \`${CONSOLE_CHECK}\``);
    expect(resolveKitConfig({ config: JSON.stringify({ console: { app_id: 7 } }) })).toMatchObject({ ok: true, config: { console: { appId: 7 } } });
    expect(COVERED_REPO).toContain("`console.app_id`");
  });
});
