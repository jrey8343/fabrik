// Small builders for the core's tests: say only what a test cares about.
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { IssueSnapshot, KitConfig, Snapshot } from "../loop/types.ts";

/** An issue with these labels and this parent; everything else is plain. */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    author: "someone",
    labels: [],
    parent: null,
    openPullRequests: [],
    ...overrides,
  };
}

/** A snapshot of this issue, in a repo whose Operator is @the-operator unless the test says otherwise. */
export function snapshotOf(issue: IssueSnapshot, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return { issue, operator: "the-operator", ...overrides };
}

/** A Kit config with every v1 default, as a Product repo with no .fabrik/config.json gets. */
export function kitConfig(): KitConfig {
  return DEFAULT_KIT_CONFIG;
}
