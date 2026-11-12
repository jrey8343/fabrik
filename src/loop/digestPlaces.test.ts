import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { forbiddenImportsFrom, modulesImporting, runtimeImportsIn, WORKER_BUILTINS } from "../read/importWalk.ts";
import {
  DIGEST_DATA_MARKER,
  DIGEST_DATA_VERSION,
  DIGEST_FOLDS_MARKER,
  type DigestData,
  type DigestGiven,
  type DigestItem,
  type DigestReply,
  digestCommentOf,
  digestMarker,
  digestMarkIn,
  digestTop,
  isDigestComment,
  noDigestIn,
  noDigestLine,
  readDigestComment,
  readDigestReply,
} from "./digestContract.ts";
import { type DigestHead, type DigestPlace, MAX_PLACE_LINES, MAX_PLACES, type NamedPlace, PLACE_KINDS } from "./digestPlaces.ts";
import { planFor } from "./rules.ts";
import type { Action } from "./types.ts";

const HEAD = "a".repeat(40);
const BLOB = `https://github.com/acme/shop/blob/${HEAD}`;

/** The saved-basket rule at the head: a hundred lines, `const line1 = 1;` to `const line100 = 100;`, ending in a newline. */
const SAVE = `${Array.from({ length: 100 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`;
/** The basket page's copy at the head: five lines, with no newline after the last. */
const COPY = ["export const copy = {", '  save: "Save basket",', '  saved: "Saved for 24 hours",', '  gone: "Your saved basket has expired",', "};"].join("\n");

/** What the head holds of the two files the places below name; the pull request changes neither. */
function aHead(overrides: Partial<DigestHead> = {}): DigestHead {
  return {
    files: [
      { path: "src/basket/save.ts", text: SAVE },
      { path: "src/basket/copy.ts", text: COPY },
    ],
    changed: [],
    ...overrides,
  };
}

function given(head: DigestHead = aHead()): DigestGiven {
  return aDigestGiven({ repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD, head });
}

function bodyOf(reply: DigestReply, from: DigestGiven = given()): string {
  const comment = digestCommentOf(reply, from);
  if (!comment.ok) throw new Error(`expected a Digest, got the refusal: ${comment.refused}`);
  return comment.body;
}

/** Needs your eyes as the comment shows it: the lines between its heading and the next. */
function needsYourEyesIn(body: string): string[] {
  return (body.split("### Needs your eyes\n\n")[1]?.split("\n\n### ")[0] ?? "").split("\n");
}

/** A place as the writer names one: lines of the saved-basket rule, as code. */
function aPlace(start: number, end: number, rest: Partial<NamedPlace> = {}): NamedPlace {
  return { path: "src/basket/save.ts", start, end, as: "code", ...rest };
}

function anItem(kind: DigestItem["kind"], rest: Partial<DigestItem> = {}): DigestItem {
  return { kind, claim: "Prices hold for 24 hours.", sentence: "The Ticket said for a while, and the Implementer chose a day.", asks: [], places: [], picture: null, suggestedRequest: null, ...rest };
}

describe("The places an item of the Digest writer's reply names", () => {
  it("are none, or up to three, each a path, a first and a last line and whether it is code or words an End user reads", () => {
    const places = [aPlace(10, 12), aPlace(30, 34), aPlace(4, 4, { path: "src/basket/copy.ts", as: "words" })];

    expect(readDigestReply(aDigestReply({ items: [anItem("yours-to-judge", { places }), anItem("not-proven")] }))).toMatchObject({
      ok: true,
      output: { items: [{ places }, { places: [] }] },
    });
  });

  it("refuse the Digest when an item names a fourth", () => {
    const four = [aPlace(1, 3), aPlace(10, 12), aPlace(30, 34), aPlace(40, 44)];

    expect(readDigestReply(aDigestReply({ items: [anItem("not-proven"), anItem("yours-to-judge", { places: four })] }))).toEqual({
      ok: false,
      errors: ["items[1].places must be a list of at most 3 places, not 4"],
    });
  });

  it.each([
    ["an item's places is missing", { places: undefined }, "items[0].places must be a list of at most 3 places"],
    ["a place is no object", { places: ["src/basket/save.ts:10"] }, "items[0].places[0] must be an object"],
    ["a place has no path", { places: [{ ...aPlace(10, 12), path: " " }] }, "items[0].places[0].path must be non-empty text"],
    ["a first line is no whole number", { places: [{ ...aPlace(10, 12), start: "10" }] }, "items[0].places[0].start must be a whole number"],
    ["a last line is no whole number", { places: [aPlace(10, 12), { ...aPlace(10, 12), end: 12.5 }] }, "items[0].places[1].end must be a whole number"],
    ["what a place is shown as is unknown", { places: [{ ...aPlace(10, 12), as: "prose" }] }, 'items[0].places[0].as must be one of code, words, not "prose"'],
  ])("break the reply's shape when %s, naming it", (_what, broken, error) => {
    expect(readDigestReply(aDigestReply({ items: [{ ...anItem("not-proven"), ...broken } as DigestItem] }))).toEqual({ ok: false, errors: [error] });
  });
});

