// The words an earlier release wrote where the Kit now names the Evidence page
// (#629). A UI pull request's body or a prototype round that such a release
// posted keeps them, and the Kit must still read it as it reads its own: its
// evidence marker found, its preview linked into it. A record of their day, so
// the test that holds the rename doesn't scan this file.

/** Each sentence the Kit writes now, and how an earlier release wrote it. */
const EARLIER_WORDS: readonly (readonly [now: string, then: string])[] = [
  ["[Open the Evidence page](", "[Open the gallery]("],
  ["kept no Evidence page of its", "kept no gallery of its"],
  ["[The Evidence page](", "[The gallery]("],
  ["The Evidence page expires in about 30 days", "The gallery expires in about 30 days"],
  ["The Kit kept no Evidence page of the captures", "The Kit kept no gallery of the captures"],
  ["There's no Evidence page: ", "There's no gallery: "],
];

/** `text`, a body or round the Kit writes now, as an earlier release wrote it; throws when it names no Evidence page to word the old way. */
export function asAnEarlierReleaseWroteIt(text: string): string {
  const then = EARLIER_WORDS.reduce((written, [now, earlier]) => written.replaceAll(now, earlier), text);
  if (then === text) throw new Error(`nothing in this text names the Evidence page: ${text}`);
  return then;
}
