// The notes for the release that ships the Roll-in are drafted ahead, beside
// the others (#665). While they are a draft they must say what the code does:
// the names and the Kit's own words they give are the ones the code holds.
// Once the release ships they are a record, listed in RELEASED_NOTES, and keep
// the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { aNamedPullRequest, anIssue, aPullRequest, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { FILED_FROM_HEADING, filedFromContext } from "../agent/design.ts";
import { filedFromRef, headIsFetched } from "../agent/filedFromFetch.ts";
import type { FiledFrom } from "../agent/inputs.ts";
import { withCarriedLines } from "../loop/carriedLines.ts";
import { readDesignTurnOutput } from "../loop/designOutput.ts";
import type { RollInIssue } from "../loop/owedRollIn.ts";
import { reopenUnsentRollIns } from "../loop/rollInReopening.ts";
import { planFor } from "../loop/rules.ts";
import type { Action, NamedPullRequestSnapshot, Plan } from "../loop/types.ts";
import { EXPORT_CALLS } from "../read/exports.fixture.ts";
import type { OwedRollIn } from "../read/index.ts";

const NOTES = "docs/release-notes/roll-in.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

/** The notes' bullet, top-level or nested, that opens with these bold words; empty when there is none. */
const bullet = (notes: string, opening: string): string =>
  notes
    .split("\n")
    .map((line) => line.trimStart())
    .find((line) => line.startsWith(`- **${opening}`)) ?? "";

