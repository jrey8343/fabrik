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
        },
      ],
      considered: [],
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
      followUps: [{ title: "Tidy the footer", body: "It was crooked already." }],
      considered: ["conversation-3"],
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