describe("An item's places, in the Digest's comment", () => {
  it("are plain links to the file and its lines at the head, after the item's sentence", () => {
    const places = [aPlace(10, 12), aPlace(4, 4, { path: "src/basket/copy.ts", as: "words" })];

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places }), anItem("not-proven", { claim: "Nothing shows a basket expiring." })] })))).toEqual([
      "- **Prices hold for 24 hours.** The Ticket said for a while, and the Implementer chose a day.",
      `  [\`src/basket/save.ts\`, lines 10 to 12](${BLOB}/src/basket/save.ts?plain=1#L10-L12) · [\`src/basket/copy.ts\`, line 4](${BLOB}/src/basket/copy.ts?plain=1#L4)`,
      "- **Nothing shows a basket expiring.** The Ticket said for a while, and the Implementer chose a day.",
    ]);
  });

  it("link a path with a space or a bracket in it so that the link still opens", () => {
    const path = "docs/saved baskets (v2).md";
    const head = aHead({ files: [{ path, text: "# Saved baskets\n\nA saved basket keeps its prices for a day.\n" }] });

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(3, 3, { path, as: "words" })] })] }), given(head)))[1]).toBe(
      `  [\`docs/saved baskets (v2).md\`, line 3](${BLOB}/docs/saved%20baskets%20%28v2%29.md?plain=1#L3)`,
    );
  });
});

describe("An item's places, in the Digest's comment, at a path Markdown would trip on", () => {
  it("names a path with a backtick in it as plain words, so the link's own words stay whole and mention nobody", () => {
    const path = "docs/@olive's `saved` [basket].md";
    const head = aHead({ files: [{ path, text: "A saved basket keeps its prices for a day.\n" }] });

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(1, 1, { path, as: "words" })] })] }), given(head)))[1]).toBe(
      `  [docs/@​olive's \\\`saved\\\` \\[basket\\].md, line 1](${BLOB}/docs/%40olive's%20%60saved%60%20%5Bbasket%5D.md?plain=1#L1)`,
    );
  });

  it("drops a place whose path is no file's path in a repo, whatever was read for it", () => {
    const paths = ["../shop/src/basket/save.ts", "/src/basket/save.ts", "src//basket/save.ts", "./src/basket/save.ts"];
    const head = aHead({ files: paths.map((path) => ({ path, text: SAVE })) });

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: paths.slice(0, 3).map((path) => aPlace(1, 3, { path })) })] }), given(head)))).toHaveLength(1);
    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(1, 3, { path: paths[3] })] })] }), given(head)))).toHaveLength(1);
  });
});

describe("A place that does not resolve in the head", () => {
  const SENTENCE = "- **Prices hold for 24 hours.** The Ticket said for a while, and the Implementer chose a day.";
  const link = (path: string, lines: string, anchor: string) => `[\`${path}\`, ${lines}](${BLOB}/${path}?plain=1#${anchor})`;

  it.each([
    ["is in a file the head lacks", aPlace(10, 12, { path: "src/basket/gone.ts" })],
    ["runs past the end of its file", aPlace(98, 101)],
    ["starts past the end of its file", aPlace(101, 101)],
    ["has its first line after its last", aPlace(12, 10)],
    ["starts before its file's first line", aPlace(0, 3)],
  ])("is dropped when it %s, and its item lands with the places that do resolve", (_what, wrong) => {
    const body = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(10, 12), wrong, aPlace(30, 34)] })] }));

    expect(needsYourEyesIn(body)).toEqual([SENTENCE, `  ${link("src/basket/save.ts", "lines 10 to 12", "L10-L12")} · ${link("src/basket/save.ts", "lines 30 to 34", "L30-L34")}`]);
  });

  it("costs its item only its link: an item whose every place is dropped still lands, with its claim and its sentence", () => {
    const places = [aPlace(1, 3, { path: "src/basket/gone.ts" }), aPlace(200, 210), aPlace(9, 2)];

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places })] })))).toEqual([SENTENCE]);
  });

  it("is told by the file's own lines: its last line is a place whether or not a newline follows it, and the line after is not", () => {
    const places = [aPlace(100, 100), aPlace(5, 5, { path: "src/basket/copy.ts", as: "words" }), aPlace(6, 6, { path: "src/basket/copy.ts", as: "words" })];

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places })] })))).toEqual([
      SENTENCE,
      `  ${link("src/basket/save.ts", "line 100", "L100")} · ${link("src/basket/copy.ts", "line 5", "L5")}`,
    ]);
  });

  it("is dropped when its file is not text, or has no lines", () => {
    const head = aHead({
      files: [
        { path: "public/basket.png", text: "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\n\u0000\u0000\n" },
        { path: "src/basket/.keep", text: "" },
      ],
    });
    const places = [aPlace(1, 2, { path: "public/basket.png" }), aPlace(1, 1, { path: "src/basket/.keep" })];

    expect(needsYourEyesIn(bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places })] }), given(head)))).toEqual([SENTENCE]);
  });
});

