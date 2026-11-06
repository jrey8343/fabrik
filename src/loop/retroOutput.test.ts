import { describe, expect, it } from "vitest";
import { parseRetroOutput } from "./retroOutput.ts";

const reply = (value: unknown) => parseRetroOutput(JSON.stringify(value));

/** A valid tightening: a lint check in the Product repo, on two PRs' evidence. */
const aCheck = (overrides: Record<string, unknown> = {}) => ({
  title: "Fail the lint on a raw SQL string outside src/db",
  problem: "Two PRs were sent back for raw SQL in a route handler.",
  change: "Add `no-restricted-syntax` for SQL template literals outside `src/db/` in `eslint.config.js`.",
  kind: "mechanical",
  direction: "tighten",
  target: "product-code",
  evidence: ["#140", "#131"],
  ...overrides,
});

/** A valid loosening: relaxing a Kit prompt rule on a counted streak. */
const aLoosening = (overrides: Record<string, unknown> = {}) => ({
  title: "Let the Reviewer pass a docs-only PR without UI evidence",
  problem: "Every docs-only PR since the rule was added merged with no escape, revert or Request changes.",
  change: "In `prompts/review.md`, drop the UI evidence check for a PR that changes only `docs/`.",
  kind: "judgement",
  direction: "loosen",
  target: "kit",
  evidence: ["#101", "#102"],
  streak: { pullRequests: [101, 102, 103], kind: "agent PRs that change only files under docs/" },
  undoes: "#88",
  ...overrides,
});

/** The errors a reply holding these proposals is refused with. */
const refusal = (...proposals: unknown[]) => {
  const result = reply({ proposals });
  return result.ok ? [] : result.errors;
};

