import { describe, expect, it } from "vitest";
import { FAULT_OPENS_AT_MERGE, faultsNamedIn, followUpsIn, followUpsSection, issueTitleOf, listedFollowUpsIn, newIssueUrl } from "./followUps.ts";
import { verdictMarker } from "./markers.ts";

const REPO = "https://github.com/acme/shop";
const BADGE = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count.\n\nSeen on the product page." } as const;
const MONEY = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;
const FOOTER = { kind: "fault", title: "The footer test is skipped", body: "" } as const;

/** A Verdict comment's Follow-ups part, as the Kit posts it on pull request #50. */
const sectionOf = (...followUps: Parameters<typeof followUpsSection>[0]) => followUpsSection(followUps, REPO, 50).join("\n");

describe("The Follow-ups part of a pass's Verdict comment (#885)", () => {
  it("shows a fault with the line saying the Kit opens it at merge, and no link", () => {
    expect(sectionOf(BADGE)).toBe(
      ["", "### Follow-ups", "", "#### The badge miscounts", "", "`badge.ts:14` reads a stale count.\n\nSeen on the product page.", "", FAULT_OPENS_AT_MERGE].join("\n"),
    );
    expect(FAULT_OPENS_AT_MERGE).toBe("The Kit opens this fault as an issue when the pull request merges.");
  });

  it("shows an idea with its Open as issue link, as a Follow-up given no kind is shown", () => {
    const link = `[Open as issue](${newIssueUrl(REPO, MONEY.title, MONEY.body, "From PR #50")})`;

    expect(sectionOf(MONEY)).toBe(["", "### Follow-ups", "", "#### Extract the money type", "", MONEY.body, "", link].join("\n"));
    expect(sectionOf({ title: MONEY.title, body: MONEY.body })).toBe(sectionOf(MONEY));
  });
});

describe("Reading a posted Verdict comment's Follow-ups back (#885)", () => {
  it("reads each one's kind, title and body, an idea with its link and a fault with none", () => {
    expect(listedFollowUpsIn(sectionOf(BADGE, MONEY, FOOTER))).toEqual([
      { ...MONEY, url: newIssueUrl(REPO, MONEY.title, MONEY.body, "From PR #50") },
      { ...BADGE, url: null },
      { ...FOOTER, url: null },
    ]);
    expect(followUpsIn(sectionOf(BADGE, MONEY, FOOTER))).toEqual([MONEY, BADGE, FOOTER]);
  });

  it("lists the ideas before the faults, each in the order named, so a reader that knows only links reads every idea and stops at the first fault", () => {
    /** The reader as it was before a Follow-up had a kind: an item ends at its Open as issue link. */
    const readBefore = (comment: string): string[] => {
      const lines = comment.split("\n");
      const titles: string[] = [];
      let at = lines.lastIndexOf("### Follow-ups") + 1;
      for (;;) {
        while (lines[at] === "") at += 1;
        const title = /^#### (.*)$/.exec(lines[at] ?? "")?.[1];
        const link = lines.findIndex((line, i) => i > at && /^\[Open as issue\]\((.*)\)$/.test(line));
        if (title === undefined || link === -1) return titles;
        titles.push(title);
        at = link + 1;
      }
    };
    const TIDY = { kind: "idea", title: "Tidy the cart", body: "" } as const;

    expect(followUpsIn(sectionOf(BADGE, MONEY, FOOTER, TIDY)).map(({ title }) => title)).toEqual([MONEY.title, TIDY.title, BADGE.title, FOOTER.title]);
    expect(readBefore(sectionOf(BADGE, MONEY, FOOTER, TIDY))).toEqual([MONEY.title, TIDY.title]);
    expect(readBefore(sectionOf(BADGE, FOOTER))).toEqual([]);
  });

  it("reads a comment posted before a Follow-up had a kind as naming ideas", () => {
    const before = ["### Follow-ups", "", "#### Tidy the footer", "", "Crooked.", "", `[Open as issue](${REPO}/issues/new?title=Tidy+the+footer)`].join("\n");

    expect(followUpsIn(before)).toEqual([{ kind: "idea", title: "Tidy the footer", body: "Crooked." }]);
  });
});

describe("The faults a pull request's passes named (#885)", () => {
  /** The Fabrik App's Verdict comment on a head, listing these Follow-ups. */
  const aVerdictNaming = (verdict: "pass" | "execution-flaw", head: string, ...followUps: Parameters<typeof followUpsSection>[0]) =>
    [verdictMarker({ verdict, headSha: head.repeat(40), source: "reviewer", requestChanges: false }), "**Verdict**", sectionOf(...followUps)].join("\n");

  it("are every fault of every pass, oldest pass first, in the order named, an idea never among them", () => {
    const comments = [aVerdictNaming("pass", "a", BADGE, MONEY), "A note of the Kit's.", aVerdictNaming("pass", "b", FOOTER, BADGE)];

    expect(faultsNamedIn(comments)).toEqual([
      { title: BADGE.title, body: BADGE.body },
      { title: FOOTER.title, body: "" },
      { title: BADGE.title, body: BADGE.body },
    ]);
  });

  it("are never taken from a Verdict that is no pass", () => {
    expect(faultsNamedIn([aVerdictNaming("execution-flaw", "a", BADGE)])).toEqual([]);
  });
});

describe("The title of the issue a Follow-up opens as (#885)", () => {
  it("is the Follow-up's own, cut as its Open as issue link cuts it when longer than GitHub takes", () => {
    const long = "x".repeat(300);

    expect(issueTitleOf("The badge miscounts")).toBe("The badge miscounts");
    expect(issueTitleOf(long)).toBe(new URL(newIssueUrl(REPO, long, "", "From PR #50")).searchParams.get("title"));
    expect(Array.from(issueTitleOf(long)).length).toBeLessThanOrEqual(256);
  });
});
