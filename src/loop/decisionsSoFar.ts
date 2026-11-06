// A Map's Decisions so far (#154): the index of the Decisions resolved on its
// way, one line each. The Kit only ever appends to it, into the body as it
// stands, so whatever else the Operator wrote in the Map stays as it is.
import { DECISIONS_SO_FAR_HEADING, fencedRunsOf } from "./markers.ts";

/**
 * The Map's body with `line` appended to its Decisions so far: on a line of
 * its own after the section's last line that isn't blank, or under the
 * heading this adds at the end of a body with no such section. Only a heading
 * outside code counts, as the section's own or as the next one, which ends
 * it. Every other byte of the body stays, and the line ends as the body's
 * lines do: in \r\n once the Operator has edited it on GitHub's web editor.
 */
export function withDecisionLine(body: string, line: string): string {
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const map = headingIn(body) === -1 ? withEmptySection(body, newline) : body;
  const lines = map.split("\n");
  const prose = outsideCode(map);
  const start = headingIn(map);
  const next = lines.findIndex((each, at) => at > start && prose[at] === true && SECTION_HEADING.test(each));
  const end = next === -1 ? lines.length : next;
  const last = lines.findLastIndex((each, at) => at < end && each.trim() !== "");
  // Just after the last line's text, before whatever ends it.
  const at = lines.slice(0, last + 1).join("\n").replace(/\r$/, "").length;
  return `${map.slice(0, at)}${newline}${line}${map.slice(at)}`;
}

/** A heading as deep as the Map's own, or shallower, which ends the section above it. */
const SECTION_HEADING = /^ {0,3}##?(\s|$)/;

/** Which line of the body opens its Decisions so far, or -1 when none does. */
function headingIn(body: string): number {
  const prose = outsideCode(body);
  return body.split("\n").findIndex((each, at) => prose[at] === true && each.trim() === DECISIONS_SO_FAR_HEADING);
}

/** Whether each of the body's lines is outside its fenced code blocks. */
function outsideCode(body: string): boolean[] {
  return fencedRunsOf(body).runs.flatMap(({ code, lines }) => lines.map(() => !code));
}

/** The body with an empty Decisions so far added at its end, a blank line after the rest. */
function withEmptySection(body: string, newline: string): string {
  const ended = body.endsWith(newline);
  const gap = body === "" || body.endsWith(newline.repeat(2)) ? "" : ended ? newline : newline.repeat(2);
  return `${body}${gap}${DECISIONS_SO_FAR_HEADING}${ended ? newline : ""}`;
}
