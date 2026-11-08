import { describe, expect, it } from "vitest";
import { parseImplementOutput } from "./implementOutput.ts";

const output = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", ...fields });

describe("The routes the Implementer names", () => {
  it("are read from its output, in the order it named them", () => {
    expect(parseImplementOutput(output({ routes: ["/book", "/services/physio"] }))).toMatchObject({
      ok: true,
      output: { routes: ["/book", "/services/physio"] },
    });
  });

  it("are read from a retry's or a Request-changes run's output too, which captures again", () => {
    expect(parseImplementOutput(output({ fix: "Fixes the mobile layout.", routes: ["/book"] }), "pull-request")).toMatchObject({
      ok: true,
      output: { fix: "Fixes the mobile layout.", routes: ["/book"] },
    });
  });

  it("read as none when the output names none", () => {
    const parsed = parseImplementOutput(output());

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.routes).toBeUndefined();
  });

  it.each([
    ["a bare path", "/book"],
    ["an object", { route: "/book" }],
    ["a list with a non-string in it", ["/book", 5]],
    ["a list with a path that doesn't start with /", ["/book", "services"]],
    ["a list with a full URL in it", ["/book", "https://example.com/book"]],
    ["a list with a protocol-relative URL in it", ["/book", "//example.com/book"]],
  ])("are dropped when the output gives %s, and the output still reads", (_, routes) => {
    const parsed = parseImplementOutput(output({ routes }));

    expect(parsed).toMatchObject({ ok: true, output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days." } });
    expect(parsed.ok && parsed.output.routes).toBeUndefined();
  });
});

describe("A Request-changes run's two answers about the review it was started for", () => {
  const answered = (fields: Record<string, unknown> = {}) =>
    output({ fix: "Moves the waitlist button.", reviewMiss: false, amendsTicket: true, ...fields });

  it("are read from its output: whether it has a Review miss, with each point named, and whether it amends the Ticket", () => {
    const parsed = parseImplementOutput(
      answered({ reviewMiss: true, reviewMissPoints: ["The Ticket asked for a confirmation email", "AGENTS.md bans inline styles"] }),
      "request-changes",
    );

    expect(parsed).toMatchObject({
      ok: true,
      output: {
        answers: {
          reviewMiss: true,
          points: ["The Ticket asked for a confirmation email", "AGENTS.md bans inline styles"],
          amendsTicket: true,
        },
      },
    });
  });

  it("read a no Review miss as naming no point", () => {
    expect(parseImplementOutput(answered(), "request-changes")).toMatchObject({
      ok: true,
      output: { answers: { reviewMiss: false, points: [], amendsTicket: true } },
    });
  });

  it.each([
    ["no reviewMiss", { reviewMiss: undefined }, "reviewMiss must be true or false on a Request-changes run"],
    ["a reviewMiss that isn't a boolean", { reviewMiss: "no" }, "reviewMiss must be true or false on a Request-changes run"],
    ["no amendsTicket", { amendsTicket: undefined }, "amendsTicket must be true or false on a Request-changes run"],
    ["a Review miss naming no point", { reviewMiss: true }, "reviewMissPoints must name each point that is a Review miss"],
    ["a Review miss with a blank point", { reviewMiss: true, reviewMissPoints: ["The email", " "] }, "reviewMissPoints must name each point that is a Review miss"],
  ])("reject an output with %s", (_, fields, error) => {
    expect(parseImplementOutput(answered(fields), "request-changes")).toEqual({ ok: false, errors: [error] });
  });

  it("are owed by a Request-changes run alone: a retry's output reads without them", () => {
    const parsed = parseImplementOutput(output({ fix: "Fixes the failing test." }), "pull-request");

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.answers).toBeUndefined();
  });

  it("still owe the fix every run on a PR owes", () => {
    expect(parseImplementOutput(answered({ fix: undefined }), "request-changes")).toEqual({
      ok: false,
      errors: ["fix must be non-empty Markdown on a retry or Request-changes run"],
    });
  });
});
