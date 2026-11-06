// How the Kit writes a time, or a list, in the text it posts. Pure, no I/O.

/** Such as "2026-11-09 04:00 UTC", from an ISO time or milliseconds. */
export function readable(time: string | number): string {
  const at = new Date(time).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** `a`, `a or b`, or `a, b or c`; or with `and`. */
export function spelled(items: readonly string[], conjunction: "or" | "and" = "or"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}
