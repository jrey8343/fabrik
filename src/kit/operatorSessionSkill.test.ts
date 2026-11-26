// The Kit's text for cloud sessions (Spec #918, #952): one of Fabrik's own
// skills, read and never run, held to what the code and the resolutions name.
// Its frontmatter hides it, it spells every tracker operation over REST and no
// command as `gh issue` or `gh pr`, its marker is the line the Kit writes, it
// names the bare Session environment and the keys and file a session reads,
// and its short list is the posture ADR's.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BARE_SESSION_ENVIRONMENT, operatorSessionMarker } from "./operatorSession.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const skill = read("skills/fabrik-operator-session/SKILL.md");

/** The skill's frontmatter lines, between its opening and closing `---`. */
function frontmatter(text: string): string[] {
  const lines = text.split("\n");
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : lines.slice(1, end);
}

/** The posture ADR, found by the name after its number. */
const postureAdr = () => {
  const name =
    "an-operator-session-is-trusted-as-the-operator-up-to-a-short-list-of-acts-which-stop-at-a-pull-request-the-operator-merges-or-at-the-operators-own-hands.md";
  const [file = ""] = readdirSync(new URL("docs/adr/", root)).filter((entry) => entry.slice(5) === name);
  return read(`docs/adr/${file}`);
};

const SHORT_LIST = [
  "a merge into a default branch",
  "a production deploy",
  "a release of the Kit",
  "reading or writing a secret's value",
  "deleting data or a resource",
  "a DNS change",
  "a message sent or a thing shared with someone as the Operator beyond GitHub",
  "anything that spends money",
];

describe("The Kit's text for cloud sessions, skills/fabrik-operator-session/ (#952)", () => {
  it("names itself fabrik-operator-session in its frontmatter, and is hidden from the Operator's slash commands", () => {
    const fields = frontmatter(skill);

    expect(fields).toContain("name: fabrik-operator-session");
    expect(fields).toContain("user-invocable: false");
    expect(fields.some((line) => line.startsWith("description: "))).toBe(true);
  });

  it.each([
    "repos/<owner>/<repo>/issues/<n>",
    "repos/<owner>/<repo>/issues/<n>/comments",
    "repos/<owner>/<repo>/issues/comments/<comment id>",
    "repos/<owner>/<repo>/issues/<n>/labels",
    "repos/<owner>/<repo>/issues/<n>/labels/<label>",
    "repos/<owner>/<repo>/issues/<n>/assignees",
    "repos/<owner>/<repo>/issues -f title=<title>",
    "repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=",
    "repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by -F issue_id=",
    "--paginate repos/<owner>/<repo>/issues/<parent>/sub_issues",
    "--paginate repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by",
    "repos/<owner>/<repo>/pulls?head=<owner>:<branch>&state=open",
    "repos/<owner>/<repo>/pulls -f title=<title> -f head=<branch> -f base=<default branch>",
    "repos/<owner>/<repo>/pulls/<n>",
    "repos/<owner>/<repo>/actions/workflows/<file>/dispatches -f ref=<default branch>",
    "-f state=closed -f state_reason=completed",
  ])("spells the REST form %s", (path) => {
    expect(skill).toContain(path);
  });

  it("puts every body and comment in a file, never inline", () => {
    expect(skill).toContain("-F body=@<file>");
    expect(skill).not.toMatch(/-[fF] body=(?!@<file>)/);
  });

  it("spells no command as gh issue <verb> or gh pr <verb>", () => {
    expect(skill).not.toMatch(/\bgh (issue|pr) [a-z]/);
  });

  it("shows the marker as the line operatorSessionMarker writes, with session_<id> for the address", () => {
    const lines = skill.split("\n").map((line) => line.trim());
    const marker = operatorSessionMarker("https://claude.ai/code/session_<id>");

    expect(lines).toContain(marker);
    expect(lines).toContain("This issue is being worked in [an Operator session](https://claude.ai/code/session_<id>).");
    expect(lines[lines.indexOf(marker) + 1]).toBe("This issue is being worked in [an Operator session](https://claude.ai/code/session_<id>).");
  });

  it.each([`\`${BARE_SESSION_ENVIRONMENT}\``, "`console.app_id`", "`console.held_workflows`", "`.fabrik/operator-session.md`"])("names %s", (name) => {
    expect(skill).toContain(name);
  });

  it.each(SHORT_LIST)("names the short-list act %s", (act) => {
    expect(skill).toContain(act);
  });

  it("gives the short list as the posture's ADR gives it, in its order", () => {
    const adrList = /gets a stop the session can't make or fake: ([^.]+)\./.exec(postureAdr())?.[1] ?? "";

    expect(adrList).toBe(`${SHORT_LIST.slice(0, -1).join(", ")}, and ${SHORT_LIST.at(-1)}`);
    expect(skill).toContain(`So a short list of acts that can't be undone is never yours: ${adrList}.`);
  });
});

describe("The connector check before any work (#996)", () => {
  const step = /\n3\. \*\*Connectors\.\*\* ([^\n]+)/.exec(skill)?.[1] ?? "";

  it("names Claude Docs, by its tools, as the connector that comes with the account and stops no session", () => {
    expect(step).toContain("Claude Docs (`mcp__Claude_Docs__*`) comes with every Claude account and can't be disconnected, so it stops nothing");
  });

  it("still stops on any other connector the repo's file doesn't name", () => {
    expect(step).toContain("If the list holds any other connector's tools and this repo's `.fabrik/operator-session.md` doesn't name that connector, say which as your first words and do no work until the Operator says to go on or starts again.");
  });

  it("calls the tools of no connector the file doesn't name, Claude Docs' included", () => {
    expect(step).toContain("Call none of the tools of a connector the file doesn't name, Claude Docs' included, either way.");
  });
});
