// `/fabrik-pair` in both places (Spec #918, #954): one skill at the Operator's
// terminal and in a cloud session, which reads the rules it shares with every
// Operator session from `fabrik-operator-session`, merges nothing where the Kit
// config holds `console.app_id`, asks for the tap before a Held workflow, spells
// no `gh issue` or `gh pr` command, and describes the weekly-limit issue with
// rotation off and on as the Kit writes it; and the README's Pairing session.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const skill = read("skills/fabrik-pair/SKILL.md");

describe("the Pairing session's skill, skills/fabrik-pair/SKILL.md (#954)", () => {
  it.each([
    "`.claude/skills/fabrik-operator-session/SKILL.md`",
    "`console.app_id`",
    "`console.held_workflows`",
    "`fabrik/pair-<n>`",
    "`Closes #<n>`",
  ])("names %s", (name) => {
    expect(skill).toContain(name);
  });

  it("names each road to a merge as the one act: gh, REST, and the GitHub MCP server's merge_pull_request and enable_pr_auto_merge", () => {
    expect(skill).toContain(
      "Every road to a merge is the same act: `gh`, REST, and the GitHub MCP server's `merge_pull_request` and `enable_pr_auto_merge`.",
    );
  });

  it("spells no command as gh issue <verb> or gh pr <verb>", () => {
    expect(skill).not.toMatch(/\bgh (issue|pr) [a-z]/);
  });

  it("keeps no copy of the shared rules: no REST form, no marker line, no sort table", () => {
    expect(skill).not.toMatch(/repos\/<owner>\/<repo>/);
    expect(skill).not.toContain("gh api");
    expect(skill).not.toContain("<!-- fabrik:operator-session");
    expect(skill).not.toMatch(/^\|/m);
  });

  it("merges another pull request only at the terminal on a repo with no console.app_id, reading the key from the checkout", () => {
    expect(skill).toContain(
      "A step that is the merge of another pull request is the Operator's, from the Console, in a cloud session and on any repo whose `.fabrik/config.json` holds `console.app_id`. Read the key from the checkout, and never learn it from a refusal. Anywhere else, at the terminal, you merge it on the Operator's word.",
    );
    expect(skill).toContain("you never merge it");
  });

  it("asks for the Operator's tap before it starts a Held workflow, at the terminal too", () => {
    expect(skill).toContain(
      "A workflow the repo's Kit config lists in `console.held_workflows` is started only after the Operator's tap in the Console, at the terminal too: ask for the tap, naming the workflow, then start the run and follow it.",
    );
  });
});

describe("the Pairing session's weekly-limit issue (#954)", () => {
  const weeklyLimit = skill.split("\n## The weekly-limit issue\n")[1]?.split("\n## ")[0] ?? "";

  it("says rotation is off with one Subscription and on with two or more", () => {
    expect(weeklyLimit).toContain("**One Subscription, so rotation is off.**");
    expect(weeklyLimit).toContain("**Two or more, so rotation is on.**");
  });

  it("with rotation off, restarts the stalled Tickets by re-adding their trigger labels once the reset is ticked", () => {
    const off = weeklyLimit.split("**Two or more, so rotation is on.**")[0] ?? "";

    expect(off).toContain("**Restart the stalled Tickets**, only once the reset is ticked");
    expect(off).toContain("tick the step once every stalled Ticket has its label back");
  });

  it("with rotation on, re-adds nothing, since the Kit resumes held runs itself, as the Kit's own step says", () => {
    const on = weeklyLimit.split("**Two or more, so rotation is on.**")[1] ?? "";

    expect(on).toContain("**Nothing to re-add.** The Kit resumes each held run itself, in the order they were held.");
    expect(on).toContain("so nothing is re-added by hand");
    expect(on).not.toMatch(/\bRe-add\b/);
  });
});

describe("the README's Pairing session (#954)", () => {
  const readme = read("README.md");
  /** The README's `##` section of this title, from under its heading to the next `##` heading. */
  const section = (title: string) => readme.split(`\n## ${title}\n`)[1]?.split("\n## ")[0] ?? "";

  it("lands as the Ticket writes it", () => {
    expect(section("Pairing session").trim()).toBe(
      [
        "The Operator works through a `ready-for-human` issue with an agent that counts as the Operator by running `/fabrik-pair <issue>` (`skills/fabrik-pair/SKILL.md`), at their own terminal or in a cloud session, where it is an Operator session (see [Operator sessions](#operator-sessions)). It is one skill in both places. It reads the rules it shares with every Operator session from `fabrik-operator-session` (`skills/fabrik-operator-session/SKILL.md`), the Kit's text for cloud sessions, which the `SessionStart` hook points every cloud session to.",
        "",
        "- It counts as the Operator, so it may change Trust-root files. It refuses an issue that isn't open and `ready-for-human`, except the weekly-limit issue, whose steps it follows as the Kit wrote them: with one Subscription it waits for the reset before restarting the stalled Tickets, and with rotation on it waits for the reset and re-adds nothing, since the Kit resumes held runs itself. It still finishes after the Kit has closed the issue. The issue body's `- [ ]` task list is the plan; with none, the session agrees one with the Operator and writes it in below the original text. A rerun resumes at the first unticked step.",
        "- At the terminal it runs with the Operator's own `gh` credentials, talks the Operator through simple steps, and builds a wizard (`.claude/skills/wizard`) in a temp folder, never committed, for dashboards, credentials or a run of commands. In a cloud session it writes to the tracker over REST, builds no wizard, and before step one sorts every step: done by the session, done by the Operator's hands with the session guiding, or left for a laptop, reading what the repo attaches from `.fabrik/operator-session.md`.",
        "- It ticks each step once a command confirms it or, where nothing can, once the Operator does, and says which. File changes, Trust-root files included, go out at once in one pull request on `fabrik/pair-<n>`, never pushed to the default branch, whose body has `Closes #<n>` only when its merge is the last thing left. It never merges its own pull request. It merges another only at the terminal, on the Operator's word, on a repo whose Kit config holds no `console.app_id`; anywhere else a merge is the Operator's, from the Console. It starts a Held workflow only after the Operator's tap in the Console, at the terminal too.",
        "- It keeps one comment on the issue as its record, edited as it goes: what was done and how it was checked, every system touched and every workflow dispatched, and what is left, with what each left step waits on. In a cloud session that comment opens with the session's marker, which the read library gives as the row's `operatorSession`. When every step is ticked it is the closing comment, and the session closes the issue, or leaves that to the pull request's merge. Stopping partway, it leaves the issue open and assigned. No comment names a secret's value or @-mentions anyone.",
        "",
        "The token-rotation and weekly-limit issues the Kit opens write their steps as a task list and point at `/fabrik-pair`.",
      ].join("\n"),
    );
  });
});
