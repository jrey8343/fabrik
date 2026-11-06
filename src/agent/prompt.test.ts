import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "../kit/config.ts";
import { extraSkillsLine, promptFor } from "./prompt.ts";
import { RESEARCH_ISSUE_HEADING, researchContext } from "./research.ts";
import { RETRO_ISSUE_HEADING } from "./retro.ts";

describe("the prompt line naming a role's Extra skills", () => {
  it("is one line naming each Extra skill, where it is, and where to learn when to use it", () => {
    const line = extraSkillsLine("design", [
      { source: "jrey8343/skills", name: "event-storming" },
      { source: "jrey8343/skills", name: "deciders" },
    ]);
    expect(line).toBe(
      "This repo gives you the Extra skills `event-storming` and `deciders`, installed in `.claude/skills/`; this repo's design instructions say when to use them.",
    );
  });

  it("names a single Extra skill on its own", () => {
    expect(extraSkillsLine("review", [{ source: "jrey8343/skills", name: "event-storming" }])).toBe(
      "This repo gives you the Extra skill `event-storming`, installed in `.claude/skills/`; this repo's review instructions say when to use it.",
    );
  });

  it("is nothing for a role with no Extra skills", () => {
    expect(extraSkillsLine("implement", [])).toBeNull();
  });
});

