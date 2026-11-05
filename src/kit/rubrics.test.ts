import { describe, expect, it } from "vitest";
import { loadRubrics, RUBRIC_HASHES, readRubric, rubricContentHash, rubricSet, rubricVersionErrors } from "./rubrics.ts";

/** A rubric file, with whatever front-matter lines the case changes. */
function rubricFile(fields: Record<string, string> = {}, text = "Judge the run.\n\n- `clean`: nothing wasted.\n- `slow`: time wasted.\n"): string {
  const header = { name: "efficiency", version: "2", threshold: "0.7", labels: "[clean, slow]", ...fields };
  const lines = Object.entries(header).map(([key, value]) => `${key}: ${value}`);
  return ["---", ...lines, "---", "", text].join("\n");
}

describe("A rubric file", () => {
  it("reads as the rubric's name, version, pass threshold, labels and text", () => {
    expect(readRubric(rubricFile())).toEqual({
      name: "efficiency",
      version: 2,
      threshold: 0.7,
      labels: ["clean", "slow"],
      text: "Judge the run.\n\n- `clean`: nothing wasted.\n- `slow`: time wasted.",
    });
  });

  it.each([
    ["a name that isn't lowercase words joined by hyphens", rubricFile({ name: "Efficiency" }), /name/],
    ["a version of 0", rubricFile({ version: "0" }), /version/],
    ["a version that isn't a whole number", rubricFile({ version: "1.5" }), /version/],
    ["a threshold above 1", rubricFile({ threshold: "1.2" }), /threshold/],
    ["a threshold below 0", rubricFile({ threshold: "-0.1" }), /threshold/],
    ["a threshold that isn't a number", rubricFile({ threshold: "high" }), /threshold/],
    ["no labels", rubricFile({ labels: "[]" }), /labels/],
    ["a label listed twice", rubricFile({ labels: "[clean, clean]" }), /labels/],
    ["labels that aren't a [list]", rubricFile({ labels: "clean, slow" }), /labels/],
    ["a label that isn't lowercase words joined by hyphens", rubricFile({ labels: "[clean, Sandbox fight]" }), /labels/],
    ["a field the Kit doesn't know", rubricFile({ model: "sonnet" }), /model/],
    ["no rubric text", rubricFile({}, "\n"), /text/],
  ])("is refused with %s", (_, text, problem) => {
    expect(() => readRubric(text, "prompts/scorers/efficiency.md")).toThrow(problem);
  });

  it.each([
    ["no front matter", "Judge the run.\n"],
    ["no name", rubricFile().replace("name: efficiency\n", "")],
    ["no threshold", rubricFile().replace("threshold: 0.7\n", "")],
  ])("is refused with %s, naming the file", (_, text) => {
    expect(() => readRubric(text, "prompts/scorers/efficiency.md")).toThrow("prompts/scorers/efficiency.md");
  });
});

describe("The Kit's Scorer rubrics", () => {
  it("are Efficiency, Ticket compliance and Skill use, each with a version, a pass threshold, its labels and its text", async () => {
    const rubrics = await loadRubrics();
    expect(rubrics.map((rubric) => rubric.name)).toEqual(["efficiency", "ticket-compliance", "skill-use"]);
    for (const rubric of rubrics) {
      expect(Number.isInteger(rubric.version) && rubric.version >= 1).toBe(true);
      expect(rubric.threshold).toBeGreaterThanOrEqual(0);
      expect(rubric.threshold).toBeLessThanOrEqual(1);
      expect(rubric.labels.length).toBeGreaterThan(1);
      expect(rubric.text.trim()).not.toBe("");
    }
  });

  it("each judge the run's transcript, never the code it wrote, which the Reviewer's Verdict judges", async () => {
    for (const rubric of await loadRubrics()) {
      expect(rubric.text).toContain("Judge the run's transcript");
      expect(rubric.text).toContain("the Reviewer's Verdict does that");
    }
  });

  it("each explain every label they list, so the judge knows when to give it", async () => {
    for (const rubric of await loadRubrics()) {
      for (const label of rubric.labels) expect(rubric.text).toContain(`- \`${label}\`: `);
    }
  });

  it("give Efficiency the labels clean, repeated calls, re-reads, dead-end loop and Sandbox fight", async () => {
    const [efficiency] = await loadRubrics();
    expect(efficiency?.labels).toEqual(["clean", "repeated-calls", "re-reads", "dead-end-loop", "sandbox-fight"]);
  });
});

describe("The rubric set", () => {
  const rubrics = [
    { name: "efficiency", version: 1 },
    { name: "ticket-compliance", version: 3 },
    { name: "skill-use", version: 2 },
  ];

  it("names each rubric's name and version, with a short hash of them that's safe in a file name", () => {
    const set = rubricSet(rubrics);
    expect(set.pairs).toEqual(["efficiency@1", "ticket-compliance@3", "skill-use@2"]);
    expect(set.hash).toMatch(/^[0-9a-f]{7}$/);
  });

  it("has a new hash when any rubric's version changes", () => {
    const bumped = rubrics.map((rubric) => (rubric.name === "skill-use" ? { ...rubric, version: 3 } : rubric));
    expect(rubricSet(bumped).hash).not.toBe(rubricSet(rubrics).hash);
  });

  it("has the same hash whatever order its rubrics come in", () => {
    expect(rubricSet([...rubrics].reverse()).hash).toBe(rubricSet(rubrics).hash);
  });
});

describe("The rubric version guard", () => {
  const rubric = readRubric(rubricFile({ version: "1" }));
  const recorded = { "efficiency@1": rubricContentHash(rubric) };

  it("passes a rubric that is what was recorded for its version", () => {
    expect(rubricVersionErrors([rubric], recorded)).toEqual([]);
  });

  it.each([
    ["its text", { ...rubric, text: `${rubric.text}\n- \`stuck\`: going nowhere.` }],
    ["its threshold", { ...rubric, threshold: 0.6 }],
    ["its labels", { ...rubric, labels: [...rubric.labels, "stuck"] }],
  ])("fails a rubric whose %s changed without a version bump, telling the editor to bump it and what to record", (_, changed) => {
    expect(rubricVersionErrors([changed], recorded)).toEqual([expect.stringMatching(/^efficiency@1 .*bump its version.*"efficiency@2": "[0-9a-f]{64}"/)]);
  });

  it("fails a bumped version until its hash is recorded, giving the line to record", () => {
    const bumped = { ...rubric, version: 2, threshold: 0.6 };
    expect(rubricVersionErrors([bumped], recorded)).toEqual([expect.stringContaining(`"efficiency@2": "${rubricContentHash(bumped)}"`)]);
    expect(rubricVersionErrors([bumped], { ...recorded, "efficiency@2": rubricContentHash(bumped) })).toEqual([]);
  });

  it("passes the Kit's rubrics against the hashes the Kit recorded for their versions", async () => {
    expect(rubricVersionErrors(await loadRubrics(), RUBRIC_HASHES)).toEqual([]);
  });
});
