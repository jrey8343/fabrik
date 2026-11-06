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

describe("The Operator comments a prototype or prototype-round output weighed", () => {
  it.each([
    ["prototype", () => requested],
    ["prototype-round", () => built],
  ])("are read on a %s output, as on every kind", (_, output) => {
    expect(turn({ ...output(), operatorCommentsConsidered: ["conversation-3"] })).toMatchObject({
      ok: true,
      output: { operatorCommentsConsidered: ["conversation-3"] },
    });
  });

  it.each([
    ["prototype", () => requested],
    ["prototype-round", () => built],
  ])("are left out of a %s output when they aren't a list of ids, which never fails the turn", (_, output) => {
    const checked = turn({ ...output(), operatorCommentsConsidered: "conversation-3" });

    expect(checked.ok && "operatorCommentsConsidered" in checked.output).toBe(false);
    expect(checked.ok).toBe(true);
  });
});

describe("A Design turn output of a kind the contract doesn't know", () => {
  it("is refused, naming every kind it does", () => {
    expect(turn({ kind: "mockup" })).toEqual({
      ok: false,
      errors: ['kind must be round, brief, spec, split, not-planned, map, prototype or prototype-round, not "mockup"'],
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

  const [a, b, c] = built.variants;
  const variant = (summary: string, i: number) => ({ summary, component: `src/routes/book/Variant${i}.tsx` });

  it("reads 5 variants, lettered A to E", () => {
    const five = { ...built, variants: ["One", "Two", "Three", "Four", "Five"].map(variant) };

    const checked = turn(five);

    expect(checked.ok && checked.output.kind === "prototype-round" && checked.output.variants.map(({ letter }) => letter)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it.each([
    ["no intro", { ...built, intro: undefined }, "a prototype-round needs non-empty intro text"],
    ["an empty intro", { ...built, intro: " " }, "a prototype-round needs non-empty intro text"],
    ["no recommendation", { ...built, recommendation: undefined }, "a prototype-round needs non-empty recommendation text"],
    ["an empty recommendation", { ...built, recommendation: "" }, "a prototype-round needs non-empty recommendation text"],
    ["a variant with no summary", { ...built, variants: [a, { component: b?.component }, c] }, "variant B needs a summary, one non-empty line"],
    [
      "a variant whose summary runs over two lines",
      { ...built, variants: [a, b, { ...c, summary: "Calendar first.\nDetails after." }] },
      "variant C needs a summary, one non-empty line",
    ],
    ["a variant with no component", { ...built, variants: [{ summary: a?.summary }, b, c] }, "variant A needs the repo path of its component"],
    ["a variant with an empty component", { ...built, variants: [a, { ...b, component: " " }, c] }, "variant B needs the repo path of its component"],
    [
      "a variant whose component is an absolute path",
      { ...built, variants: [a, b, { ...c, component: "/home/runner/work/app/src/routes/book/VariantC.tsx" }] },
      "variant C needs the repo path of its component",
    ],
    ["one variant", { ...built, variants: [a] }, "a prototype-round needs from 2 to 5 variants"],
    ["no variants", { ...built, variants: [] }, "a prototype-round needs from 2 to 5 variants"],
    ["variants left out", { ...built, variants: undefined }, "a prototype-round needs from 2 to 5 variants"],
    ["six variants", { ...built, variants: ["1", "2", "3", "4", "5", "6"].map(variant) }, "a prototype-round needs from 2 to 5 variants"],
  ])("refuses %s, naming it", (_, output, error) => {
    expect(turn(output)).toEqual({ ok: false, errors: [error] });
  });

  it("refuses a variant that isn't an object, naming both fields it lacks", () => {
    expect(turn({ ...built, variants: [a, "A stepper", c] })).toEqual({
      ok: false,
      errors: ["variant B needs a summary, one non-empty line", "variant B needs the repo path of its component"],
    });
  });

  it("names every problem at once", () => {
    expect(turn({ kind: "prototype-round", variants: [{ component: "src/A.tsx" }, { summary: "A stepper." }] })).toEqual({
      ok: false,
      errors: [
        "a prototype-round needs non-empty intro text",
        "variant A needs a summary, one non-empty line",
        "variant B needs the repo path of its component",
        "a prototype-round needs non-empty recommendation text",
      ],
    });
  });
});
