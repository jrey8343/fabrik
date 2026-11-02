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

/** Labels the wayfinder skill puts on the maps and tickets it creates. */
export function isWayfinderLabel(label: string): boolean {
  return label.startsWith("wayfinder:");
}
