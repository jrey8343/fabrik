import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anIssue, aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { ASK_ANSWERS } from "../loop/digestContract.ts";
import { spinOffMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { Action, LoopEvent, Plan, Snapshot } from "../loop/types.ts";

// The docs of the second part of the minor in which the Kit opens issues itself (#882, ADR-0039): a Request changes
// that asks for a Spin-off (#884). What they say is checked against the plan, so neither drifts.
const NOTES = "docs/release-notes/kit-opens-issues.md";
const read = (path: string) => readFileSync(`${KIT}/${path}`, "utf8");

/** A glossary entry's definition: the paragraph under its `**Term**:` line. */
const entry = (term: string) => read("GLOSSARY.md").split(`\n**${term}**:\n`)[1]?.split("\n")[0] ?? "";

const RUN = "https://github.com/acme/shop/actions/runs/1/attempts/1";
const ASKS = [
  {
    review: 900,
    asks: [
      { id: "review-900", url: "https://github.com/acme/shop/pull/50#pullrequestreview-900" },
      { id: "inline-9", url: "https://github.com/acme/shop/pull/50#discussion_r9" },
    ],
  },
];

/** A Request-changes run for review 900 on PR 50, passed on its head, landing with a Spin-off for each of these asks. */
function landing(from: readonly string[], changes: Extract<LoopEvent, { kind: "implement-run-finished" }>["changes"]): Plan {
  const event: LoopEvent = {
    kind: "implement-run-finished",
    runUrl: RUN,
    issue: 7,
    output: JSON.stringify({
      title: "Rename the total",
      summary: "Adds the order total.",
      fix: "Set the export aside, as the Operator asked.",
      reviewMiss: false,
      amendsTicket: false,
      spinOffs: from.map((id) => ({ title: "Export the waitlist as CSV", body: 'The Operator wrote: "open the CSV export as its own issue".', from: id })),
    }),
    branch: "fabrik/ticket-7",
    base: "fabrik/ticket-7",
    changes,
    fixes: { pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN, review: 900 },
  };
  const pullRequest = aPullRequest({
    verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }],
    leftDraftSinceVerdict: true,
    notedChangesRequests: [900],
    requestChangesRunInFlight: 900,
    requestChangesRunReviews: [900],
  });
  const snapshot: Snapshot = { ...snapshotOfPullRequest(pullRequest), issue: anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], openPullRequests: [50] }), requestChangesAsks: ASKS };
  return planFor(event, snapshot, kitConfig());
}

const actionsOf = (plan: Plan): readonly Action[] => (plan.kind === "act" ? plan.actions : []);
const noteOf = (plan: Plan): string =>
  actionsOf(plan)
    .flatMap((action) => (action.kind === "comment-linking" ? [action.body.map((part) => (typeof part === "string" ? part : "#57")).join("")] : []))
    .join("\n");

