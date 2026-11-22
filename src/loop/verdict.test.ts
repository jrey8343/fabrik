import { describe, expect, it } from "vitest";
import { parseVerdict } from "./verdict.ts";

describe("Reading the Follow-ups a Reviewer names on a pass", () => {
  it("reads one Follow-up's title and body, and keeps them out of the findings", () => {
    const parsed = parseVerdict(
      [
        "verdict: pass",
        "",
        "Checked the empty-cart case and its test.",
        "",
        "follow-ups:",
        "- The cart badge miscounts after a refresh",
        "  It was already wrong before this PR: `badge.ts` reads a stale count.",
        "",
        "  Seen on the product page.",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      ok: true,
      verdict: "pass",
      findings: "Checked the empty-cart case and its test.",
      findingTags: [],
      followUps: [
        {
          title: "The cart badge miscounts after a refresh",
          body: "It was already wrong before this PR: `badge.ts` reads a stale count.\n\nSeen on the product page.",
          kind: "idea",
        },
      ],
      considered: [],
      redChecks: [],
    });
  });

  it("reads several Follow-ups in order", () => {
    const parsed = parseVerdict("verdict: pass\n\nChecked it.\n\nfollow-ups:\n- First\n  One.\n- Second\n  Two.");

    expect(parsed).toMatchObject({
      ok: true,
      followUps: [
        { title: "First", body: "One." },
        { title: "Second", body: "Two." },
      ],
    });
  });

  it("a pass with no Follow-ups block has none", () => {
    expect(parseVerdict("verdict: pass\n\nChecked it.")).toMatchObject({ ok: true, findings: "Checked it.", followUps: [] });
  });

  it("reads Follow-ups before the line naming the Operator comments weighed, and that line too", () => {
    const parsed = parseVerdict(
      "verdict: pass\n\nChecked it.\n\nfollow-ups:\n- Tidy the footer\n  It was crooked already.\n\noperator comments considered: conversation-3",
    );

    expect(parsed).toEqual({
      ok: true,
      verdict: "pass",
      findings: "Checked it.",
      findingTags: [],
      followUps: [{ title: "Tidy the footer", body: "It was crooked already.", kind: "idea" }],
      considered: ["conversation-3"],
      redChecks: [],
    });
  });

  it.each(["execution-flaw", "design-flaw"])("a %s Verdict drops a Follow-ups block", (verdict) => {
    const parsed = parseVerdict(`verdict: ${verdict}\n\nThe build is red.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.`);

    expect(parsed).toMatchObject({ ok: true, verdict, findings: "The build is red.", followUps: [] });
  });

  it.each([
    ["an item with no title", "follow-ups:\n- \n  A body."],
    ["a body line that isn't indented", "follow-ups:\n- A title\nA body."],
    ["no items", "follow-ups:"],
  ])("a pass with %s still lands, its block left in the findings as plain text", (_, block) => {
    const parsed = parseVerdict(`verdict: pass\n\nChecked it.\n\n${block}`);

    expect(parsed).toMatchObject({ ok: true, verdict: "pass", findings: `Checked it.\n\n${block}`, followUps: [] });
  });

  it("a flaw keeps the findings that come after a Follow-ups block it drops", () => {
    const parsed = parseVerdict("verdict: execution-flaw\n\nThe build is red.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.\n\nAlso, the tests fail.");

    expect(parsed).toMatchObject({ ok: true, findings: "The build is red.\n\nAlso, the tests fail.", followUps: [] });
  });

  it("a pass with findings after its Follow-ups block keeps it all as plain text", () => {
    const output = "Checked it.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.\n\nOne more thing.";

    expect(parseVerdict(`verdict: pass\n\n${output}`)).toMatchObject({ ok: true, findings: output, followUps: [] });
  });
});

