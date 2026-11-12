import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestFacts, aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import {
  DIGEST_FOLDS_MARKER,
  type DigestData,
  type DigestGiven,
  type DigestItem,
  type DigestReply,
  digestCommentOf,
  digestMarker,
  digestMarkIn,
  digestTop,
  noDigestLine,
  readDigestComment,
  readDigestReply,
} from "./digestContract.ts";
import { type DigestHead, type DigestPlace, MAX_PLACE_LINES, MAX_PLACES, type NamedPlace, PLACE_KINDS } from "./digestPlaces.ts";

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
  return { kind, claim: "Prices hold for 24 hours.", sentence: "The Ticket said for a while, and the Implementer chose a day.", asks: [], places: [], suggestedRequest: null, ...rest };
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

describe("The Digest's data line", () => {
  const WHAT = "A shopper can now save their basket from /basket. A saved basket keeps its prices for a day.";
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

  it("keeps a field a later release adds at this version, which removes none and changes no meaning", () => {
    const [, line = ""] = BODY.split("\n");
    const later = line.replace('{"v":1,', '{"v":1,"risk":"low",');

    expect(readDigestComment(withDataLine(later))).toMatchObject({ ok: true, data: { ...dataOf(BODY), risk: "low" } });
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
    expect(output).toContain("Each has `kind`, `claim`, `sentence`, `asks`, `places` and `suggestedRequest`");
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