/** The data a comment's second line holds, as its reader gives it. */
function dataOf(body: string): DigestData {
  const read = readDigestComment(body);
  if (!read.ok) throw new Error(`expected a readable Digest, got: ${read.why}`);
  return read.data;
}

/** The places a Digest carries, item by item. */
function placesOf(body: string): DigestPlace[][] {
  return dataOf(body).items.map(({ places }) => [...places]);
}

/** A Digest with one item, the Operator's to judge, that names these places. */
function pointingAt(places: readonly NamedPlace[], head: DigestHead = aHead()): string {
  return bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places })] }), given(head));
}

describe("A place's lines, as a Digest carries them", () => {
  // Each fingerprint below was worked out apart from the Kit, with `shasum -a 256` over the lines joined by newlines.
  it("are cut to the first 40 when the place is longer, with a fingerprint of those 40 and a link to them", () => {
    const body = pointingAt([aPlace(21, 80)]);

    expect(placesOf(body)).toEqual([[{ path: "src/basket/save.ts", start: 21, end: 60, as: "code", inDiff: false, fingerprint: "7e78da4c27f9" }]]);
    expect(needsYourEyesIn(body)[1]).toBe(`  [\`src/basket/save.ts\`, lines 21 to 60](${BLOB}/src/basket/save.ts?plain=1#L21-L60)`);
  });

  it("are left whole at 40 lines, and cut at 41", () => {
    const forty = { path: "src/basket/save.ts", start: 21, end: 60, as: "code", inDiff: false, fingerprint: "7e78da4c27f9" };

    expect(placesOf(pointingAt([aPlace(21, 60), aPlace(21, 61)]))).toEqual([[forty, forty]]);
  });

  it("are never cut to fit a file they run past the end of: such a place is dropped", () => {
    expect(placesOf(pointingAt([aPlace(70, 120)]))).toEqual([[]]);
  });

  it("have a fingerprint of 12 hex characters of the SHA-256 of the lines at the head, joined by newlines", () => {
    expect(placesOf(pointingAt([aPlace(10, 12), aPlace(5, 5), aPlace(2, 4, { path: "src/basket/copy.ts", as: "words" })]))).toEqual([
      [
        { path: "src/basket/save.ts", start: 10, end: 12, as: "code", inDiff: false, fingerprint: "79e380d6cca3" },
        { path: "src/basket/save.ts", start: 5, end: 5, as: "code", inDiff: false, fingerprint: "7dc94023053f" },
        { path: "src/basket/copy.ts", start: 2, end: 4, as: "words", inDiff: false, fingerprint: "42190ee3e49e" },
      ],
    ]);
  });

  it("are the same lines whether the file ends its lines with a line feed or with a carriage return and one", () => {
    const fingerprints = ["first\nsecond\nthird\n", "first\r\nsecond\r\nthird\r\n"].map((text) => placesOf(pointingAt([aPlace(1, 2, { path: "notes.txt" })], aHead({ files: [{ path: "notes.txt", text }] }))));

    expect(fingerprints).toEqual([[[expect.objectContaining({ fingerprint: "4252f8d56b4b" })]], [[expect.objectContaining({ fingerprint: "4252f8d56b4b" })]]]);
  });
});

