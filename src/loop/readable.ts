// How the Kit writes a time, or a list, in the text it posts. Pure, no I/O.

/**
 * Such as "2026-11-09 04:00 UTC", from an ISO time or milliseconds: the wall
 * clock in `timeZone`, an IANA zone such as the Operator's, named after it.
 */
export function readable(time: string | number, timeZone = "UTC"): string {
  const at = new Date(wallClock(new Date(time).getTime(), timeZone).asUtc).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} ${timeZone}`;
}

/** A moment as the wall clock in a time zone reads it. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: string;
  /** The wall-clock time read as if it were UTC. */
  readonly asUtc: number;
}

/** The wall clock in `timeZone`, an IANA zone, at `time` in milliseconds. */
export function wallClock(time: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  }).formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const [year, month, day, hour, minute, second] = (["year", "month", "day", "hour", "minute", "second"] as const).map((type) =>
    Number(part(type)),
  ) as [number, number, number, number, number, number];
  return { year, month, day, weekday: part("weekday"), asUtc: Date.UTC(year, month - 1, day, hour, minute, second) };
}

/** `a`, `a or b`, or `a, b or c`; or with `and`. */
export function spelled(items: readonly string[], conjunction: "or" | "and" = "or"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}
