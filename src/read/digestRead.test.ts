import { describe, expect, it } from "vitest";
import type { DigestData } from "../loop/digestContract.ts";
import { aDigestComment, aNoDigestLine, anOpenPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
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
function digestOf(facts: Facts): DigestRead | null | undefined {
  return rowsOf(facts, null, null, null, NOW).find(({ standing }) => standing.pullRequest === 50)?.digest;
}

describe("The Digest on an open agent pull request's row", () => {
  it("is readable for a pull request at the Merge gate with a Digest for its head: the data, the folds, the head, when it was posted and where", () => {
    const digest = aDigestComment(HEAD, "2026-11-08T18:05:00Z", { data: DATA, folds: FOLDS }, { url: "https://github.com/owner/product/pull/50#issuecomment-9" });

    expect(digestOf(atTheMergeGate(digest))).toEqual({
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

    expect(digestOf(atTheMergeGate(carried))).toMatchObject({ is: "readable", head: HEAD, carriedFrom: EARLIER_HEAD });
  });

  it("is none when the only Digest is for an earlier head: one for another head is never given", () => {
    expect(digestOf(atTheMergeGate(aDigestComment(EARLIER_HEAD, "2026-11-08T17:00:00Z", { data: DATA })))).toEqual({ is: "none" });
  });

  it("is none for a head nothing names: a draft still in the Loop", () => {
    const draft = homeFactsOf({ github: factsOf({ openPullRequests: [anOpenPullRequest({ number: 50, ticket: 7, draft: true })] }) });

    expect(digestOf(draft)).toEqual({ is: "none" });
  });

  it.each(["failed", "timed-out", "refused", "no-subscription", "never-started"] as const)("is not written, with how, when the Kit's no-Digest line for the head says %s", (how) => {
    const line = aNoDigestLine(HEAD, how, "2026-11-08T18:05:00Z", { url: "https://github.com/owner/product/pull/50#issuecomment-8" });

    expect(digestOf(atTheMergeGate(line))).toEqual({ is: "not-written", how, url: "https://github.com/owner/product/pull/50#issuecomment-8" });
  });

  it("is the newer of the two when the head has a no-Digest line and a Digest: a Digest posted after the line is readable, a line after the Digest is not written", () => {
    const line = (at: string) => aNoDigestLine(HEAD, "timed-out", at);
    const digest = (at: string) => aDigestComment(HEAD, at, { data: DATA });

    expect(digestOf(atTheMergeGate(line("2026-11-08T18:05:00Z"), digest("2026-11-08T19:00:00Z")))).toMatchObject({ is: "readable", at: "2026-11-08T19:00:00Z" });
    expect(digestOf(atTheMergeGate(digest("2026-11-08T18:05:00Z"), line("2026-11-08T19:00:00Z")))).toMatchObject({ is: "not-written", how: "timed-out" });
  });

  it("is the newest Digest for the head when it has two, and never a no-Digest line for an earlier head", () => {
    const first = aDigestComment(HEAD, "2026-11-08T18:05:00Z", {}, { url: "https://github.com/owner/product/pull/50#issuecomment-8" });
    const second = aDigestComment(HEAD, "2026-11-08T19:00:00Z", { data: DATA }, { url: "https://github.com/owner/product/pull/50#issuecomment-9" });

    expect(digestOf(atTheMergeGate(aNoDigestLine(EARLIER_HEAD, "failed", "2026-11-08T17:00:00Z"), first, second))).toMatchObject({ is: "readable", url: "https://github.com/owner/product/pull/50#issuecomment-9", data: DATA });
    expect(digestOf(atTheMergeGate(aNoDigestLine(EARLIER_HEAD, "failed", "2026-11-08T17:00:00Z")))).toEqual({ is: "none" });
  });
});
