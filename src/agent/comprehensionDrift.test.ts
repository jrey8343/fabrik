import { describe, expect, it } from "vitest";
import { comprehensionDrift, type MergedPullRequestChanges } from "./comprehensionDrift.ts";

/** When the Audit was opened: the 30 days run back from here. */
const AT = "2026-11-08T00:00:00Z";

/** A PR merged `daysAgo` days before AT, changing `files`: an agent PR unless said otherwise. */
function merged(files: string[], daysAgo = 1, by: { headRef?: string; authorIsBot?: boolean } = {}): MergedPullRequestChanges {
  return {
    mergedAt: new Date(Date.parse(AT) - daysAgo * 86_400_000).toISOString(),
    headRef: by.headRef ?? "fabrik/ticket-7",
    authorIsBot: by.authorIsBot ?? true,
    files,
  };
}

/** `n` agent PRs, each changing `files`. */
const times = (n: number, files: string[], daysAgo = 1) => Array.from({ length: n }, () => merged(files, daysAgo));

describe("Comprehension drift", () => {
  it("is a file merged agent PRs changed more than 5 times in the last 30 days: 5 isn't drift and 6 is", () => {
    const pullRequests = [...times(6, ["src/booking/slots.ts"]), ...times(5, ["src/billing/invoice.ts"])];

    expect(comprehensionDrift(pullRequests, AT)).toEqual([{ path: "src/booking/slots.ts", changes: 6 }]);
  });

  it("doesn't count human PRs: one from a person's branch, or the App's from a branch that isn't an agent branch", () => {
    const pullRequests = [
      ...times(5, ["src/booking/slots.ts"]),
      merged(["src/booking/slots.ts"], 1, { headRef: "operator/fix-slots", authorIsBot: false }),
      merged(["src/booking/slots.ts"], 1, { headRef: "fabrik/ticket-9", authorIsBot: false }),
      merged(["src/booking/slots.ts"], 1, { headRef: "fabrik/skills-bump", authorIsBot: true }),
    ];

    expect(comprehensionDrift(pullRequests, AT)).toEqual([]);
  });

  it("counts only the 30 days up to the Audit: a change 31 days before, or merged after it, isn't one", () => {
    const pullRequests = [...times(5, ["src/booking/slots.ts"], 29), merged(["src/booking/slots.ts"], 31), merged(["src/booking/slots.ts"], -1)];

    expect(comprehensionDrift(pullRequests, AT)).toEqual([]);
    expect(comprehensionDrift([...pullRequests, merged(["src/booking/slots.ts"], 30)], AT)).toEqual([
      { path: "src/booking/slots.ts", changes: 6 },
    ]);
  });

  describe("is cleared by a doc a merged agent PR changed in the 30 days", () => {
    const hot = times(6, ["src/booking/slots.ts", "src/billing/invoice.ts", "server.ts"]);

    it.each([
      ["a Markdown file in the same directory", "src/booking/README.md", ["server.ts", "src/billing/invoice.ts"]],
      ["a Markdown file at the root, for a file at the root", "NOTES.md", ["src/billing/invoice.ts", "src/booking/slots.ts"]],
      ["an ADR", "docs/adr/0004-slots-are-per-clinic.md", []],
      ["the glossary", "GLOSSARY.md", []],
    ])("%s", (_, doc, left) => {
      const drift = comprehensionDrift([...hot, merged(["src/booking/slots.test.ts", doc], 20)], AT);

      expect(drift.map((file) => file.path)).toEqual(left);
    });

    it("but not by a Markdown file in another directory, below it or above it, or a doc changed before the 30 days", () => {
      const docs = merged(["src/booking/rules/README.md", "src/README.md", "src/booking/notes.txt"]);
      const old = merged(["src/booking/README.md", "GLOSSARY.md", "docs/adr/0004-slots-are-per-clinic.md"], 31);

      expect(comprehensionDrift([...times(6, ["src/booking/slots.ts"]), docs, old], AT)).toEqual([
        { path: "src/booking/slots.ts", changes: 6 },
      ]);
    });

    it("and not by a human PR's doc change, since human PRs count for nothing", () => {
      const human = merged(["src/booking/README.md", "GLOSSARY.md"], 1, { headRef: "operator/docs", authorIsBot: false });

      expect(comprehensionDrift([...times(6, ["src/booking/slots.ts"]), human], AT)).toEqual([
        { path: "src/booking/slots.ts", changes: 6 },
      ]);
    });
  });
});
