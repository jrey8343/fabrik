// An AFK role's prompt: the Kit's prompt for the role, the line naming its
// Extra skills (if it has any), the Product's instructions for the role, then
// the issue thread and anything else the role is given. Pure, no I/O.
import { type ExtraSkill, type InstructedRole, isPhase, type KitConfig, type Phase } from "../kit/config.ts";

/** `a`, `a` and `b`, or `a`, `b` and `c`. */
function listed(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  const last = quoted.pop() ?? "";
  return quoted.length === 0 ? last : `${quoted.join(", ")} and ${last}`;
}

/**
 * The fixed Kit line telling a role which Extra skills it has, or null when it
 * has none. When to use them is the Operator's call, in .fabrik/<phase>.md.
 */
export function extraSkillsLine(phase: Phase, skills: readonly ExtraSkill[]): string | null {
  if (skills.length === 0) return null;
  const one = skills.length === 1;
  return `This repo gives you the Extra skill${one ? "" : "s"} ${listed(skills.map((skill) => skill.name))}, installed in \`.claude/skills/\`; this repo's ${phase} instructions say when to use ${one ? "it" : "them"}.`;
}

/** What one AFK role's prompt is built from. */
export interface PromptParts {
  /** The Kit's prompt for the role, from prompts/<role>.md. */
  readonly template: string;
  /**
   * The role, which names its .fabrik/<role>.md instructions; a Step-up run is
   * an implement run. Every role but the Auditor is also a Kit config phase.
   */
  readonly role: InstructedRole;
  /** How the Product's own instructions for this role relate to the Kit's prompt. */
  readonly note: string;
  readonly config: KitConfig;
  readonly issue: unknown;
  /** The heading over the issue. */
  readonly heading: string;
  /** Anything else the role is given, after the issue. */
  readonly extra: readonly string[];
}

/**
 * The Kit's prompt for the role, then the line naming its Extra skills, then
 * the Product's instructions for the role, then the issue thread, then
 * anything else the role is given. The Auditor and the Retro take no Extra skills (ADR-0008).
 */
export function promptFor({ template, role, note, config, issue, heading, extra }: PromptParts): string {
  const parts = [template.trimEnd()];
  const skills = isPhase(role) ? extraSkillsLine(role, config.extraSkills[role]) : null;
  if (skills !== null) parts.push(skills);
  const instructions = config.instructions[role];
  if (instructions !== null) {
    parts.push(`## This Product repo's ${role} instructions`, note, instructions.trimEnd());
  }
  parts.push(`## ${heading}`, "```json", JSON.stringify(issue, null, 2), "```", ...extra);
  return `${parts.join("\n\n")}\n`;
}
