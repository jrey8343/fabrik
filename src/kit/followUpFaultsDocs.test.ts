import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { aPullRequest, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { digestCommentOf } from "../loop/digestContract.ts";
import { FAULT_OPENS_AT_MERGE } from "../loop/followUps.ts";
import { FOLLOW_UPS_OPENED_MARKER, followUpMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { Plan } from "../loop/types.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "./config.ts";

// The docs of the third part of the minor in which the Kit opens issues itself (#882, ADR-0039): a Follow-up that is a
// fault opens as an issue at the merge (#885). What they say is checked against the plan, the contract and the Kit
// config, so neither drifts.
const NOTES = "docs/release-notes/kit-opens-issues.md";
const read = (path: string) => readFileSync(`${KIT}/${path}`, "utf8");

/** A glossary entry's definition: the paragraph under its `**Term**:` line. */
const entry = (term: string) => read("GLOSSARY.md").split(`\n**${term}**:\n`)[1]?.split("\n")[0] ?? "";

const FAULT = { title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." };

/** The plan for agent pull request #42 merging, its passes having named one fault, with this many Follow-up issues open already. */
const merging = (open = 0, cap = DEFAULT_KIT_CONFIG.caps.followUpIssues): Plan =>
  planFor(
    { kind: "pull-request-closed", pullRequest: 42, merged: true, closedByBot: false },
    snapshotOfPullRequest(aPullRequest({ number: 42, open: false, draft: false, faults: [FAULT] }), { followUpIssues: { repoUrl: "https://github.com/acme/shop", open, ofPullRequest: [] } }),
    kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, followUpIssues: cap } }),
  );
const openedBy = (plan: Plan) => (plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "create-issue" ? [action] : [])) : []);
const commentOf = (plan: Plan): string =>
  plan.kind !== "act"
    ? ""
    : plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : action.kind === "comment-linking" ? [action.body.map((part) => (typeof part === "string" ? part : "#101")).join("")] : [])).join("\n");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Kit-opens-issues release notes, on a Follow-up that is a fault (#885)", () => {
  const notes = read(NOTES);
  const changed = (lead: string) => notes.split("\n").find((line) => line.startsWith(`- **${lead}**`)) ?? "";

  it("say the draft holds all three of the Spec's parts", () => {
    expect(notes).toContain("This draft holds all three of the Spec's parts");
    expect(notes).toContain("a Follow-up that is a fault ([#885](https://github.com/jrey8343/fabrik/issues/885))");
    expect(notes).not.toContain("adds its part here when it is built");
  });

  it("say in the release-note line that a fault opens as an issue when its pull request merges, and an idea stays a link", () => {
    const line = notes.split("\n## Release-note line\n")[1]?.split("\n## ")[0] ?? "";
    expect(line).toContain("A Follow-up is now a fault or an idea");
    expect(line).toContain("the Kit opens each fault as an issue when the pull request merges");
    expect(line).toContain("`caps.follow_up_issues`");
  });

  it("say what a fault is and how the Verdict comment shows one, in the comment's own words", () => {
    expect(changed("A Follow-up is a fault or an idea.")).toContain("where it is, by file and line, and what shows it is wrong");
    expect(changed("A Follow-up is a fault or an idea.")).toContain("`- [fault] <title>` or `- [idea] <title>`");
    expect(changed("The Verdict says which.")).toContain(`"${FAULT_OPENS_AT_MERGE}"`);
  });

  it("say what the Kit opens each fault with, as the plan has it", () => {
    const [issue] = openedBy(merging());
    expect(issue?.labels).toEqual(["needs-triage"]);
    expect(issue?.body.split("\n")[0]).toBe(followUpMarker(42));
    expect(issue?.body.split("\n").at(-1)).toBe("From PR #42");
    const opens = changed("A fault opens as an issue at the merge.");
    expect(opens).toContain("with `needs-triage` and no other label");
    expect(opens).toContain(`\`${followUpMarker(42).replace('"pullRequest":42', '"pullRequest":<n>')}\``);
    expect(opens).toContain("`From PR #<n>`");
    expect(opens).toContain("drops one whose title, outer spaces aside, repeats an earlier one's");
  });

  it("say what the one comment holds and that its first line makes the opening happen once, as the plan writes it", () => {
    const comment = commentOf(merging());
    expect(comment.split("\n")[0]).toBe(FOLLOW_UPS_OPENED_MARKER);
    const once = changed("One comment, once.");
    expect(once).toContain(`\`${FOLLOW_UPS_OPENED_MARKER}\``);
    expect(once).toContain("each issue it opened, each fault left over the cap with its Open as issue link, and each fault that was an issue already");
    expect(once).toContain("opens nothing more");
  });

  it("say the cap as the Kit config has it: its default, that it can only be lowered, what it counts, and that 0 opens none", () => {
    const cap = changed("A cap on the Follow-up issues the Kit has open.");
    expect(cap).toContain(`\`caps.follow_up_issues\` (default ${DEFAULT_KIT_CONFIG.caps.followUpIssues})`);
    expect(resolveKitConfig({ config: `{ "caps": { "follow_up_issues": ${DEFAULT_KIT_CONFIG.caps.followUpIssues + 1} } }` })).toMatchObject({ ok: false });
    expect(cap).toContain("can only be lowered");
    expect(openedBy(merging(DEFAULT_KIT_CONFIG.caps.followUpIssues))).toEqual([]);
    expect(openedBy(merging(0, 0))).toEqual([]);
    expect(cap).toContain("At `0` the Kit opens none");
  });

  it("say Triage sorts one as any issue, the Digest shows every fault, and the Retro's evidence says what became of each", () => {
    expect(changed("Triage sorts it as any issue.")).toContain("`followUp`");
    expect(changed("Triage sorts it as any issue.")).toContain("may set it aside");
    const digest = changed("The Digest shows every fault.");
    const refused = digestCommentOf(aDigestReply({ followUps: ["f1"] }), aDigestGiven({ facts: aDigestFacts({ followUps: [{ id: "f1", kind: "fault", title: FAULT.title, url: null }] }) }));
    expect(refused).toMatchObject({ ok: false });
    expect(digest).toContain("refuses a reply that names a fault's id");
    expect(digest).toContain("`faults`");
    const retro = changed("The Retro's evidence says what became of each.");
    for (const field of ["`kind`", "`kitOpened`", "`overCap`", "`openedAs`"]) expect(retro).toContain(field);
  });

  it("say what the read library gains, and that a row kept before reads its Follow-ups as ideas", () => {
    const library = changed("The read library.");
    expect(library).toContain("`kind`");
    expect(library).toContain("`filedAs` names the issue the Kit opened");
    expect(library).toContain("`readRow`");
    expect(library).toContain("`mergedFollowUps`");
  });

  it("say why it is a minor in the releasing guide's terms: one new Kit config field, with a default", () => {
    const why = notes.split("\n").find((line) => line.startsWith("- **Why a minor:**")) ?? "";
    expect(why).toContain("No new label, no Setup step and no new App permission is needed");
    expect(why).toContain("The one new Kit config field, `caps.follow_up_issues`, has a default");
    expect(why).toContain("the read library removes nothing");
    expect(why).not.toContain("no new Kit config field");
    expect(read("docs/releasing.md")).toContain("new behaviour or new Kit config fields. Every new field has a default");
  });

  it("no longer say a Follow-up is only a link, and name the limits the rule has", () => {
    expect(notes).not.toContain("**A Follow-up, an Audit candidate and a Retro proposal** are still links the Operator opens.");
    expect(notes).toContain("**An idea, an Audit candidate and a Retro proposal** are still links the Operator opens.");
    const limits = notes.split("\n## Known limits\n")[1] ?? "";
    expect(limits).toContain("**No veto before the merge.**");
    expect(limits).toContain("**Only the merge's own event opens them.**");
    expect(limits).toContain("**A merged row carries its Follow-ups for 24 hours.**");
  });

  it("name no person and no private repo", () => {
    expect(notes).not.toMatch(/gradually|jrey(?!8343\/fabrik)/i);
  });
});