const PUSHED = { net: [{ path: "src/cart.ts" }], commits: [{ path: "src/cart.ts" }] };
const NOTHING = { net: [], commits: [] };

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Kit-opens-issues release notes, on a Request changes' Spin-offs (#884)", () => {
  const notes = read(NOTES);
  const changed = (lead: string) => notes.split("\n").find((line) => line.startsWith(`- **${lead}**`)) ?? "";

  it("say the draft holds a Request changes' Spin-offs among the Spec's parts", () => {
    expect(notes).toContain("a Request changes that asks for a Spin-off ([#884](https://github.com/jrey8343/fabrik/issues/884))");
  });

  it("say in the release-note line that a Request changes can ask for a point to be its own issue", () => {
    const line = notes.split("\n## Release-note line\n")[1]?.split("\n## ")[0] ?? "";
    expect(line).toContain("A Request changes can now ask for a point to be its own issue");
  });

  it("say what asks for a Spin-off: the Operator's words in a Request changes, never an agent's judgement or an Operator comment", () => {
    const asks = changed("A Request changes can ask for a Spin-off.");
    for (const words of ['"open this separately"', '"as its own issue"', '"in a different ticket"']) expect(asks).toContain(words);
    expect(asks).toContain("A point without such words is built, however large or unrelated");
    expect(asks).toContain("An Operator comment asks for none");
  });

  it("say what the Kit opens each one with, as the plan has it", () => {
    const plan = landing(["inline-9"], PUSHED);
    const opened = actionsOf(plan).find((action) => action.kind === "create-issue");
    const with_ = changed("What the Kit opens a Request changes' Spin-off with.");

    expect(opened).toMatchObject({ labels: ["needs-triage"], blockedBy: [{ ticket: 7 }] });
    expect(opened?.kind === "create-issue" ? opened.body.split("\n")[0] : "").toBe(spinOffMarker({ from: "request-changes", pullRequest: 50, review: 900 }));
    expect(opened?.kind === "create-issue" ? opened.body.split("\n").at(-1) : "").toBe("From PR #50");
    expect(with_).toContain("with `needs-triage` and no other label");
    expect(with_).toContain('`<!-- fabrik:spin-off {"from":"request-changes","pullRequest":<n>,"review":<id>} -->`');
    expect(with_).toContain("`From PR #<n>`");
    expect(with_).toContain("a blocked-by edge to the pull request's Ticket");
  });

  it("say how the run's comment lists each one, in the plan's own words", () => {
    const listed = changed("The run's comment lists each one.");

    expect(noteOf(landing(["inline-9"], PUSHED))).toContain(
      "The Kit opened 1 Spin-off, work the Operator's Request changes asked to be an issue of its own, which Triage sorts next. It waits on #7, this pull request's Ticket.",
    );
    expect(noteOf(landing(["inline-9"], PUSHED))).toContain("- #57 Export the waitlist as CSV\n  Asked for in [the Operator's comment on the code](https://github.com/acme/shop/pull/50#discussion_r9)");
    expect(listed).toContain("its number, its title and a link to your words");
    expect(listed).toContain("`<!-- fabrik:spin-off-opened #<issue> {…} -->`");
  });

  it("say when a run that committed nothing returns the pull request to the Merge gate, and when it is handed back, as the plan decides", () => {
    const only = changed("A Request changes of only Spin-offs costs no Review.");
    const everyAsk = landing(["review-900", "inline-9"], NOTHING);
    const oneOfTwo = landing(["inline-9"], NOTHING);

    expect(actionsOf(everyAsk).slice(-2).map((action) => action.kind)).toEqual(["mark-ready-for-review", "request-review"]);
    expect(noteOf(everyAsk)).toContain("is back at the Merge gate at aaaaaaa, where its pass stands. No Review runs, and no retry was used.");
    expect(actionsOf(oneOfTwo)).toContainEqual({ kind: "add-labels", issue: 50, labels: ["ready-for-human"] });
    expect(only).toContain("the run committed nothing, the head did not move, the latest Verdict is a pass on that head, and every ask of every review the run read is named by a Spin-off");
    expect(only).toContain("the review's own words when it has any, and each of your comments on the code in it");
    expect(only).toContain("Anything short of that is handed back");
    expect(only).toContain("its Spin-offs opened all the same");
  });

  it("say what later runs, the Reviewer and the Digest are given, and the Digest's fourth answer by its name", () => {
    expect(changed("Later runs and Reviews are given them.")).toContain('"The points set aside as Spin-offs"');
    expect(changed("Later runs and Reviews are given them.")).toContain("an unbuilt requested change, an Execution flaw");
    const digest = changed("The Digest shows them under the ask.");
    expect(ASK_ANSWERS).toContain("set-aside");
    expect(digest).toContain("`set-aside`");
    expect(digest).toContain("`spinOffs`");
  });

  it("no longer say every point of a Request changes is built, and still say why it is a minor", () => {
    expect(notes).not.toContain("every point of a Request changes is still built on the pull request");
    expect(notes).toContain("a point of a Request changes with no such words is still built on the pull request (ADR-0010)");
    const why = notes.split("\n").find((line) => line.startsWith("- **Why a minor:**")) ?? "";
    expect(why).toContain("No new label, no Setup step and no new App permission is needed");
  });

  it("say the limits the rule has: an ask that holds both, a run that ends without landing, and a landing that fails part-way", () => {
    const limits = notes.split("\n## Known limits\n")[1] ?? "";
    expect(limits).toContain("- **Kit code goes by asks, not by points.**");
    expect(limits).toContain("- **A run that ends without landing opens no Spin-off.**");
    expect(limits).toContain("- **A landing that fails part-way can open a Spin-off twice.**");
  });
});