describe("Reading each Follow-up's kind (#885)", () => {
  it("reads a Follow-up marked a fault and one marked an idea, each title without its mark", () => {
    const parsed = parseVerdict(
      "verdict: pass\n\nChecked it.\n\nfollow-ups:\n- [fault] The badge miscounts\n  `badge.ts:14` reads a stale count.\n- [idea] Extract the money type\n  The cart and the till both round.",
    );

    expect(parsed).toMatchObject({
      ok: true,
      findings: "Checked it.",
      followUps: [
        { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." },
        { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." },
      ],
    });
  });

  it("reads a Follow-up with no kind as an idea", () => {
    expect(parseVerdict("verdict: pass\n\nChecked it.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.")).toMatchObject({
      ok: true,
      followUps: [{ kind: "idea", title: "Tidy the footer", body: "Crooked." }],
    });
  });

  it("reads any other mark as part of the title, and the Follow-up as an idea", () => {
    expect(parseVerdict("verdict: pass\n\nChecked it.\n\nfollow-ups:\n- [bug] Tidy the footer\n  Crooked.")).toMatchObject({
      ok: true,
      followUps: [{ kind: "idea", title: "[bug] Tidy the footer", body: "Crooked." }],
    });
  });

  it("a fault with no title after its mark still lands, its block left in the findings as plain text", () => {
    const block = "follow-ups:\n- [fault]\n  A body.";

    expect(parseVerdict(`verdict: pass\n\nChecked it.\n\n${block}`)).toMatchObject({ ok: true, findings: `Checked it.\n\n${block}`, followUps: [] });
  });
});

describe("Reading the tags on a Reviewer's findings", () => {
  it("reads each top-level item's tag, and an item with none as untagged", () => {
    const parsed = parseVerdict(
      [
        "verdict: execution-flaw",
        "",
        "- [small: body] The PR body still says the cart is cached.",
        "- [small: comment] `cart.ts`'s header comment still names `loadCart`.",
        "- [missed earlier] The empty cart throws in `checkout.ts`.",
        "- `checkout.test.ts` covers only a full cart.",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({ ok: true, findingTags: ["small-body", "small-comment", "missed-earlier", null] });
  });

  it("reads no tag from prose, an item's indented lines or a code block, and keeps the findings as written", () => {
    const findings = [
      "[small: body] Prose outside the items carries no tag.",
      "",
      "- [small: comment] The README still names `loadCart`.",
      "  - [missed earlier] A nested line is part of the item above.",
      "  ```diff",
      "- [small: body] a removed line in a quoted diff",
      "  ```",
      "",
      "```",
      "- [missed earlier] nor in a code block of its own",
      "```",
    ].join("\n");

    const parsed = parseVerdict(`verdict: execution-flaw\n\n${findings}\n\noperator comments considered: conversation-3`);

    expect(parsed).toMatchObject({ ok: true, findings, findingTags: ["small-comment"] });
  });

  it.each([
    ["a tag that doesn't open the item", "- The README is stale [small: comment]."],
    ["a tag spelled otherwise", "- [small] The README is stale."],
    ["a tag in other case", "- [Small: comment] The README is stale."],
    ["a tag inside formatting", "- **[small: comment]** The README is stale."],
    ["an item marked with another bullet", "* [small: comment] The README is stale."],
  ])("reads %s as untagged, or as no item", (_, line) => {
    const parsed = parseVerdict(`verdict: execution-flaw\n\n${line}`);

    expect(parsed).toMatchObject({ ok: true, findingTags: line.startsWith("- ") ? [null] : [] });
  });

  it("reads findings with no items as having no tags", () => {
    expect(parseVerdict("verdict: execution-flaw\n\nThe empty cart throws.")).toMatchObject({ ok: true, findingTags: [] });
  });
});

describe("Reading the Reviewer's judgment of each red Required check (#780)", () => {
  const NO_JUDGMENT = "the Reviewer gave no judgment";

  it("reads each red check's judgment and reason, and keeps the block out of the findings and their tags", () => {
    const parsed = parseVerdict(
      [
        "verdict: execution-flaw",
        "",
        "- [small: comment] A stale comment in `cart.ts`.",
        "",
        "red-checks:",
        "- unrelated `e2e`: the booking journey fails the same way on main's head, in code this change doesn't reach.",
        "- caused `gate`: the typecheck error is in a stub the renamed type breaks.",
        "",
        "operator comments considered: conversation-3",
      ].join("\n"),
      ["gate", "e2e"],
    );

    expect(parsed).toEqual({
      ok: true,
      verdict: "execution-flaw",
      findings: "- [small: comment] A stale comment in `cart.ts`.",
      findingTags: ["small-comment"],
      followUps: [],
      considered: ["conversation-3"],
      redChecks: [
        { check: "gate", judgment: "caused", reason: "the typecheck error is in a stub the renamed type breaks." },
        { check: "e2e", judgment: "unrelated", reason: "the booking journey fails the same way on main's head, in code this change doesn't reach." },
      ],
    });
  });

  it("reads the block after a pass's Follow-ups, and keeps both", () => {
    const parsed = parseVerdict(
      "verdict: pass\n\nChecked it.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.\n\nred-checks:\n- unrelated `e2e`: red on main's head too.",
      ["e2e"],
    );

    expect(parsed).toMatchObject({
      ok: true,
      findings: "Checked it.",
      followUps: [{ title: "Tidy the footer", body: "Crooked." }],
      redChecks: [{ check: "e2e", judgment: "unrelated", reason: "red on main's head too." }],
    });
  });

  it.each([
    ["left out", "- unrelated `lint`: red on main too."],
    ["misnamed", "- unrelated `e2e-tests`: red on main too."],
    ["misspelled in its judgment", "- unrelatd `e2e`: red on main too."],
    ["given no reason", "- unrelated `e2e`:"],
    ["not in backticks", "- unrelated e2e: red on main too."],
  ])("reads a red check whose item is %s as caused, the Reviewer having given no judgment", (_, item) => {
    const parsed = parseVerdict(`verdict: pass\n\nChecked it.\n\nred-checks:\n${item}`, ["e2e"]);

    expect(parsed).toMatchObject({ ok: true, findings: "Checked it.", findingTags: [], redChecks: [{ check: "e2e", judgment: "caused", reason: NO_JUDGMENT }] });
  });

  it("reads every red check as caused when the reply has no block", () => {
    expect(parseVerdict("verdict: pass\n\nChecked it.", ["gate", "e2e"])).toMatchObject({
      ok: true,
      redChecks: [
        { check: "gate", judgment: "caused", reason: NO_JUDGMENT },
        { check: "e2e", judgment: "caused", reason: NO_JUDGMENT },
      ],
    });
  });

  it("ignores an item for a check that isn't red, and the whole block on a green head, whose items count as no findings", () => {
    const block = "red-checks:\n- unrelated `e2e`: red on main too.\n- caused `gate`: the stub.";

    expect(parseVerdict(`verdict: execution-flaw\n\n- A bug.\n\n${block}`, ["gate"])).toMatchObject({
      findingTags: [null],
      redChecks: [{ check: "gate", judgment: "caused", reason: "the stub." }],
    });
    expect(parseVerdict(`verdict: execution-flaw\n\n- A bug.\n\n${block}`)).toEqual(parseVerdict("verdict: execution-flaw\n\n- A bug."));
  });

  it("reads a check named twice as caused if either item says so", () => {
    const parsed = parseVerdict("verdict: pass\n\nChecked it.\n\nred-checks:\n- unrelated `e2e`: red on main.\n- caused `e2e`: the stub breaks.", ["e2e"]);

    expect(parsed).toMatchObject({ redChecks: [{ check: "e2e", judgment: "caused", reason: "the stub breaks." }] });
  });

  it("matches a check whose name holds a backtick as the prompt wrote it", () => {
    const parsed = parseVerdict("verdict: pass\n\nChecked it.\n\nred-checks:\n- unrelated `e2e 'smoke'`: red on main.", ["e2e `smoke`"]);

    expect(parsed).toMatchObject({ redChecks: [{ check: "e2e `smoke`", judgment: "unrelated", reason: "red on main." }] });
  });

  it("keeps findings that come after the block", () => {
    const parsed = parseVerdict("verdict: execution-flaw\n\n- A bug.\n\nred-checks:\n- unrelated `e2e`: red on main.\n\nAlso, the tests are thin.", ["e2e"]);

    expect(parsed).toMatchObject({ findings: "- A bug.\n\nAlso, the tests are thin.", redChecks: [{ check: "e2e", judgment: "unrelated" }] });
  });
});