describe("Whether a place can take a pinned comment: its `inDiff`", () => {
  const line = (number: number) => `const line${number} = ${number};`;
  /** The pull request's patch of the saved-basket rule, as GitHub's API gives it: two hunks, lines 8 to 15 and 29 to 37 on the head's side. */
  const PATCH = [
    "@@ -8,7 +8,8 @@ const line7 = 7;",
    ...[8, 9, 10].map((number) => ` ${line(number)}`),
    "-const line11 = 0;",
    ...[11, 12].map((number) => `+${line(number)}`),
    ...[13, 14, 15].map((number) => ` ${line(number)}`),
    "@@ -28,6 +29,9 @@ const line28 = 28;",
    ...[29, 30, 31].map((number) => ` ${line(number)}`),
    ...[32, 33, 34].map((number) => `+${line(number)}`),
    ...[35, 36, 37].map((number) => ` ${line(number)}`),
  ].join("\n");
  const changing = (changed: DigestHead["changed"]) => aHead({ changed });
  const HEAD_HELD = changing([{ path: "src/basket/save.ts", patch: PATCH }]);
  const inDiffOf = (places: readonly NamedPlace[], head: DigestHead = HEAD_HELD) => placesOf(pointingAt(places, head)).flat().map(({ start, end, inDiff }) => `${start}-${end}: ${inDiff}`);

  it("is true when every line of it lies in one hunk of its file's diff, on the head's side, the hunk's unchanged lines counting", () => {
    expect(inDiffOf([aPlace(11, 12), aPlace(8, 15), aPlace(13, 15)])).toEqual(["11-12: true", "8-15: true", "13-15: true"]);
    expect(inDiffOf([aPlace(29, 29), aPlace(32, 37)])).toEqual(["29-29: true", "32-37: true"]);
  });

  it("is false when it spans two hunks, runs out of one, or lies between them", () => {
    expect(inDiffOf([aPlace(12, 31), aPlace(14, 16), aPlace(20, 22)])).toEqual(["12-31: false", "14-16: false", "20-22: false"]);
    expect(inDiffOf([aPlace(7, 9), aPlace(1, 3), aPlace(38, 40)])).toEqual(["7-9: false", "1-3: false", "38-40: false"]);
  });

  it("is false in a file the pull request does not change, and the place still lands", () => {
    expect(inDiffOf([aPlace(2, 4, { path: "src/basket/copy.ts", as: "words" })])).toEqual(["2-4: false"]);
  });

  it("is false in a file GitHub gives no patch for, as for one whose diff is too large", () => {
    expect(inDiffOf([aPlace(11, 12)], changing([{ path: "src/basket/save.ts", patch: null }]))).toEqual(["11-12: false"]);
  });

  it("is worked out after the cut: a place of 60 lines whose first 40 lie in one hunk is in the diff", () => {
    const added = changing([{ path: "src/basket/save.ts", patch: ["@@ -0,0 +1,100 @@", ...Array.from({ length: 100 }, (_, index) => `+${line(index + 1)}`)].join("\n") }]);

    expect(inDiffOf([aPlace(21, 80)], added)).toEqual(["21-60: true"]);
    expect(inDiffOf([aPlace(8, 60)])).toEqual(["8-47: false"]);
  });

  it("reads a hunk that names no count as one line, and one that leaves no line on the head's side as holding none", () => {
    const oneLine = changing([{ path: "src/basket/save.ts", patch: `@@ -5 +5 @@\n-const line5 = 0;\n+${line(5)}\n@@ -9,2 +8,0 @@\n-const gone = 1;\n-const gone = 2;` }]);

    expect(inDiffOf([aPlace(5, 5), aPlace(5, 6), aPlace(8, 8)], oneLine)).toEqual(["5-5: true", "5-6: false", "8-8: false"]);
  });

  it("takes a hunk only from a header of the patch's own, never from a changed line that reads like one", () => {
    const quoting = changing([{ path: "src/basket/save.ts", patch: `@@ -5 +5 @@\n-const line5 = 0;\n+${line(5)}\n+@@ -1,100 +1,100 @@\n @@ -1,100 +1,100 @@` }]);

    expect(inDiffOf([aPlace(5, 5), aPlace(40, 44)], quoting)).toEqual(["5-5: true", "40-44: false"]);
  });
});

