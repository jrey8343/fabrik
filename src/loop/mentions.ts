/**
 * An `@` that would start a mention: one followed by a letter or a digit, and
 * not straight after a letter, a digit, an underscore or a backtick. So an
 * address such as `a@b.c` holds none, and neither does a name that opens a
 * code span. The Kit's one test for a mention: what strips them and what
 * refuses them both read it.
 */
const MENTION = /(?<![\w`])@(?=[A-Za-z0-9])/g;

/**
 * Agent-written text never notifies anyone: a zero-width space after each `@`
 * that would start a mention keeps the text readable but unlinked.
 */
export function withoutMentions(text: string): string {
  return text.replace(MENTION, "@​");
}

/**
 * Whether the text mentions someone, by the test withoutMentions strips with:
 * true exactly when that would change it. For text the Kit refuses, where it
 * can't strip: a Roll-in's, which the Operator sends as their own.
 */
export function mentionsSomeone(text: string): boolean {
  // search starts from the beginning whatever the pattern's lastIndex.
  return text.search(MENTION) !== -1;
}
