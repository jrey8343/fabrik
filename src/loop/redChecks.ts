// The red Required checks on a head, as a Verdict and the Reviewer's prompt
// carry them: each check under its name with its Failure excerpt (#775), an
// outside service's what it wrote to GitHub (#777), and, for one that failed
// again, its first attempt (#776), grouped by what its attempts came to
// (failed again on the Kit's re-run; outside, so not re-run; not re-run, and
// why). Pure.
import { type CheckExcerpt, renderFailureExcerpts } from "../review/failureExcerpt.ts";
import { withoutMentions } from "./mentions.ts";
import { checkCode } from "./flakyChecks.ts";
import type { RedChecksOnMain, RedRequiredChecks } from "./types.ts";

/** Why a red check has no Failure excerpt: the Review's jobs passed out none for it, as when their artifact is missing. */
export const NO_EXCERPT = "the Review checks job passed out no Failure excerpt for it";

/** The checks in each group, in the order the wait read them. */
function redChecksGrouped({ failed, rerun }: Pick<RedRequiredChecks, "failed" | "rerun">): {
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
 * The red checks, each group under the heading of what its attempts came to,
 * each check its Failure excerpt's list item, and one with no excerpt saying
 * its failure couldn't be read. Under each check's name come `notesOf` its
 * paragraphs, such as the Reviewer's judgment of it (#780). The excerpts take
 * what's left of `room` around them.
 */
export function redChecksText(
  red: RedRequiredChecks,
  room = Number.POSITIVE_INFINITY,
  notesOf: (check: string) => readonly string[] = () => [],
): string {
  const { again, outside, plain } = redChecksGrouped(red);
  const excerpts = [...again, ...outside, ...plain].map(
    (name): CheckExcerpt => red.excerpts.find(({ check }) => check === name) ?? { kind: "unread", check: name, link: "", why: NO_EXCERPT },
  );
  const refused = red.rerun?.refused ?? null;
  const plainHeading = refused === null ? "These failed:" : `The Kit didn't re-run these: ${withoutMentions(refused.trim().replace(/\.$/, ""))}.`;
  const text = (blocks: readonly string[]) => {
    const blockOf = (name: string) =>
      withNotes(blocks[excerpts.findIndex(({ check }) => check === name)]!, [...notesOf(name), ...(red.onMain === undefined ? [] : [onMainLine(red.onMain, name)])]);
    // Each check is a list item of paragraphs, so a blank line parts them.
    const listed = (heading: string, items: readonly string[]) => (items.length === 0 ? [] : [[heading, "", items.join("\n\n")].join("\n")]);
    return [
      ...listed("These failed again when the Kit re-ran them on the same head:", again.map(blockOf)),
      ...listed("These aren't GitHub Actions, so the Kit couldn't re-run them:", outside.map(blockOf)),
      ...listed(plainHeading, plain.map(blockOf)),
    ].join("\n\n");
  };
  // The excerpts take what's left of the room around them, the blank lines between them counted.
  const around = text(excerpts.map(() => "")).length;
  return text(renderFailureExcerpts(excerpts, { room: room - around + 2 * Math.max(excerpts.length - 1, 0) }));
}

/**
 * What a red check came to on the default branch's head (#780), for the
 * Reviewer to weigh: passed, failed with its link, still running, or not run
 * there; or why that couldn't be read.
 */
function onMainLine(onMain: RedChecksOnMain, name: string): string {
  if (onMain.kind === "unread") return `Its result on the default branch's head couldn't be read: ${withoutMentions(onMain.why.trim().replace(/\.$/, ""))}.`;
  const check = onMain.checks.find((each) => each.name === name);
  const result =
    check === undefined || check.is === "never-reported"
      ? "it didn't run there"
      : check.is === "passed"
        ? "it passed"
        : check.is === "running"
          ? "it's still running"
          : `it failed${check.url === null ? "" : ` ([the job](${check.url}))`}`;
  return `On ${checkCode(onMain.branch)}'s head, ${onMain.sha.slice(0, 7)}: ${result}.`;
}

/** What the Review checks job passed out of the red checks' results on the default branch's head (#780), as its `main` output; unread with why when it passed out none that reads. */
export function redChecksOnMainOf(text: string | undefined): RedChecksOnMain {
  const none: RedChecksOnMain = { kind: "unread", why: "the Review checks job passed out none" };
  let value: unknown;
  try {
    value = JSON.parse(text === undefined || text === "" ? "null" : text);
  } catch {
    return none;
  }
  if (typeof value !== "object" || value === null) return none;
  const { kind, why, branch, sha, checks } = value as Record<string, unknown>;
  if (kind === "unread" && typeof why === "string") return { kind, why };
  if (kind !== "read" || typeof branch !== "string" || typeof sha !== "string" || !Array.isArray(checks)) return none;
  type Read = Extract<RedChecksOnMain, { kind: "read" }>["checks"][number];
  const read = checks.flatMap((check: unknown): Read[] => {
    if (typeof check !== "object" || check === null) return [];
    const { name, is, url } = check as Record<string, unknown>;
    if (typeof name !== "string" || (is !== "passed" && is !== "failing" && is !== "running" && is !== "never-reported")) return [];
    return [{ name, is, url: typeof url === "string" ? url : null }];
  });
  return { kind, branch, sha, checks: read };
}

/** A check's list item with these paragraphs under its first line, its name, indented to stay in the item. */
function withNotes(block: string, notes: readonly string[]): string {
  if (notes.length === 0) return block;
  const newline = block.indexOf("\n");
  const [head, rest] = newline === -1 ? [block, ""] : [block.slice(0, newline), block.slice(newline)];
  return [head, ...notes.map((note) => `  ${note}`)].join("\n\n") + rest;
}
