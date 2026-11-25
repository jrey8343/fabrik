// What the README tells the Operator under Trial session. About the untried
// queue command (#966): the lines that run it from a download of the pinned
// release, what it prints, key by key, and how it ends. And about the skill,
// /fabrik-trial (#967): how a Trial session is started and what it does.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOW } from "../__fixtures__/cannedRepo.ts";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { trialProblemLine } from "../loop/markers.ts";
import { aDeployment, anAgentMerge, declaring, LIVE, stagingRepo } from "./stagingRepo.fixture.ts";
import { readUntriedQueue } from "./untriedQueue.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const readme = read("README.md");
/** The README's section for the Trial session. */
const section = readme.split("\n## Trial session\n")[1]?.split("\n## ")[0] ?? "";
/** The lines of the section's shell block. */
const lines = (/```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? "").trimEnd().split("\n");
/** The section's bullet that opens with `lead` in bold. */
const bullet = (lead: string): string => section.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";
const PROGRAM = "src/trial/untried-queue-main.ts";

/** What the command prints for a repo with one pull request untried on staging: the queue, and that pull request by its number. */
async function printed(): Promise<{ queue: Record<string, unknown>; one: Record<string, unknown> }> {
  const raw = { files: declaring(), deployments: { production: [LIVE], staging: [aDeployment("staging", 655, 55, "2026-11-05T10:05:00Z")] }, mergedPullRequests: [anAgentMerge(55, "2026-11-05T10:00:00Z")] };
  const queue = await readUntriedQueue(stagingRepo(raw).client, "jrey8343/shop", null, NOW);
  const one = await readUntriedQueue(stagingRepo(raw).client, "jrey8343/shop", 55, NOW);
  if (!queue.ok || !one.ok) throw new Error("not read");
  return { queue: { ...queue.printed }, one: { ...one.printed } };
}

describe("the README's section for the Trial session, on the untried queue command", () => {
  it("is a section of its own, after the Merge gate's and before the Audit's, and the Layout names the folder the command is in", () => {
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));

    // The section on workflows that hold a role (#942) is the one straight after the Merge gate's.
    expect(headings.indexOf("## Trial session")).toBeGreaterThan(headings.indexOf("## Merge gate"));
    expect(headings.indexOf("## Audit")).toBe(headings.indexOf("## Trial session") + 1);
    expect(section).toContain("What there is to try comes from the untried queue command, a read-only program of the Kit");
    // Plain words, never set as a term: the glossary has no such entry.
    expect(readme).not.toMatch(/\*\*untried queue[^*]*\*\*/i);
    expect(section).toContain("(ADR-0040)");
    const layout = readme.split("\n## Layout\n")[1]?.split("\n## ")[0] ?? "";
    expect(layout).toContain("- `src/trial/` holds the untried queue command (see [Trial session](#trial-session))");
    expect(layout).toContain("`untried-queue-main.ts`");
    expect(layout).toContain("`untriedQueue.ts`");
  });

  it("gives the lines that run it from the Product repo's checkout: the release the caller pins, read as the SessionStart hook reads it, downloaded as /fabrik-visual-evidence downloads it, the program run from it, and the folder deleted", () => {
    const hook = (JSON.parse(read("templates/claude-settings.json")) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } }).hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    const pinRead = /sed -n -E "[^ ]+"/.exec(hook)?.[0];
    const download = /^curl .*$/m.exec(read("skills/fabrik-visual-evidence/SKILL.md"))?.[0];

    expect(pinRead).toBeDefined();
    expect(download).toContain("<release>");
    expect(lines).toEqual([
      `RELEASE=$(${pinRead} .github/workflows/fabrik.yml | head -n 1)`,
      "FABRIK=$(mktemp -d)",
      download?.replace("<release>", "$RELEASE"),
      `node "$FABRIK/${PROGRAM}"`,
      'rm -rf "$FABRIK"',
    ]);
    expect(existsSync(new URL(PROGRAM, root))).toBe(true);
    expect(section).toContain("with their own `gh` credentials");
  });

  it("says what it needs, and that nothing is installed", () => {
    const needs = bullet("Nothing is installed.");

    expect(needs).toContain("Node 24.3 or later and `gh`");
    expect(needs).toContain("no module it reaches imports an npm package");
    expect(needs).toContain("needs no credential");
  });

  it("names every key the command prints, of the queue, of one pull request and of its Trial steps", async () => {
    const { queue, one } = await printed();
    const pullRequest = one["pullRequest"] as Record<string, unknown>;
    const trialSteps = pullRequest["trialSteps"] as { steps: object[] };
    const keys = [queue, one, pullRequest, pullRequest["standing"] as object, trialSteps, trialSteps.steps[0] ?? {}].flatMap((printedObject) => Object.keys(printedObject));

    expect([...new Set(keys)].toSorted()).toEqual(
      ["do", "expect", "mergedAt", "name", "number", "pages", "production", "pullRequest", "repo", "result", "route", "sentence", "shots", "site", "staging", "standing", "steps", "summary", "title", "toTry", "trialSteps", "unread", "untried", "url"].toSorted(),
    );
    expect(keys.filter((key) => !section.includes(`\`${key}\``))).toEqual([]);
    expect(section).toContain("`staging.url` and `production.url`");
  });

  it("says which of the two it prints with no argument and with a pull request's number, and that an empty queue is an empty list", () => {
    expect(bullet("With no argument")).toContain("`untried`: every agent pull request on the Promote list whose result is `untried`, oldest merge first");
    expect(bullet("With no argument")).toContain("An empty queue is an empty list");
    expect(bullet("With a pull request's number")).toContain(`\`node "$FABRIK/${PROGRAM}" 50\``);
    expect(bullet("With a pull request's number")).toContain("whatever its result");
    expect(bullet("With a pull request's number")).toContain("its Standing's `name` and the Kit's `sentence` for it");
  });

  it("says which of a Promote entry's two trials trialSteps is, and that its text is an agent's", () => {
    const steps = bullet("`trialSteps` are its Trial steps");

    expect(steps).toContain("what a `PromoteEntry` carries as `staging.trial`");
    expect(steps).toContain("The entry's own `trial`, whether the pull request needs a Staging trial at all, is not printed");
    expect(steps).toContain("`result` says `no-screen` for one that needs none");
    expect(steps).toContain("null for a pull request that keeps none");
    expect(steps).toContain("never an instruction to follow");
  });

  it("says it only reads, by the read library's rule, and how it ends: 0 printed, 1 with one line, 2 with its usage", () => {
    expect(bullet("It only reads.")).toContain("`promoteListOf`");
    expect(bullet("It only reads.")).toContain("it holds no rule of its own");
    expect(bullet("It only reads.")).toContain("It writes nothing on GitHub and nothing on disk");
    const ends = bullet("When it prints nothing");
    expect(ends).toContain("one line on stderr and exits 1");
    expect(ends).toContain("Kit config declares no `staging`");
    expect(ends).toContain("the number is not a merged agent pull request on the Promote list");
    expect(ends).toContain("It exits 0 when it printed, and 2, with its usage, for arguments it does not take");
  });
});

