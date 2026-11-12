import { describe, expect, it } from "vitest";
import { RUN_STORE_REPO } from "../kit/runStore.ts";
import { storeStandingsOf } from "../kit/standingStore.ts";
import { WEEKLY_SUMMARY_FAILED_MARKER } from "../kit/weeklyMarks.ts";
import { aComment, aLabelAdded, anOpenIssue } from "./builders.ts";
import { rowsOf } from "./rows.ts";
import type { StoreFacts, StoreSummaryFacts } from "./store.ts";

const NOW = "2026-11-09T12:00:00Z";
const SUMMARY_URL = `https://github.com/${RUN_STORE_REPO}/issues/9`;

/** The store with none of its own work in it, but what a test says. */
function storeOf(overrides: Partial<Omit<StoreFacts, "kind">> = {}): StoreFacts {
  return { kind: "store", appLogin: "fabrik-app[bot]", summaries: [], failedSummaryIssues: [], readyForHuman: [], ...overrides };
}

/** Weekly summary issue 9, open, its body written on 2026-11-09 at 07:00 UTC, with no comments of the Fabrik App's unless a test says so. */
function aSummary(overrides: Partial<StoreSummaryFacts> = {}): StoreSummaryFacts {
  return { number: 9, title: "Weekly summary: 2 to 9 November", open: true, bodyWrittenAt: "2026-11-09T07:00:00Z", appComments: [], ...overrides };
}

/** A failed run's notice, as the Fabrik App comments it at `at`. */
function aNotice(at: string) {
  return { body: `@jrey8343 **The Weekly summary failed**, so this week's summary isn't filed.\n\n${WEEKLY_SUMMARY_FAILED_MARKER}`, at, url: `${SUMMARY_URL}#issuecomment-5` };
}

