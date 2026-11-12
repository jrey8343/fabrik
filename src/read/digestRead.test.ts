import { describe, expect, it } from "vitest";
import type { DigestData } from "../loop/digestContract.ts";
import { aDigestComment, aNoDigestLine, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import type { DigestRead } from "./digestRead.ts";
import type { Facts } from "./gather.ts";
import { rowsOf } from "./rows.ts";

const NOW = "2026-11-08T20:00:00Z";
const HEAD = "h".repeat(40);
const EARLIER_HEAD = "e".repeat(40);

/** A Digest's top: one thing that is the Operator's to judge, pointing at the saved-basket rule inside the diff and at the page's words outside it, and one Follow-up. */
const DATA: DigestData = {
  v: 1,
  items: [
    {
      kind: "yours-to-judge",
      claim: "Prices hold for 24 hours.",
      sentence: "The Ticket said for a while, and the Implementer chose a day.",
      places: [
        { path: "src/basket/save.ts", start: 3, end: 4, as: "code", inDiff: true, fingerprint: "0123456789ab" },
        { path: "src/basket/copy.ts", start: 2, end: 2, as: "words", inDiff: false, fingerprint: "ba9876543210" },
      ],
      picture: null,
      suggestedRequest: null,
    },
  ],
  whatItDoes: "A shopper can now save their basket from /basket.",
  howItGotHere: "One Review passed it at the first head.",
  followUps: [{ title: "Share a saved basket by link", url: "https://github.com/owner/product/issues/new?title=Share+a+saved+basket+by+link" }],
};

const FOLDS = ["<details>", "<summary>Walk me through it</summary>", "", "1. The basket page's Save button.", "", "</details>", "", "[The run](https://github.com/owner/product/actions/runs/42/attempts/1)"].join("\n");

/** Agent pull request 50 for Ticket 7, out of draft at the Merge gate on a pass at its head, with these comments after the Verdict. */
function atTheMergeGate(...comments: ReturnType<typeof aDigestComment>[]): Facts {
  const pullRequest = anOpenPullRequest({ number: 50, ticket: 7, draft: false, comments: [aVerdictComment("pass", HEAD, "2026-11-08T18:00:00Z"), ...comments] });
  return homeFactsOf({ github: factsOf({ openPullRequests: [pullRequest] }) });
}

/** The Digest on pull request 50's row. */
function digestOn(facts: Facts): DigestRead | null | undefined {
  return rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50)?.digest;
}

