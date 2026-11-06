import { describe, expect, it } from "vitest";
import { parseDesignTurnOutput } from "./designOutput.ts";

const turn = (value: unknown) => parseDesignTurnOutput(JSON.stringify(value));

const requested = {
  kind: "prototype",
  route: "/book",
  variants: 3,
  brief: "- **A**: one long form, everything on one page.\n- **B**: a stepper, one question at a time.\n- **C**: a calendar first, details after.\n\nThe Operator asked for a bigger booking button in every variant.",
  comment: "Prototyping the booking page as you approved.",
};

describe("A Design turn's prototype output: the Operator approved a Prototype", () => {
  it("reads the route, the variant count, the brief and the request comment's lead-in", () => {
    expect(turn(requested)).toEqual({ ok: true, output: requested });
  });

  it.each([2, 5])("reads %i variants", (variants) => {
    expect(turn({ ...requested, variants })).toMatchObject({ ok: true, output: { variants } });
  });

  it.each([
    ["a route not starting with /", { ...requested, route: "book" }, "a prototype needs a route, a path starting with /"],
    ["a route that is a whole URL", { ...requested, route: "https://penrithphysio.com.au/book" }, "a prototype needs a route, a path starting with /"],
    ["a protocol-relative route", { ...requested, route: "//penrithphysio.com.au/book" }, "a prototype needs a route, a path starting with /"],
    ["no route", { ...requested, route: undefined }, "a prototype needs a route, a path starting with /"],
    ["1 variant", { ...requested, variants: 1 }, "a prototype needs variants, a whole number from 2 to 5"],
    ["6 variants", { ...requested, variants: 6 }, "a prototype needs variants, a whole number from 2 to 5"],
    ["2.5 variants", { ...requested, variants: 2.5 }, "a prototype needs variants, a whole number from 2 to 5"],
    ["variants given as text", { ...requested, variants: "3" }, "a prototype needs variants, a whole number from 2 to 5"],
    ["no variant count", { ...requested, variants: undefined }, "a prototype needs variants, a whole number from 2 to 5"],
    ["an empty brief", { ...requested, brief: " " }, "a prototype needs non-empty brief text"],
    ["no brief", { ...requested, brief: undefined }, "a prototype needs non-empty brief text"],
    ["an empty comment", { ...requested, comment: "" }, "a prototype needs a comment, one non-empty line"],
    ["a comment of two lines", { ...requested, comment: "Prototyping the booking page.\nThree variants." }, "a prototype needs a comment, one non-empty line"],
  ])("refuses %s, naming it", (_, output, error) => {
    expect(turn(output)).toEqual({ ok: false, errors: [error] });
  });

  it("names every problem at once", () => {
    expect(turn({ kind: "prototype", route: "book", variants: 9 })).toEqual({
      ok: false,
      errors: [
        "a prototype needs a route, a path starting with /",
        "a prototype needs variants, a whole number from 2 to 5",
        "a prototype needs non-empty brief text",
        "a prototype needs a comment, one non-empty line",
      ],
    });
  });
});

const built = {
  kind: "prototype-round",
  intro: "Three takes on `/book`, each with the bigger booking button you asked for.",
  variants: [
    { summary: "One long form: every field on one page.", component: "src/routes/book/VariantA.tsx" },
    { summary: "A stepper: one question at a time.", component: "src/routes/book/VariantB.tsx" },
    { summary: "Calendar first, details after.", component: "src/routes/book/VariantC.tsx" },
  ],
  recommendation: "B, with C's calendar as its first step",
};

describe("A prototype turn's prototype-round output: the variants it built", () => {
  it("reads the intro, each variant lettered A, B, C in order with its summary and component, and the recommendation", () => {
    expect(turn(built)).toEqual({
      ok: true,
      output: {
        kind: "prototype-round",
        intro: built.intro,
        variants: [
          { letter: "A", summary: "One long form: every field on one page.", component: "src/routes/book/VariantA.tsx" },
          { letter: "B", summary: "A stepper: one question at a time.", component: "src/routes/book/VariantB.tsx" },
          { letter: "C", summary: "Calendar first, details after.", component: "src/routes/book/VariantC.tsx" },
        ],
        recommendation: "B, with C's calendar as its first step",
      },
    });
  });

  it("reads its own checked output back the same, as the push job does after the agent job checked it", () => {
    const checked = turn(built);
    if (!checked.ok) throw new Error(checked.errors.join("; "));

    expect(turn(checked.output)).toEqual(checked);
  });
});