describe("The Digest's data line", () => {
  const WHAT ="A shopper can now save their basket from /basket. A saved basket keeps its prices for a day.";
  const HOW = "One Review passed it at the first head. The product code is unchanged since that Verdict.";

  it("is the comment's second line, hidden, under a first line that still names the head", () => {
    const [first, second, third] = bodyOf(aDigestReply()).split("\n");

    expect(first).toBe(`<!-- fabrik:digest {"head":"${HEAD}","asks":[],"carriedFrom":null} -->`);
    expect(second).toBe(`<!-- fabrik:digest-data {"v":1,"items":[],"whatItDoes":"${WHAT}","howItGotHere":"${HOW}","followUps":[]} -->`);
    expect(third).toBe(`**Digest** of #50, written as of [\`aaaaaaa\`](https://github.com/acme/shop/pull/50/commits/${HEAD}).`);
    expect(digestMarkIn(bodyOf(aDigestReply()))).toEqual({ head: HEAD, asks: [], carriedFrom: null });
  });

  // The reply names its items out of kind order; one place is in a file the head lacks; and the item that is the Operator's to judge has a suggested request.
  const REPLY = aDigestReply({
    asks: [{ id: "review-8", answer: "not-in-head", where: "The saved-basket page's heading", checkedBy: "search" }],
    items: [
      anItem("not-proven", { claim: "Nothing shows a basket expiring.", sentence: "No test moves the clock.", suggestedRequest: "  Add a test that moves the clock a day.  " }),
      anItem("yours-to-judge", { places: [aPlace(10, 12), aPlace(1, 3, { path: "src/basket/gone.ts" })], suggestedRequest: "Make it two days." }),
      anItem("asked-not-here", {
        claim: "The heading still says cart.",
        sentence: "You asked for basket   throughout.",
        asks: ["review-8"],
        places: [aPlace(2, 4, { path: "src/basket/copy.ts", as: "words" })],
        suggestedRequest: "Rename the heading to Saved basket.",
      }),
    ],
    followUps: ["f2", "f1"],
  });
  const FOLLOW_UPS = [
    { id: "f1", title: "Share a saved basket by link", url: "https://github.com/acme/shop/issues/new?title=Share" },
    { id: "f2", title: "Expire saved baskets", url: "https://github.com/acme/shop/issues/new?title=Expire" },
    { id: "f3", title: "Rename the cart module", url: "https://github.com/acme/shop/issues/new?title=Rename" },
  ];
  const GIVEN = aDigestGiven({
    repoUrl: "https://github.com/acme/shop",
    pullRequest: 50,
    headSha: HEAD,
    facts: aDigestFacts({ asks: [{ id: "review-8", what: "request-changes", url: "https://github.com/acme/shop/pull/50#pullrequestreview-8" }], followUps: FOLLOW_UPS }),
    head: aHead(),
  });
  const DATA: DigestData = {
    v: 1,
    items: [
      {
        kind: "asked-not-here",
        claim: "The heading still says cart.",
        sentence: "You asked for basket throughout.",
        places: [{ path: "src/basket/copy.ts", start: 2, end: 4, as: "words", inDiff: false, fingerprint: "42190ee3e49e" }],
        picture: null,
        suggestedRequest: "Rename the heading to Saved basket.",
      },
      {
        kind: "yours-to-judge",
        claim: "Prices hold for 24 hours.",
        sentence: "The Ticket said for a while, and the Implementer chose a day.",
        places: [{ path: "src/basket/save.ts", start: 10, end: 12, as: "code", inDiff: false, fingerprint: "79e380d6cca3" }],
        picture: null,
        suggestedRequest: null,
      },
      { kind: "not-proven", claim: "Nothing shows a basket expiring.", sentence: "No test moves the clock.", places: [], picture: null, suggestedRequest: "Add a test that moves the clock a day." },
    ],
    whatItDoes: WHAT,
    howItGotHere: HOW,
    followUps: [
      { title: "Share a saved basket by link", url: "https://github.com/acme/shop/issues/new?title=Share" },
      { title: "Expire saved baskets", url: "https://github.com/acme/shop/issues/new?title=Expire" },
    ],
  };

  it("holds the Digest as it landed: the items in kind order, a place that did not resolve and a suggested request that may not stand dropped, and the Follow-ups shown", () => {
    expect(dataOf(bodyOf(REPLY, GIVEN))).toEqual(DATA);
  });

  it("holds exactly the fields rendered: the top of the comment is the read-back data rendered again, and what is not rendered is not in the top", () => {
    const body = bodyOf(REPLY, GIVEN);
    const [, , ...rest] = body.split("\n");
    const top = rest.slice(0, rest.indexOf(DIGEST_FOLDS_MARKER) - 1).join("\n");

    expect(top).toBe(digestTop(dataOf(body), GIVEN));
    expect(top).toContain("- **The heading still says cart.** You asked for basket throughout.");
    expect(top).toContain(`[\`src/basket/copy.ts\`, lines 2 to 4](${BLOB}/src/basket/copy.ts?plain=1#L2-L4)`);
    expect(top).toContain("- Expire saved baskets: [Open as issue](https://github.com/acme/shop/issues/new?title=Expire)");
    expect(top).not.toContain("gone.ts");
    expect(top).not.toContain("Rename the heading");
    expect(top).not.toContain("Rename the cart module");
  });

  it("reads back with the comment's head, the asks it answered, that it was written fresh, and its folds: the Markdown from the folds line down", () => {
    const body = bodyOf(REPLY, GIVEN);
    const read = readDigestComment(body);

    expect(read).toMatchObject({ ok: true, head: HEAD, asks: ["review-8"], carriedFrom: null });
    expect(read).toMatchObject({ folds: body.split(`${DIGEST_FOLDS_MARKER}\n`)[1] });
    expect(read).toMatchObject({ folds: expect.stringMatching(/^<details>\n<summary>Walk me through it<\/summary>[\s\S]*\n\[The run\]\(https:\/\/github\.com\/acme\/shop\/actions\/runs\/42\/attempts\/1\)$/) });
  });

  it("names nothing of the asks an item is about, nor anything of the folds", () => {
    const [, line = ""] = bodyOf(REPLY, GIVEN).split("\n");

    expect(line).not.toContain("review-8");
    expect(line).not.toContain("store the lines");
    expect(Object.keys(dataOf(bodyOf(REPLY, GIVEN))).toSorted()).toEqual(["followUps", "howItGotHere", "items", "v", "whatItDoes"]);
  });

  it("can neither close its hidden line early nor mention anyone, whatever a claim holds, and reads back as the Digest shows it", () => {
    const claim = "The banner --> says <b>cart</b>, as @olive asked.";
    const body = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { claim, sentence: "Ask @acme/design." })] }));
    const [, line = ""] = body.split("\n");

    expect(line.startsWith("<!-- fabrik:digest-data {")).toBe(true);
    expect(line.endsWith("} -->")).toBe(true);
    // Between the line's opening and its close there is no `<`, `>` or `@` at all, so no `-->` and no mention.
    expect(line.slice("<!-- fabrik:digest-data ".length, -" -->".length)).not.toMatch(/[<>@]/);
    expect(dataOf(body).items[0]).toMatchObject({ claim: "The banner --> says <b>cart</b>, as @​olive asked.", sentence: "Ask @​acme/design." });
    expect(body).toContain("- **The banner --> says <b>cart</b>, as @​olive asked.** Ask @​acme/design.");
  });

  it("counts toward GitHub's length: a Digest that fits only without its data line is refused, never landed without one", () => {
    // Each claim is short in the Markdown and long as data: every `<` is six characters in the hidden line.
    const reply = aDigestReply({ items: [anItem("yours-to-judge", { claim: "<".repeat(900) })], walkthrough: "x".repeat(60_000) });
    const comment = digestCommentOf(reply, given());

    expect(comment).toMatchObject({ ok: false, refused: expect.stringMatching(/^the Digest would be 6\d{4} characters, over GitHub's limit of 65536 for a comment$/) });
    expect(JSON.stringify(reply).length).toBeLessThan(62_000);
  });
});

describe("Reading a Digest's comment back", () => {
  const BODY = bodyOf(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(10, 12)] })] }));
  const withDataLine = (line: string) => BODY.split("\n").with(1, line).join("\n");

  it("says a data line at a version it does not know is of an unknown version", () => {
    const [, line = ""] = BODY.split("\n");

    expect(readDigestComment(withDataLine(line.replace('{"v":1,', '{"v":2,')))).toEqual({ ok: false, why: "unknown-version" });
    expect(readDigestComment(withDataLine('<!-- fabrik:digest-data {"v":2,"cards":[]} -->'))).toEqual({ ok: false, why: "unknown-version" });
  });

  it.each([
    ["does not parse", '<!-- fabrik:digest-data {"v":1,"items":[ -->'],
    ["is no object", '<!-- fabrik:digest-data [1] -->'],
    ["names no version", '<!-- fabrik:digest-data {"items":[],"whatItDoes":"It saves.","howItGotHere":"One pass.","followUps":[]} -->'],
    ["is at this version and not its shape", '<!-- fabrik:digest-data {"v":1,"items":[{"kind":"worth-reading"}],"whatItDoes":"It saves.","howItGotHere":"One pass.","followUps":[]} -->'],
    ["holds a place that is no place", '<!-- fabrik:digest-data {"v":1,"items":[{"kind":"not-proven","claim":"A.","sentence":"B.","places":[{"path":"a.ts","start":"1"}],"picture":null,"suggestedRequest":null}],"whatItDoes":"It saves.","howItGotHere":"One pass.","followUps":[]} -->'],
  ])("says a data line that %s is malformed", (_what, line) => {
    expect(readDigestComment(withDataLine(line))).toEqual({ ok: false, why: "malformed" });
  });

  it("says a Digest with no data line under its first has none, as one written before the line was", () => {
    expect(readDigestComment(BODY.split("\n").toSpliced(1, 1).join("\n"))).toEqual({ ok: false, why: "no-data" });
    // A data line anywhere but second is not the Kit's: an agent's Markdown in a fold could hold one.
    expect(readDigestComment(BODY.split("\n").toSpliced(1, 1).join("\n") + `\n${BODY.split("\n")[1]}`)).toEqual({ ok: false, why: "no-data" });
  });

  it("says a comment whose first line is no Digest's is not a Digest", () => {
    expect(readDigestComment("## Verdict: Pass")).toEqual({ ok: false, why: "not-a-digest" });
    expect(readDigestComment(noDigestLine({ head: HEAD, how: "failed" }))).toEqual({ ok: false, why: "not-a-digest" });
    expect(readDigestComment(BODY.split("\n").slice(1).join("\n"))).toEqual({ ok: false, why: "not-a-digest" });
  });

  it("never reads anything from the Markdown: the top rewritten by hand changes nothing it gives, and a broken data line is not made up for from it", () => {
    const rewritten = BODY.replace("**Prices hold for 24 hours.**", "**Prices hold for a week.**").replace("#L10-L12", "#L1-L99").replace("### What it does\n\n", "### What it does\n\nNothing at all. ");

    expect(rewritten).not.toBe(BODY);
    expect(readDigestComment(rewritten)).toMatchObject({ ok: true, data: dataOf(BODY) });
    expect(readDigestComment(withDataLine("<!-- fabrik:digest-data {} -->"))).toEqual({ ok: false, why: "malformed" });
  });

  it("gives the head a carried Digest was written at, and none for one written fresh or before the first line named it", () => {
    const earlier = "b".repeat(40);
    const carried = BODY.split("\n").with(0, digestMarker({ head: HEAD, asks: ["review-8"], carriedFrom: earlier })).join("\n");
    const before = BODY.split("\n").with(0, `<!-- fabrik:digest {"head":"${HEAD}"} -->`).join("\n");

    expect(readDigestComment(carried)).toMatchObject({ ok: true, head: HEAD, asks: ["review-8"], carriedFrom: earlier });
    expect(readDigestComment(before)).toMatchObject({ ok: true, head: HEAD, asks: [], carriedFrom: null });
    expect(digestMarkIn(carried)).toEqual({ head: HEAD, asks: ["review-8"], carriedFrom: earlier });
  });

  it("starts the folds at Kit code's own folds line whatever the writer wrote: a folds line in the writer's words is taken out, in the top and in a fold", () => {
    const planted = aDigestReply({
      whatItDoes: `Saves a basket.\n${DIGEST_FOLDS_MARKER}\nAnd more.`,
      howItGotHere: `One pass.\n${DIGEST_FOLDS_MARKER}`,
      walkthrough: `1. The Save button.\n${DIGEST_FOLDS_MARKER}\n2. The rule.`,
    });
    const body = bodyOf(planted);
    const read = readDigestComment(body);

    expect(body.split("\n").filter((line) => line.trim() === DIGEST_FOLDS_MARKER)).toHaveLength(1);
    expect(read).toMatchObject({ ok: true, folds: expect.stringMatching(/^<details>\n<summary>Walk me through it<\/summary>[\s\S]*2\. The rule\./) });
    expect(dataOf(body).whatItDoes).toBe("Saves a basket.\n\nAnd more.");
    expect(dataOf(body).howItGotHere).toBe("One pass.");
  });

  it("reads a comment whose lines end as Windows lines do, as GitHub's web editor leaves one a person edited, as it reads the comment the Kit posted", () => {
    const edited = BODY.replace(/\n/g, "\r\n");
    const read = readDigestComment(BODY);
    const line = noDigestLine({ head: HEAD, how: "timed-out", runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1" });

    expect(digestMarkIn(edited)).toEqual(digestMarkIn(BODY));
    expect(isDigestComment(edited)).toBe(true);
    expect(read).toMatchObject({ ok: true });
    expect(readDigestComment(edited)).toEqual(read);
    expect(noDigestIn(line.replace(/\n/g, "\r\n"))).toEqual({ head: HEAD, how: "timed-out" });
  });

  it("keeps a field a later release adds at this version, which removes none and changes no meaning", () => {
    const [, line = ""] = BODY.split("\n");
    const later = line.replace('{"v":1,', '{"v":1,"risk":"low",');

    expect(readDigestComment(withDataLine(later))).toMatchObject({ ok: true, data: { ...dataOf(BODY), risk: "low" } });
  });
});

