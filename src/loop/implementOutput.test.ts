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
    expect(parseImplementOutput(output({ fix: "Fixes the mobile layout.", routes: ["/book"] }), true)).toMatchObject({
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
