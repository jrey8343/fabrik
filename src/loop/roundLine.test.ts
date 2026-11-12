import { describe, expect, it } from "vitest";
import { type RoundLine, roundLineIn, roundLineOf, withoutRoundLines } from "./roundLine.ts";

const MARKER = "<!-- fabrik:design-round 2 -->";
const VISIBLE = "@jrey **Design session, round 2.** Reply with the numbers you'd answer differently, or `yes` to take every recommendation.\n\nOne question.\n\n**1. Ship it?**\n➡️ Recommended: Yes.";
const FIELDS = { v: 1, kind: "round", round: 2, intro: "One question.", questions: [{ question: "Ship it?", recommendation: "Yes." }] };

/** A Round's comment whose line under its marker is `line`. */
const roundWith = (line: string) => `${MARKER}\n${line}\n${VISIBLE}`;
const lineOf = (value: unknown) => `<!-- fabrik:round-line ${JSON.stringify(value)} -->`;

describe("Reading a Round's hidden line", () => {
  it("reads the fields a Round's line holds", () => {
    expect(roundLineIn(roundWith(lineOf(FIELDS)))).toEqual(FIELDS);
  });

  it("reads sentBack, with or without a Verdict, and asksMap", () => {
    const withVerdict = { ...FIELDS, sentBack: { pullRequest: 50, verdict: "https://github.com/acme/shop/pull/50#issuecomment-9" }, asksMap: true };
    const byOperator = { ...FIELDS, sentBack: { pullRequest: 50, verdict: null } };

    expect(roundLineIn(roundWith(lineOf(withVerdict)))).toEqual(withVerdict);
    expect(roundLineIn(roundWith(lineOf(byOperator)))).toEqual(byOperator);
  });

  it("reads a Round whose lines come back ending in CRLF, as an edited comment's can", () => {
    const crlf = roundWith(lineOf(FIELDS)).replaceAll("\n", "\r\n");

    expect(roundLineIn(crlf)).toEqual(FIELDS);
    expect(withoutRoundLines(crlf)).toBe(`${MARKER}\n${VISIBLE}`.replaceAll("\n", "\r\n"));
  });

  it("reads back, and takes out, a line whose text holds a line or paragraph separator", () => {
    const fields: RoundLine = { ...FIELDS, v: 1, kind: "round", intro: "One\u2028question.", questions: [{ question: "Ship\u2029it?", recommendation: "Yes\u2028\u2029now." }] };
    const body = `${MARKER}\n${roundLineOf(fields)}\n${VISIBLE}`;

    expect(roundLineIn(body)).toEqual(fields);
    expect(withoutRoundLines(body)).toBe(`${MARKER}\n${VISIBLE}`);
  });

  it("ignores a key it doesn't know, so a later release may add one", () => {
    expect(roundLineIn(roundWith(lineOf({ ...FIELDS, later: "something", questions: [{ ...FIELDS.questions[0], why: "x" }] })))).toEqual(FIELDS);
  });

  it.each([
    ["a Round with no line, as an earlier release posted", `${MARKER}\n${VISIBLE}`],
    ["a line that doesn't parse", roundWith("<!-- fabrik:round-line {\"v\":1, -->")],
    ["a version it doesn't know", roundWith(lineOf({ ...FIELDS, v: 2 }))],
    ["a version that isn't a number", roundWith(lineOf({ ...FIELDS, v: "1" }))],
    ["a kind it doesn't know", roundWith(lineOf({ ...FIELDS, kind: "poll" }))],
    ["a round that isn't a whole number above 0", roundWith(lineOf({ ...FIELDS, round: 0 }))],
    ["an intro that isn't text", roundWith(lineOf({ ...FIELDS, intro: 3 }))],
    ["questions that aren't a list", roundWith(lineOf({ ...FIELDS, questions: "Ship it?" }))],
    ["a question with no recommendation", roundWith(lineOf({ ...FIELDS, questions: [{ question: "Ship it?" }] }))],
    ["a sentBack with no pull request", roundWith(lineOf({ ...FIELDS, sentBack: { verdict: null } }))],
    ["a sentBack whose Verdict isn't text or null", roundWith(lineOf({ ...FIELDS, sentBack: { pullRequest: 50, verdict: 9 } }))],
    ["an asksMap that isn't true", roundWith(lineOf({ ...FIELDS, asksMap: false }))],
    ["JSON that isn't an object", roundWith(lineOf([FIELDS]))],
    ["a line that isn't directly under the marker", `${MARKER}\n${VISIBLE}\n${lineOf(FIELDS)}`],
    ["a comment that doesn't open with a Round's marker", `Quoting the Kit:\n${lineOf(FIELDS)}\n${VISIBLE}`],
    ["a comment that opens with another marker", `<!-- fabrik:design-turn-failed -->\n${lineOf(FIELDS)}`],
  ])("gives no data for %s", (_, body) => {
    expect(roundLineIn(body)).toBeNull();
  });
});

describe("Taking a Round's hidden line out of a comment", () => {
  it("takes the line out of a Round, leaving the rest as it was", () => {
    expect(withoutRoundLines(roundWith(lineOf(FIELDS)))).toBe(`${MARKER}\n${VISIBLE}`);
  });

  it.each([
    ["a Round with no line", `${MARKER}\n${VISIBLE}`],
    ["a comment that only quotes a line", `Quoting the Kit:\n${lineOf(FIELDS)}`],
    ["text with no line at all", "Option A, please."],
  ])("leaves %s as it is", (_, text) => {
    expect(withoutRoundLines(text)).toBe(text);
  });
});

