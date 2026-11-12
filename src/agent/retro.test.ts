import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { aRetroEvidenceInput } from "../__fixtures__/retroEvidence.ts";
import { aMergedPullRequest, anEscapeMarkerIssue, aRunRecord, factsOf } from "../read/builders.ts";
import { evidenceBundle } from "../kit/retroEvidence.ts";
import { RETRO_SECTIONS, retroContext } from "./retro.ts";

/** Retro 120's bundle: escape #80 against #50 and #51, both merged in its window, and nothing else. */
const bundle = evidenceBundle(
  aRetroEvidenceInput({
    records: [aRunRecord({ runId: 1001, role: "review", pullRequest: 50, verdict: "pass", endedAt: "2026-11-01T00:00:00Z" })],
    facts: factsOf({
      pullRequests: [
        aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 }),
        aMergedPullRequest("2026-11-03T00:00:00Z", { number: 51, ticket: 8 }),
      ],
      escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->", { number: 80 })],
    }),
  }),
);

/** The Kit's role prompts and rubrics, by their paths in the Kit. */
const KIT_FILES: Readonly<Record<string, string>> = {
  "prompts/triage.md": "You run Triage.\n",
  "prompts/design.md": "You run the Design session.\n",
  "prompts/implement.md": "You are the Implementer.\n",
  "prompts/review.md": "You are the Reviewer.\n",
  "prompts/audit.md": "You are the Auditor.\n",
  "prompts/retro.md": "You run the Retro.\n",
  "prompts/research.md": "You are the Researcher.\n",
  "prompts/prototype.md": "You take a Design session's prototype turn.\n",
  "prompts/scorers/efficiency.md": "---\nname: efficiency\n---\nScore how directly the run worked.\n",
  "prompts/scorers/ticket-compliance.md": "---\nname: ticket-compliance\n---\nScore how closely it kept to its Ticket.\n",
  "prompts/scorers/skill-use.md": "---\nname: skill-use\n---\nScore how it used its skills.\n",
};

async function aKitWith(files: Readonly<Record<string, string>>): Promise<string> {
  const kit = await mkdtemp(join(tmpdir(), "fabrik-kit-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(kit, path)), { recursive: true });
    await writeFile(join(kit, path), text);
  }
  return kit;
}

async function evidenceFileOf(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-retro-evidence-")), "evidence.json");
  await writeFile(path, text);
  return path;
}

describe("A Retro run's context", () => {
  it("sets out each part of the evidence under its own heading, one item to a line, then the Kit's role prompts and rubrics, each under its path in the Kit", async () => {
    const parts = await retroContext(await evidenceFileOf(JSON.stringify(bundle)), await aKitWith(KIT_FILES));

    const [escape] = bundle.escapes;
    const [first, second] = bundle.streakTable;
    expect(escape?.ref).toBe("#80");
    expect([first?.ref, second?.ref]).toEqual(["#50", "#51"]);
    expect(parts).toEqual([
      `## ${RETRO_SECTIONS.window}`,
      "```json",
      '{"start":"2026-10-31T00:00:00.000Z","end":"2026-11-07T00:00:00.000Z"}',
      "```",
      `## ${RETRO_SECTIONS.escapes}`,
      "```json",
      `[\n${JSON.stringify(escape)}\n]`,
      "```",
      `## ${RETRO_SECTIONS.feedback}`,
      "```json",
      "[]",
      "```",
      `## ${RETRO_SECTIONS.followUps}`,
      "```json",
      "[]",
      "```",
      `## ${RETRO_SECTIONS.lowScores}`,
      "```json",
      "[]",
      "```",
      `## ${RETRO_SECTIONS.sample}`,
      "```json",
      "[]",
      "```",
      `## ${RETRO_SECTIONS.streaks}`,
      "```json",
      `[\n${JSON.stringify(first)},\n${JSON.stringify(second)}\n]`,
      "```",
      `## ${RETRO_SECTIONS.closedRetros}`,
      "```json",
      `[\n${JSON.stringify(bundle.history.retros[0])}\n]`,
      "```",
      `## ${RETRO_SECTIONS.filedProposals}`,
      "```json",
      "[]",
      "```",
      `## ${RETRO_SECTIONS.kit}`,
      ...Object.entries(KIT_FILES).flatMap(([path, text]) => [`### ${path}`, "```markdown", text.trimEnd(), "```"]),
    ]);
  });

  // A proposal to change a prompt quotes it from here, so a fence inside one mustn't end the quote early.
  it("quotes a Kit prompt that holds a code fence in a longer fence, so it stays whole", async () => {
    const review = "You are the Reviewer.\n\n```ts\nconst verdict = 'pass';\n```\n";

    const parts = await retroContext(await evidenceFileOf(JSON.stringify(bundle)), await aKitWith({ ...KIT_FILES, "prompts/review.md": review }));

    const at = parts.indexOf("### prompts/review.md");
    expect(parts.slice(at, at + 4)).toEqual(["### prompts/review.md", "````markdown", review.trimEnd(), "````"]);
  });

  it.each([
    ["isn't JSON", "{"],
    ["has no window", JSON.stringify({ ...bundle, window: undefined })],
    ["has no streak table", JSON.stringify({ ...bundle, streakTable: undefined })],
    ["has no history", JSON.stringify({ ...bundle, history: undefined })],
  ])("refuses evidence that %s, so the run fails rather than proposes blind", async (_, text) => {
    await expect(retroContext(await evidenceFileOf(text), await aKitWith(KIT_FILES))).rejects.toThrow(/evidence\.json/);
  });

  it("fails when the Kit checkout is missing a role prompt or rubric it quotes", async () => {
    const { "prompts/scorers/skill-use.md": _, ...rest } = KIT_FILES;

    await expect(retroContext(await evidenceFileOf(JSON.stringify(bundle)), await aKitWith(rest))).rejects.toThrow(/skill-use\.md/);
  });
});
