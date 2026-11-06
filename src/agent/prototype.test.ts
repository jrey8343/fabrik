import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { PROTOTYPE_SECTIONS, prototypeTurnContext } from "./prototype.ts";

/** The Kit job's prototype_request output, as the prototype job's env passes it. */
const REQUEST = JSON.stringify({
  route: "/book",
  variants: 3,
  brief: "A: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button.",
  reply: 4321,
});

const withUi = kitConfig({ ui: UI, sandbox: { ...kitConfig().sandbox, build: "npm run build" } });

describe("A prototype turn's context", () => {
  it("sets out the approved request: the route, the variants by letter, the branch and the brief", () => {
    const { request, parts } = prototypeTurnContext(withUi, 7, REQUEST);

    expect(request).toEqual({
      request: { route: "/book", variants: 3, brief: "A: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button." },
      reply: 4321,
    });
    expect(parts.slice(0, 3)).toEqual([
      `## ${PROTOTYPE_SECTIONS.request}`,
      "The Operator approved a Prototype of `/book` in 3 variants. Build them as the variants A, B and C of that one route, each shown at `/book?variant=` and its letter, on the branch `prototype/7`, which is checked out.",
      "What the variants explore, as the Design session's request gives it:",
    ]);
    expect(parts[3]).toBe("```markdown\nA: a calendar first.\nB: a list of open times.\nC: one big next-free-slot button.\n```");
  });

  it("sets out how the Kit builds, serves and captures the branch once the turn has ended", () => {
    const { parts } = prototypeTurnContext(withUi, 7, REQUEST);

    expect(parts.slice(4)).toEqual([
      `## ${PROTOTYPE_SECTIONS.sandbox}`,
      ["- Build: `npm run build`", "- Serve: `npm run preview`, which answers at `http://127.0.0.1:4321`"].join("\n"),
      "Once you finish, the Kit builds the branch, serves it, and captures each variant at mobile and desktop widths, at `http://127.0.0.1:4321/book?variant=A` and so on, so each variant must render there from its letter alone.",
    ]);
    expect(prototypeTurnContext(kitConfig({ ui: UI }), 7, REQUEST).parts[5]).toBe(
      ["- Build: none configured", "- Serve: `npm run preview`, which answers at `http://127.0.0.1:4321`"].join("\n"),
    );
  });

  it("fences the brief so no run of backticks in it can close the fence", () => {
    const brief = "A: shows ```code``` blocks.";
    const { parts } = prototypeTurnContext(withUi, 7, JSON.stringify({ route: "/book", variants: 2, brief, reply: null }));

    expect(parts[3]).toBe(`\`\`\`\`markdown\n${brief}\n\`\`\`\``);
  });

  it.each([
    ["no request at all", ""],
    ["text that isn't JSON", "the booking page, please"],
    ["a route that isn't a path", JSON.stringify({ route: "book", variants: 3, brief: "Three layouts.", reply: null })],
    ["too many variants", JSON.stringify({ route: "/book", variants: 6, brief: "Six layouts.", reply: null })],
    ["no brief", JSON.stringify({ route: "/book", variants: 3, brief: " ", reply: null })],
  ])("refuses %s, so the run fails rather than builds what nobody approved", (_, text) => {
    expect(() => prototypeTurnContext(withUi, 7, text)).toThrow(/FABRIK_PROTOTYPE_REQUEST/);
  });

  // The Kit job only starts a prototype turn with a ui block, so the default branch's Kit config lost it since.
  it("refuses a repo whose Kit config has no ui block, which the Kit can neither serve nor capture", () => {
    expect(() => prototypeTurnContext(kitConfig({ ui: null }), 7, REQUEST)).toThrow(/ui block/);
  });
});
