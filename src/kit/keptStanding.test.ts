import { describe, expect, it } from "vitest";
import { A_SCHEMA_1_BLOCKED, KEPT_STANDINGS, SCHEMA_1_NAMES, THAT_BLOCKED_AT_SCHEMA_2, THE_SAME_AT_SCHEMAS_1_AND_2 } from "./keptStandings.fixture.ts";
import { type Standing, STANDING_SCHEMA, standingAt } from "./standing.ts";
import { newerStandingSchemaOf, readStanding } from "./keptStanding.ts";
import { wordStanding } from "./standingWording.ts";

const NOW = "2026-11-09T00:00:00Z";

describe("a kept Standing read back", () => {
  describe("of schema 1, blocked", () => {
    it("names each Blocker by the Standing's own repo, in the order the current schema keeps them, with none hidden", () => {
      const read = readStanding(A_SCHEMA_1_BLOCKED);

      expect(read).toEqual({
        ...A_SCHEMA_1_BLOCKED,
        schema: 2,
        detail: {
          blockers: [
            { repo: "acme/shop", number: 7 },
            { repo: "acme/shop", number: 9 },
          ],
          hiddenBlockers: 0,
        },
      });
      expect(wordStanding(read!, NOW, "UTC").sentence).toBe("Blocked by #7 and #9.");
    });

    it("keeps a joined Pairing session's pull request and the head in its detail", () => {
      const head = "h".repeat(40);
      const joined = { ...A_SCHEMA_1_BLOCKED, pullRequest: 60, detail: { blockers: [9], pullRequest: "waiting-on-checks", head } };

      expect(readStanding(joined)).toEqual({
        ...joined,
        schema: 2,
        detail: { blockers: [{ repo: "acme/shop", number: 9 }], hiddenBlockers: 0, pullRequest: "waiting-on-checks", head },
      });
    });
  });

  describe("of schema 1, of any other name", () => {
    it("the kept Standings hold one of every name v3.4.1 could write", () => {
      expect([...THE_SAME_AT_SCHEMAS_1_AND_2.map(({ name }) => name), "blocked"].toSorted()).toEqual(SCHEMA_1_NAMES.toSorted());
    });

    it.each(THE_SAME_AT_SCHEMAS_1_AND_2.map((standing) => [standing.name, standing] as const))("a %s Standing reads as itself at schema 2", (_name, standing) => {
      const kept = JSON.parse(JSON.stringify({ ...standing, schema: 1 })) as unknown;

      expect(readStanding(kept)).toEqual({ ...standing, schema: 2 });
    });
  });

  describe("of the current schema", () => {
    it("comes back as it is", () => {
      expect(readStanding(THAT_BLOCKED_AT_SCHEMA_2)).toBe(THAT_BLOCKED_AT_SCHEMA_2);
    });

    it("reads as an equal value once written as JSON and read back", () => {
      expect(readStanding(JSON.parse(JSON.stringify(THAT_BLOCKED_AT_SCHEMA_2)))).toEqual(THAT_BLOCKED_AT_SCHEMA_2);
    });
  });

  describe("of no schema the Kit knows", () => {
    it.each([
      ["a string", "blocked"],
      ["null", null],
      ["nothing", undefined],
      ["a list", [A_SCHEMA_1_BLOCKED]],
      ["a Standing with no schema", { ...A_SCHEMA_1_BLOCKED, schema: undefined }],
      ["a Standing whose schema is no integer", { ...A_SCHEMA_1_BLOCKED, schema: 1.5 }],
      ["a Standing whose schema is a string", { ...A_SCHEMA_1_BLOCKED, schema: "1" }],
      ["a Standing of schema 0", { ...A_SCHEMA_1_BLOCKED, schema: 0 }],
      ["a Standing of schema 3, a newer Kit's", { ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 }],
    ])("%s reads as null", (_what, kept) => {
      expect(readStanding(kept)).toBeNull();
    });
  });

  describe("at every schema a Standing has had", () => {
    it("the kept Standings hold some for every schema from 1 to STANDING_SCHEMA", () => {
      const schemas = Array.from({ length: STANDING_SCHEMA }, (_, index) => index + 1);

      expect(Object.keys(KEPT_STANDINGS).map(Number)).toEqual(schemas);
      for (const schema of schemas) {
        expect(KEPT_STANDINGS[schema]?.length).toBeGreaterThan(0);
        for (const kept of KEPT_STANDINGS[schema] ?? []) expect(kept).toMatchObject({ schema });
      }
    });

    it.each(Object.entries(KEPT_STANDINGS).flatMap(([schema, kept]) => kept.map((standing) => [schema, (standing as { name: string }).name, standing] as const)))(
      "a schema %s %s Standing reads at the current schema and is worded",
      (_schema, _name, kept) => {
        const read = readStanding(kept);

        expect(read).toMatchObject({ schema: STANDING_SCHEMA });
        const words = wordStanding(read!, NOW, "UTC");
        expect(words.pill).toEqual(expect.any(String));
        expect(words.sentence).toEqual(expect.any(String));
        expect(words.sentence).not.toContain("undefined");
      },
    );
  });
});

describe("the schema of a newer Kit's Standing", () => {
  it("is given for a Standing of a schema past the Kit's", () => {
    expect(newerStandingSchemaOf({ ...THAT_BLOCKED_AT_SCHEMA_2, schema: 3 })).toBe(3);
  });

  it.each([
    ["a Standing of schema 1", A_SCHEMA_1_BLOCKED],
    ["a Standing of schema 2", THAT_BLOCKED_AT_SCHEMA_2],
    ["a Standing with no schema", { ...A_SCHEMA_1_BLOCKED, schema: undefined }],
    ["a Standing whose schema is no integer", { ...A_SCHEMA_1_BLOCKED, schema: 3.5 }],
    ["a string", "blocked"],
    ["null", null],
  ])("is null for %s", (_what, kept) => {
    expect(newerStandingSchemaOf(kept)).toBeNull();
  });
});

describe("a Standing of another schema, given where a kept Standing is read", () => {
  const notStarted = THE_SAME_AT_SCHEMAS_1_AND_2.find(({ name }) => name === "not-started")!;
  const READERS: readonly (readonly [string, (standing: Standing) => unknown])[] = [
    ["wordStanding", (standing) => wordStanding(standing, NOW, "UTC")],
    ["standingAt", (standing) => standingAt(standing, NOW)],
  ];

  describe.each(READERS)("%s", (_reader, read) => {
    it.each([
      ["a schema-1 blocked Standing", A_SCHEMA_1_BLOCKED, "schema 1"],
      ["a schema-1 Standing of a name schema 2 left as it was", { ...notStarted, schema: 1 }, "schema 1"],
      ["a Standing of schema 3, a newer Kit's", { ...notStarted, schema: 3 }, "schema 3"],
      ["a Standing with no schema", { ...notStarted, schema: undefined }, "no schema"],
    ])("refuses %s, naming its schema, the Kit's and readStanding", (_what, standing, itsSchema) => {
      const reading = () => read(standing as unknown as Standing);

      expect(reading).toThrow(new RegExp(`${itsSchema} .*schema 2.*readStanding`));
      expect(reading).not.toThrow(TypeError);
    });

    it("reads a schema-1 Standing once readStanding has read it", () => {
      expect(() => read(readStanding(A_SCHEMA_1_BLOCKED)!)).not.toThrow();
    });
  });
});
