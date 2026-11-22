import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { DIGEST_FOLDS_MARKER, type DigestGiven, type DigestReply, digestCommentOf, readDigestComment } from "./digestContract.ts";
import { digestFactsOf } from "./digestFacts.ts";
import { followUpsSection, type NamedFollowUp, newIssueUrl } from "./followUps.ts";
import { verdictMarker } from "./markers.ts";

const REPO = "https://github.com/acme/shop";
const BADGE = { kind: "fault", title: "The badge miscounts", body: "`badge.ts:14` reads a stale count." } as const;
const MONEY = { kind: "idea", title: "Extract the money type", body: "The cart and the till both round." } as const;
const FOOTER = { kind: "fault", title: "The footer test is skipped", body: "`footer.test.ts:3` is `it.skip`." } as const;

/** A pass on #50 of acme/shop whose comment lists these Follow-ups, as the Kit posts one. */
const aPassNaming = (minute: number, head: string, followUps: readonly NamedFollowUp[]) => ({
  at: `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`,
  body: [verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: head.repeat(40) }), "## Verdict: Pass", ...followUpsSection(followUps, REPO, 50)].join("\n"),
});

/** The Digest's comment for this reply and what Kit code hands the contract; a refusal fails the test. */
function bodyOf(reply: DigestReply, given: DigestGiven): string {
  const comment = digestCommentOf(reply, given);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

/** The Follow-ups section of a Digest: what sits between its heading and the folds line. */
const shown = (body: string) => body.split("\n### Follow-ups\n\n")[1]?.split(`\n\n${DIGEST_FOLDS_MARKER}\n`)[0];

describe("Kit code's facts about the Follow-ups, by kind (#885)", () => {
  it("give each Follow-up its kind, a fault with no link and an idea with its Open as issue link", () => {
    const { followUps } = digestFactsOf({ openedAt: "2026-11-02T10:00:00Z", kitComments: [aPassNaming(5, "a", [BADGE, MONEY])], requestChanges: [], landedNothing: 0 });

    expect(followUps).toEqual([
      { id: "f1", kind: "fault", title: BADGE.title, url: null },
      { id: "f2", kind: "idea", title: MONEY.title, url: newIssueUrl(REPO, MONEY.title, MONEY.body, "From PR #50") },
    ]);
  });
});

describe("The faults a Digest shows (#885)", () => {
  const NAMED = aDigestGiven({
    facts: aDigestFacts({
      followUps: [
        { id: "f1", kind: "fault", title: BADGE.title, url: null },
        { id: "f2", kind: "idea", title: MONEY.title, url: `${REPO}/issues/new?title=Extract+the+money+type` },
        { id: "f3", kind: "fault", title: FOOTER.title, url: null },
        { id: "f4", kind: "fault", title: ` ${BADGE.title} `, url: null },
      ],
    }),
  });
  const OPENS_AT_MERGE = "the Kit opens this fault as an issue when the pull request merges";

  it("are every fault Kit code listed, each once by its title, with the line saying it opens at merge, whatever the reply names", () => {
    expect(shown(bodyOf(aDigestReply({ followUps: [] }), NAMED))).toBe([`- ${BADGE.title}: ${OPENS_AT_MERGE}`, `- ${FOOTER.title}: ${OPENS_AT_MERGE}`].join("\n"));
  });

  it("come before the ideas the reply names, each of those with its Open as issue link", () => {
    expect(shown(bodyOf(aDigestReply({ followUps: ["f2"] }), NAMED))).toBe(
      [`- ${BADGE.title}: ${OPENS_AT_MERGE}`, `- ${FOOTER.title}: ${OPENS_AT_MERGE}`, `- ${MONEY.title}: [Open as issue](${REPO}/issues/new?title=Extract+the+money+type)`].join("\n"),
    );
  });

  it("refuse the Digest when the reply names a fault's id: the writer chooses only among the ideas", () => {
    expect(digestCommentOf(aDigestReply({ followUps: ["f1", "f2"] }), NAMED)).toEqual({
      ok: false,
      refused: "the reply names a fault among the Follow-ups to show, which Kit code shows itself: `f1`",
    });
    expect(digestCommentOf(aDigestReply({ followUps: ["f3", "f1"] }), NAMED)).toEqual({
      ok: false,
      refused: "the reply names faults among the Follow-ups to show, which Kit code shows itself: `f3`, `f1`",
    });
  });

  it("are in the Digest's data beside the Follow-ups shown, and a Digest written before faults reads as showing none", () => {
    const read = readDigestComment(bodyOf(aDigestReply({ followUps: ["f2"] }), NAMED));

    expect(read).toMatchObject({
      ok: true,
      data: { followUps: [{ title: MONEY.title, url: `${REPO}/issues/new?title=Extract+the+money+type` }], faults: [{ title: BADGE.title }, { title: FOOTER.title }] },
    });
    const before = bodyOf(aDigestReply(), aDigestGiven()).replace(',"faults":[]}', "}");
    expect(before).toContain('"followUps":[]} -->');
    expect(readDigestComment(before)).toMatchObject({ ok: true, data: { followUps: [], faults: [] } });
  });
});
