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
});
