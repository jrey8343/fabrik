// Starting an AFK role's agent run, on the model, effort and timeout its Kit config gives it.
import type { AgentRole, KitConfig, Plan } from "./types.ts";

export function startAgentRun(role: AgentRole, issueNumber: number, config: KitConfig): Extract<Plan, { kind: "act" }> {
  const { model, effort, timeoutMinutes } = config.roles[role];
  return {
    kind: "act",
    actions: [{ kind: "start-agent-run", role, issue: issueNumber, model, effort, timeoutMinutes }],
  };
}
