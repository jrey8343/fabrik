// The Loop rules core's interface: a Loop event, a snapshot of GitHub state and
// the resolved Kit config go in; a plan comes out.

/** Something that happened in a Product repo that the Loop may act on. */
export type LoopEvent = { readonly kind: "issue-opened"; readonly issue: number };

/** An issue as the core sees it, gathered fresh by the GitHub adapter. */
export interface IssueSnapshot {
  readonly number: number;
  readonly author: string;
  readonly labels: readonly string[];
  /** The parent issue's number, or null if it isn't a sub-issue. */
  readonly parent: number | null;
}

/** The slice of GitHub state a Loop event needs to be decided. */
export interface Snapshot {
  readonly issue: IssueSnapshot;
}

/** The resolved Kit config. It grows its fields with the rules that read them. */
export type KitConfig = Readonly<Record<never, never>>;

/** One change the GitHub adapter makes on the core's behalf. */
export type Action = {
  readonly kind: "add-labels";
  readonly issue: number;
  readonly labels: readonly string[];
};

/** What the core decided: actions to apply, or nothing, with the reason why. */
export type Plan =
  | { readonly kind: "act"; readonly actions: readonly Action[] }
  | { readonly kind: "nothing"; readonly reason: string };