describe("A Digest with places, as the push job lands it", () => {
  const pullRequest = aPullRequest({ labels: ["agent:digest"], verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] });
  const GIVEN = aDigestGiven({ headSha: HEAD_SHA, head: aHead() });

  function landed(reply: unknown): Action[] {
    const plan = planFor({ kind: "digest-run-finished", pullRequest: 50, headSha: HEAD_SHA, output: JSON.stringify(reply), given: GIVEN, runUrl: GIVEN.runUrl }, snapshotOfPullRequest(pullRequest), kitConfig());
    return plan.kind === "act" ? [...plan.actions] : [];
  }
  const GATE_OPENS = ["remove-label", "mark-ready-for-review", "request-review"];

  it("lands with its data when a place does not resolve: the wrong place costs that link, never the account", () => {
    const [comment, ...rest] = landed(aDigestReply({ items: [anItem("yours-to-judge", { places: [aPlace(10, 12), aPlace(500, 510), aPlace(3, 5, { path: "src/basket/gone.ts" })] })] }));
    const body = comment?.kind === "comment" ? comment.body : "";

    expect(digestMarkIn(body)).toEqual({ head: HEAD_SHA, asks: [], carriedFrom: null });
    expect(placesOf(body)).toEqual([[{ path: "src/basket/save.ts", start: 10, end: 12, as: "code", inDiff: false, fingerprint: "79e380d6cca3" }]]);
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });

  it("is refused when an item names four places: the no-Digest line says so, and the gate opens all the same", () => {
    const four = [aPlace(1, 3), aPlace(10, 12), aPlace(30, 34), aPlace(40, 44)];
    const [comment, ...rest] = landed(aDigestReply({ items: [anItem("yours-to-judge", { places: four })] }));

    expect(comment).toEqual({
      kind: "comment",
      issue: 50,
      body: noDigestLine({ head: HEAD_SHA, how: "refused", reason: "items[0].places must be a list of at most 3 places, not 4", runUrl: GIVEN.runUrl }),
    });
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });

  it("is refused when its comment, data line and all, would be longer than GitHub takes: the no-Digest line says so", () => {
    const [comment, ...rest] = landed(aDigestReply({ items: [anItem("yours-to-judge", { claim: "<".repeat(900) })], walkthrough: "x".repeat(60_000) }));
    const body = comment?.kind === "comment" ? comment.body : "";

    expect(body.split("\n")[0]).toBe(`<!-- fabrik:no-digest {"head":"${HEAD_SHA}","how":"refused"} -->`);
    expect(body).toMatch(/No Digest could be written for this head, `[0-9a-f]{7}`: `refused`, Kit code refused the Digest writer's reply \(the Digest would be 6\d{4} characters, over GitHub's limit of 65536 for a comment\)\./);
    expect(rest.map(({ kind }) => kind)).toEqual(GATE_OPENS);
  });
});

