// A Blocker (GLOSSARY.md): an issue, in any repo, that holds another piece of
// work by a blocked-by edge, while it is open or once it closed as not planned
// (ADR-0001, amended in #98 and #771). This module holds how a Blocker is
// named and listed, the same in Dispatch's reasons, a Standing's sentence and
// a Design session's closing comments. Which edges are Blockers is read from
// GitHub's answer in src/github/blockers.ts, the one rule every reader uses.

/** An issue by its repo, `owner/name`, set for an issue in the same repo too, and its number. */
export interface IssueRef {
  readonly repo: string;
  readonly number: number;
}

/** Whether these name the same repo: GitHub's repo names are case-insensitive. */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Each issue once, by repo, then number. */
export function inBlockerOrder<R extends IssueRef>(refs: readonly R[]): R[] {
  const seen = new Set<string>();
  return refs
    .filter((ref) => {
      const key = `${ref.repo.toLowerCase()}#${ref.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .toSorted((a, b) => {
      const [x, y] = [a.repo.toLowerCase(), b.repo.toLowerCase()];
      return x === y ? a.number - b.number : x < y ? -1 : 1;
    });
}

/**
 * The issue as GitHub writes it from `here`, `owner/name`: `#N` for one in
 * `here`, `owner/name#N` for one elsewhere, or everywhere when `here` is null.
 */
export function issueRefName(ref: IssueRef, here: string | null): string {
  return here !== null && sameRepo(ref.repo, here) ? `#${ref.number}` : `${ref.repo}#${ref.number}`;
}

/**
 * Blockers as a sentence names them from `here`: this repo's first, then each
 * other repo's, each once by repo then number, and the hidden ones last,
 * counted, as no read can name them: "#12, a/b#3 and 2 issues the Fabrik App
 * can't read".
 */
export function blockersPhrase(blockers: readonly IssueRef[], hidden: number, here: string | null): string {
  const names = refsNamedFrom(blockers, here);
  const all = hidden > 0 ? [...names, hiddenBlockersPhrase(hidden)] : names;
  return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

/** Each issue once, named from `here`: this repo's first, by number, then each other repo's, by repo, then number. */
export function refsNamedFrom(refs: readonly IssueRef[], here: string | null): string[] {
  const ordered = inBlockerOrder(refs);
  const isHere = ({ repo }: IssueRef) => here !== null && sameRepo(repo, here);
  return [...ordered.filter(isHere), ...ordered.filter((ref) => !isHere(ref))].map((ref) => issueRefName(ref, here));
}

/** `1 issue the Fabrik App can't read`, `2 issues …`: blockers GitHub counts in a repo the Fabrik App can't read. */
export function hiddenBlockersPhrase(hidden: number): string {
  return `${hidden} ${hidden === 1 ? "issue" : "issues"} the Fabrik App can't read`;
}
