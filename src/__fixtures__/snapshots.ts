// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { IssueSnapshot, KitConfig, Snapshot } from "../loop/types.ts";

/** An issue with these labels and this parent; everything else is plain. */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    open: true,
    author: "someone",
    labels: [],
    parent: null,
    openPullRequests: [],
    designRounds: 0,
    ...overrides,
  };
}

/** A snapshot of this issue in a repo the Operator (by default `operator`) runs. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, operator: "operator", ...overrides };
}

/** A Kit config with every v1 default, as a Product repo with no .fabrik/config.json gets. */
export function kitConfig(): KitConfig {
  return DEFAULT_KIT_CONFIG;
}