describe("an AFK role's prompt", () => {
  const eventStorming = { source: "jrey8343/skills", name: "event-storming" };
  const deciders = { source: "jrey8343/skills", name: "deciders" };
  const config = (extraSkills: Partial<KitConfig["extraSkills"]>): KitConfig => ({
    ...DEFAULT_KIT_CONFIG,
    instructions: { ...DEFAULT_KIT_CONFIG.instructions, design: "Storm the events first.\n", implement: "Use Deciders.\n" },
    extraSkills: { ...DEFAULT_KIT_CONFIG.extraSkills, ...extraSkills },
  });
  const issue = { number: 7, title: "Orders" };
  const base = { note: "The Operator wrote these for this repo.", issue, heading: "The issue", extra: ["## More", "Context."] };

  it("puts the Extra skills line after the Kit's prompt and before the Product's phase instructions", () => {
    const prompt = promptFor({ ...base, template: "# The Kit's design prompt\n", role: "design", config: config({ design: [eventStorming] }) });
    expect(prompt).toBe(
      [
        "# The Kit's design prompt",
        "This repo gives you the Extra skill `event-storming`, installed in `.claude/skills/`; this repo's design instructions say when to use it.",
        "## This Product repo's design instructions",
        "The Operator wrote these for this repo.",
        "Storm the events first.",
        "## The issue",
        "```json",
        JSON.stringify(issue, null, 2),
        "```",
        "## More",
        "Context.",
      ].join("\n\n") + "\n",
    );
  });

  it("is unchanged for a role with no picks, even when other roles have some", () => {
    const prompt = promptFor({ ...base, template: "# The Kit's implement prompt\n", role: "implement", config: config({ design: [eventStorming] }) });
    expect(prompt).toBe(
      [
        "# The Kit's implement prompt",
        "## This Product repo's implement instructions",
        "The Operator wrote these for this repo.",
        "Use Deciders.",
        "## The issue",
        "```json",
        JSON.stringify(issue, null, 2),
        "```",
        "## More",
        "Context.",
      ].join("\n\n") + "\n",
    );
  });

  it("names the implement role's Extra skills in a Step-up run, which runs as an Implementer", () => {
    // A Step-up changes only the model and effort; its prompt is the implement role's.
    const prompt = promptFor({
      ...base,
      template: "# The Kit's implement prompt\n",
      role: "implement",
      config: config({ design: [eventStorming], implement: [deciders] }),
    });
    expect(prompt).toContain("the Extra skill `deciders`");
    expect(prompt).not.toContain("event-storming");
  });

  it("gives the Auditor this repo's audit instructions from .fabrik/audit.md, and no Extra skills line", () => {
    const withAudit: KitConfig = {
      ...config({ design: [eventStorming], review: [deciders] }),
      instructions: { ...DEFAULT_KIT_CONFIG.instructions, audit: "Booking first.\n" },
    };

    const prompt = promptFor({ ...base, template: "# The Kit's audit prompt\n", role: "audit", config: withAudit, heading: "The pending Audit" });

    expect(prompt).toBe(
      [
        "# The Kit's audit prompt",
        "## This Product repo's audit instructions",
        "The Operator wrote these for this repo.",
        "Booking first.",
        "## The pending Audit",
        "```json",
        JSON.stringify(issue, null, 2),
        "```",
        "## More",
        "Context.",
      ].join("\n\n") + "\n",
    );
  });

  it("gives the Retro this repo's retro instructions from .fabrik/retro.md, and no Extra skills line", () => {
    const withRetro: KitConfig = {
      ...config({ design: [eventStorming], review: [deciders] }),
      instructions: { ...DEFAULT_KIT_CONFIG.instructions, retro: "Weigh the billing escapes first.\n" },
    };

    const prompt = promptFor({ ...base, template: "# The Kit's retro prompt\n", role: "retro", config: withRetro, heading: RETRO_ISSUE_HEADING });

    expect(prompt).toBe(
      [
        "# The Kit's retro prompt",
        "## This Product repo's retro instructions",
        "The Operator wrote these for this repo.",
        "Weigh the billing escapes first.",
        "## The pending Retro",
        "```json",
        JSON.stringify(issue, null, 2),
        "```",
        "## More",
        "Context.",
      ].join("\n\n") + "\n",
    );
  });

  describe("for the Researcher", () => {
    const decision = { number: 42, title: "Which payment provider takes group bookings?", body: "## Question\n\nCan one payment cover every seat?" };
    const map = { number: 12, title: "Let patients book group classes", body: "## Destination\n\nA Spec for group class booking." };
    /** The prompt as the agent runner builds it, from the Decision and its Map as the agent-inputs step left them. */
    const researchPrompt = async (instructions: string | null) => {
      const mapFile = join(await mkdtemp(join(tmpdir(), "fabrik-research-")), "spec.json");
      await writeFile(mapFile, JSON.stringify(map));
      const withResearch: KitConfig = {
        ...config({ design: [eventStorming], review: [deciders] }),
        instructions: { ...DEFAULT_KIT_CONFIG.instructions, research: instructions },
      };
      const { parts } = await researchContext(mapFile, decision);
      return promptFor({
        ...base,
        template: "# The Kit's research prompt\n",
        role: "research",
        config: withResearch,
        issue: decision,
        heading: RESEARCH_ISSUE_HEADING,
        extra: parts,
      });
    };
    const decisionMapAndFindingsFile = [
      "## The research Decision",
      "```json",
      JSON.stringify(decision, null, 2),
      "```",
      "## The Map",
      "```json",
      JSON.stringify(map, null, 2),
      "```",
      "## The findings file",
      "Write your findings to `docs/research/42-which-payment-provider-takes-group-bookings.md`, from the repo root, and change no other file.",
    ];

    it("gives the Researcher its Decision, the Map's body and its findings file, with this repo's research instructions from .fabrik/research.md and no Extra skills line", async () => {
      expect(await researchPrompt("Prefer the payment providers' own API references.\n")).toBe(
        [
          "# The Kit's research prompt",
          "## This Product repo's research instructions",
          "The Operator wrote these for this repo.",
          "Prefer the payment providers' own API references.",
          ...decisionMapAndFindingsFile,
        ].join("\n\n") + "\n",
      );
    });

    it("leaves the research instructions out when the repo has no .fabrik/research.md", async () => {
      expect(await researchPrompt(null)).toBe(["# The Kit's research prompt", ...decisionMapAndFindingsFile].join("\n\n") + "\n");
    });
  });
});
