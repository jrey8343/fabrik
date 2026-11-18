// The red Required checks on a head, as a Verdict and the Reviewer's prompt
// carry them: each check under its name with its Failure excerpt (#775), an
// outside service's what it wrote to GitHub (#777), and, for one that failed
// again, its first attempt (#776), grouped by what its attempts came to
// (failed again on the Kit's re-run; outside, so not re-run; not re-run, and
// why). Pure.
import { type CheckExcerpt, renderFailureExcerpts } from "../review/failureExcerpt.ts";
import { withoutMentions } from "./mentions.ts";
import type { RedRequiredChecks } from "./types.ts";

/** Why a red check has no Failure excerpt: the Review's jobs passed out none for it, as when their artifact is missing. */
export const NO_EXCERPT = "the Review checks job passed out no Failure excerpt for it";

/** What each group of red checks is headed with: by what the Kit's re-run came to. */
export interface RedCheckHeadings {
  /** The checks the Kit re-ran on the same head that failed again. */
  readonly again: string;
  /** The checks that aren't GitHub Actions, which the Kit can't re-run. */
  readonly outside: string;
  /** The rest, which the Kit didn't re-run, given why when GitHub or the Kit refused (`refused`), with any lines after them. */
  readonly plain: (refused: string | null) => { readonly heading: string; readonly after?: readonly string[] };
}

/** The checks in each group, in the order the wait read them. */
export function redChecksGrouped({ failed, rerun }: Pick<RedRequiredChecks, "failed" | "rerun">): {
  readonly again: readonly string[];
  readonly outside: readonly string[];
  readonly plain: readonly string[];
} {
  // Re-run on the same head and red again (#462): no flake, so the Retry needn't wonder whether one is.
  const again = failed.filter((name) => rerun?.failedAgain.includes(name) === true);
  const outside = failed.filter((name) => rerun?.outside.includes(name) === true && !again.includes(name));
  const plain = failed.filter((name) => !again.includes(name) && !outside.includes(name));
  return { again, outside, plain };
}

/**
 * The red checks under `headings`, each group a heading and its checks, each
 * check its Failure excerpt's list item, and one with no excerpt saying its
 * failure couldn't be read. The excerpts take what's left of `room` around
 * them.
 */
export function redChecksText(red: RedRequiredChecks, headings: RedCheckHeadings, room = Number.POSITIVE_INFINITY): string {
  const { again, outside, plain } = redChecksGrouped(red);
  const excerpts = [...again, ...outside, ...plain].map(
    (name): CheckExcerpt => red.excerpts.find(({ check }) => check === name) ?? { kind: "unread", check: name, link: "", why: NO_EXCERPT },
  );
  const { heading: plainHeading, after = [] } = headings.plain(red.rerun?.refused ?? null);
  const text = (blocks: readonly string[]) => {
    const blockOf = (name: string) => blocks[excerpts.findIndex(({ check }) => check === name)]!;
    // Each check is a list item of paragraphs, so a blank line parts them.
    const listed = (heading: string, items: readonly string[], between: string, lines: readonly string[] = []) =>
      items.length === 0 ? [] : [[heading, "", items.join(between), ...lines].join("\n")];
    return [
      ...listed(headings.again, again.map(blockOf), "\n\n"),
      ...listed(headings.outside, outside.map(blockOf), "\n\n"),
      ...listed(plainHeading, plain.map(blockOf), "\n\n", after),
    ].join("\n\n");
  };
  // The excerpts take what's left of the room around them, the blank lines between them counted.
  const around = text(excerpts.map(() => "")).length;
  return text(renderFailureExcerpts(excerpts, { room: room - around + 2 * Math.max(excerpts.length - 1, 0) }));
}

/**
 * How a Reviewer's Verdict and its prompt head the red checks on a head it
 * judged (#779): by what each check's attempts came to.
 */
export const REVIEWED_RED_CHECK_HEADINGS: RedCheckHeadings = {
  again: "These failed again when the Kit re-ran them on the same head:",
  outside: "These aren't GitHub Actions, so the Kit couldn't re-run them:",
  plain: (refused) => ({ heading: refused === null ? "These failed:" : `The Kit didn't re-run these: ${withoutMentions(refused.trim().replace(/\.$/, ""))}.` }),
};