describe("The glossary's account of a Follow-up's two kinds (#885)", () => {
  it("rewrites Follow-up with its two kinds and what happens to each, in the form the other entries take", () => {
    const followUp = entry("Follow-up");
    expect(followUp).toContain("Work the Reviewer names on a pass that deserves its own issue but lies outside the Ticket's scope");
    expect(followUp).toContain("A fault is something already wrong that its body shows");
    expect(followUp).toContain("the Kit opens it as an issue when the pull request merges, up to `caps.follow_up_issues`");
    expect(followUp).toContain("An idea is anything else, and stays a link the Operator opens as an issue or ignores");
    expect(read("GLOSSARY.md")).toMatch(/\n\*\*Follow-up\*\*:\n.+\n_Avoid_: nit, suggestion\n/);
  });

  it("amends the Digest, Triage and Intake to match, and leaves a Trial problem apart from a Follow-up", () => {
    expect(entry("Digest")).toContain("its Follow-ups, the faults the Kit opens as issues at the merge and the ideas worth opening");
    expect(entry("Triage")).toContain("A Follow-up the Kit opened it sorts as any issue");
    expect(entry("Intake")).toContain("a Check's issue, a Spin-off or a Follow-up that is a fault");
    expect(read("GLOSSARY.md")).toContain("_Avoid_: Follow-up (the Reviewer's), bug report, defect");
  });
});