describe("The glossary's account of a Request changes' Spin-off (#884)", () => {
  it("gives the Spin-off its second source, and says no agent and no Operator comment sets a point aside", () => {
    const spinOff = entry("Spin-off");
    expect(spinOff).toContain("A Request changes opens one for a point the Operator says, in words, is to be its own issue");
    expect(spinOff).toContain("waits on the pull request's Ticket");
    expect(spinOff).toContain("No agent sets a point aside on its own judgement, and an Operator comment asks for none.");
  });

  it("amends Request changes: however large the change, it's built, but for a point asked for as a Spin-off", () => {
    expect(entry("Request changes")).toContain("However large the change, it's built, but for a point the Operator asks, in words, to be its own issue, which the Kit opens as a Spin-off");
  });

  it("amends Retry, for the run of only Spin-offs", () => {
    expect(entry("Retry")).toContain(
      "A Request-changes run whose review asked only for Spin-offs commits nothing, gets no Verdict and uses no Retry: the pull request returns to the Merge gate on the pass it had.",
    );
  });

  it("says a point set aside as a Spin-off is no Review miss", () => {
    expect(entry("Review miss")).toContain("A point that amends the Ticket, one set aside as a Spin-off, or one that only asks for a rebase, is none");
  });
});

describe("ADR-0039 and ADR-0010, on a Request changes' Spin-offs (#884)", () => {
  const file = (prefix: string) => readdirSync(`${KIT}/docs/adr`).find((name) => name.startsWith(prefix)) ?? "";
  const adr = read(`docs/adr/${file("0039-")}`);

  it("records the Request changes part as its own part, after the Design session's", () => {
    expect(adr).toContain("A Request changes' Spin-offs are the second part built (#884):");
    expect(adr.indexOf("A Request changes' Spin-offs are the second part built (#884):")).toBeGreaterThan(adr.indexOf("A Design session's Spin-offs are the first part built (#883):"));
    for (const lead of [
      "- **Only a Request changes asks for one.**",
      "- **Only the Operator's words set a point aside.**",
      "- **The Kit opens each in the plan that lands the run.**",
      "- **A run of only Spin-offs returns the pull request to the Merge gate with no Review.**",
      "- **The Reviewer is given each beside the Operator's words.**",
      "- **The Digest shows each under its ask.**",
    ]) {
      expect(adr).toContain(lead);
    }
  });

  it("says why an Operator comment still triggers nothing, and why only the Operator's words set a point aside", () => {
    const part = adr.split("A Request changes' Spin-offs are the second part built (#884):")[1]?.split("\n\n")[1] ?? "";
    const rule = (lead: string) => part.split("\n").find((line) => line.startsWith(`- **${lead}**`)) ?? "";

    expect(rule("Only a Request changes asks for one.")).toContain("An Operator comment still triggers nothing (ADR-0007)");
    expect(rule("Only a Request changes asks for one.")).toContain("one entry point for asking for work");
    expect(rule("Only the Operator's words set a point aside.")).toContain("(ADR-0010)");
    expect(rule("Only the Operator's words set a point aside.")).toContain("an agent that may judge a requested change unrelated may leave unbuilt what the Operator asked for");
  });

  it("no longer says its own part is still to be built", () => {
    expect(adr).toContain("#885");
    expect(adr).not.toContain("A Request changes' Spin-offs come with #884");
  });

  it("ADR-0010 gains a line pointing at it", () => {
    const consequences = read(`docs/adr/${file("0010-")}`).split("\n## Consequences\n")[1] ?? "";
    expect(consequences).toContain("ADR-0039 refines \"However large the change, it's built\"");
    expect(consequences).toContain("a point the Operator asks, in words, to be its own issue is set aside as a Spin-off");
  });
});

