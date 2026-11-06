// Where a Researcher run's findings land (#154): the Kit names a research
// Decision's throwaway branch and its one findings file from the Decision's
// number and title, as it names an agent branch from its Ticket, so the agent
// never picks either. The agent job names them from the title it starts with;
// the push job reads them back from the branch, so a title edited during the
// run still finds the file the run was given. Pure, and imports no package.
import { slug } from "../kit/config.ts";

/** A research Decision, as both sides know it: its issue number and title. */
export interface ResearchSubject {
  readonly number: number;
  readonly title: string;
}

/** What every research branch's name starts with, as `/wayfinder` names one. */
export const RESEARCH_BRANCH_PREFIX = "research/";

/** The folder every findings file is in: outside every trust root, so a research branch can land. */
export const FINDINGS_DIR = "docs/research";

/** The most of the title's slug a research slug keeps, so a long title makes no long branch or file name. */
const TITLE_SLUG_LIMIT = 50;

/** The title's slug, cut short at the last word that fits. */
function titleSlug(title: string): string {
  const whole = slug(title);
  if (whole.length <= TITLE_SLUG_LIMIT) return whole;
  const fits = whole.slice(0, TITLE_SLUG_LIMIT + 1);
  const lastWord = fits.lastIndexOf("-");
  return lastWord > 0 ? fits.slice(0, lastWord) : fits.slice(0, TITLE_SLUG_LIMIT);
}

/**
 * The Decision's research slug: its number, then its title's slug, cut short
 * at a word, so `42-which-payment-provider`. A title with no letter or digit
 * to slug leaves the number alone.
 */
export function researchSlugFor({ number, title }: ResearchSubject): string {
  const words = titleSlug(title);
  return words === "" ? String(number) : `${number}-${words}`;
}

/** The throwaway branch the Decision's findings land on, never merged and with no PR. */
export function researchBranchFor(decision: ResearchSubject): string {
  return `${RESEARCH_BRANCH_PREFIX}${researchSlugFor(decision)}`;
}

/** The one file, from the repo root, a research run writes and its branch may change. */
export function findingsPathFor(decision: ResearchSubject): string {
  return findingsPathOf(researchSlugFor(decision));
}

function findingsPathOf(researchSlug: string): string {
  return `${FINDINGS_DIR}/${researchSlug}.md`;
}

/** A research slug: a Decision's number, then the words of a title's slug, if any. */
const RESEARCH_BRANCH = /^research\/(([1-9][0-9]*)(?:-[a-z0-9]+)*)$/;

/**
 * The Decision a research branch was named for and the findings file it may
 * change, or null when no Decision's slug makes this branch.
 */
export function researchOfBranch(branch: string): { readonly decision: number; readonly findingsPath: string } | null {
  const match = RESEARCH_BRANCH.exec(branch);
  if (match === null) return null;
  return { decision: Number(match[2]), findingsPath: findingsPathOf(match[1]!) };
}
