// Leaves held lines (src/loop/heldLine.ts, #471) out of what the Loop and the
// agents read. A held line is a quiet note for the Operator, never input: no
// Kit rule may take it for activity or a reply, as the Design queue's "the
// Operator replied, a turn is due" or the stuck-trigger check would, and no
// agent is handed it. The snapshot and the agents' inputs read comments through
// GraphQL, so every comment node whose body is a held line is dropped from
// what a query returns. Their REST reads of comments keep only the Operator's,
// so a held line, the App's, never reaches them.
import { isHeldLine } from "../loop/heldLine.ts";
import type { ReadClient } from "./client.ts";

/** `github`, whose GraphQL answers carry no held line. Every other call is its own. */
export function leavingOutHeldLines<Reader extends Pick<ReadClient, "graphql">>(github: Reader): Reader {
  return new Proxy(github, {
    get(target, property) {
      if (property === "graphql") {
        return async (query: string, variables: Record<string, unknown>) => withoutHeldLines(await target.graphql(query, variables));
      }
      const value: unknown = Reflect.get(target, property, target);
      // Bound to the client itself, whose private fields a call through the proxy couldn't reach.
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The value with every array element that is a comment whose body is a held line dropped, at any depth. */
export function withoutHeldLines<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => !isHeldLineNode(item)).map((item) => withoutHeldLines(item)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withoutHeldLines(field)])) as T;
}

function isHeldLineNode(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const { body } = item as { body?: unknown };
  return typeof body === "string" && isHeldLine(body);
}