describe("The Digest on an open agent pull request's row", () => {
  it("is readable for a pull request at the Merge gate with a Digest for its head: the data, the folds, the head, when it was posted and where", () => {
    const digest = aDigestComment(HEAD, "2026-11-08T18:05:00Z", { data: DATA, folds: FOLDS }, { url: "https://github.com/owner/product/pull/50#issuecomment-9" });

    expect(digestOn(atTheMergeGate(digest))).toEqual({
      is: "readable",
      head: HEAD,
      carriedFrom: null,
      at: "2026-11-08T18:05:00Z",
      url: "https://github.com/owner/product/pull/50#issuecomment-9",
      data: DATA,
      folds: FOLDS,
    });
  });

  it("gives the head a Digest carried forward was first written at", () => {
    const carried = aDigestComment(HEAD, "2026-11-08T18:05:00Z", { carriedFrom: EARLIER_HEAD });

    expect(digestOn(atTheMergeGate(carried))).toMatchObject({ is: "readable", head: HEAD, carriedFrom: EARLIER_HEAD });
  });

  it("is none when the only Digest is for an earlier head: one for another head is never given", () => {
    expect(digestOn(atTheMergeGate(aDigestComment(EARLIER_HEAD, "2026-11-08T17:00:00Z", { data: DATA })))).toEqual({ is: "none" });
  });

  it("is none for a head nothing names: a draft still in the Loop", () => {
    const draft = homeFactsOf({ github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: true })] }) });

    expect(digestOn(draft)).toEqual({ is: "none" });
  });

  it.each(["failed", "timed-out", "refused", "no-subscription", "never-started"] as const)("is not written, with how, when the Kit's no-Digest line for the head says %s", (how) => {
    const line = aNoDigestLine(HEAD, how, "2026-11-08T18:05:00Z", { url: "https://github.com/owner/product/pull/50#issuecomment-8" });

    expect(digestOn(atTheMergeGate(line))).toEqual({ is: "not-written", how, url: "https://github.com/owner/product/pull/50#issuecomment-8" });
  });

  it("is the newer of the two when the head has a no-Digest line and a Digest: a Digest posted after the line is readable, a line after the Digest is not written", () => {
    const line = (at: string) => aNoDigestLine(HEAD, "timed-out", at);
    const digest = (at: string) => aDigestComment(HEAD, at, { data: DATA });

    expect(digestOn(atTheMergeGate(line("2026-11-08T18:05:00Z"), digest("2026-11-08T19:00:00Z")))).toMatchObject({ is: "readable", at: "2026-11-08T19:00:00Z" });
    expect(digestOn(atTheMergeGate(digest("2026-11-08T18:05:00Z"), line("2026-11-08T19:00:00Z")))).toMatchObject({ is: "not-written", how: "timed-out" });
  });

  it("is the newest Digest for the head when it has two, and never a no-Digest line for an earlier head", () => {
    const first = aDigestComment(HEAD, "2026-11-08T18:05:00Z", {}, { url: "https://github.com/owner/product/pull/50#issuecomment-8" });
    const second = aDigestComment(HEAD, "2026-11-08T19:00:00Z", { data: DATA }, { url: "https://github.com/owner/product/pull/50#issuecomment-9" });

    expect(digestOn(atTheMergeGate(aNoDigestLine(EARLIER_HEAD, "failed", "2026-11-08T17:00:00Z"), first, second))).toMatchObject({ is: "readable", url: "https://github.com/owner/product/pull/50#issuecomment-9", data: DATA });
    expect(digestOn(atTheMergeGate(aNoDigestLine(EARLIER_HEAD, "failed", "2026-11-08T17:00:00Z")))).toEqual({ is: "none" });
  });

  it("is read only from a comment the Fabrik App wrote, any bot's when the gather was given no App login: a person quoting one fakes nothing", () => {
    const quoted = aDigestComment(HEAD, "2026-11-08T18:05:00Z", { data: DATA }, { author: "someone", byBot: false });
    const anotherBots = aDigestComment(HEAD, "2026-11-08T18:05:00Z", { data: DATA }, { author: "some-app[bot]" });
    const withNoAppLogin = (...comments: ReturnType<typeof aDigestComment>[]): Facts => ({ ...atTheMergeGate(...comments), appLogin: null });

    expect(digestOn(atTheMergeGate(quoted))).toEqual({ is: "none" });
    expect(digestOn(atTheMergeGate(anotherBots))).toEqual({ is: "none" });
    expect(digestOn(withNoAppLogin(anotherBots))).toMatchObject({ is: "readable", data: DATA });
    expect(digestOn(withNoAppLogin(quoted))).toEqual({ is: "none" });
  });

  it("is null on every other row: an issue's, and a Plain pull request's", () => {
    const ticket = anOpenIssue({ number: 7, title: "Build the thing", labels: ["ready-for-agent"] });
    const facts = homeFactsOf({ github: factsOf({ openIssues: [ticket], plainPullRequests: [aPlainPullRequest({ number: 70 })] }) });

    const rows = rowsOf(facts, null, null, null, NOW);

    expect(rows.map(({ standing, digest }) => ({ issue: standing.issue, pullRequest: standing.pullRequest, digest }))).toEqual(
      expect.arrayContaining([
        { issue: 7, pullRequest: null, digest: null },
        { issue: null, pullRequest: 70, digest: null },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("A Digest no reader can draw", () => {
  const URL = "https://github.com/owner/product/pull/50#issuecomment-9";
  /** The Digest of the head as the builder writes it, with nothing for the Operator's eyes, as GitHub renders it: its hidden lines left out. */
  const RENDERED = [
    `**Digest** of #50, written as of [\`hhhhhhh\`](https://github.com/owner/product/pull/50/commits/${HEAD}).`,
    "",
    "### Needs your eyes",
    "",
    "Nothing.",
    "",
    "### What it does",
    "",
    "A shopper can now save their basket.",
    "",
    "### How it got here",
    "",
    "One Review passed it at the first head.",
    "",
    "### Follow-ups",
    "",
    "None named.",
    "",
    "[The run](https://github.com/owner/product/actions/runs/42/attempts/1)",
  ].join("\n");
  const written = aDigestComment(HEAD, "2026-11-08T18:05:00Z", {}, { url: URL });
  /** That Digest with its data line, the comment's second, rewritten. */
  const withDataLine = (rewrite: (line: string) => string) => ({ ...written, body: written.body.split("\n").map((line, at) => (at === 1 ? rewrite(line) : line)).join("\n") });

  it("is unreadable, with its Markdown, when its data line is at a version this release does not know", () => {
    const later = withDataLine((line) => line.replace('{"v":1,', '{"v":2,'));

    expect(later.body).not.toBe(written.body);
    expect(digestOn(atTheMergeGate(later))).toEqual({ is: "unreadable", why: "unknown-version", url: URL, markdown: RENDERED });
  });

  it.each([
    ["does not parse", (line: string) => line.replace('{"v":1,', '{"v":1,,')],
    ["lacks a field its version names", (line: string) => line.replace('"whatItDoes"', '"whatItDid"')],
    ["is not there", () => "A line a person might write."],
  ])("is unreadable as malformed, with where it is, when its data line %s", (_how, rewrite) => {
    const broken = withDataLine(rewrite);

    expect(broken.body).not.toBe(written.body);
    expect(digestOn(atTheMergeGate(broken))).toMatchObject({ is: "unreadable", why: "malformed", url: URL });
  });

  it("is unreadable as edited when GitHub records an edit of its body, though its data line still reads: the Kit never edits a Digest, so the edit is a person's", () => {
    const edited = { ...written, bodyEditedAt: "2026-11-08T18:30:00Z" };

    expect(digestOn(atTheMergeGate(edited))).toEqual({ is: "unreadable", why: "edited", url: URL, markdown: RENDERED });
  });

  it("gives an edited Digest's Markdown as the person left it, with every hidden line left out", () => {
    const edited = { ...written, body: `${written.body.replace("Nothing.", "Nothing, they say.")}\n<!-- fabrik:verdict {"verdict":"pass"} -->`, bodyEditedAt: "2026-11-08T18:30:00Z" };

    expect(digestOn(atTheMergeGate(edited))).toEqual({ is: "unreadable", why: "edited", url: URL, markdown: RENDERED.replace("Nothing.", "Nothing, they say.") });
  });
});
