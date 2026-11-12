import { describe, expect, it } from "vitest";
import { roundLineIn, withoutRoundLines } from "./roundLine.ts";

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
