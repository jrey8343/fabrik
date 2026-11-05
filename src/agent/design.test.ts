import { describe, expect, it } from "vitest";
import { sentBackContext } from "./design.ts";

const issue = { number: 7, title: "Add a waitlist", body: "As a patient…", comments: [] };
const sha = (c: string) => c.repeat(40);

const sentBack = {
  pullRequest: { number: 50, title: "Add a waitlist", baseRefName: "main", headRefName: "fabrik/ticket-7", headRefOid: sha("c") },
  sentBackBy: "verdict",
  verdicts: [
    { verdict: "execution-flaw", source: "reviewer", headSha: sha("a"), comment: "<!-- fabrik:verdict {} -->\nThe test is missing." },
    { verdict: "execution-flaw", source: "ci", headSha: sha("c"), comment: "<!-- fabrik:verdict {} -->\nThe checks are red." },
  ],
  operatorReviews: [],
  commits: [{ sha: sha("c"), message: "Add the waitlist table\n\nWith a body." }],
  files: [{ filename: "src/waitlist.ts", status: "added", additions: 2, deletions: 0 }],
  diff: "diff --git a/src/waitlist.ts b/src/waitlist.ts\n@@ -0,0 +1,2 @@\n+export const waitlist = [];",
  diffTruncated: false,
};

describe("A Design session's context from the PR a Ticket came back from", () => {
  it("leaves an issue that didn't come back as it is, with nothing added", () => {
    expect(sentBackContext(issue)).toEqual({ issue, parts: [] });
  });

  it("takes the PR out of the issue and sets out its Verdicts, oldest first, then what its branch built", () => {
    const { issue: rest, parts } = sentBackContext({ ...issue, sentBack });

    expect(rest).toEqual(issue);
    const text = parts.join("\n\n");
    expect(text).toContain("## The pull request this Ticket came back from");
    expect(text).toContain("#50: Add a waitlist");
    expect(text.indexOf("The test is missing.")).toBeLessThan(text.indexOf("The checks are red."));
    expect(text).toContain(`### Verdict 1 of 2: execution-flaw (reviewer), on ${sha("a")}`);
    expect(text).toContain(`### Verdict 2 of 2: execution-flaw (ci), on ${sha("c")}`);
    expect(text).toContain(`- ${sha("c").slice(0, 7)} Add the waitlist table`);
    expect(text).toContain("- src/waitlist.ts (added, +2 −0)");
    expect(text).toContain("```diff\ndiff --git a/src/waitlist.ts b/src/waitlist.ts\n@@ -0,0 +1,2 @@\n+export const waitlist = [];\n```");
  });

  it("sets out the Operator's reviews, inline comments included, when the Operator sent it back", () => {
    const { parts } = sentBackContext({
      ...issue,
      sentBack: {
        ...sentBack,
        sentBackBy: "operator",
        verdicts: [],
        operatorReviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "This isn't the waitlist we want.",
            commitId: sha("c"),
            submittedAt: "2026-11-02T00:00:00Z",
            comments: [{ path: "src/waitlist.ts", line: 1, body: "Patients, not slots." }],
          },
        ],
      },
    });

    const text = parts.join("\n\n");
    expect(text).toContain("The Operator sent it back to design from the Merge gate");
    expect(text).toContain("This isn't the waitlist we want.");
    expect(text).toContain("#### `src/waitlist.ts` line 1\n\nPatients, not slots.");
    expect(text).not.toContain("### Verdict");
  });

  const operatorComments = [
    {
      id: "inline-8",
      url: "https://github.com/acme/shop/pull/50#discussion_r8",
      where: { kind: "inline", path: "src/waitlist.ts", line: 2 },
      createdAt: "2026-11-01T12:00:00Z",
      body: "The waitlist is per clinic.",
    },
  ];

  it.each(["verdict", "operator"])("sets out the Operator's comments on the PR when sent back by the %s, before what its branch built", (by) => {
    const { parts } = sentBackContext({ ...issue, sentBack: { ...sentBack, sentBackBy: by, operatorComments } });

    const text = parts.join("\n\n");
    expect(text).toContain("### The Operator's comments on the pull request");
    expect(text).toContain("#### `inline-8`: inline on `src/waitlist.ts` line 2, 2026-11-01T12:00:00Z\n\nThe waitlist is per clinic.");
    expect(text.indexOf("The waitlist is per clinic.")).toBeLessThan(text.indexOf("### What its branch built"));
  });
});
