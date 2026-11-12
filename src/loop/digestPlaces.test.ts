import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { type DigestGiven, type DigestItem, type DigestReply, digestCommentOf, readDigestReply } from "./digestContract.ts";
import { type DigestHead, MAX_PLACE_LINES, MAX_PLACES, type NamedPlace, PLACE_KINDS } from "./digestPlaces.ts";

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
