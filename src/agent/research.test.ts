import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESEARCH_SECTIONS, researchContext } from "./research.ts";

const decision = {
  number: 42,
  title: "Which payment provider takes group bookings?",
  body: "## Question\n\nCan one payment cover every seat in a group class?",
  author: { login: "operator" },
  labels: [{ name: "wayfinder:research" }],
  comments: [],
};

const map = {
  number: 12,
  title: "Let patients book group classes",
  body: "## Destination\n\nA Spec for group class booking.\n\n## Notes\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n",
};

/** The spec.json the agent-inputs step writes: the issue's parent, for a Decision its Map. */
async function mapFileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-research-")), "spec.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("A Researcher run's context", () => {
  it("sets out the Decision's Map, then the one findings file the Kit names from the Decision's number and title", async () => {
    const { findingsPath, parts } = await researchContext(await mapFileOf(map), decision);

    expect(findingsPath).toBe("docs/research/42-which-payment-provider-takes-group-bookings.md");
    expect(parts).toEqual([
      `## ${RESEARCH_SECTIONS.map}`,
      "```json",
      JSON.stringify(map, null, 2),
      "```",
      `## ${RESEARCH_SECTIONS.findingsFile}`,
      "Write your findings to `docs/research/42-which-payment-provider-takes-group-bookings.md`, from the repo root, and change no other file.",
    ]);
  });

  it.each([
    ["no Map, as for an issue with no parent", null],
    ["a Map with no body", { number: 12, title: "Let patients book group classes" }],
    ["a Map with no number", { title: "Let patients book group classes", body: "## Destination" }],
  ])("refuses %s, so the run fails rather than researches out of context", async (_, broken) => {
    await expect(researchContext(await mapFileOf(broken), decision)).rejects.toThrow(/Map/);
  });

  it.each([
    ["no number", { ...decision, number: undefined }],
    ["no title", { ...decision, title: undefined }],
  ])("refuses a Decision with %s, which its findings file is named from", async (_, broken) => {
    await expect(researchContext(await mapFileOf(map), broken)).rejects.toThrow(/Decision/);
  });
});
