// Label names the Loop reads and writes (docs/agents/triage-labels.md).

/** Every label that says where an issue is in the Loop. An issue holds at most one. */
export const STATE_LABELS: readonly string[] = [
  "needs-triage",
  "needs-info",
  "needs-design",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
];

/** What kind of work an issue is. Triage leaves exactly one on every issue it sorts. */
export const CATEGORY_LABELS: readonly string[] = ["bug", "enhancement"];

/** The trigger label Dispatch adds to start an Implementer (ADR-0001). */
export const DISPATCH_LABEL = "agent:implement";

/** Labels the wayfinder skill puts on the maps and tickets it creates. */
export function isWayfinderLabel(label: string): boolean {
  return label.startsWith("wayfinder:");
}
