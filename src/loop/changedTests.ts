// Changed existing tests (#463): the test files an agent PR's Implement runs
// changed that were already there before the run that changed them, which
// the push job reads from the run's own commits (src/github/branch.ts). The
// PR body lists them in a section the Kit writes after the Implementer's
// summary, closed by a marker the PR snapshot reads back, so a later run's
// list adds to it; and the Reviewer is pointed at each one, since a run that
// loosens an assertion can turn red checks green. Pure, no I/O.
import { code } from "../evidence/uiEvidence.ts";

/** The file names a test takes: `*.test.*`, `*.spec.*`, `*_test.*` and `test_*.*`. */
const TEST_NAMES: readonly RegExp[] = [/^.+\.test\..+$/, /^.+\.spec\..+$/, /^.+_test\..+$/, /^test_.+\..+$/];

/** The folders everything under which is a test's, at any depth. */
const TEST_FOLDERS: readonly string[] = ["test", "tests", "__tests__"];

/** Whether a repo path is a test's, by the Kit's fixed list of test-path conventions. */
export function isTestPath(path: string): boolean {
  const folders = path.split("/");
  const name = folders.pop() ?? "";
  return TEST_NAMES.some((pattern) => pattern.test(name)) || folders.some((folder) => TEST_FOLDERS.includes(folder));
}

/** The hidden line the section opens with, so it can be found and dropped whole. */
const SECTION_START = "<!-- fabrik:changed-tests-start -->";

/** The section's heading, which the Reviewer's block shares. */
const HEADING = "## Changed existing tests";

/**
 * The Changed existing tests section of an agent PR's body, or null when
 * there are none, so a PR whose runs changed no existing test reads as it
 * always did. Its paths may be agent-made, so each shows as code on one line,
 * and its marker escapes `<` and `>`, so no path can close it early.
 */
export function changedTestsSection(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const marker = JSON.stringify(paths).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return [
    SECTION_START,
    HEADING,
    "",
    "The Implementer's commits changed these test files, which were already there before the run that changed them. The summary above should say why.",
    "",
    ...paths.map((path) => `- ${code(path)}`),
    `<!-- fabrik:changed-tests ${marker} -->`,
  ].join("\n");
}

/** The marker line, matched against a whole line with its outer whitespace trimmed. */
const MARKER = /^<!-- fabrik:changed-tests (\[.*\]) -->$/;

/**
 * The changed existing tests the marker in this body lists, or none. Read only
 * from a body the Fabrik App wrote: the last marker counts, the section being
 * Kit text after the Implementer's summary, and one that doesn't read is none.
 */
export function changedTestsIn(body: string): string[] {
  const lists = body.split("\n").flatMap((line) => {
    const list = listOf(MARKER.exec(line.trim())?.[1]);
    return list === null ? [] : [list];
  });
  return lists.at(-1) ?? [];
}

function listOf(json: string | undefined): string[] | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return Array.isArray(value) && value.every((path) => typeof path === "string" && path !== "") ? value : null;
}

/** Each path once, the earlier list's first, in the order each was first named. */
export function together(earlier: readonly string[], later: readonly string[]): string[] {
  return [...new Set([...earlier, ...later])];
}

/** A line that looks like one of the section's hidden lines, spaced or spelled near enough to pass for one. */
const HIDDEN_LINE = /^<!--\s*fabrik:changed-tests\b.*-->$/;

const SECTION_START_LINE = /^<!--\s*fabrik:changed-tests-start\s*-->$/;

/**
 * The text without any Changed existing tests section, from its start line
 * through the marker after it, nor any other line that looks like one of its
 * hidden lines, as withoutEvidence drops the UI evidence's. Run on agent text, so no agent can forge a list or carry an
 * old one forward.
 */
export function withoutChangedTests(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (!HIDDEN_LINE.test(line.trim())) {
      kept.push(line);
      continue;
    }
    // A start line opens a section through the marker after it; with no marker after it, it goes alone.
    const end = SECTION_START_LINE.test(line.trim())
      ? lines.findIndex((each, i) => i > at && HIDDEN_LINE.test(each.trim()) && !SECTION_START_LINE.test(each.trim()))
      : -1;
    if (end !== -1) at = end;
    // Each with the blank lines that set it apart.
    while (at + 1 < lines.length && isBlank(lines[at + 1])) at++;
    if (at === lines.length - 1) while (kept.length > 0 && isBlank(kept.at(-1))) kept.pop();
  }
  return kept.join("\n");
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

/**
 * The Reviewer's block for a PR whose Implement runs changed existing tests,
 * or nothing when they changed none, so its prompt reads as it always did: the
 * list, and the rule for judging each change.
 */
export function reviewerChangedTestsBlock(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return [
    HEADING,
    "The Implementer's commits on this PR changed these test files, which were already there before the run that changed them:",
    "",
    ...paths.map((path) => `- ${code(path)}`),
    "",
    "Judge each change to an existing test on its merits, against the Ticket: a test the Ticket's change makes wrong should change, but a test changed only to pass is not. An assertion weakened or removed without a reason in the PR body is an `execution-flaw`.",
  ];
}
