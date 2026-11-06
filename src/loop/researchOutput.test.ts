import { describe, expect, it } from "vitest";
import { parseResearchOutput } from "./researchOutput.ts";

const reply = (value: unknown) => parseResearchOutput(JSON.stringify(value));

const findings = {
  gist: "Stripe Checkout takes one payment for every seat in a group booking; refunding one seat is a partial refund.",
  keyFacts: [
    "A Checkout Session's line item takes a quantity, so one payment covers every seat (https://docs.stripe.com/api/checkout/sessions/create).",
    "A refund can be for part of a payment's amount (https://docs.stripe.com/api/refunds/create).",
  ],
};

describe("The research output contract", () => {
  it("reads a one-line gist and the key facts it rests on", () => {
    expect(reply(findings)).toEqual({ ok: true, output: findings });
  });

  it.each([
    ["an empty gist", { ...findings, gist: "" }, "gist must be non-empty text"],
    ["a blank gist", { ...findings, gist: "  " }, "gist must be non-empty text"],
    ["no gist", { keyFacts: findings.keyFacts }, "gist must be non-empty text"],
    ["a gist of two lines", { ...findings, gist: "Stripe takes group bookings.\nSquare doesn't." }, "gist must be one line"],
    ["a gist ending in a line break", { ...findings, gist: "Stripe takes group bookings.\r\n" }, "gist must be one line"],
    ["no key facts", { ...findings, keyFacts: [] }, "keyFacts must be a list of at least one fact"],
    ["key facts left out", { gist: findings.gist }, "keyFacts must be a list of at least one fact"],
    ["key facts that aren't a list", { ...findings, keyFacts: "Stripe takes group bookings." }, "keyFacts must be a list of at least one fact"],
    ["an empty key fact", { ...findings, keyFacts: ["Stripe takes group bookings.", " "] }, "keyFacts[1] must be non-empty text"],
    ["a key fact that isn't text", { ...findings, keyFacts: [{ fact: "Stripe takes group bookings." }] }, "keyFacts[0] must be non-empty text"],
  ])("refuses %s", (_, output, error) => {
    expect(reply(output)).toEqual({ ok: false, errors: [error] });
  });

  it("names every problem at once", () => {
    expect(reply({ gist: "", keyFacts: [] })).toEqual({
      ok: false,
      errors: ["gist must be non-empty text", "keyFacts must be a list of at least one fact"],
    });
  });

  it.each([
    ["a list", [findings]],
    ["text", "Stripe takes group bookings."],
    ["null", null],
  ])("refuses %s in place of an object", (_, output) => {
    expect(reply(output)).toEqual({ ok: false, errors: ["Research output must be a JSON object"] });
  });

  it("refuses a reply that isn't JSON", () => {
    expect(parseResearchOutput("Stripe takes group bookings.")).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^Research output is not valid JSON/)],
    });
  });
});
