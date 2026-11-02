// Small builders for the core's tests: say only what a test cares about.
import type { IssueSnapshot, KitConfig, Snapshot } from "../loop/types.ts";

/** An issue with these labels and this parent; everything else is plain. */
export function anIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    author: "someone",
    labels: [],
    parent: null,
    ...overrides,
  };
}

export function snapshotOf(issue: IssueSnapshot): Snapshot {
  return { issue };
}

export function kitConfig(): KitConfig {
  return {};
}
