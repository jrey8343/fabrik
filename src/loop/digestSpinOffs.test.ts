// A Digest and the points the Operator asked to be Spin-offs (#884): Kit
// code's facts name, on each ask, the Spin-offs opened from it, the Digest
// shows them under that ask, and the writer answers only for what was to be
// built.
import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply, aRequestChanges } from "../__fixtures__/digests.ts";
import { type DigestAnswer, type DigestGiven, type DigestItem, type DigestReply, digestCommentOf, readDigestReply } from "./digestContract.ts";
import { type DigestAsk, type DigestThread, digestFactsOf } from "./digestFacts.ts";
import { REQUEST_CHANGES_RUN_EMPTY_MARKER, REQUEST_CHANGES_RUN_MARKER, requestChangesAnswersMarker } from "./markers.ts";

const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00Z`;
const REVIEW = (id: number) => `https://github.com/acme/shop/pull/50#pullrequestreview-${id}`;
const DISCUSSION = (id: number) => `https://github.com/acme/shop/pull/50#discussion_r${id}`;

/** A Request-changes run's outcome note, as the Kit posted it, recording the Spin-offs it opened. */
const runNote = (first: string, review: number, ...opened: [issue: number, from: string, title: string][]) =>
  [
    first,
    requestChangesAnswersMarker({ review, reviewMiss: false, amendsTicket: false }),
    ...opened.map(([issue, from, title]) => `<!-- fabrik:spin-off-opened #${issue} ${JSON.stringify({ from, title })} -->`),
    "The Request-changes run landed.",
  ].join("\n");

function aThread(overrides: Partial<DigestThread> = {}): DigestThread {
  return { openedAt: at(0), kitComments: [], requestChanges: [], landedNothing: 0, ...overrides };
}

describe("The asks Kit code lists, on a pull request with Spin-offs (#884)", () => {
  const requestChanges = [
    aRequestChanges(8, at(20), { body: "Call it a basket. Open the CSV export separately." }),
    aRequestChanges(11, at(30), { body: "", lineComments: [{ comment: 12, url: DISCUSSION(12), path: "src/cart.ts", line: 12 }] }),
  ];

  it("name, on each ask, each Spin-off the Kit opened from it, by its issue and title, read from the Kit's own notes", () => {
    const kitComments = [
      { at: at(25), body: runNote(REQUEST_CHANGES_RUN_MARKER, 8, [57, "review-8", "Export the waitlist as CSV"], [58, "review-8", "Text the waitlist"]) },
      { at: at(35), body: runNote(REQUEST_CHANGES_RUN_EMPTY_MARKER, 11, [59, "inline-12", "Coupons"]) },
    ];

    expect(digestFactsOf(aThread({ kitComments, requestChanges })).asks).toEqual([
      {
        id: "review-8",
        what: "request-changes",
        url: REVIEW(8),
        spinOffs: [
          { issue: 57, title: "Export the waitlist as CSV" },
          { issue: 58, title: "Text the waitlist" },
        ],
      },
      { id: "inline-12", what: "line-comment", url: DISCUSSION(12), path: "src/cart.ts", line: 12, spinOffs: [{ issue: 59, title: "Coupons" }] },
    ]);
  });

  it("name a Spin-off once when two notes record its issue, as the note of a push that was refused and the note of the landing after it", () => {
    const note = runNote(REQUEST_CHANGES_RUN_MARKER, 8, [57, "review-8", "Export the waitlist as CSV"]);
    const kitComments = [
      { at: at(25), body: note },
      { at: at(26), body: note },
    ];

    expect(digestFactsOf(aThread({ kitComments, requestChanges })).asks[0]).toMatchObject({ id: "review-8", spinOffs: [{ issue: 57, title: "Export the waitlist as CSV" }] });
  });

  it("name none on an ask no Spin-off was opened from, which is listed as it always was", () => {
    const kitComments = [{ at: at(25), body: runNote(REQUEST_CHANGES_RUN_MARKER, 8, [57, "review-8", "Export the waitlist as CSV"]) }];

    expect(digestFactsOf(aThread({ kitComments, requestChanges })).asks[1]).toEqual({ id: "inline-12", what: "line-comment", url: DISCUSSION(12), path: "src/cart.ts", line: 12 });
    expect(digestFactsOf(aThread({ requestChanges })).asks.every((ask) => !("spinOffs" in ask))).toBe(true);
  });
});

/** Two asks: a Request changes one Spin-off was opened from, and a line comment none was. */
const ASKS: readonly DigestAsk[] = [
  { id: "review-8", what: "request-changes", url: REVIEW(8), spinOffs: [{ issue: 57, title: "Export the waitlist as CSV" }] },
  { id: "inline-12", what: "line-comment", url: DISCUSSION(12), path: "src/cart.ts", line: 12 },
];
const GIVEN = aDigestGiven({ facts: aDigestFacts({ asks: ASKS }) });

