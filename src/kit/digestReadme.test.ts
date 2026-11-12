// The README's section on the Digest was written a bullet at a time, one
// Ticket after another, each saying what it added. Read whole, against what
// was built (#657): the bullets that open it say what the finished Digest
// is, as the contract renders it, and the section reads as one account.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { digestCommentOf, NO_DIGEST_HOWS, parseDigestReply } from "../loop/digestContract.ts";

describe("The README's Digest section, read whole", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";
  const bulletOf = (name: string): string => section.split("\n").find((line) => line.startsWith(`- **${name}**`)) ?? "";

  it("The Digest writer names every field of the writer's reply, and the one thing the writer judges", () => {
    const writer = bulletOf("The Digest writer");
    const reply = aDigestReply();
    const fields = Object.keys(reply);

    // The fixture is a reply the contract takes, and one short of any field is not.
    expect(parseDigestReply(JSON.stringify(reply)).ok).toBe(true);
    for (const field of fields) {
      expect(parseDigestReply(JSON.stringify({ ...reply, [field]: undefined })).ok).toBe(false);
      expect(writer).toContain(`\`${field}\``);
    }
    expect(fields).toHaveLength(8);
    expect(writer).toContain("Its reply is eight fields");
    expect(writer).toContain("beyond whether each thing asked for is in the head");
    expect(writer).toContain("Kit code's facts");
  });

  it("The comment lists the top's four sections and the four folds in the order the contract renders them", () => {
    const comment = bulletOf("The comment");
    const digest = digestCommentOf(aDigestReply(), aDigestGiven());
    const body = digest.ok ? digest.body : "";
    const sections = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    const folds = [...body.matchAll(/^<summary>(.+)<\/summary>$/gm)].map((match) => match[1]);

    expect(sections).toHaveLength(4);
    expect(folds).toHaveLength(4);
    const at = [...sections, ...folds].map((name) => comment.indexOf(`**${name}**`));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    expect(comment).toContain("four folds");
    expect(comment.indexOf("a link to the run")).toBeGreaterThan(at.at(-1) ?? -1);
  });

  it("No Digest names every way an attempt ends with none, and each reply Kit code refuses", () => {
    const noDigest = bulletOf("No Digest");

    for (const how of NO_DIGEST_HOWS) expect(noDigest).toContain(`\`${how}\``);
    for (const refused of ["breaks its shape", "leaves an ask of yours unanswered", "do not cover every ask", "runs over 180 words", "names a Follow-up Kit code did not list", "too long for one comment"]) {
      expect(noDigest).toContain(refused);
    }
  });

  it("The gate names the two passes that open the gate themselves, with no label", () => {
    const gate = bulletOf("The gate");

    expect(gate).toContain("Two passes open the gate themselves, adding no label");
    expect(gate).toContain("(see **Carried forward**)");
    expect(gate).toContain("(see **Never held**)");
  });

  it("says what a Digest has, never what a Ticket added to it", () => {
    expect(section).not.toMatch(/\bgains?\b/);
  });
});
