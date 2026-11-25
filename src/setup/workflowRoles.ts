// What a Product repo's workflow asks for, for Setup's report (Spec #917):
// whether a session can start it by workflow_dispatch, and for each job
// whether it asks for id-token: write and the environment it names. Read line
// by line, as the caller's permissions check reads a caller workflow, since
// Setup runs with no npm install. It reads triggers, permissions and
// environments, never a step, a run: or an input. Pure, no I/O.
import { childrenOf, type Line, linesOf, type Permissions, permissionsOf, unquoted } from "../kit/callerPermissions.ts";

/** One job of a workflow, as Setup reads it. */
export interface JobRoles {
  readonly name: string;
  /** Whether it asks for `id-token: write`, by its own `permissions:` or, with none, the workflow's: `write-all` included. */
  readonly idToken: boolean;
  /** The environment it names, as written, an expression included, or null when it names none. */
  readonly environment: string | null;
}

/** What a workflow asks for, as Setup reads it. */
export interface WorkflowRoles {
  /** Whether it can be started by `workflow_dispatch`. */
  readonly dispatchable: boolean;
  readonly jobs: readonly JobRoles[];
}

/** Whether the workflow can be started by `workflow_dispatch`, and what each of its jobs asks for. */
export function workflowRolesOf(text: string): WorkflowRoles {
  const lines = linesOf(text);
  let dispatchable = false;
  let permissions: Permissions | null = null;
  const jobs: { name: string; lines: Line[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = keyOf(lines[i]!);
    if (lines[i]!.indent !== 0 || key === null) continue;
    const children = childrenOf(lines, i);
    if (key.name === "on") dispatchable = eventsOf(key.value, children).includes(DISPATCH);
    if (key.name === "permissions") permissions = permissionsOf(key.value, children);
    if (key.name === "jobs") {
      for (let j = 0; j < children.length; j++) {
        const job = keyOf(children[j]!);
        if (children[j]!.indent !== children[0]!.indent || job === null || job.value !== "") continue;
        jobs.push({ name: job.name, lines: childrenOf(children, j) });
      }
    }
  }
  // A job's own permissions: replaces the workflow's, so it is read once the workflow's is known, wherever that is written.
  return { dispatchable, jobs: jobs.map((job) => jobOf(job.name, job.lines, permissions)) };
}

function jobOf(name: string, lines: readonly Line[], workflowPermissions: Permissions | null): JobRoles {
  let permissions: Permissions | null = null;
  let environment: string | null = null;
  const own = lines[0]?.indent;
  for (let i = 0; i < lines.length; i++) {
    const key = keyOf(lines[i]!);
    if (lines[i]!.indent !== own || key === null) continue;
    if (key.name === "permissions") permissions = permissionsOf(key.value, childrenOf(lines, i));
    if (key.name === "environment") environment = environmentOf(key.value, childrenOf(lines, i));
  }
  const asks = permissions ?? workflowPermissions;
  const idToken = asks !== null && (asks.scopes.get("id-token") ?? asks.all) === "write";
  return { name, idToken, environment };
}

/** The environment an `environment:` names, as a name or as a block's `name:`, as written; null for a block with no `name:`. */
function environmentOf(inline: string, block: readonly Line[]): string | null {
  if (inline !== "") return unquoted(inline);
  const own = block[0]?.indent;
  const name = block.map((line) => (line.indent === own ? keyOf(line) : null)).find((key) => key?.name === "name");
  return name === undefined || name === null || name.value === "" ? null : unquoted(name.value);
}

const DISPATCH = "workflow_dispatch";

/** A line's key, unquoted, and what follows its colon, or null for a line that isn't a key. */
function keyOf(line: Line): { readonly name: string; readonly value: string } | null {
  const key = /^((["'])[^"']*\2|[^:\s]+):(.*)$/.exec(line.body);
  return key === null ? null : { name: unquoted(key[1] ?? ""), value: (key[3] ?? "").trim() };
}

/**
 * The events an `on:` names: a single event (`on: workflow_dispatch`), a flow
 * list (`on: [push, workflow_dispatch]`), a block list, one event to a line,
 * or a block's own keys, whatever is under them.
 */
function eventsOf(inline: string, block: readonly Line[]): string[] {
  if (inline.startsWith("[")) return inline.replace(/^\[|\]$/g, "").split(",").map(unquoted);
  if (inline !== "") return [unquoted(inline)];
  const own = block[0]?.indent;
  return block.flatMap((line) => {
    if (line.indent !== own) return [];
    if (line.body.startsWith("-")) return [unquoted(line.body.slice(1))];
    const key = keyOf(line);
    return key === null ? [] : [key.name];
  });
}
