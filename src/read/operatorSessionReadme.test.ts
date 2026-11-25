// What the README tells a reader of the Kit about the Operator session on a
// row (#951): where the address comes from, and what counts as a marker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operatorSessionMarker } from "../kit/operatorSession.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
/** The README's section on reading the Kit from another program. */
const section = readme.split("\n## Reading the Kit from another program\n")[1]?.split("\n## ")[0] ?? "";

const BULLET =
  "- **An Operator session on the row.** The row of an open issue carries `operatorSession`: the address of the Operator session that last reported itself there, or null. A session reports itself with a comment whose first line is `<!-- fabrik:operator-session <address> -->`, and the Kit counts it only when the Operator wrote the comment and the address is exactly `https://claude.ai/code/session_` and an id, since anyone can comment on a public repo and the address is a link the Operator taps. The comment posted last wins, so the row leads back to the session that wrote last, and earlier ones stay on the thread. It is worked out from the last hundred comments of the issue, which the gather reads, so a marker a hundred newer comments follow is no longer read, and the row leaves with the issue when it closes. A reader parses nothing: it draws the address. A row kept before the field reads with it null.";

describe("the README's section on reading the Kit from another program, on the Operator session on a row", () => {
  it("holds the bullet as written", () => {
    expect(section.split("\n")).toContain(BULLET);
  });

  it("puts it straight after the bullet on Follow-ups and the bullets under it", () => {
    const leads = section.split("\n").filter((line) => line.startsWith("- **"));

    expect(leads[leads.findIndex((line) => line.startsWith("- **Follow-ups.**")) + 1]).toBe(BULLET);
  });

  it("leaves the bullets under Follow-ups under that bullet, not under this one", () => {
    const lines = section.split("\n");

    expect(lines[lines.indexOf(BULLET) + 1]).not.toMatch(/^ {2}- /);
  });

  it("gives the marker line as the Kit writes it", () => {
    expect(BULLET).toContain(`\`${operatorSessionMarker("<address>")}\``);
  });
});
