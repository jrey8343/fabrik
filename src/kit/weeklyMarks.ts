// The marks by which the store's Weekly summary issues and a failed run's
// notice are known: by the filing (src/kit/weeklyFiling.ts) and by the store's
// Standing (src/kit/standingStore.ts), which the read library reaches. Pure,
// and it imports nothing, so reading these marks needs nothing the filing does.

/** The label on every Weekly summary issue, by which the next week's filing finds it. */
export const WEEKLY_SUMMARY_LABEL = "fabrik:weekly-summary";

/** The title of the issue a failed run files when no Weekly summary was ever filed to comment on. */
export const WEEKLY_SUMMARY_FAILED_TITLE = "Weekly summary failed";

/**
 * The hidden last line of a failed run's notice, on the comment and on the
 * issue it files alike, by which the store's Standing knows the notice for
 * what it is (src/kit/standingStore.ts). Its visible text is unchanged.
 */
export const WEEKLY_SUMMARY_FAILED_MARKER = "<!-- fabrik:weekly-summary-failed -->";

/** How a failed run's notice opens, after its @-mention: an earlier release's notice, with no marker, is known by it. */
export const FAILED_OPENING = "**The Weekly summary failed**";

/** Whether `body` is a failed Weekly summary run's notice: it carries the marker, or, from an earlier release, opens with an @-mention and the notice's words. */
export function isWeeklyFailureNotice(body: string): boolean {
  if (body.split("\n").some((line) => line.trim() === WEEKLY_SUMMARY_FAILED_MARKER)) return true;
  const mention = /^@\S+ /.exec(body)?.[0];
  return mention !== undefined && body.slice(mention.length).startsWith(FAILED_OPENING);
}
