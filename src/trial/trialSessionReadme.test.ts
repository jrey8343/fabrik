// What the README tells the Operator about the untried queue command (#966),
// under Trial session: the lines that run it from a download of the pinned
// release, what it prints, key by key, and how it ends.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOW } from "../__fixtures__/cannedRepo.ts";
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

    expect(headings.indexOf("## Trial session")).toBe(headings.indexOf("## Merge gate") + 1);
    expect(headings.indexOf("## Audit")).toBe(headings.indexOf("## Trial session") + 1);
    expect(section).toContain("the **untried queue command**");
    expect(section).toContain("(ADR-0040)");
    const layout = readme.split("\n## Layout\n")[1]?.split("\n## ")[0] ?? "";
    expect(layout).toContain("- `src/trial/` holds the **untried queue command** (see [Trial session](#trial-session))");
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