// A prototype round and its failure round carry their line third, under the prototype marker (#636).
describe("Reading a prototype round's hidden line", () => {
  const PROTOTYPE = "<!-- fabrik:prototype-round -->";
  const FAILED = "<!-- fabrik:prototype-failed -->";
  const SHOWN = "@jrey **Design session, round 3: the prototype.** …\n\n**1. Which variant?**\n➡️ Recommended: B.";
  const VARIANT = { letter: "A", summary: "One long form.", component: "https://github.com/acme/shop/blob/7e3d1c9/src/A.tsx", preview: null };
  const PROTOTYPE_FIELDS = {
    v: 1,
    kind: "prototype",
    round: 3,
    intro: "Two ways.",
    questions: [{ question: "Which variant?", recommendation: "B." }],
    route: "/book",
    recommended: "B",
    variants: [VARIANT, { ...VARIANT, letter: "B", summary: "A stepper.", preview: "https://prototype-7--shop.netlify.app/book?variant=B" }],
    captures: { run: 9100, artifact: 9201 },
  };
  const FAILED_FIELDS = {
    v: 1,
    kind: "prototype-failed",
    round: 3,
    intro: "`sandbox.build` failed.",
    questions: [{ question: "Carry on without a prototype, or try again?", recommendation: "Carry on without a prototype." }],
    otherAnswers: ["Try again"],
  };
  const prototypeWith = (line: string) => `<!-- fabrik:design-round 3 -->\n${PROTOTYPE}\n${line}\n${SHOWN}`;
  const failedWith = (line: string) => `<!-- fabrik:design-round 3 -->\n${FAILED}\n${line}\n${SHOWN}`;

  it("reads a prototype round's route, advised letter, variants and captures", () => {
    expect(roundLineIn(prototypeWith(lineOf(PROTOTYPE_FIELDS)))).toEqual(PROTOTYPE_FIELDS);
  });

  it("reads one with no advised letter, and one whose captures are null", () => {
    const { recommended: _, ...unadvised } = PROTOTYPE_FIELDS;

    expect(roundLineIn(prototypeWith(lineOf(unadvised)))).toEqual(unadvised);
    expect(roundLineIn(prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, captures: null })))).toEqual({ ...PROTOTYPE_FIELDS, captures: null });
  });

  it("reads a prototype failure round's question and other answers", () => {
    expect(roundLineIn(failedWith(lineOf(FAILED_FIELDS)))).toEqual(FAILED_FIELDS);
  });

  it("reads them from a comment whose lines come back ending in CRLF, and takes the line out", () => {
    const crlf = prototypeWith(lineOf(PROTOTYPE_FIELDS)).replaceAll("\n", "\r\n");

    expect(roundLineIn(crlf)).toEqual(PROTOTYPE_FIELDS);
    expect(withoutRoundLines(crlf)).toBe(`<!-- fabrik:design-round 3 -->\n${PROTOTYPE}\n${SHOWN}`.replaceAll("\n", "\r\n"));
  });

  it("takes the line out of each, leaving both markers and the rest as they were", () => {
    expect(withoutRoundLines(prototypeWith(lineOf(PROTOTYPE_FIELDS)))).toBe(`<!-- fabrik:design-round 3 -->\n${PROTOTYPE}\n${SHOWN}`);
    expect(withoutRoundLines(failedWith(lineOf(FAILED_FIELDS)))).toBe(`<!-- fabrik:design-round 3 -->\n${FAILED}\n${SHOWN}`);
  });

  it.each([
    ["a prototype round with no line, as an earlier release posted", `<!-- fabrik:design-round 3 -->\n${PROTOTYPE}\n${SHOWN}`],
    ["variants that are empty", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, recommended: undefined, variants: [] }))],
    ["variants that aren't a list", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, variants: VARIANT }))],
    ["a variant with no component", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, variants: [{ ...VARIANT, component: undefined }] }))],
    ["a variant whose preview isn't text or null", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, variants: [{ ...VARIANT, preview: 3 }] }))],
    ["a variant with no preview key", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, variants: [{ ...VARIANT, preview: undefined }] }))],
    ["a route that isn't text", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, route: ["/book"] }))],
    ["an advised letter that isn't one of its variants'", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, recommended: "C" }))],
    ["an advised letter that isn't text", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, recommended: 2 }))],
    ["captures with no artifact", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, captures: { run: 9100 } }))],
    ["no captures key", prototypeWith(lineOf({ ...PROTOTYPE_FIELDS, captures: undefined }))],
    ["a prototype line under the failure marker", failedWith(lineOf(PROTOTYPE_FIELDS))],
    ["a failure line under the prototype marker", prototypeWith(lineOf(FAILED_FIELDS))],
    ["an ordinary Round's line under the prototype marker", prototypeWith(lineOf(FIELDS))],
    ["a prototype line second, where an ordinary Round's goes", roundWith(lineOf(PROTOTYPE_FIELDS))],
    ["other answers that aren't a list of text", failedWith(lineOf({ ...FAILED_FIELDS, otherAnswers: "Try again" }))],
    ["other answers holding something not text", failedWith(lineOf({ ...FAILED_FIELDS, otherAnswers: ["Try again", 2] }))],
    ["a failure round's questions that aren't a list", failedWith(lineOf({ ...FAILED_FIELDS, questions: null }))],
  ])("gives no data for %s", (_, body) => {
    expect(roundLineIn(body)).toBeNull();
  });
});
