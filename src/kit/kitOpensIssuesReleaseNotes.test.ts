import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { readDesignTurnOutput } from "../loop/designOutput.ts";
import { spinOffMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import { readTriageOutput } from "../loop/triageOutput.ts";

// The docs of the minor in which the Kit opens issues itself (#882, ADR-0039), as its first Ticket leaves them (#883):
// a Design session's Spin-offs. What they say is checked against the contract and the plan, so neither drifts.
const NOTES = "docs/release-notes/kit-opens-issues.md";
const read = (path: string) => readFileSync(`${KIT}/${path}`, "utf8");

/** A glossary entry's definition: the paragraph under its `**Term**:` line. */
const entry = (term: string) => read("GLOSSARY.md").split(`\n**${term}**:\n`)[1]?.split("\n")[0] ?? "";

const spinOff = { title: "Remind waitlisted patients", body: "Text each one a day before.", restsOn: 'Round 2, answer 3: "not now"', blockedBy: [] };
const notPlanned = { kind: "not-planned", comment: "The Operator decided against it.", spinOffs: [spinOff] };

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Kit-opens-issues release notes, while drafted", () => {
  const notes = read(NOTES);

  it("open with what they are the notes for, and the releasing guide lists them after the gathering-check notes among the drafted notes", () => {
    expect(notes.split("\n")[0]).toBe("# Release notes: The Kit opens issues itself");
    expect(notes).toMatch(/^The notes for the minor release in which the Kit opens issues itself \(\[#882\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/882\), ADR-0039\)/m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const drafted = read("docs/releasing.md").split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain(
      "(release-notes/gathering-check-excerpts.md), the Kit-opens-issues minor's ([#882](https://github.com/jrey8343/fabrik/issues/882)) are [the Kit opens issues itself](release-notes/kit-opens-issues.md)",
    );
  });

  it("say which finishes open a Spin-off, and what the Kit opens each with, as the plan has it", () => {
    expect(notes).toContain("an agent brief, an Operator brief, a Spec, a split, a Roll-in and not planned");
    const plan = planFor({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(notPlanned) }, snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());
    const opened = plan.kind === "act" ? plan.actions.find((action) => action.kind === "create-issue") : undefined;
    expect(opened?.kind === "create-issue" ? opened.labels : null).toEqual(["needs-triage"]);
    expect(notes).toContain("with `needs-triage` and no other label");
    // The marker as the notes spell it, with the session's issue as `<n>`.
    expect(notes).toContain(`\`${spinOffMarker({ from: "design", issue: 7 }).replace('"issue":7', '"issue":<n>')}\``);
    expect(notes).toContain("`Follows #<Spec> (its Tickets: …)`");
  });

  it("say what the closing comment gives of each Spin-off, in the plan's own words", () => {
    const plan = planFor({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(notPlanned) }, snapshotOf(anIssue({ number: 7, labels: ["needs-design"] })), kitConfig());
    const closing = plan.kind === "act" ? plan.actions.find((action) => action.kind === "comment-linking") : undefined;
    const text = closing?.kind === "comment-linking" ? closing.body.filter((part) => typeof part === "string").join("") : "";
    expect(text).toContain("The Kit opened 1 Spin-off, work the Operator's answers put outside this outcome, which Triage sorts next:");
    expect(notes).toContain("its number, its title and its `restsOn` line");
    expect(notes).toContain("Rests on:");
  });

  it("say `newIssue` is refused with a message that names `spinOffs`, as the contract refuses it", () => {
    const step = { key: "reminders", title: "Open the issue", body: "It needs an issue.", blockedBy: [], operator: true, steps: ["Open it"], newIssue: { title: "x", body: "y" } };
    const refused = readDesignTurnOutput({ kind: "spec", comment: "c", spec: { title: "t", body: "b" }, tickets: [step] }, 7);
    expect(refused).toMatchObject({ ok: false, errors: [expect.stringContaining("spinOffs")] });
    expect(notes).toContain("`newIssue` is refused, with a message that names `spinOffs`");
    expect(notes).toContain("An Operator step already open keeps the link its body has.");
  });

  it("say Triage sets a Spin-off aside only as a duplicate, as the contract holds it to", () => {
    const wontfix = { category: "enhancement", state: "wontfix", comment: "No." };
    expect(readTriageOutput(wontfix, 104, true)).toMatchObject({ ok: false });
    expect(readTriageOutput({ ...wontfix, duplicateOf: 98 }, 104, true)).toMatchObject({ ok: true });
    expect(notes).toContain("A `wontfix` on a Spin-off with no `duplicateOf` is refused");
  });

  it("say why it is a minor, in the releasing guide's terms, and what a Product repo's own instructions may need", () => {
    const why = notes.split("\n").find((line) => line.startsWith("- **Why a minor:**")) ?? "";
    // The Follow-up part adds the minor's one Kit config field (#885).
    expect(why).toContain("No new label, no Setup step and no new App permission is needed");
    expect(why).toContain("the read library removes nothing");
    expect(notes).toContain("`.fabrik/design.md`");
  });

  it("name the Tickets of the two later parts", () => {
    expect(notes).toContain("[#884](https://github.com/jrey8343/fabrik/issues/884)");
    expect(notes).toContain("[#885](https://github.com/jrey8343/fabrik/issues/885)");
  });

  it("name no person and no private repo", () => {
    expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
  });
});

describe("The glossary's account of a Spin-off (#883)", () => {
  it("defines the Spin-off, naming the Design session as its source and the Roll-in as what it is not", () => {
    const spinOffEntry = entry("Spin-off");
    expect(spinOffEntry).toContain("Work the Operator's words put outside the piece at hand, which the Kit opens as an issue of its own");
    expect(spinOffEntry).toContain("A Design session opens one");
    expect(spinOffEntry).toContain("It is the opposite of a Roll-in");
    expect(read("GLOSSARY.md")).toMatch(/\n\*\*Spin-off\*\*:\n.+\n_Avoid_: .+\n/);
  });

  it("amends the Design session, the Operator step, Triage and Intake to match", () => {
    expect(entry("Design session")).toContain("Any finish but a Map can open Spin-offs");
    expect(entry("Operator step")).toContain("It never asks the Operator to open an issue: work that needs an issue of its own is a Spin-off");
    expect(entry("Triage")).toContain("A Spin-off it sets aside only as a duplicate of a named issue");
    expect(entry("Intake")).toContain("a Check's issue, a Spin-off");
  });
});

describe("ADR-0039, the Kit opens issues itself", () => {
  const file = readdirSync(`${KIT}/docs/adr`).find((name) => name.startsWith("0039-")) ?? "";
  const adr = file === "" ? "" : read(`docs/adr/${file}`);

  it("is titled for the decision, and names the issue that decided it", () => {
    expect(adr.split("\n")[0]).toBe("# The Kit opens issues itself, on the Operator's word and on its own judgement, each entering at Triage");
    expect(adr.trimEnd().split("\n").at(-1)).toBe("Decided in [Spec: The Kit opens issues itself](https://github.com/jrey8343/fabrik/issues/882).");
  });

  it("records the two rules, why they differ, and that every such issue enters at Triage", () => {
    expect(adr).toContain("- **On the Operator's word: a Spin-off.**");
    expect(adr).toContain("- **On the Kit's own judgement: a Follow-up that is a fault.**");
    expect(adr).toContain("The Operator's word needs no bar");
    expect(adr).toContain("- **It enters at Triage.**");
  });

  it("says it reverses #825's link, and names the Tickets of the two later parts", () => {
    expect(adr).toContain('This reverses #825\'s "The Operator still opens it from the link"');
    expect(adr).toContain("#884");
    expect(adr).toContain("#885");
  });
});

describe("The README's account of a Design session's Spin-offs (#883)", () => {
  const readme = read("README.md");
  const design = readme.split("\n## Design session (async)\n")[1]?.split("\n## ")[0] ?? "";
  const triage = readme.split("\n## Triage\n")[1]?.split("\n## ")[0] ?? "";
  const spinOffs = design.split("\n").find((line) => line.startsWith("**Spin-offs** (#883, ADR-0039):")) ?? "";

  it("says which finishes carry Spin-offs, what each one holds, and when a session writes one", () => {
    expect(spinOffs).toContain("an agent brief, an Operator brief, a Spec, a split, a Roll-in and not planned");
    expect(spinOffs).toContain("A round and a Map take none");
    expect(spinOffs).toContain("a `title`, a `body` that stands alone, a `restsOn`, one line naming the Operator's answer it rests on, and a `blockedBy`");
    expect(spinOffs).toContain("never for work the Operator did not speak to");
  });

  it("says what the Kit opens each one with, what it waits on and how the closing comment names it", () => {
    expect(spinOffs).toContain("with `needs-triage` and no other label");
    expect(spinOffs).toContain(`\`${spinOffMarker({ from: "design", issue: 7 }).replace('"issue":7', '"issue":<n>')}\``);
    expect(spinOffs).toContain("only as the first line of an issue the Fabrik App opened");
    expect(spinOffs).toContain("`Follows #<Spec> (its Tickets: …)`");
    expect(spinOffs).toContain("on an agent brief, to the issue the brief rewrites");
    expect(spinOffs).toContain("its number, its title and its `restsOn` line");
  });

  it("no longer describes an Operator step that opens an issue, in the section or the open Tickets paragraph", () => {
    expect(design).not.toContain("An Operator step whose job is to open a new issue");
    expect(design.split("\n").find((line) => line.startsWith("**The open Tickets**"))).toContain("An Operator step never asks the Operator to open an issue");
    expect(spinOffs).toContain("the Kit writes no Open as issue link on an Operator step");
    expect(spinOffs).toContain("An Operator step already open keeps the link its body has.");
  });

  it("says how Triage sorts a Spin-off, and that it is silent", () => {
    const paragraph = triage.split("\n").find((line) => line.startsWith("A **Spin-off**")) ?? "";
    expect(paragraph).toContain("`spinOff`");
    expect(paragraph).toContain("sets it aside only as a duplicate of a named issue");
    expect(paragraph).toContain("a `wontfix` on one with no `duplicateOf` is refused");
    const row = readme.split("\n").find((line) => line.startsWith("| Spin-off |")) ?? "";
    expect(row).toContain("| Silent |");
  });
});