describe("The modules that hold the Digest's contract, its place code and the read of the head", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const moduleAt = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

  it.each(["src/loop/digestContract.ts", "src/loop/digestPlaces.ts", "src/github/digestHead.ts"])("%s imports no npm package and no Node built-in a Worker can't load, nor reaches a module that does", (path) => {
    expect(forbiddenImportsFrom(moduleAt(path), read)).toEqual([]);
  });

  it.each(["src/loop/digestContract.ts", "src/loop/digestPlaces.ts", "src/github/digestHead.ts"])("%s reaches nothing typed on the Kit's client class, so a reader's own three-call client serves", (path) => {
    expect(modulesImporting("GitHub", moduleAt(path), read)).toEqual([]);
  });

  it("the place code's one built-in is one the read library's entry may import", () => {
    expect(runtimeImportsIn(read(moduleAt("src/loop/digestPlaces.ts")))).toEqual(["node:crypto"]);
    expect(WORKER_BUILTINS).toContain("node:crypto");
  });
});

describe("The README's Digest section, on places and data", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";
  const bullets = section.split("\n").filter((line) => line.startsWith("- **"));
  const places = bullets.find((line) => line.startsWith("- **Places and data**")) ?? "";

  it("comes straight after Needs your eyes", () => {
    expect(bullets[bullets.findIndex((line) => line.startsWith("- **Needs your eyes**")) + 1]).toBe(places);
    expect(places).not.toBe("");
  });

  it("says what a place is, and what Kit code does with each before the Digest lands", () => {
    for (const said of [
      "The Digest points and never quotes",
      "up to three places",
      "`path`, `start`, `end`",
      "`code` or `words`",
      "is dropped, and its item is kept",
      "cut to its first 40",
      "`inDiff`",
      "in one hunk of that file's diff",
      "the first 12 hex characters of the SHA-256 of its lines",
      "A fourth place on an item",
    ]) {
      expect(places).toContain(said);
    }
  });

  it("gives the data line as the contract writes it, where it sits and what it holds", () => {
    const [, line = ""] = bodyOf(aDigestReply()).split("\n");

    expect(line.replace(/\{.*\}/, '{"v":1,…}')).toBe(`${DIGEST_DATA_MARKER} {"v":1,…} -->`);
    expect(places).toContain(`\`${DIGEST_DATA_MARKER} {"v":${DIGEST_DATA_VERSION},…} -->\``);
    expect(places).toContain("the comment's second line");
    for (const field of ["`items`", "`kind`", "`claim`", "`sentence`", "`places`", "`picture`", "`suggestedRequest`", "`whatItDoes`", "`howItGotHere`", "`followUps`", "`fingerprint`"]) {
      expect(places).toContain(field);
    }
    expect(places).toContain("never parsed from the Markdown");
    expect(places).toContain("only when a field is removed or changes meaning");
  });

  it("says the first line's new field, and what a Digest too long for one comment comes to", () => {
    expect(places).toContain("`carriedFrom`");
    expect(places).toContain("is refused");
    expect(places).toContain("65,536");
  });
});