describe("ADR-0039, on a Follow-up that is a fault (#885)", () => {
  const file = readdirSync(`${KIT}/docs/adr`).find((name) => name.startsWith("0039-")) ?? "";
  const adr = file === "" ? "" : read(`docs/adr/${file}`);
  const part = adr.split("\nA Follow-up that is a fault is the third part built (#885):\n")[1]?.split("\n\nThis reverses")[0] ?? "";
  const rule = (lead: string) => part.split("\n").find((line) => line.startsWith(`- **${lead}**`)) ?? "";

  it("adds the Follow-up part as the third built, and leaves the parts before it as they were", () => {
    expect(adr).toContain("A Design session's Spin-offs are the first part built (#883):");
    expect(adr).toContain("A Request changes' Spin-offs are the second part built (#884):");
    expect(part).not.toBe("");
    expect(adr).not.toContain("The Follow-up part is built in a later Ticket");
  });

  it("says why faults and not ideas, why at the merge, and why a cap and no veto", () => {
    expect(rule("Faults, and not ideas.")).toContain("Design sessions the Operator never asked for");
    expect(rule("Faults, and not ideas.")).toContain("by file and line");
    expect(rule("At the merge, and not at the pass.")).toContain("A pull request can pass more than once");
    expect(rule("At the merge, and not at the pass.")).toContain("beside an open pull request on the same code");
    expect(rule("A cap, and no veto.")).toContain("`caps.follow_up_issues`");
    expect(rule("A cap, and no veto.")).toContain("A decision per Follow-up on every pull request is the work #101 avoided");
    expect(rule("Once.")).toContain(FOLLOW_UPS_OPENED_MARKER);
  });

  it("says it reverses #101's nothing auto-filed, for faults only", () => {
    expect(adr).toContain('It also reverses #101\'s "nothing auto-filed", for faults only');
    expect(adr).toContain("#885");
  });
});

describe("The README's account of a Follow-up that is a fault (#885)", () => {
  const readme = read("README.md");
  const section = (heading: string) => readme.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
  const bullet = (within: string, lead: string) => within.split("\n").find((line) => line.trimStart().startsWith(`- **${lead}**`)) ?? "";

  it("says in Review what a fault and an idea are, how the block marks each, and what the Verdict comment shows", () => {
    const followUps = bullet(section("Review"), "Follow-ups");
    expect(followUps).toContain("Each is a fault or an idea");
    expect(followUps).toContain("`- [fault] <title>` or `- [idea] <title>`");
    expect(followUps).toContain(`"${FAULT_OPENS_AT_MERGE}"`);
    expect(followUps).not.toContain("The Kit never files one itself.");
  });

  it("says at the Merge gate what the merge opens, with what, under which cap, and that it happens once", () => {
    const faults = bullet(section("Merge gate"), "Faults open as issues");
    expect(faults).toContain("with `needs-triage` and no other label");
    expect(faults).toContain(`\`${followUpMarker(42).replace('"pullRequest":42', '"pullRequest":<n>')}\``);
    expect(faults).toContain("`caps.follow_up_issues`");
    expect(faults).toContain(`\`${FOLLOW_UPS_OPENED_MARKER}\``);
    expect(faults).toContain("A Plain pull request has no Verdict, so nothing opens for one, and nothing opens for a pull request closed unmerged.");
    expect(faults).toContain("There is no veto before the merge");
  });

  it("lists the cap in the Kit config's example and its fields, as the template and the defaults have it", () => {
    const config = section("Kit config");
    expect(config).toContain(`"follow_up_issues": ${DEFAULT_KIT_CONFIG.caps.followUpIssues}`);
    expect(JSON.parse(read("templates/fabrik-config.json"))).toMatchObject({ caps: { follow_up_issues: DEFAULT_KIT_CONFIG.caps.followUpIssues } });
    const cap = config.split("\n").find((line) => line.trimStart().startsWith("- `caps.follow_up_issues`")) ?? "";
    expect(cap).toContain(`(default ${DEFAULT_KIT_CONFIG.caps.followUpIssues})`);
    expect(cap).toContain("Set it to `0`");
  });

  it("says how Triage is told of one, what the Digest and the Retro's evidence do with a fault, that it is silent, and what a row carries", () => {
    const triage = section("Triage").split("\n").find((line) => line.startsWith("A **Follow-up the Kit opened**")) ?? "";
    expect(triage).toContain("`followUp`");
    expect(triage).toContain("sorts it as any issue, and may set it aside");
    expect(bullet(section("Digest"), "Kit code's facts")).toContain("Kit code shows every fault itself");
    expect(bullet(section("Digest"), "No Digest")).toContain("or names a fault among the Follow-ups to show");
    expect(readme).toContain("what became of the issue the Kit opened for each fault");
    const row = readme.split("\n").find((line) => line.startsWith("| Follow-up issue |")) ?? "";
    expect(row).toContain("| Silent |");
    const library = bullet(section("Reading the Kit from another program"), "Follow-ups.");
    expect(library).toContain("`kind`");
    expect(library).toContain("`filedAs`");
    expect(bullet(section("Reading the Kit from another program"), "`readRow`")).toContain("A Follow-up kept before it had a `kind` reads as an idea");
  });
});
