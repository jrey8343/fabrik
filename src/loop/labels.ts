// Every label the Kit reads or writes (docs/agents/triage-labels.md), in one
// place: the core, the adapter and the setup program all take them from here.

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

/**
 * The label on a replay issue: the Operator's request for a Replay, whose body
 * names the one variable to change (#156). Unlike the Kit's other issues, the
 * Operator files it, not the App.
 */
export const REPLAY_LABEL = "fabrik:replay";

/**
 * The mark for a Stepped-up start (ADR-0014): a Design session or the
 * Operator puts it on a Ticket, and every Implement run that starts while it's
 * on is a Step-up. It isn't one of KIT_ISSUE_LABELS: a marked Ticket is a
 * Ticket like any other.
 */
export const STEP_UP_LABEL = "fabrik:step-up";

/** Every label that marks an issue as the Kit's own, so Intake leaves it alone and the adapter reads it into the snapshot. */
export const KIT_ISSUE_LABELS = [
  TOKEN_ROTATION_LABEL,
  WEEKLY_LIMIT_LABEL,
  USAGE_CREDITS_LABEL,
  AUDIT_LABEL,
  RETRO_LABEL,
  REPLAY_LABEL,
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

/** How a Decision on a Map gets resolved. Each names the `wayfinder:<type>` label the Decision carries. */
export const DECISION_TYPES = ["research", "prototype", "grilling", "task"] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
/** A Decision's label, which says how it gets resolved. A Decision carries no state or category label. */
export type DecisionLabel = `wayfinder:${DecisionType}`;

/** The label a Decision of this type carries, typed as that one label when the type is known. */
export function decisionLabel<Type extends DecisionType>(type: Type): `wayfinder:${Type}` {
  return `wayfinder:${type}`;
}

/** The label on a research Decision: one the Researcher resolves AFK, under an open Map (#154). */
export const RESEARCH_DECISION_LABEL = "wayfinder:research" satisfies DecisionLabel;

/**
 * The trigger label that starts a Researcher run on a research Decision
 * (ADR-0001), as Dispatch adds agent:implement to a Ticket. The label comes
 * off as the run starts, so re-adding it runs the Decision again (#154).
 */
export const RESEARCH_LABEL = "agent:research";

/**
 * The trigger label the scheduled tick adds to a replay issue to start its
 * next pending Ticket, both arms (#156), as Dispatch adds agent:implement
 * (ADR-0001). The label comes off as the run starts. A trigger label, not one
 * of KIT_ISSUE_LABELS.
 */
export const REPLAY_TRIGGER_LABEL = "agent:replay";

/** A label the Kit itself adds or removes. Labels read from GitHub stay plain strings: anyone can add any label. */
export type Label =
  | StateLabel
  | CategoryLabel
  | typeof DISPATCH_LABEL
  | typeof DESIGN_LABEL
  | typeof REVIEW_LABEL
  | KitIssueLabel
  | typeof MONITOR_LABEL
  | typeof MAP_LABEL
  | DecisionLabel
  | typeof RESEARCH_LABEL
  | typeof REPLAY_TRIGGER_LABEL
  | typeof STEP_UP_LABEL;

/** Every label the Kit uses, so Setup can create each one. */
export const ALL_LABELS: readonly Label[] = [
  ...STATE_LABELS,
  DISPATCH_LABEL,
  DESIGN_LABEL,
  REVIEW_LABEL,
  RESEARCH_LABEL,
  REPLAY_TRIGGER_LABEL,
  ...CATEGORY_LABELS,
  ...KIT_ISSUE_LABELS,
  MONITOR_LABEL,
  STEP_UP_LABEL,
  MAP_LABEL,
  ...DECISION_TYPES.map(decisionLabel),
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
