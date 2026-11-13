// How the Kit writes a time, or a list, in the text it posts. Pure, no I/O.

/**
 * Such as "2026-11-09 04:00 UTC", from an ISO time or milliseconds: the wall
 * clock in `timeZone`, an IANA zone such as the Operator's time zone, named
 * after it; in UTC when it's null, as when the Operator has given none.
 */
export function readable(time: string | number, timeZone: string | null): string {
  const zone = timeZone ?? "UTC";
  const at = new Date(wallClock(new Date(time).getTime(), zone).asUtc).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} ${zone}`;
}

/** Whether it's an IANA time zone the runtime's time zone data knows, such as Europe/London, as GitHub's schedule `timezone:` takes. */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The Operator's time zone a setting gives, from wherever it's read: a zone
 * the runtime knows, else null, which writes times in UTC rather than fails.
 */
export function knownTimeZone(value: unknown): string | null {
  return typeof value === "string" && isTimeZone(value) ? value : null;
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