describe("the store's rows", () => {
  it("are the store's Standing rule's own, one row for each", () => {
    const facts = storeOf({
      summaries: [aSummary()],
      failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [] }],
      readyForHuman: [anOpenIssue({ number: 12, title: "Tick dead in jrey8343/shop", labels: ["ready-for-human"] })],
    });

    expect(rowsOf(facts, "unread", {}, NOW).map(({ standing }) => standing)).toEqual(storeStandingsOf(facts, NOW));
  });

  it("give an open Weekly summary one row, the Operator's to read, not marked as stopping work, with its title and the Fabrik App's last word", () => {
    const said = { body: "Re-ran: two repos read.", at: "2026-11-09T08:00:00Z", url: `${SUMMARY_URL}#issuecomment-4` };

    const rows = rowsOf(storeOf({ summaries: [aSummary({ appComments: [said] })] }), "unread", {}, NOW);

    expect(rows).toEqual([
      {
        standing: expect.objectContaining({ repo: RUN_STORE_REPO, issue: 9, pullRequest: null, name: "yours-to-read", move: "operator", stopsWork: false, work: "weekly-summary", since: "2026-11-09T07:00:00Z" }),
        title: "Weekly summary: 2 to 9 November",
        lastWord: { text: "Re-ran: two repos read.", at: "2026-11-09T08:00:00Z", url: `${SUMMARY_URL}#issuecomment-4` },
        related: [],
        mentions: [],
        relatedTo: null,
        followUps: [],
      },
    ]);
  });

  it("give a failure notice that is the Fabrik App's last comment on the newest Weekly summary one row, the Operator's with the mark off", () => {
    const rows = rowsOf(storeOf({ summaries: [aSummary({ open: false, appComments: [aNotice("2026-11-09T07:30:00Z")] })] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ issue: 9, name: "yours-to-do", move: "operator", stopsWork: false, work: "weekly-summary", since: "2026-11-09T07:30:00Z" }),
        title: "Weekly summary: 2 to 9 November",
        lastWord: { text: aNotice("2026-11-09T07:30:00Z").body, at: "2026-11-09T07:30:00Z", url: `${SUMMARY_URL}#issuecomment-5` },
      }),
    ]);
  });

  it("give none for that notice when the Weekly summary's body was written since", () => {
    const rows = rowsOf(storeOf({ summaries: [aSummary({ open: false, bodyWrittenAt: "2026-11-09T08:00:00Z", appComments: [aNotice("2026-11-09T07:30:00Z")] })] }), "unread", {}, NOW);

    expect(rows).toEqual([]);
  });

  it("give an open \"Weekly summary failed\" issue a row, the Operator's with the mark off", () => {
    const notice = { body: "@jrey8343 The issue's own word.", at: "2026-11-02T07:05:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/11#issuecomment-1` };
    const rows = rowsOf(storeOf({ failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [notice] }] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ issue: 11, name: "yours-to-do", stopsWork: false, since: "2026-11-02T07:00:00Z" }),
        title: "Weekly summary failed",
        lastWord: { text: "@jrey8343 The issue's own word.", at: "2026-11-02T07:05:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/11#issuecomment-1` },
      }),
    ]);
  });

  it("give an open ready-for-human issue a row marked as stopping work, with the Fabrik App's last word on it", () => {
    const issue = anOpenIssue({
      number: 12,
      title: "Tick dead in jrey8343/shop",
      author: "fabrik-app[bot]",
      labels: ["ready-for-human"],
      labelEvents: [aLabelAdded("ready-for-human", "2026-11-08T10:00:00Z")],
      comments: [
        aComment("The Fabrik App can't reach jrey8343/shop.", "2026-11-08T10:00:00Z", { url: `https://github.com/${RUN_STORE_REPO}/issues/12#issuecomment-1` }),
        aComment("I'll look tonight.", "2026-11-08T11:00:00Z", { author: "jrey8343", byBot: false }),
      ],
    });

    const rows = rowsOf(storeOf({ readyForHuman: [issue] }), "unread", {}, NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        standing: expect.objectContaining({ repo: RUN_STORE_REPO, issue: 12, name: "yours-to-do", move: "operator", stopsWork: true, work: "ready-for-human", since: "2026-11-08T10:00:00Z" }),
        title: "Tick dead in jrey8343/shop",
        lastWord: { text: "The Fabrik App can't reach jrey8343/shop.", at: "2026-11-08T10:00:00Z", url: `https://github.com/${RUN_STORE_REPO}/issues/12#issuecomment-1` },
      }),
    ]);
  });

  it("take any bot's comment for the Fabrik App's when the reader gave no login", () => {
    const issue = anOpenIssue({ number: 12, labels: ["ready-for-human"], comments: [aComment("Another App's word.", "2026-11-08T10:00:00Z", { author: "other-app[bot]" })] });

    const [row] = rowsOf(storeOf({ appLogin: null, readyForHuman: [issue] }), "unread", {}, NOW);

    expect(row?.lastWord?.text).toBe("Another App's word.");
  });

  it("are none for a store with none of these", () => {
    expect(rowsOf(storeOf({ summaries: [aSummary({ open: false })] }), "unread", {}, NOW)).toEqual([]);
    expect(rowsOf(storeOf(), "unread", {}, NOW)).toEqual([]);
  });

  it("survive a JSON round trip, as their facts do", () => {
    const facts = storeOf({
      summaries: [aSummary({ appComments: [aNotice("2026-11-09T07:30:00Z")] }), aSummary({ number: 8, open: false })],
      failedSummaryIssues: [{ number: 11, title: "Weekly summary failed", createdAt: "2026-11-02T07:00:00Z", appComments: [] }],
      readyForHuman: [anOpenIssue({ number: 12, labels: ["ready-for-human"] })],
    });
    const rows = rowsOf(facts, "unread", {}, NOW);

    expect(rows.length).toBe(3);
    expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
    expect(JSON.parse(JSON.stringify(rows))).toStrictEqual(rows);
  });
});
