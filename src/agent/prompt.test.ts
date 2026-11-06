import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG, type KitConfig } from "../kit/config.ts";
import { extraSkillsLine, promptFor } from "./prompt.ts";
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
});