describe("The README's account of a Request changes' Spin-offs (#884)", () => {
  const readme = read("README.md");
  const section = (heading: string) => readme.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
  const bullet = (heading: string, lead: string) => section(heading).split("\n").find((line) => line.startsWith(`- **${lead}**`)) ?? "";
  const requestChanges = bullet("Merge gate", "Request changes");
  const spinOffs = bullet("Merge gate", "A Spin-off from a Request changes");

  it("amends the Request changes bullet: built however large, but for a point asked for as a Spin-off, and given to later runs", () => {
    expect(requestChanges).toContain("the run builds it however large it is, but for a point you ask, in words, to be its own issue (see **A Spin-off from a Request changes** below)");
    expect(requestChanges).toContain("and the points of them set aside as Spin-offs");
    expect(requestChanges).toContain("unless the run set aside every ask as a Spin-off, when the PR goes back to the Merge gate (see **A Spin-off from a Request changes** below)");
  });

  it("has a bullet of its own, straight after Request changes, saying what asks for one and what the Kit opens", () => {
    const bullets = section("Merge gate").split("\n").filter((line) => line.startsWith("- **"));
    expect(bullets[bullets.indexOf(requestChanges) + 1]).toBe(spinOffs);
    expect(spinOffs).toContain("(#884, ADR-0039)");
    expect(spinOffs).toContain("`spinOffs`");
    expect(spinOffs).toContain("with `needs-triage` and no other label");
    expect(spinOffs).toContain('`<!-- fabrik:spin-off {"from":"request-changes","pullRequest":<n>,"review":<id>} -->`');
    expect(spinOffs).toContain("`From PR #<n>`");
    expect(spinOffs).toContain("a blocked-by edge to the PR's Ticket");
    expect(spinOffs).toContain("`<!-- fabrik:spin-off-opened #<issue> {…} -->`");
    expect(spinOffs).toContain('"The points set aside as Spin-offs"');
  });

  it("says when a run that commits nothing goes back to the Merge gate, and that anything short of it is handed back", () => {
    expect(spinOffs).toContain("the run committed nothing, the PR's head did not move, its latest Verdict is a pass on that head, and every ask of every review the run read is named by a Spin-off's `from`");
    expect(spinOffs).toContain("no Review, no Hand-back and no retry");
    expect(spinOffs).toContain("Anything short of that is handed back");
  });

  it("names both sources where Triage sorts a Spin-off, and where it lists how loud one is", () => {
    const paragraph = section("Triage").split("\n").find((line) => line.startsWith("A **Spin-off**")) ?? "";
    expect(paragraph).toContain("(#883, #884, ADR-0039)");
    expect(paragraph).toContain("or when it landed a Request-changes run whose review asked for a point to be its own issue");
    expect(paragraph).toContain("or the pull request and the review that asked for it");
    const row = readme.split("\n").find((line) => line.startsWith("| Spin-off |")) ?? "";
    expect(row).toContain("or when it lands a Request-changes run that returned one");
    expect(row).toContain("| Silent |");
  });

  it("says in the Digest section that an ask carries its Spin-offs, and that set aside is an answer only for such an ask", () => {
    const eyes = bullet("Digest", "Needs your eyes");
    expect(eyes).toContain("An ask the Kit opened a Spin-off from (#884) carries them among Kit code's facts, as `spinOffs`, and the fourth fold shows them under it");
    expect(eyes).toContain("or set aside, when the whole of it was");
    expect(eyes).toContain("set aside for an ask the Kit opened no Spin-off from, or for a criterion");
  });
});