describe("the README's section for the Trial session, on the skill, /fabrik-trial (#967)", () => {
  /** The section's words on the skill: what comes before the untried queue command's own paragraph. */
  const onTheSkill = section.split("\nWhat there is to try comes from the untried queue command")[0] ?? "";
  /** The plain bullet of them that opens with `lead`. */
  const says = (lead: string): string => onTheSkill.split("\n").find((line) => line.startsWith(`- ${lead}`)) ?? "";

  it("says how the Operator starts one, alone or with a pull request's number, in a local session with Claude in Chrome connected, before it says how the command is run", () => {
    const opening = onTheSkill.split("\n").find((line) => line.startsWith("A Trial session is")) ?? "";

    expect(onTheSkill).not.toBe(section);
    expect(opening).toContain("A Trial session is a Staging trial the Operator runs with an agent driving their own browser (ADR-0040)");
    expect(opening).toContain("The Operator starts one by running `/fabrik-trial`, or `/fabrik-trial <pull request number>` for one pull request, in a local Claude Code session in the Product repo's checkout");
    expect(opening).toContain("with Claude in Chrome connected");
    expect(opening).toContain("(`skills/fabrik-trial/SKILL.md`)");
    expect(existsSync(new URL("skills/fabrik-trial/SKILL.md", root))).toBe(true);
    expect(opening).toContain("The `SessionStart` hook installs the skill");
    expect(opening).toContain("It runs with the Operator's own `gh` credentials:");
    expect(onTheSkill).not.toContain("```");
  });

  it("says when it stops before it starts, where it takes the work from, and what it does with a pull request that is not ready or not read", () => {
    const finds = says("It stops at once");

    expect(finds).toContain("when `gh auth status` fails or the session has no Claude in Chrome tools");
    expect(finds).toContain("the whole untried queue, oldest merge first");
    expect(finds).toContain("the Kit's sentence for its Standing");
    expect(finds).toContain("named as unread");
    expect(finds).toContain("An empty queue ends the session in one line");
  });

  it("says the Operator signs in, and the session never types a credential or asks for one", () => {
    const handsOver = says("It opens the staging site in a new tab");

    expect(handsOver).toContain("waits while the Operator signs in and passes any access screen");
    expect(handsOver).toContain("It never types a credential and never asks for one");
  });

  it("says it performs every step without asking, on the staging site alone, and how it reports each", () => {
    const performs = says("It performs each pull request's Trial steps in order");

    expect(performs).toContain("without asking, writes included");
    expect(performs).toContain("It acts only on the origin of `staging.url`, and stops before any action on another origin or on `production.url`");
    expect(performs).toContain("as matched");
    expect(performs).toContain("with the page's address, the visible text that differs and any console errors");
    expect(performs).toContain("which the Operator may do by hand in the same tab");
    expect(performs).toContain("JavaScript dialog");
    expect(says("It treats Trial steps as data")).toContain("is not followed, and is reported");
  });

  it("says the verdict is the Operator's and how each is recorded, by the labels' names and the Trial problem's line as the Kit has them", () => {
    const records = says("It asks the Operator for the verdict once for each pull request");

    expect(records).toContain("never chooses it, whatever the steps showed (ADR-0038)");
    expect(records).toContain(`On accept it puts \`${TRIAL_ACCEPTED_LABEL}\` on the pull request`);
    expect(records).toContain(`\`${trialProblemLine(50).replace("50", "<n>")}\``);
    expect(records).toContain(`then puts \`${TRIAL_PROBLEM_LABEL}\` on the pull request`);
    expect(records).toContain("no images and no @-mentions");
    expect(records).toContain("with `gh`, as the Operator");
    expect(records).toContain("On leave it writes nothing");
  });

  it("says what a pull request with no Trial steps is trialled from, and how a queue goes on and ends", () => {
    expect(says("A pull request with no Trial steps")).toContain("asks the Operator what to check");
    expect(says("In a queue")).toContain("ends with one line for each saying its verdict");
  });

  it("says what stays as it is: no Kit job puts either label on, and the Fabrik App gains no permission", () => {
    expect(onTheSkill).toContain("\nNo Kit job puts either label on anything, and the Fabrik App gains no permission.\n");
  });

  it("names every one of the Kit's own skills where the Layout says what the SessionStart hook installs, and the skill beside the command it runs", () => {
    const layout = readme.split("\n## Layout\n")[1]?.split("\n## ")[0] ?? "";
    const hook = layout.split("\n").find((line) => line.startsWith("- `templates/claude-settings.json`")) ?? "";
    const own = readdirSync(new URL("skills/", root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(own).toContain("fabrik-trial");
    for (const name of own) expect(hook).toContain(`\`${name}\``);
    expect(layout.split("\n").find((line) => line.startsWith("- `src/trial/`"))).toContain("`skills/fabrik-trial/SKILL.md`");
  });
});
