// GitHub's anchor for a Markdown heading, for the tests that hold a link to a
// heading of the README or a guide to one that is there.

/** GitHub's anchor for a heading's text: lower case, punctuation but `-` and `_` dropped, each space as `-`. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}