describe("The Digest writer's prompt, on places", () => {
  const prompt = readFileSync(new URL("../../prompts/digest.md", import.meta.url), "utf8");
  const eyes = prompt.split("\n### Needs your eyes\n")[1]?.split(/\n###? /)[0] ?? "";
  const output = prompt.split("\n## Your output\n")[1] ?? "";

  it("has the writer name the lines an item is about: up to three places of at most 40 lines each, as code or as words", () => {
    expect(MAX_PLACES).toBe(3);
    expect(MAX_PLACE_LINES).toBe(40);
    expect(eyes).toContain("`places`, on any item: the lines it is about, as up to three places, or an empty list when it is about no lines.");
    expect(eyes).toContain("At most three places on an item, and at most 40 lines in each.");
    expect(eyes).toContain("`path`, from the repo's root; `start` and `end`, its first and last line, both included, counting the file's first line as 1; and `as`");
    expect(PLACE_KINDS).toEqual(["code", "words"]);
    expect(eyes).toContain("`as` is `code` for code, and `words` for words an End user reads");
  });

  it("says what the Kit does with a place: a wrong one is dropped, a long one is cut and a fourth refuses the Digest", () => {
    expect(eyes).toContain("The Kit drops a place whose file or lines the head does not have");
    expect(eyes).toContain("cuts a longer place to its first 40 lines");
    expect(eyes).toContain("refuses a Digest with a fourth place on an item");
  });

  it("tells the writer to point and never to quote the lines in the top", () => {
    expect(eyes).toContain("Point; never quote.");
    expect(eyes).toContain("Don't retype them in `claim` or `sentence`, or anywhere in the top.");
  });

  it("gives places their part of the reply's shape", () => {
    expect(output).toContain("Each has `kind`, `claim`, `sentence`, `asks`, `places`, `picture` and `suggestedRequest`");
    expect(output).toContain("`places` is a list of at most three places, each with `path`, `start`, `end` and `as`, and an empty list when the item is about no lines");
  });

  it("keeps its own example to the rule: every item names places, none more than three, none over 40 lines, as code and as words", () => {
    const read = readDigestReply(JSON.parse(/<digest>\n([\s\S]*?)\n<\/digest>/.exec(prompt)?.[1] ?? "null"));
    if (!read.ok) throw new Error(read.errors.join("; "));
    const places = read.output.items.map((item) => item.places);

    expect(places.every((named) => named.length >= 1 && named.length <= MAX_PLACES)).toBe(true);
    expect(places.flat().every(({ start, end }) => start >= 1 && end >= start && end - start + 1 <= MAX_PLACE_LINES)).toBe(true);
    expect([...new Set(places.flat().map(({ as }) => as))].toSorted()).toEqual([...PLACE_KINDS]);
  });
});
