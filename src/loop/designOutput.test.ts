import { describe, expect, it } from "vitest";
import { resolveKitConfig } from "../kit/config.ts";
import {
  PROTOTYPE_DEFAULT_VARIANTS,
  PROTOTYPE_MIN_VARIANTS,
  PROTOTYPE_VARIANT_CAP,
  parseDesignTurnOutput,
  parsePrototypeTurnOutput,
} from "./designOutput.ts";
import { mentionsSomeone, withoutMentions } from "./mentions.ts";

/** The issue the turn's Design session is on. */
const ISSUE = 7;

const turn = (value: unknown) => parseDesignTurnOutput(JSON.stringify(value), ISSUE);

const requested = {
  kind: "prototype",
  route: "/book",
  variants: 3,
  brief: "- **A**: one long form, everything on one page.\n- **B**: a stepper, one question at a time.\n- **C**: a calendar first, details after.\n\nThe Operator asked for a bigger booking button in every variant.",
  comment: "Prototyping the booking page as you approved.",
};

describe("A Design turn's round output that asks the Map question", () => {
  const round = { kind: "round", intro: "One question first.", questions: [{ question: "Chart this as a Map instead?", recommendation: "Yes." }] };

  it("keeps asksMap when it is true", () => {
    expect(turn({ ...round, asksMap: true })).toEqual({ ok: true, output: { ...round, asksMap: true } });
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ["the text true", "true"],
    ["1", 1],
    ["null", null],
  ])("leaves the mark out, and still reads the round, when asksMap is %s", (_, asksMap) => {
    const result = turn({ ...round, asksMap });
    expect(result).toEqual({ ok: true, output: round });
  });
});

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

const rollIn = {
  kind: "roll-in",
  pullRequest: 42,
  summary: "Show the cart's total beside its heading, so a shopper sees it without scrolling.",
  acceptanceCriteria: ["The cart page shows the total beside its heading.", "The total updates when a line is removed."],
};

