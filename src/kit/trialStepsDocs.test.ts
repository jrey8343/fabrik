// The Trial steps' words and their decision (Spec #962), written down with
// the Implementer's `trial` and its marker (#963): the glossary's two terms,
// the ADR, and the line of ADR-0038 that points at it.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { retryBodyOnlyMarker, trialStepsMarker } from "../loop/markers.ts";
import { bodyOnly } from "../loop/retry.ts";
import { FINDING_TAG_TEXT } from "../loop/verdict.ts";
import { DEFAULT_KIT_CONFIG, homeFactsOf, rowsOf } from "../read/index.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("The Trial steps' words and decision (#962)", () => {
  it("has its two terms in the glossary, after the Promote list, worded as the Spec words them", () => {
    const glossary = read("GLOSSARY.md");
    const evidenceTerms = glossary.slice(glossary.indexOf("**UI evidence**:"), glossary.indexOf("## Measuring the factory"));

    expect(evidenceTerms).toContain(
      [
        "_Avoid_: release list, changelog, deploy queue, release candidates",
        "",
        "**Trial steps**:",
        "The summary and ordered steps an Implementer writes for a pull request that asks for a Staging trial, each saying where to go, what to do and what should be seen.",
        "_Avoid_: test plan, test script, QA checklist, acceptance criteria (a Ticket's)",
        "",
        "**Trial session**:",
        "A Staging trial the Operator runs with an agent driving their own browser, which ends in the Operator's verdict.",
        "_Avoid_: Pairing session (works an issue, not a merged change), QA session, test run",
        "",
      ].join("\n"),
    );
  });

  it("has its ADR under a number of its own, in the form the others take, with the options the Spec rejected", () => {
    const name = "0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md";
    const numbers = readdirSync(new URL("docs/adr/", root)).map((file) => Number(file.slice(0, 4)));

    expect(numbers.filter((number) => number === 40)).toHaveLength(1);
    const adr = read(`docs/adr/${name}`);
    expect(adr.split("\n")[0]).toBe("# The Implementer writes a Staging trial's steps and the Reviewer judges them");
    expect(adr).toContain("\n## Considered options\n");
    expect(adr).toContain("\n## Consequences\n");
    expect(adr).toContain("Decided in [Spec: Trial steps, and a Staging trial paired with Claude in Chrome](https://github.com/jrey8343/fabrik/issues/962).");
    const options = adr.slice(adr.indexOf("\n## Considered options\n"), adr.indexOf("\n## Consequences\n"));
    for (const rejected of [
      "Steps derived from the Ticket's acceptance criteria.",
      "Steps written in the Design session.",
      "The pairing agent inferring what to test.",
      "A self-contained prompt composed by a reader.",
      "Records for Dynamic routes named in Kit config.",
      "A flow diagram.",
      "The agent accepting when every step matched.",
      "Pausing before steps that write.",
      "A recording on the Trial problem.",
    ]) {
      expect(options).toContain(`- **${rejected}**`);
    }
  });

  it("names in its ADR what the Implementer's output and the pull request's marker are called, as the code has them", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");

    const marker = trialStepsMarker({ summary: "A waitlist.", steps: [{ do: "Pick a full day.", expect: "A button shows." }] });

    for (const word of ["`trial`", "`summary`", "`steps`", "`route`", "`do`", "`expect`", "`staging`"]) expect(adr).toContain(word);
    // The marker as the writer opens and closes it, around JSON the ADR doesn't spell out.
    expect(adr).toContain(`\`${marker.slice(0, marker.indexOf("{"))}{…}${marker.slice(marker.lastIndexOf("}") + 1)}\``);
  });

  it("is pointed at from ADR-0038, in one line saying a label an agent puts on at the Operator's word, with the Operator's credential, is the Operator's", () => {
    const earlier = read("docs/adr/0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md");
    const pointing = earlier.split("\n").filter((line) => line.includes("](0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md)"));

    expect(pointing).toHaveLength(1);
    expect(pointing[0]).toContain("a label an agent puts on at the Operator's word, with the Operator's credential, is the Operator's");
    expect(pointing[0]).toContain("[ADR-0040]");
  });

  it("says in the README, under staging in Kit config, the one thing the Loop now does where the block is declared, in place of saying no prompt reads it", () => {
    const staging = read("README.md")
      .split("\n")
      .find((line) => line.startsWith("- `staging` (default `null`)"));

    expect(staging).toContain(
      "Nothing in the Loop waits on staging or reads its address or its deploys, which only a reader of the Kit acts on. The Loop asks only whether the block is there: where it is, the Implementer writes Trial steps for each pull request that will ask for a Staging trial, and the Kit keeps them on the pull request (ADR-0040).",
    );
    expect(staging).not.toContain("no Loop rule, job or prompt reads it");
    expect(staging).toContain("`null`, or leaving it out, declares none, and the repo reads exactly as it does without the block.");
  });

  it("says in the README, after it, that the Reviewer judges them on such a pull request (#964)", () => {
    const staging = read("README.md")
      .split("\n")
      .find((line) => line.startsWith("- `staging` (default `null`)"));

    expect(staging).toContain(
      "and the Kit keeps them on the pull request (ADR-0040). The Reviewer judges them against the diff before the merge, on such a pull request only. Kit config is a Trust-root file",
    );
  });

  it("says in its ADR how a finding about Trial steps is fixed: tagged as one about the body, by a run that gives trial again and commits nothing for it (#964)", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");
    const consequences = adr.slice(adr.indexOf("\n## Consequences\n"));

    expect(consequences).toContain(
      `- A finding about Trial steps is one about the pull request's body, where they are kept, so the Reviewer tags it \`${FINDING_TAG_TEXT["small-body"]}\`. The run that fixes it gives \`trial\` again and has nothing to commit for it, which a Touch-up whose findings are all about the body may do.`,
    );
    expect(consequences).not.toContain("reaches a Retry only beside a finding in the code");
  });

  it("says in its ADR what a Retry of findings all about the body may do, once the Touch-ups are used, and that the rule is the Loop's in every repo", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");
    const consequences = adr.slice(adr.indexOf("\n## Consequences\n"));
    const tag = FINDING_TAG_TEXT["small-body"];

    expect(consequences).toContain(
      `A pull request gets two Touch-ups, so a third Execution flaw of such findings alone calls for a Retry, and that Retry may commit nothing too: where every finding of its Verdict is tagged \`${tag}\`, by the same count of the same tags, the Kit writes the body again from what the run gave, posts the run's \`fix\` under a note that ends it, and Reviews the same head again. It is still one of the Ticket's two Retries. A Retry given any finding not tagged \`${tag}\` is as it was: one that commits nothing is an empty diff.`,
    );
    expect(consequences).toContain("This one rule is the Loop's own ([ADR-0027](0027-an-execution-flaw-of-only-small-or-missed-earlier-findings-calls-for-a-touch-up-not-a-retry.md)), so it holds in a repo that declares no `staging` too, for any findings about the body alone.");
    // The test the Kit counts by: every finding tagged as about the body, and none of any other kind.
    expect(bodyOnly({ small: 2, missedEarlier: 0, counted: 0, smallBody: 2 })).toBe(true);
    expect(bodyOnly({ small: 2, missedEarlier: 0, counted: 1, smallBody: 2 })).toBe(false);
    // The note that ends it, as its writer opens it.
    expect(retryBodyOnlyMarker("a".repeat(40))).toBe(`<!-- fabrik:retry-body-only ${"a".repeat(40)} -->`);
  });

  it("says in its ADR that a run on an existing pull request that gives no trial the Kit can read keeps the steps it carries, and no longer that it leaves none (#962)", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");
    const consequences = adr.slice(adr.indexOf("\n## Consequences\n"));

    expect(consequences).toContain(
      "- A run on an existing pull request that leaves `trial` out, or gives a malformed one, keeps the Trial steps the pull request carries: the Kit reads them from the marker in the body it wrote, and writes them again in the body the run leaves. A run that gives them replaces them, and a first run that gives none writes none.",
    );
    expect(consequences).toContain("So a run that changes nothing a person sees, as a Touch-up of a stale comment, cannot take away steps the Reviewer has judged, and steps a later run should have changed and did not are the Reviewer's to find.");
    expect(adr).not.toContain("A run that leaves `trial` out leaves its pull request with none");
  });

  it("says in its ADR that a trial on a pull request that asks for no Staging trial is on its row all the same, and no longer that nobody reads it", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");
    const steps = { summary: "The booking API retries a failed save.", steps: [{ do: "Book a visit with the network off, then on.", expect: "The visit is booked once." }] };
    // Merged agent pull request 50 carries no UI evidence and closes no Trial problem, so it asks for no Staging trial.
    const facts = homeFactsOf({
      kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, staging: { url: "https://staging.shop.example", environment: "staging" } } }, dispatch: null },
      mergedLastDay: [{ number: 50, title: "Retry a failed save", ticket: 7, mergeCommit: "m".repeat(40), mergedAt: "2026-11-09T11:30:00Z" }],
      trialStepsMarkers: [{ pullRequest: 50, marker: steps }],
    });
    const row = rowsOf(facts, null, null, null, "2026-11-09T12:00:00Z").find(({ staging }) => staging !== undefined);

    expect(adr).toContain(
      "`trial` on a pull request that asks for none is kept all the same, and read as any other is: its row and its entry on the Promote list carry it as `staging.trial`, whatever they say of whether it needs a Staging trial, and the untried queue command prints it for a pull request named by its number.",
    );
    expect(adr).not.toContain("read by nobody");
    expect(row?.standing).toMatchObject({ detail: { staging: { trial: { needed: false } } } });
    expect(row?.staging?.trial).toMatchObject({ summary: steps.summary });
  });

  it("is pointed at from ADR-0027, in one line saying Trial steps findings carry the body's tag and what a Retry of only such findings may do", () => {
    const earlier = read("docs/adr/0027-an-execution-flaw-of-only-small-or-missed-earlier-findings-calls-for-a-touch-up-not-a-retry.md");
    const pointing = earlier.split("\n").filter((line) => line.includes("](0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md)"));

    expect(pointing).toHaveLength(1);
    expect(pointing[0]).toBe(
      `A finding about a pull request's Trial steps carries \`${FINDING_TAG_TEXT["small-body"]}\`, as [ADR-0040](0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md) has it, and a Retry whose findings are all \`${FINDING_TAG_TEXT["small-body"]}\`, which a third such flaw calls for, may commit nothing as that Touch-up may: the Kit replaces the body and Reviews the same head again, and it is still one of the Ticket's two Retries.`,
    );
  });

  it("says in the glossary and the README that the Retry a third flaw about the body alone calls for may commit nothing, by the note the Kit posts for it", () => {
    const glossary = read("GLOSSARY.md");
    const touchUp = /^\*\*Touch-up\*\*:\n(.*)$/m.exec(glossary)?.[1] ?? "";
    const readme = read("README.md").split("\n");
    const touchUps = readme.find((line) => line.startsWith("- **Touch-ups** (#750, ADR-0027)")) ?? "";
    const push = readme.find((line) => line.startsWith("- **The push**: the push job runs the trust-root guard")) ?? "";
    const marker = retryBodyOnlyMarker("a".repeat(40)).replace("a".repeat(40), "<sha>");

    expect(touchUp).toContain("So may the Retry a third flaw of such findings calls for, which still counts as a Retry.");
    expect(touchUps).toContain(`The Retry a third such flaw calls for may commit nothing too (#962, ADR-0040): its prompt says so, the Kit lands it the same way under a \`${marker}\` note, and it counts as the Retry it is.`);
    expect(push).toContain("A retry that commits nothing is posted as an Execution-flaw Verdict with source `empty-diff`, and counts like any other, unless every finding it was given is `[small: body]` (see **Touch-ups**).");
  });

  it("says in its ADR which labels a Trial session puts on with the Operator's credential, by the names ADR-0038 reads", () => {
    const adr = read("docs/adr/0040-the-implementer-writes-a-staging-trials-steps-and-the-reviewer-judges-them.md");

    expect(adr).toContain(`\`${TRIAL_ACCEPTED_LABEL}\``);
    expect(adr).toContain(`\`${TRIAL_PROBLEM_LABEL}\``);
    expect(adr).toContain("](0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md)");
  });
});