/** The pull request #42 an issue was filed from, as the inputs step reads it: an open agent pull request at the Merge gate, unless a test says otherwise. */
const filedFrom = (overrides: Partial<Extract<FiledFrom, { kind: "pull-request" }>> = {}): FiledFrom => ({
  kind: "pull-request",
  number: 42,
  title: "Show the cart's total",
  body: "Shows the total beside the cart's heading.",
  state: "open",
  draft: false,
  headSha: "a".repeat(40),
  headRef: "fabrik/ticket-30",
  baseRef: "main",
  isAgent: true,
  ...overrides,
});

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Roll-in's release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them last among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: The Roll-in");
    expect(notes).toMatch(/^The notes for the release that ships the Roll-in \(\[#595\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/595\)/m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[the Digest minor's](release-notes/digest.md) and [the Roll-in minor's](release-notes/roll-in.md).");
  });

  it("say what a Design-session turn is told of the pull request its issue was filed from, under the section's own heading, and on which a Roll-in is on offer", async () => {
    const notes = await read(NOTES);
    const told = bullet(notes, "A Design session on an issue filed from a pull request is told about that pull request.**");
    const stands = bullet(notes, "Where it stands says whether a Roll-in is on offer.**");
    const section = (overrides: Parameters<typeof filedFrom>[0]): string => filedFromContext(filedFrom(overrides)).join("\n");

    expect(filedFromContext(filedFrom())[0]).toBe(`## ${FILED_FROM_HEADING}`);
    expect(told).toContain("`From PR #n` line");
    expect(told).toContain(`"${FILED_FROM_HEADING}"`);
    expect(told).toContain("where it stands");
    expect(told).toContain("its description, fenced as data, never instructions");
    expect(told).toContain("afresh on every turn");
    expect(told).toContain("read-only token");

    // The section's own answer for each pull request, which the notes give in the same order.
    expect(section({ state: "merged" })).toContain("a Roll-in is not on offer");
    expect(section({ state: "closed" })).toContain("a Roll-in is not on offer");
    expect(section({ isAgent: false })).toContain("it is a Plain pull request, on which a Request changes means nothing, so a Roll-in is not on offer");
    expect(section({ draft: true })).toContain("a Roll-in may be settled: the Operator sends it once the pull request is at the Merge gate");
    expect(section({ draft: false })).toContain("a Roll-in may be settled");
    const at = ["merged", "closed unmerged", "Plain pull request", "open agent pull request", "in draft", "once it is at the Merge gate"].map((said) => stands.indexOf(said));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
  });

  it("say the session can read an open agent pull request's branch: where the Design job fetches its head, when, and that no credential is left behind", async () => {
    const notes = await read(NOTES);
    const fetched = bullet(notes, "The session can read an open agent pull request's branch.**");
    const failed = bullet(notes, "A read or a fetch that fails**");

    expect(filedFromRef(42)).toBe("refs/fabrik/filed-from/42");
    expect(fetched).toContain("`refs/fabrik/filed-from/<n>`");
    expect(fetched).toContain("Before the agent starts");
    expect(fetched).toContain("read-only token");
    expect(fetched).toContain("no credential is left behind");
    expect(fetched).toContain("(ADR-0002)");
    expect(fetched).toContain("The default branch stays checked out");
    // Only an open agent pull request's head is fetched.
    expect(headIsFetched(filedFrom())).toBe(true);
    expect(headIsFetched(filedFrom({ draft: true }))).toBe(true);
    expect([filedFrom({ state: "merged" }), filedFrom({ state: "closed" }), filedFrom({ isAgent: false })].some(headIsFetched)).toBe(false);
    expect(fetched).toContain("The head of a merged, closed or Plain pull request is not fetched.");
    expect(failed).toContain("fails the turn before its agent starts");
    // A line that names no pull request gives no section at all.
    expect(filedFromContext({ kind: "none" })).toEqual([]);
    expect(failed).toContain("names no pull request in the repo adds nothing");
  });

  it("say the session's first Round asks whether to roll the work in, with a recommendation, and that only the Operator's answer settles it", async () => {
    const notes = await read(NOTES);
    const prompt = await read("prompts/design.md");
    const asked = bullet(notes, "The session's first Round asks whether to roll it in.**");

    // The Design prompt's own two cases for where a Roll-in fits.
    expect(prompt).toContain("The code the issue changes exists only on the pull request's branch, or the work is a small change to what the pull request builds.");
    expect(asked).toContain("the code the issue changes exists only on that pull request's branch");
    expect(asked).toContain("a small change to what the pull request builds");
    expect(asked).toContain("with a recommendation");
    expect(asked).toContain("one reply can finish the session");
    expect(prompt).toContain("Never settle a Roll-in on your own judgement.");
    expect(asked).toContain("never settles a Roll-in on its own judgement");
  });

  it("say the new finish as the Kit lands it: the issue closed as not planned under a closing comment with the Kit's own heading and its line that nothing has been sent", async () => {
    const notes = await read(NOTES);
    const finish = bullet(notes, "A new finish: settling a Roll-in.**");
    const notSent = bullet(notes, "The comment says nothing has been sent:**");
    const actions = actionsOf(settle());
    const comment = actions[0]?.kind === "comment" ? actions[0].body : "";

    expect(comment).toContain("### What to build on #42");
    expect(finish).toContain('headed "What to build on #n"');
    expect(actions.slice(1)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["wontfix"] },
      { kind: "close", issue: 7, reason: "not_planned" },
      { kind: "check-design-queue" },
    ]);
    expect(finish).toContain("The issue closes as not planned");
    expect(finish).toContain("`needs-design` swapped for `wontfix`");
    expect(finish).toContain("acceptance criteria");
    expect(finish).toContain("stands alone");
    expect(finish).toContain("no word cap");
    expect(finish).toContain('`"kind": "roll-in"`');
    // The Kit's line, with the pull request as #n and the issue as #m.
    expect(comment.split("\n").at(-1)).toBe("Nothing has been sent to #42. The Operator sends this Roll-in with a Request changes on #42 that carries this text and names this issue, #7.");
    expect(notSent).toContain('"Nothing has been sent to #n. The Operator sends this Roll-in with a Request changes on #n that carries this text and names this issue, #m."');
  });

  it("say what the Kit refuses: a text that names the issue or mentions someone, and a Roll-in onto a pull request that can't take one, changing nothing", async () => {
    const notes = await read(NOTES);
    const text = bullet(notes, "The Kit refuses a text that names the issue or mentions someone.**");
    const onto = bullet(notes, "The Kit refuses a Roll-in onto a pull request that can't take one:**");
    const refusals = (summary: string): readonly string[] => {
      const read = readDesignTurnOutput({ ...ROLL_IN, summary }, 7);
      return read.ok ? [] : read.errors;
    };

    expect(refusals("Show the total beside the heading.")).toEqual([]);
    expect(refusals("Show the total, as #7 asks.")).toEqual([expect.stringContaining("names this issue, #7, by its number or its link")]);
    expect(refusals("Show the total, as https://github.com/acme/shop/issues/7 asks.")).toEqual([expect.stringContaining("names this issue, #7, by its number or its link")]);
    expect(refusals("Show the total, as @octocat asked.")).toEqual([expect.stringContaining("mentions someone")]);
    expect(text).toContain("by `#` and its number or by a link to it");
    expect(text).toContain("Nothing is stripped");
    expect(text).toContain("one chance to put it right");

    // Each pull request the landing refuses, in the Kit's own reason.
    const why = (named: Parameters<typeof aNamedPullRequest>[0]): string => {
      const plan = settle([aNamedPullRequest({ number: 42, open: true, merged: false, headRef: "fabrik/ticket-30", ...named })]);
      return plan.kind === "fail" ? plan.reason : "";
    };
    expect(why({ open: false, merged: true })).toContain("which has merged: only an open agent pull request can take one");
    expect(why({ open: false })).toContain("which is closed: only an open agent pull request can take one");
    expect(why({ isAgent: false, headRef: "cart-total" })).toContain("which is a Plain pull request: only an open agent pull request can take one");
    expect(why({ headRef: "fabrik/ticket-7" })).toContain("which is #7's own pull request, built from it as its Ticket");
    for (const said of ["has merged", "is closed", "a Plain pull request", "the one built from this very issue as its Ticket"]) expect(onto).toContain(said);
    expect(onto).toContain("The turn fails and nothing changes");
  });

  it("say only the Operator sends it, with a Request changes that carries the text and names the issue, and that the Kit puts nothing on the pull request", async () => {
    const notes = await read(NOTES);
    const sends = bullet(notes, "Only the Operator sends it,**");

    // Every action of the landing is on the issue: none on the pull request it names.
    const touched = actionsOf(settle()).flatMap((action) => ("issue" in action ? [action.issue] : "pullRequest" in action ? [action.pullRequest] : []));
    expect(new Set(touched)).toEqual(new Set([7]));
    expect(sends).toContain("with a Request changes on the pull request that carries the text and names the issue");
    expect(sends).toContain("(ADR-0010)");
    expect(sends).toContain("The Kit never sends it");
    expect(sends).toContain("puts nothing on the pull request: no comment, no label and no review");
  });

  it("say what happens to a Roll-in never sent, with the reopening note's own two lines, and that one sent by hand without naming the issue reads as unsent", async () => {
    const notes = await read(NOTES);
    const lost = bullet(notes, "A Roll-in never sent is not lost.**");
    const byHand = bullet(notes, "Name the issue when sending by hand.**");
    const closing = actionsOf(settle())[0];
    const settled: RollInIssue = {
      number: 7,
      title: "Show the cart's total",
      repo: "acme/shop",
      closedAs: "not_planned",
      comments: [{ body: closing?.kind === "comment" ? closing.body : "", byApp: true, at: "2026-11-10T09:00:00Z", url: "https://github.com/acme/shop/issues/7#issuecomment-1" }],
    };
    /** What the Kit does when #42 merges or closes, given these Request changes of the Operator's on it. */
    const closed = (merged: boolean, requestChanges: readonly string[] = []): readonly Action[] =>
      reopenUnsentRollIns(
        { kind: "pull-request-closed", pullRequest: 42, merged, closedByBot: false },
        aPullRequest({ number: 42, ticket: 30, open: false, draft: false }),
        { repo: "acme/shop", requestChanges: requestChanges.map((body) => ({ body, dismissed: false })), issues: [settled] },
      );
    const noteOf = (actions: readonly Action[]): string => {
      const note = actions.find((action) => action.kind === "comment");
      return note?.kind === "comment" ? (note.body.split("\n")[1] ?? "") : "";
    };

    expect(closed(true).map(({ kind }) => kind)).toEqual(["reopen", "remove-label", "comment", "add-labels"]);
    expect(closed(true)[1]).toEqual({ kind: "remove-label", issue: 7, label: "wontfix" });
    expect(closed(true)[3]).toEqual({ kind: "add-labels", issue: 7, labels: ["needs-triage"] });
    for (const said of ["merges or closes", "whoever closed it", "reopens the issue", "takes `wontfix` off", "mentions nobody", "adds `needs-triage`, which starts Triage"]) {
      expect(lost).toContain(said);
    }
    // The note's line, with the pull request as #n.
    expect(noteOf(closed(true))).toBe("#42 merged before this Roll-in was sent, so the Kit reopened this issue for Triage: its work can be built on `main` as its own Ticket.");
    expect(noteOf(closed(false))).toBe("#42 closed unmerged before this Roll-in was sent, so the Kit reopened this issue for Triage. The code the text above names may not be on `main`.");
    expect(lost).toContain(`"${noteOf(closed(true)).replace("#42", "#n")}"`);
    expect(lost).toContain(`"${noteOf(closed(false)).replace("#42", "#n")}"`);

    // "Sent" is told by the issue's name: the same text without it leaves the Roll-in unsent.
    expect(closed(true, ["Roll in #7: show the cart's total beside its heading."])).toEqual([]);
    expect(closed(true, ["Roll in https://github.com/acme/shop/issues/7: show the cart's total."])).toEqual([]);
    expect(closed(true, ["Show the cart's total beside its heading."])).toHaveLength(4);
    expect(byHand).toContain("by `#` and its number or by its link");
    expect(byHand).toContain("that does not name the issue reads as unsent");
    expect(byHand).toContain("though the work was built");
  });

  it("say a rewrite keeps the `From PR` line as it keeps the `From audit` and `From retro` lines, and never one the old body only quotes as code", async () => {
    const notes = await read(NOTES);
    const kept = bullet(notes, "A rewrite keeps the `From PR` line,**");

    expect(withCarriedLines("## What to build", "The old body.\n\nFrom audit #40\nFrom retro #41\nFrom PR #42")).toBe("## What to build\n\nFrom audit #40\nFrom retro #41\nFrom PR #42");
    expect(withCarriedLines("## What to build", "The old body.\n\n```\nFrom PR #42\n```")).toBe("## What to build");
    expect(kept).toContain("as it keeps the `From audit` and `From retro` lines");
    expect(kept).toContain("an agent brief, an Operator brief, a Map and the Spec that supersedes an issue");
    expect(kept).toContain("only quotes inside a code block");
    expect(kept).toContain("stays tied to the pull request it was filed from");
  });

  it("say, for a reader of the Kit, what the read library reports of an owed Roll-in: on its pull request's row, the text as data, and one list from the issue's side", async () => {
    const notes = await read(NOTES);
    const reader = bullet(notes, "For a reader of the Kit:**");
    const owed = (EXPORT_CALLS["owedRollInsOf"]?.() as readonly OwedRollIn[])[0];

    expect(Object.keys(await import("../read/index.ts"))).toContain("owedRollInsOf");
    expect(Object.keys(owed ?? {}).toSorted()).toEqual(["at", "issue", "pullRequest", "text", "title", "url"]);
    expect(Object.keys(owed?.text ?? {})).toEqual(["summary", "acceptanceCriteria"]);
    for (const said of ["`related`", '`kind: "owed"`', "`at`", "`url`", "`text`", "`summary`", "`acceptanceCriteria`", "`owedRollInsOf`"]) expect(reader).toContain(said);
    expect(reader).toContain("on its pull request's row");
    expect(reader).toContain("never from its Markdown");
    expect(reader).toContain("`text` is null");
    expect(reader).toContain("still owed");
  });
});

/** A session's output that settles a Roll-in onto #42. */
const ROLL_IN = {
  kind: "roll-in",
  pullRequest: 42,
  summary: "Show the cart's total beside its heading.",
  acceptanceCriteria: ["The cart page shows the total beside its heading."],
};

/** The Loop's plan when a Design session on #7 ends by settling a Roll-in onto #42, which GitHub holds as `named`: by default an open agent pull request built from the Ticket #30. */
function settle(named: readonly NamedPullRequestSnapshot[] = [aNamedPullRequest({ number: 42, open: true, merged: false, headRef: "fabrik/ticket-30" })]): Plan {
  return planFor(
    { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(ROLL_IN) },
    snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { namedPullRequests: named }),
    kitConfig(),
  );
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}