describe("A Design turn's roll-in output: the Operator settled a Roll-in", () => {
  it("reads the pull request, the summary and the criteria, beside its kind", () => {
    expect(turn(rollIn)).toEqual({ ok: true, output: rollIn });
  });

  it.each([
    ["no summary", { ...rollIn, summary: undefined }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["an empty summary", { ...rollIn, summary: " \n" }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["no criteria", { ...rollIn, acceptanceCriteria: [] }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["criteria left out", { ...rollIn, acceptanceCriteria: undefined }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["an empty criterion", { ...rollIn, acceptanceCriteria: ["The total shows.", " "] }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["a criterion that isn't text", { ...rollIn, acceptanceCriteria: [3] }, "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion"],
    ["no pull request", { ...rollIn, pullRequest: undefined }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
    ["a pull request of zero", { ...rollIn, pullRequest: 0 }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
    ["a negative pull request", { ...rollIn, pullRequest: -42 }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
    ["a pull request that isn't whole", { ...rollIn, pullRequest: 42.5 }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
    ["a pull request given as text", { ...rollIn, pullRequest: "42" }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
    ["a pull request given as a link", { ...rollIn, pullRequest: "#42" }, "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero"],
  ])("refuses %s, naming it", (_, output, error) => {
    expect(turn(output)).toEqual({ ok: false, errors: [error] });
  });

  it("names every problem at once", () => {
    expect(turn({ kind: "roll-in" })).toEqual({
      ok: false,
      errors: [
        "a roll-in needs pullRequest, the number of the pull request to build on: a whole number above zero",
        "a roll-in needs a summary and at least one acceptance criterion, with no empty criterion",
      ],
    });
  });

  it("reads its fields beside kind only: a summary under a brief is no summary", () => {
    const { summary, acceptanceCriteria, ...rest } = rollIn;

    expect(turn({ ...rest, brief: { summary, acceptanceCriteria } }).ok).toBe(false);
  });

  it("takes a text of any length: there is no word cap", () => {
    const long = { ...rollIn, summary: "Show the total. ".repeat(5_000), acceptanceCriteria: Array.from({ length: 200 }, (_, i) => `Check ${i + 1} holds.`) };

    expect(turn(long)).toEqual({ ok: true, output: long });
  });

  const NAMES_ISSUE = "names this issue, #7, by its number or its link: the Implementer and the Reviewer are never given the issue, so the text has to stand alone";
  const MENTIONS = "mentions someone, which would notify them when the Operator sends it: write a name that begins with @ as inline code of its own";
  const withSummary = (summary: string) => ({ ...rollIn, summary });
  const withCriterion = (criterion: string) => ({ ...rollIn, acceptanceCriteria: ["The total shows.", criterion] });

  it.each([
    ["the summary names the issue by # and its number", withSummary("Finish what #7 asked for: show the total."), `a roll-in's summary ${NAMES_ISSUE}`],
    ["the summary opens with the issue's number", withSummary("#7: show the total."), `a roll-in's summary ${NAMES_ISSUE}`],
    ["a criterion names the issue in brackets", withCriterion("The total shows (#7)."), `a roll-in's acceptance criterion 2 ${NAMES_ISSUE}`],
    [
      "a criterion links to the issue",
      withCriterion("The total shows as https://github.com/acme/shop/issues/7 describes."),
      `a roll-in's acceptance criterion 2 ${NAMES_ISSUE}`,
    ],
    [
      "the summary links to a comment on the issue",
      withSummary("Show the total, as settled in https://github.com/acme/shop/issues/7#issuecomment-9001."),
      `a roll-in's summary ${NAMES_ISSUE}`,
    ],
    ["the summary links to the issue in other letter case", withSummary("See HTTPS://GitHub.com/Acme/Shop/issues/7."), `a roll-in's summary ${NAMES_ISSUE}`],
    ["the summary mentions someone", withSummary("Show the total, as @jrey asked."), `a roll-in's summary ${MENTIONS}`],
    ["a criterion mentions someone", withCriterion("The total shows the way @jrey-9 drew it."), `a roll-in's acceptance criterion 2 ${MENTIONS}`],
    [
      "a name beginning with @ sits later in a code span",
      withSummary("Run `npm install @acme/cart` first."),
      `a roll-in's summary ${MENTIONS}`,
    ],
    [
      "a name beginning with @ sits in a fenced block",
      withSummary("Add the import:\n\n```ts\nimport { total } from \"@acme/cart\";\n@decorated\nclass Cart {}\n```"),
      `a roll-in's summary ${MENTIONS}`,
    ],
  ])("is refused when %s, naming the reason", (_, output, error) => {
    expect(turn(output)).toEqual({ ok: false, errors: [error] });
  });

  it("names each refusal, where it is", () => {
    expect(turn({ ...rollIn, summary: "As @jrey settled on #7.", acceptanceCriteria: ["The total shows.", "It is what #7 asked for."] })).toEqual({
      ok: false,
      errors: [`a roll-in's summary ${NAMES_ISSUE}`, `a roll-in's summary ${MENTIONS}`, `a roll-in's acceptance criterion 2 ${NAMES_ISSUE}`],
    });
  });

  it.each([
    ["a longer number that only begins with the issue's digits", "Keep what #70 and #712 built."],
    ["a number that ends with the issue's digits", "Keep what #17 built."],
    ["another issue's number", "Keep what #8 built."],
    ["the issue's number with no #", "Show 7 lines at most."],
    ["a link to an issue whose number only begins with the issue's digits", "See https://github.com/acme/shop/issues/70."],
    ["a link to the pull request it is built on", "It builds on https://github.com/acme/shop/pull/42."],
    ["an anchor in a path", "See docs/cart.md#7-totals."],
    ["an email address", "Send the receipt from a@b.c, never from billing@shop.example."],
    ["a name written straight after a backtick", "Import the total from `@acme/cart`."],
    ["an @ that begins no name", "Totals are shown @ 2 decimal places."],
  ])("is read when its text holds %s", (_, text) => {
    const output = { ...rollIn, summary: text, acceptanceCriteria: [text] };

    expect(turn(output)).toEqual({ ok: true, output });
  });

  it("is refused for naming the issue the session is on, and no other", () => {
    const output = withSummary("Finish what #7 asked for.");

    expect(parseDesignTurnOutput(JSON.stringify(output), 8)).toEqual({ ok: true, output });
  });

  // One test for a mention across the Kit: what the contract refuses is exactly what the Kit's stripping would defuse.
  it.each([
    "as @jrey asked",
    "@jrey",
    "(@jrey)",
    "a@b.c",
    "`@acme/cart`",
    "`npm i @acme/cart`",
    "under_@score",
    "@ 2 decimal places",
    "@-dash",
    "no mention at all",
  ])("refuses %j as a mention exactly when the Kit's stripping of mentions would change it", (text) => {
    expect(mentionsSomeone(text)).toBe(withoutMentions(text) !== text);
    expect(turn(withSummary(text)).ok).toBe(!mentionsSomeone(text));
  });

  it("carries the Operator comments it weighed, as every kind does", () => {
    expect(turn({ ...rollIn, operatorCommentsConsidered: ["conversation-3"] })).toEqual({
      ok: true,
      output: { ...rollIn, operatorCommentsConsidered: ["conversation-3"] },
    });
  });
});

describe("A Design turn output of a kind the contract doesn't know", () => {
  it("is refused, naming every kind it does", () => {
    expect(turn({ kind: "mockup" })).toEqual({
      ok: false,
      errors: ['kind must be round, brief, spec, split, not-planned, roll-in, map, prototype or prototype-round, not "mockup"'],
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

// The letter of the variant the recommendation builds on (#636): optional, and never a reason to fail the turn.
describe("A prototype-round's advised variant", () => {
  it("keeps recommended when it is one of the variants' letters", () => {
    const result = turn({ ...built, recommended: "B" });

    expect(result.ok && result.output).toMatchObject({ kind: "prototype-round", recommended: "B" });
    expect(result.ok && result.output).not.toHaveProperty("refusedRecommended");
  });

  it("reads an output with no recommended as it always did", () => {
    const result = turn(built);

    expect(result.ok && result.output).not.toHaveProperty("recommended");
    expect(result.ok && result.output).not.toHaveProperty("refusedRecommended");
  });

  it.each([
    ["a letter past the last variant", "D", '"D"'],
    ["a lower-case letter", "b", '"b"'],
    ["a word", "Stepper", '"Stepper"'],
    ["a letter with space around it", " B", '" B"'],
    ["a number", 2, "2"],
    ["null", null, "null"],
    ["a list", ["B"], '["B"]'],
  ])("refuses %s, reading the round all the same, and keeps what was refused, as given, for the landing to note", (_, recommended, given) => {
    const result = turn({ ...built, recommended });

    expect(result.ok).toBe(true);
    expect(result.ok && result.output).not.toHaveProperty("recommended");
    expect(result.ok && result.output).toMatchObject({ refusedRecommended: given });
  });
});

describe("A prototype turn's output, which only a prototype-round keeps to", () => {
  const prototypeTurn = (value: unknown) => parsePrototypeTurnOutput(JSON.stringify(value));

  it("reads a prototype-round as any Design turn's output reads it", () => {
    expect(prototypeTurn({ ...built, operatorCommentsConsidered: ["9001"] })).toEqual(turn({ ...built, operatorCommentsConsidered: ["9001"] }));
    expect(prototypeTurn(built).ok).toBe(true);
  });

  // The turn was started to build the variants, so even a well-formed ordinary outcome breaks its contract.
  it.each([
    ["round", { kind: "round", intro: "Before we build:", questions: [{ question: "Which route?", recommendation: "/book" }] }],
    ["prototype", requested],
    ["not-planned", { kind: "not-planned", comment: "Not worth building." }],
    ["roll-in", rollIn],
    ["mockup", { kind: "mockup" }],
  ])("refuses a %s output, naming the kind", (kind, output) => {
    expect(prototypeTurn(output)).toEqual({ ok: false, errors: [`a prototype turn ends only in a prototype-round, not "${kind}"`] });
  });

  it("names a malformed prototype-round's problems as any Design turn's output does", () => {
    const malformed = { ...built, intro: " ", variants: built.variants.slice(0, 1) };

    expect(prototypeTurn(malformed)).toEqual(turn(malformed));
    expect(prototypeTurn(malformed).ok).toBe(false);
  });

  it("refuses output that isn't a JSON object", () => {
    expect(parsePrototypeTurnOutput("Here are the variants")).toMatchObject({ ok: false, errors: [expect.stringMatching(/^Design-session output is not valid JSON: /)] });
    expect(prototypeTurn(["prototype-round"])).toEqual({ ok: false, errors: ["Design-session output must be a JSON object"] });
  });
});

describe("A Prototype's variant counts, Kit constants no Kit config can change", () => {
  it("builds 3 variants by default, at least 2 and never more than 5", () => {
    expect([PROTOTYPE_MIN_VARIANTS, PROTOTYPE_DEFAULT_VARIANTS, PROTOTYPE_VARIANT_CAP]).toEqual([2, 3, 5]);
  });

  it.each([
    [{ prototype: { variants: 4 } }, "prototype is not a Kit config field"],
    [{ prototypes: { max_variants: 4 } }, "prototypes is not a Kit config field"],
    [{ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", variants: 4 } }, "ui.variants is not a Kit config field"],
    [{ roles: { design: { variants: 4 } } }, "roles.design.variants is not a Kit config field"],
  ])("refuses %j as an unknown field", (config, error) => {
    expect(resolveKitConfig({ config: JSON.stringify(config) })).toEqual({ ok: false, errors: [error] });
  });
});
