// What a Product repo's workflow asks for, for Setup's report (Spec #917):
// whether a session can start it by workflow_dispatch, and for each job
// whether it asks for id-token: write and the environment it names. Read line
// by line by the Kit's workflow reader, since Setup runs with no npm install.
// It reads triggers, permissions and environments, never a step, a run: or an
// input. Pure, no I/O.
import { flowListOf, flowMapOf, type Key, keysOf, type Permissions, permissionsOf, unquoted, workflowKeysOf } from "../kit/workflowLines.ts";

/** One job of a workflow, as Setup reads it. */
interface JobRoles {
  readonly name: string;
  /** Whether it asks for `id-token: write`, by its own `permissions:` or, with none, the workflow's: `write-all` included. */
  readonly idToken: boolean;
  /** The environment it names, as written, an expression included, or null when it names none. */
  readonly environment: string | null;
}

/** What a workflow asks for, as Setup reads it. */
interface WorkflowRoles {
  /** Whether it can be started by `workflow_dispatch`. */
  readonly dispatchable: boolean;
  readonly jobs: readonly JobRoles[];
  /** Whether any of its jobs asks for `id-token: write`. */
  readonly idToken: boolean;
  /** Each environment its jobs name, once, in the order first named. */
  readonly environments: readonly string[];
}

/** Whether the workflow can be started by `workflow_dispatch`, and what each of its jobs asks for. */
export function workflowRolesOf(text: string): WorkflowRoles {
  const { top, jobs } = workflowKeysOf(text);
  const on = top.find((key) => key.name === "on");
  const permissions = top.find((key) => key.name === "permissions");
  const workflowPermissions = permissions === undefined ? null : permissionsOf(permissions.value, permissions.block);
  const read = jobs.map((job) => jobOf(job.name, job.keys, workflowPermissions));
  return {
    dispatchable: on !== undefined && eventsOf(on).includes(DISPATCH),
    jobs: read,
    idToken: read.some((job) => job.idToken),
    environments: [...new Set(read.flatMap((job) => (job.environment === null ? [] : [job.environment])))],
  };
}

/** A job's own `permissions:` replaces the workflow's, wherever in the file the workflow's is written. */
function jobOf(name: string, keys: readonly Key[], workflowPermissions: Permissions | null): JobRoles {
  const own = keys.find((key) => key.name === "permissions");
  const environment = keys.find((key) => key.name === "environment");
  const asks = own === undefined ? workflowPermissions : permissionsOf(own.value, own.block);
  return {
    name,
    idToken: asks !== null && (asks.scopes.get("id-token") ?? asks.all) === "write",
    environment: environment === undefined ? null : environmentOf(environment),
  };
}

/** The environment an `environment:` names, as a name or as a block's or a flow map's `name:`, as written; null for one with no `name:`. */
function environmentOf({ value, block }: Key): string | null {
  const name = value === "" ? keysOf(block).find((key) => key.name === "name")?.value : value.startsWith("{") ? flowMapOf(value)?.get("name") : value;
  return name === undefined || name === "" ? null : unquoted(name);
}

const DISPATCH = "workflow_dispatch";

/**
 * The events an `on:` names: a single event (`on: workflow_dispatch`), a flow
 * list (`on: [push, workflow_dispatch]`), a flow map's own keys, a block list,
 * one event to a line, or a block's own keys, whatever is under them.
 */
function eventsOf({ value, block }: Key): string[] {
  if (value !== "") return [...(flowListOf(value) ?? flowMapOf(value)?.keys() ?? [value])].map(unquoted);
  return block.flatMap((line) => (line.indent === block[0]!.indent && line.body.startsWith("-") ? [unquoted(line.body.slice(1))] : [])).concat(keysOf(block).map((key) => key.name));
}
