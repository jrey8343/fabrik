// The README's "Operator sessions" (Spec #918, #956): what a session is and what
// reaches it, what a repo attaches in `.fabrik/operator-session.md`, the checklist
// run on each Subscription and what is kept by hand, held to the bare Session
// environment's name the read library exports; and the two sentences of Kit config
// that point to it, on the Subscriptions and on the per-phase instructions.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headingAnchor } from "../__fixtures__/headingAnchor.ts";
import { BARE_SESSION_ENVIRONMENT } from "../read/index.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const readme = read("README.md");
const lines = readme.split("\n");
/** Whether each line of the README is inside a fenced block, whose `#` lines are no headings. */
const fenced = lines.reduce<{ inside: boolean; marks: boolean[] }>(
  (acc, line) => {
    const fence = line.startsWith("```");
    acc.marks.push(acc.inside || fence);
    if (fence) acc.inside = !acc.inside;
    return acc;
  },
  { inside: false, marks: [] },
).marks;
/** The README's headings, outside its fenced blocks. */
const headings = lines.filter((line, i) => /^#{2,6} /.test(line) && !fenced[i]);
const anchors = new Set(headings.map((line) => headingAnchor(line.replace(/^#+ /, ""))));

/** The README's `##` section of this title, from its heading to the next `##` heading outside a fenced block. */
function section(title: string): string {
  const start = lines.findIndex((line, i) => line === `## ${title}` && !fenced[i]);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## ") && !fenced[i]);
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}
/** A `###` part of a section, from its heading to the next `###` heading. */
function part(text: string, title: string): string {
  return text.split(`\n### ${title}\n`)[1]?.split("\n### ")[0] ?? "";
}
/** The links a text makes, as their targets. */
const linked = (text: string) => [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");

const sessions = section("Operator sessions");
const attaches = part(sessions, "What a repo attaches: `.fabrik/operator-session.md`");
const checklist = part(sessions, "The checklist, on each Subscription");
const byHand = part(sessions, "What is kept by hand");
/** The skeleton of `.fabrik/operator-session.md`, the fenced Markdown block, without its fences. */
const skeleton = /\n```md\n([\s\S]*?)\n```\n/.exec(attaches)?.[1] ?? "";

describe("the README's Operator sessions", () => {
  it("is the section straight after the Pairing session", () => {
    const sections = headings.filter((line) => line.startsWith("## "));

    expect(sections[sections.indexOf("## Operator sessions") - 1]).toBe("## Pairing session");
  });

  it("has what a repo attaches, the checklist and what is kept by hand, in that order", () => {
    expect(sessions.split("\n").filter((line) => line.startsWith("### "))).toEqual([
      "### What a repo attaches: `.fabrik/operator-session.md`",
      "### The checklist, on each Subscription",
      "### What is kept by hand",
    ]);
  });

  it("makes the anchor every link to Operator sessions names, in the README and the posture's ADR", () => {
    expect(anchors).toContain("operator-sessions");
    expect(linked(readme).filter((target) => target === "#operator-sessions").length).toBeGreaterThanOrEqual(3);

    const posture = read("docs/adr/0042-an-operator-session-is-trusted-as-the-operator-up-to-a-short-list-of-acts-which-stop-at-a-pull-request-the-operator-merges-or-at-the-operators-own-hands.md");
    expect(linked(posture)).toContain("../../README.md#operator-sessions");
  });

  it("links the host's ADR and the posture's ADR by files that exist", () => {
    const adrs = linked(sessions).filter((target) => target.startsWith("docs/adr/"));

    expect(adrs).toEqual([
      "docs/adr/0041-an-operator-session-runs-in-a-claude-code-cloud-session-started-by-a-link-and-the-console-draws-no-chat.md",
      "docs/adr/0042-an-operator-session-is-trusted-as-the-operator-up-to-a-short-list-of-acts-which-stop-at-a-pull-request-the-operator-merges-or-at-the-operators-own-hands.md",
    ]);
    for (const adr of adrs) expect(existsSync(new URL(adr, root))).toBe(true);
  });

  it("links the shape of a workflow that holds a role, and every heading it links, by anchors the README has", () => {
    const headingLinks = linked(sessions).filter((target) => target.startsWith("#")).map((target) => target.slice(1));

    expect(linked(attaches)).toContain("#the-shape-of-a-workflow-that-holds-a-role");
    expect(headingLinks).toEqual(expect.arrayContaining(["pairing-session", "layout", "reading-the-kit-from-another-program"]));
    for (const target of headingLinks) expect(anchors).toContain(target);
  });

  it("says what reaches a session, what it leaves and its Session environments, by the names the Kit uses", () => {
    expect(sessions).toContain("`skills/fabrik-operator-session/SKILL.md`");
    expect(sessions).toContain("`<!-- fabrik:operator-session <address> -->`");
    expect(sessions).toContain("the row's `operatorSession`");
    expect(sessions).toContain("`console.session_environment`");
    expect(sessions).toContain("the variable `FABRIK_SESSION_ENVIRONMENT`");
  });
});

describe("the skeleton of `.fabrik/operator-session.md`", () => {
  it("is headed Operator session, with what is attached, the workflows a session never starts and where customers' records live", () => {
    const rows = skeleton.split("\n");

    expect(rows[0]).toBe("# Operator session");
    expect(rows.filter((row) => row.startsWith("## "))).toEqual([
      "## What is attached",
      "## Workflows a session never starts",
      "## Where customers' records live",
    ]);
  });
});

describe("the checklist, on each Subscription", () => {
  it("names the bare Session environment, its variable, where connectors are cut, and the connection never to make", () => {
    for (const name of ["`operator-sessions`", "`FABRIK_SESSION_ENVIRONMENT", "`claude.ai/customize/connectors`", "`/web-setup`"]) {
      expect(checklist).toContain(name);
    }
  });

  it("names the bare one as the read library does, and sets its variable to that name", () => {
    expect(/the bare Session environment from the environment selector under the message box: named `([^`]+)`/.exec(checklist)?.[1]).toBe(BARE_SESSION_ENVIRONMENT);
    expect(checklist).toContain(`one variable, \`FABRIK_SESSION_ENVIRONMENT=${BARE_SESSION_ENVIRONMENT}\`, and no setup script`);
  });
});

describe("what is kept by hand", () => {
  it("is the Claude GitHub App's list, each Claude account's connection, and a Product repo's own rule", () => {
    expect(byHand.split("\n").filter((line) => line.startsWith("- **")).map((line) => /^- \*\*(.+?)\*\*/.exec(line)?.[1])).toEqual([
      "The Claude GitHub App's list.",
      "GitHub connected to each Claude account through the App,",
      "A Product repo's own rule against agents' cloud credentials,",
    ]);
  });
});

describe("Kit config's sentences on Operator sessions", () => {
  it("has the subscriptions bullet say which account a session draws on, before rotation's list", () => {
    expect(readme).toContain(
      "A list that names `Claude token 2` already, alone or not, has nothing for Setup to list, so it doesn't ask then either. An Operator session runs on whichever Claude account the browser that opens the Console's link is signed in to, and draws on that account's weekly limit beside the Loop. Keep that browser signed in to the last-listed Subscription, so sessions draw on the account the Loop reaches last, and sign it in to another when that one is used up. Each Subscription sessions are opened from holds the same Session environments under the same names. With rotation on:\n",
    );
  });

  it("has the per-phase instructions bullet name `.fabrik/operator-session.md` beside them", () => {
    expect(lines).toContain(
      "- Per-phase instructions are optional Markdown files: `.fabrik/triage.md`, `.fabrik/design.md`, `.fabrik/implement.md` and `.fabrik/review.md`, the Auditor's `.fabrik/audit.md`, the Retro's `.fabrik/retro.md`, the Researcher's `.fabrik/research.md` and the Digest writer's `.fabrik/digest.md`. Beside them, `.fabrik/operator-session.md` says what the repo's Operator sessions can reach, and is read only by an Operator session (see [Operator sessions](#operator-sessions)).",
    );
  });
});