describe("The Retro output contract", () => {
  it("reads a reply with no proposals, a week with nothing worth proposing", () => {
    expect(reply({ proposals: [] })).toEqual({ ok: true, output: { proposals: [] } });
  });

  it("reads three proposals, most important first: a lint check, a loosening with its streak, and an Extra skill's", () => {
    const lintCheck = {
      title: "Fail the lint on a raw SQL string outside src/db",
      problem: "Two escapes and three Request changes were raw SQL in a route handler.",
      change: "Add `no-restricted-syntax` for template literals starting with SELECT outside `src/db/` in `eslint.config.js`.",
      kind: "mechanical",
      direction: "tighten",
      target: "product-code",
      evidence: ["#140", "#131", "runs/acme/widgets/2026-11/9001-1-review.json"],
    };
    const loosening = {
      title: "Let the Reviewer pass a docs-only PR without UI evidence",
      problem: "Every docs-only PR since the rule was added passed with no escape, revert or Request changes.",
      change: "In `prompts/review.md`, drop the UI evidence check for a PR that changes only `docs/`.",
      kind: "judgement",
      direction: "loosen",
      target: "kit",
      evidence: ["#101", "#102"],
      streak: { pullRequests: [101, 102, 103], kind: "agent PRs that change only files under docs/" },
      undoes: "#88",
    };
    const extraSkill = {
      title: "Have event-storming name the aggregate it changes",
      problem: "The Design sessions that used event-storming left the aggregate unnamed in both Specs the Operator sent back.",
      change: "In `SKILL.md`, end the session by naming the aggregate each event lands on.",
      kind: "judgement",
      direction: "tighten",
      target: "extra-skill",
      skill: "event-storming",
      evidence: ["#120", "#126"],
    };

    expect(reply({ proposals: [lintCheck, loosening, extraSkill] })).toEqual({
      ok: true,
      output: {
        proposals: [
          { ...lintCheck, skill: null },
          { ...loosening, skill: null },
          extraSkill,
        ],
      },
    });
  });

  it("refuses the whole reply for one bad proposal, keeping none of the good ones", () => {
    expect(reply({ proposals: [aCheck(), aCheck({ kind: "prose" })] })).toEqual({
      ok: false,
      errors: ['proposals[1].kind must be one of mechanical, judgement, not "prose"'],
    });
  });

  it("refuses a reply with more than 3 proposals", () => {
    expect(refusal(aCheck(), aCheck(), aCheck(), aCheck())).toEqual(["proposals must number at most 3, not 4"]);
  });

  it.each(["title", "problem", "change", "kind", "direction", "target", "evidence"])("refuses a proposal with no %s", (field) => {
    // JSON leaves out a field that's undefined.
    expect(refusal(aCheck(), aCheck({ [field]: undefined }))).toEqual([expect.stringMatching(new RegExp(`^proposals\\[1\\]\\.${field} `))]);
  });

  it.each([
    ["kind", "prose", 'proposals[0].kind must be one of mechanical, judgement, not "prose"'],
    ["direction", "relax", 'proposals[0].direction must be one of tighten, loosen, not "relax"'],
    ["target", "agents-md", 'proposals[0].target must be one of product-trust-root, product-code, kit, extra-skill, not "agents-md"'],
    ["title", "  ", "proposals[0].title must be non-empty text"],
    ["evidence", "#140", "proposals[0].evidence must be a list of refs from the evidence"],
    ["evidence", ["#140", 131], "proposals[0].evidence must be a list of refs from the evidence"],
  ])("refuses a proposal whose %s is %j", (field, value, error) => {
    expect(refusal(aCheck({ [field]: value }))).toEqual([error]);
  });

  it.each([
    ["a proposal that isn't an object", { proposals: ["Lint the SQL"] }, "proposals[0] must be an object"],
    ["proposals that aren't a list", { proposals: { title: "Lint the SQL" } }, "proposals must be a list"],
    ["no proposals", {}, "proposals must be a list"],
    ["a reply that isn't an object", [], "Retro output must be a JSON object"],
  ])("refuses %s", (_case, value, error) => {
    expect(reply(value)).toEqual({ ok: false, errors: [error] });
  });

  it("refuses a reply that isn't JSON", () => {
    expect(parseRetroOutput("Nothing to propose this week.")).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^Retro output is not valid JSON: /)],
    });
  });

  it.each(["product-trust-root", "kit", "extra-skill"])(
    "refuses a mechanical proposal that targets %s: a check lives in the Product repo's own code, never as text",
    (target) => {
      const proposal = aCheck({ target, ...(target === "extra-skill" ? { skill: "event-storming" } : {}) });
      expect(refusal(proposal)).toEqual([`proposals[0] is mechanical, so its target must be product-code, not "${target}"`]);
    },
  );

  it("reads a judgement proposal on any target", () => {
    const targets = ["product-trust-root", "product-code", "kit"].map((target) => aCheck({ kind: "judgement", target }));
    expect(reply({ proposals: targets })).toMatchObject({ ok: true });
  });

  describe("a loosening carries its streak and what it undoes, and a tightening carries neither", () => {
    const NEEDS_STREAK =
      "proposals[0].streak must hold the merged agent PRs counted, at least one, and the kind they share: a loosening rests on a streak";
    const NEEDS_UNDOES = "proposals[0].undoes must name the From retro issue or Retro proposal a loosening relaxes";

    it.each([
      ["no streak", { streak: undefined }, NEEDS_STREAK],
      ["a null streak", { streak: null }, NEEDS_STREAK],
      ["a streak in words only", { streak: "the 30 docs-only PRs since #88" }, NEEDS_STREAK],
      ["a streak with no PRs", { streak: { pullRequests: [], kind: "docs-only PRs" } }, NEEDS_STREAK],
      ["a streak naming PRs as text", { streak: { pullRequests: ["#101"], kind: "docs-only PRs" } }, NEEDS_STREAK],
      ["a streak with no kind", { streak: { pullRequests: [101, 102] } }, NEEDS_STREAK],
      ["no undoes", { undoes: undefined }, NEEDS_UNDOES],
      ["an empty undoes", { undoes: "" }, NEEDS_UNDOES],
    ])("refuses a loosening with %s", (_case, overrides, error) => {
      expect(refusal(aLoosening(overrides))).toEqual([error]);
    });

    it.each([
      ["a streak", { streak: { pullRequests: [101, 102], kind: "docs-only PRs" } }, "proposals[0].streak is only for a loosening"],
      ["an undoes", { undoes: "#88" }, "proposals[0].undoes is only for a loosening"],
    ])("refuses a tightening with %s", (_case, overrides, error) => {
      expect(refusal(aCheck(overrides))).toEqual([error]);
    });

    it("reads a tightening that writes its streak and undoes as null", () => {
      expect(reply({ proposals: [aCheck({ streak: null, undoes: null })] })).toEqual({
        ok: true,
        output: { proposals: [{ ...aCheck(), skill: null }] },
      });
    });
  });

  describe("an Extra skill's proposal names its skill, and no other proposal names one", () => {
    const skillProposal = (overrides: Record<string, unknown> = {}) =>
      aCheck({ kind: "judgement", target: "extra-skill", skill: "event-storming", ...overrides });

    it.each([
      ["no skill", { skill: undefined }],
      ["a null skill", { skill: null }],
      ["an empty skill", { skill: " " }],
      ["a skill that isn't a name", { skill: ["event-storming"] }],
    ])("refuses an extra-skill proposal with %s", (_case, overrides) => {
      expect(refusal(skillProposal(overrides))).toEqual(["proposals[0].skill must name the Extra skill an extra-skill proposal changes"]);
    });

    it.each(["product-trust-root", "product-code", "kit"])("refuses a skill on a proposal that targets %s", (target) => {
      expect(refusal(aCheck({ kind: "judgement", target, skill: "event-storming" }))).toEqual([
        `proposals[0].skill is only for an extra-skill proposal, not one that targets "${target}"`,
      ]);
    });

    it("reads a proposal that targets the Kit with its skill written as null", () => {
      expect(reply({ proposals: [aCheck({ kind: "judgement", target: "kit", skill: null })] })).toMatchObject({
        ok: true,
        output: { proposals: [{ target: "kit", skill: null }] },
      });
    });
  });
});
