// Every label the Kit reads or writes (docs/agents/triage-labels.md), in one
// place: the core, the adapter and the setup skill all take them from here.

export const NEEDS_TRIAGE = "needs-triage";
export const NEEDS_INFO = "needs-info";
export const NEEDS_DESIGN = "needs-design";
export const READY_FOR_AGENT = "ready-for-agent";
export const READY_FOR_HUMAN = "ready-for-human";
export const WONTFIX = "wontfix";

/** Every label that says where an issue is in the Loop. An issue holds at most one. */
export const STATE_LABELS = [NEEDS_TRIAGE, NEEDS_INFO, NEEDS_DESIGN, READY_FOR_AGENT, READY_FOR_HUMAN, WONTFIX] as const;
export type StateLabel = (typeof STATE_LABELS)[number];

export const BUG = "bug";
export const ENHANCEMENT = "enhancement";

/** What kind of work an issue is. Triage leaves exactly one on every issue it sorts. */
export const CATEGORY_LABELS = [BUG, ENHANCEMENT] as const;
export type CategoryLabel = (typeof CATEGORY_LABELS)[number];

/**
 * The trigger label Dispatch adds to a Ticket to start an Implementer
 * (ADR-0001). On a Ticket with an open agent PR, re-adding it resumes that
 * PR's Implement run: its retry, or the Operator's Request-changes run.
 */
export const DISPATCH_LABEL = "agent:implement";

/**
 * The trigger label the Design queue check adds to a waiting `needs-design`
 * issue to start its Design session's first turn (#147), as Dispatch adds
 * agent:implement (ADR-0001). The label comes off as the turn starts.
 */
export const DESIGN_LABEL = "agent:design";

/** The trigger label on an agent PR that starts its Review, so re-adding it resumes one after a failure. */
export const REVIEW_LABEL = "agent:review";

/** The label on the Kit's token-rotation issue, by which the adapter finds it. */
export const TOKEN_ROTATION_LABEL = "fabrik:token-rotation";

/** The label on the Kit's weekly-limit issue. */
export const WEEKLY_LIMIT_LABEL = "fabrik:weekly-limit";

/**
 * The label on the Kit's usage-credits issue: with rotation on, a run was
 * killed for spending usage credits on its Subscription, which the Kit skips
 * until the Operator closes the issue.
 */
export const USAGE_CREDITS_LABEL = "fabrik:usage-credits";

/** The label on an Audit, which the scheduled tick opens for the Auditor to fill in (#150). */
export const AUDIT_LABEL = "fabrik:audit";

/** The label on a Retro, which the scheduled tick opens for the Retro run to fill in (#151). */
export const RETRO_LABEL = "fabrik:retro";

/** Every label that marks an issue as the Kit's own, so the adapter reads it into the snapshot. */
export const KIT_ISSUE_LABELS = [
  TOKEN_ROTATION_LABEL,
  WEEKLY_LIMIT_LABEL,
  USAGE_CREDITS_LABEL,
  AUDIT_LABEL,
  RETRO_LABEL,
] as const;
export type KitIssueLabel = (typeof KIT_ISSUE_LABELS)[number];

/**
 * The label on each issue the Monitor files (#148), by which it finds its own
 * issues. It isn't one of KIT_ISSUE_LABELS, so Intake still sends a Monitor
 * issue to Triage.
 */
export const MONITOR_LABEL = "fabrik:monitor";

/**
 * The label on a Map: an issue charting the way to a destination still in fog,
 * whose children are Decisions (#154). A Design session that ends in a Map puts
 * it on in place of needs-design.
 */
export const MAP_LABEL = "wayfinder:map";

/** A label the Kit itself adds or removes. Labels read from GitHub stay plain strings: anyone can add any label. */
export type Label =
  | StateLabel
  | CategoryLabel
  | typeof DISPATCH_LABEL
  | typeof DESIGN_LABEL
  | typeof REVIEW_LABEL
  | KitIssueLabel
  | typeof MONITOR_LABEL
  | typeof MAP_LABEL;

/** Every label the Kit uses, so the setup skill can create each one. */
export const ALL_LABELS: readonly Label[] = [
  ...STATE_LABELS,
  DISPATCH_LABEL,
  DESIGN_LABEL,
  REVIEW_LABEL,
  ...CATEGORY_LABELS,
  ...KIT_ISSUE_LABELS,
  MONITOR_LABEL,
];

export function isStateLabel(label: string): label is StateLabel {
  return (STATE_LABELS as readonly string[]).includes(label);
}

export function isCategoryLabel(label: string): label is CategoryLabel {
  return (CATEGORY_LABELS as readonly string[]).includes(label);
}

export function isKitIssueLabel(label: string): label is KitIssueLabel {
  return (KIT_ISSUE_LABELS as readonly string[]).includes(label);
}

/** Labels the wayfinder skill puts on the maps and tickets it creates. */
export function isWayfinderLabel(label: string): boolean {
  return label.startsWith("wayfinder:");
}