const anAnswer = (id: string, answer: DigestAnswer["answer"], rest: Partial<DigestAnswer> = {}): DigestAnswer => ({ id, answer, where: "src/basket/save.ts", checkedBy: "reading", ...rest });
const anItem = (kind: DigestItem["kind"], asks: string[] = []): DigestItem => ({ kind, claim: "The banner still says cart.", sentence: "It reads cart at this head.", asks, places: [], picture: null, suggestedRequest: null });
const SET_ASIDE = anAnswer("review-8", "set-aside", { where: "The Spin-off's issue, #57" });

function bodyOf(reply: DigestReply, given: DigestGiven = GIVEN): string {
  const comment = digestCommentOf(reply, given);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

function refusalOf(reply: DigestReply, given: DigestGiven = GIVEN): string {
  const comment = digestCommentOf(reply, given);
  if (comment.ok) throw new Error("expected a refusal, got a Digest");
  return comment.refused;
}

const criteriaRowsOf = (body: string) => (body.split("<summary>The criteria and how each was checked</summary>\n\n")[1]?.split("\n\n</details>")[0] ?? "").split("\n").slice(2);

describe("A Digest's answer to an ask whose every point was set aside (#884)", () => {
  it("is read: set-aside is an answer", () => {
    expect(readDigestReply(aDigestReply({ asks: [SET_ASIDE] }))).toMatchObject({ ok: true, output: { asks: [SET_ASIDE] } });
  });

  it("lands with no item naming the ask: nothing of it was to be built, so nothing of it is missing", () => {
    expect(digestCommentOf(aDigestReply({ asks: [SET_ASIDE, anAnswer("inline-12", "in-head")], items: [] }), GIVEN)).toMatchObject({ ok: true });
  });

  it("is refused on an ask no Spin-off was opened from, and on a criterion, naming each", () => {
    const asks = [SET_ASIDE, anAnswer("inline-12", "set-aside"), { ...anAnswer("c1", "set-aside"), criterion: "A shopper can save their basket." }];

    expect(refusalOf(aDigestReply({ asks, items: [] }))).toBe("the reply answers set aside for asks the Kit opened no Spin-off from: `inline-12`, `c1`");
  });

  it("is refused when an asked-for-and-not-here item names it: what was set aside is not missing", () => {
    expect(refusalOf(aDigestReply({ asks: [SET_ASIDE, anAnswer("inline-12", "in-head")], items: [anItem("asked-not-here", ["review-8"])] }))).toBe(
      "item 1, asked for and not here, names an ask answered set aside: `review-8`",
    );
  });

  it("still has the writer answer for what was to be built: an ask with a Spin-off that is not in the head needs its item as any other does", () => {
    const asks = [anAnswer("review-8", "not-in-head"), anAnswer("inline-12", "in-head")];

    expect(refusalOf(aDigestReply({ asks, items: [] }))).toBe("no asked-for-and-not-here item names an ask answered not in the head or could not tell: `review-8`");
    expect(digestCommentOf(aDigestReply({ asks, items: [anItem("asked-not-here", ["review-8"])] }), GIVEN)).toMatchObject({ ok: true });
  });

  it("still may not be skipped: an ask with a Spin-off is answered like every other", () => {
    expect(refusalOf(aDigestReply({ asks: [anAnswer("inline-12", "in-head")], items: [] }))).toBe("the reply left an ask unanswered: `review-8`");
  });
});

describe("The criteria fold of a Digest, on a pull request with Spin-offs (#884)", () => {
  it("shows under each ask the Spin-offs the Kit opened from it, and says set aside where nothing of the ask was to be built", () => {
    const rows = criteriaRowsOf(bodyOf(aDigestReply({ asks: [SET_ASIDE, anAnswer("inline-12", "in-head")], items: [] })));

    expect(rows).toEqual([
      `| Your [Request changes](${REVIEW(8)})<br>Opened as a Spin-off: #57 Export the waitlist as CSV | Set aside | Reading | The Spin-off's issue, #57 |`,
      `| Your [line comment](${DISCUSSION(12)}) on \`src/cart.ts\`, line 12 | In the head | Reading | src/basket/save.ts |`,
    ]);
  });

  it("shows them too under an ask part of which was built, beside the answer for that part", () => {
    const two: DigestAsk[] = [{ ...ASKS[0]!, spinOffs: [{ issue: 57, title: "Export the waitlist | as CSV" }, { issue: 58, title: "Text the waitlist" }] }];
    const rows = criteriaRowsOf(bodyOf(aDigestReply({ asks: [anAnswer("review-8", "in-head")], items: [] }), aDigestGiven({ facts: aDigestFacts({ asks: two }) })));

    expect(rows).toEqual([`| Your [Request changes](${REVIEW(8)})<br>Opened as Spin-offs: #57 Export the waitlist \\| as CSV; #58 Text the waitlist | In the head | Reading | src/basket/save.ts |`]);
  });
});
