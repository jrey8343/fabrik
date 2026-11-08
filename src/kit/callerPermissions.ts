// A caller workflow's grants against what the Fabrik workflows it pins ask
// for (#422). GitHub starts no run of a workflow whose `uses:` job grants a
// called workflow's job less than that job's `permissions:` asks, and it
// checks every `uses:` job before any job's `if:`, so one gap fails every run
// of the caller, whatever the event, with no job, no step summary and no check
// run to say why. The Kit job on a pull request that changes the caller (a
// Dependabot bump of the pin, say) reads the caller the PR proposes and the
// workflows at the release it pins, and fails the PR's check naming the job
// and the line, so the gap is seen before the merge. The comparison is pure;
// `callerChangeErrors` does the reads.
import type { Repo } from "../github/client.ts";
import { checkCallerWorkflow, fabrikUsesIn, KIT_REPO } from "./caller.ts";

type Level = "none" | "read" | "write";

const RANK: Readonly<Record<Level, number>> = { none: 0, read: 1, write: 2 };

/** A `permissions:` value: `read-all`/`write-all` as `all`, else each scope's level, `{}` as none. */
interface Permissions {
  readonly all: Level | null;
  readonly scopes: ReadonlyMap<string, Level>;
}

interface Job {
  readonly name: string;
  readonly uses: string | null;
  /** The job's own `permissions:`, or null when it has none. */
  readonly permissions: Permissions | null;
}

interface Workflow {
  /** The workflow's top-level `permissions:`, which a job without its own takes; null when it has none. */
  readonly permissions: Permissions | null;
  readonly jobs: readonly Job[];
}

/** One line of a workflow as the check reads it: how far it's indented, and its text with the indent and any comment dropped. */
interface Line {
  readonly indent: number;
  readonly body: string;
}

/** A workflow text as the check reads it, with every comment and blank line dropped. */
function linesOf(text: string): Line[] {
  return text.split("\n").flatMap((raw) => {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) return [];
    return [{ indent: line.length - line.trimStart().length, body: line.trim() }];
  });
}

function unquoted(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

function levelOf(value: string): Level {
  const level = unquoted(value);
  return level === "read" || level === "write" ? level : "none";
}

/** A `permissions:` value from its inline form (`{}`, `read-all`, `{ contents: read }`) or its block lines. */
function permissionsOf(inline: string, block: readonly Line[]): Permissions {
  const scopes = new Map<string, Level>();
  const value = unquoted(inline);
  if (value === "read-all" || value === "write-all") return { all: value === "read-all" ? "read" : "write", scopes };
  const entries =
    value === ""
      ? block.map((line) => line.body)
      : value
          .replace(/^\{|\}$/g, "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
  for (const entry of entries) {
    const at = entry.indexOf(":");
    if (at === -1) continue;
    scopes.set(unquoted(entry.slice(0, at)), levelOf(entry.slice(at + 1)));
  }
  return { all: null, scopes };
}

/** The workflow's top-level `permissions:` and each of its jobs' `uses:` and `permissions:`. */
export function workflowOf(text: string): Workflow {
  const lines = linesOf(text);
  let permissions: Permissions | null = null;
  const jobs: Job[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.indent !== 0) continue;
    const key = /^([^:\s]+):(.*)$/.exec(line.body);
    if (key === null) continue;
    const children = childrenOf(lines, i);
    if (key[1] === "permissions") permissions = permissionsOf(key[2] ?? "", children);
    if (key[1] === "jobs") {
      for (let j = 0; j < children.length; j++) {
        const child = children[j]!;
        if (child.indent !== children[0]!.indent) continue;
        const name = /^([A-Za-z_][\w-]*):\s*$/.exec(child.body)?.[1];
        if (name === undefined) continue;
        jobs.push(jobOf(name, childrenOf(children, j)));
      }
    }
  }
  return { permissions, jobs };
}

/** The lines nested under the line at `at`: every following line indented more than it. */
function childrenOf(lines: readonly Line[], at: number): Line[] {
  const parent = lines[at]!;
  const children: Line[] = [];
  for (let i = at + 1; i < lines.length && lines[i]!.indent > parent.indent; i++) children.push(lines[i]!);
  return children;
}

function jobOf(name: string, lines: readonly Line[]): Job {
  let uses: string | null = null;
  let permissions: Permissions | null = null;
  const own = lines.length === 0 ? 0 : lines[0]!.indent;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.indent !== own) continue;
    const key = /^([^:\s]+):(.*)$/.exec(line.body);
    if (key === null) continue;
    if (key[1] === "uses") uses = unquoted(key[2] ?? "");
    if (key[1] === "permissions") permissions = permissionsOf(key[2] ?? "", childrenOf(lines, i));
  }
  return { name, uses, permissions };
}

function grantOf(permissions: Permissions, scope: string): Level {
  return permissions.scopes.get(scope) ?? permissions.all ?? "none";
}

/**
 * Every job of a called workflow that asks for more than the caller's job
 * granting it, as one error each naming the caller's job and the line to add.
 * A caller job whose `uses:` names no workflow given is left alone, as is a
 * called job with no `permissions:` of its own or its workflow's, which takes
 * the caller's. A caller job with no `permissions:` of its own or its
 * workflow's gets the repo's default token permissions, which never grant
 * `id-token: write`, so every line the called jobs ask for is one error.
 */
export function checkCallerPermissions(
  caller: { readonly path: string; readonly text: string },
  workflows: readonly { readonly uses: string; readonly text: string }[],
): string[] {
  const callerWorkflow = workflowOf(caller.text);
  const errors: string[] = [];
  for (const job of callerWorkflow.jobs) {
    const called = job.uses === null ? undefined : workflows.find((workflow) => workflow.uses === job.uses);
    if (called === undefined) continue;
    const grants = job.permissions ?? callerWorkflow.permissions;
    const calledWorkflow = workflowOf(called.text);
    if (grants === null) {
      const asked = linesAsked(calledWorkflow);
      if (asked.length > 0) errors.push(noGrants(caller.path, job.name, asked, called.uses));
      continue;
    }
    for (const calledJob of calledWorkflow.jobs) {
      const asks = calledJob.permissions ?? calledWorkflow.permissions;
      if (asks === null) continue;
      if (asks.all !== null && RANK[grants.all ?? "none"] < RANK[asks.all]) {
        errors.push(gap(caller.path, job.name, `${asks.all}-all`, null, calledJob.name, called.uses));
      }
      for (const [scope, level] of asks.scopes) {
        const granted = grantOf(grants, scope);
        if (RANK[granted] < RANK[level]) {
          errors.push(gap(caller.path, job.name, `${scope}: ${level}`, granted === "none" ? null : `${scope}: ${granted}`, calledJob.name, called.uses));
        }
      }
    }
  }
  return errors;
}

/** Every line the workflow's jobs ask for, each scope once at the highest level asked, in the order first asked. */
function linesAsked(workflow: Workflow): string[] {
  const highest = new Map<string, Level>();
  for (const job of workflow.jobs) {
    const asks = job.permissions ?? workflow.permissions;
    if (asks === null) continue;
    if (asks.all !== null) highest.set(`${asks.all}-all`, asks.all);
    for (const [scope, level] of asks.scopes) {
      if (level !== "none" && RANK[highest.get(scope) ?? "none"] < RANK[level]) highest.set(scope, level);
    }
  }
  return [...highest].map(([scope, level]) => (scope.endsWith("-all") ? `\`${scope}\`` : `\`${scope}: ${level}\``));
}

/** The error for a caller job that sets no permissions: anywhere, naming every line to add. */
function noGrants(path: string, job: string, asked: readonly string[], uses: string): string {
  const listed = asked.length < 2 ? asked.join("") : `${asked.slice(0, -1).join(", ")} and ${asked.at(-1)}`;
  return (
    `${path}: the ${job} job has no permissions: of its own, and the workflow none at the top, so it gets the repo's default token permissions, ` +
    `which never include \`id-token: write\`. The jobs of ${uses} ask for ${listed}. ` +
    "GitHub checks every uses: job of a workflow before any job's if:, so until they're granted every run of this workflow fails at startup, whatever the event. " +
    `Add a permissions: block with those lines under the ${job} job before merging.`
  );
}

/** The error for one gap: what the caller's job grants, what the called job asks, and the line to add. */
function gap(path: string, job: string, asked: string, granted: string | null, calledJob: string, uses: string): string {
  const has = granted === null ? `lacks \`${asked}\`` : `grants \`${granted}\`, but it needs \`${asked}\``;
  const fix = granted === null ? `Add \`${asked}\` under` : `Raise it to \`${asked}\` under`;
  return (
    `${path}: the ${job} job's permissions: ${has}, which the ${calledJob} job of ${uses} asks for. ` +
    "GitHub checks every uses: job of a workflow before any job's if:, so until the line is added every run of this workflow fails at startup, whatever the event. " +
    `${fix} the ${job} job's permissions: before merging.`
  );
}

/** Reads a file from a repo at a ref, as the GitHub client does; null when it isn't there. */
export interface FileReader {
  fileText(repo: Repo, path: string, ref: string): Promise<string | null>;
}

const [KIT_OWNER = "", KIT_NAME = ""] = KIT_REPO.split("/");
const KIT: Repo = { owner: KIT_OWNER, name: KIT_NAME };

/**
 * What's wrong with the caller workflow a pull request proposes, or nothing
 * when the PR leaves it as the base branch has it: its pins must agree and
 * name an exact release that holds every workflow they name, and each job
 * must grant what the workflow it calls asks for.
 */
export async function callerChangeErrors(
  files: FileReader,
  repo: Repo,
  caller: { readonly path: string; readonly baseText: string | null; readonly headSha: string },
): Promise<string[]> {
  // Read from the Product repo at the PR's head. A fork's head the repo can't serve reads as no caller, so an
  // Operator's PR from a fork isn't checked; a Dependabot bump is a branch of the repo itself.
  const head = await files.fileText(repo, caller.path, caller.headSha);
  if (head === null || head === caller.baseText) return [];
  const pins = checkCallerWorkflow(head);
  if (!pins.ok) return [`${caller.path}: ${pins.error}`];
  const reusable = [...new Set(fabrikUsesIn(head))].filter((uses) => uses.startsWith(`${KIT_REPO}/.github/workflows/`));
  const errors: string[] = [];
  const workflows: { uses: string; text: string }[] = [];
  for (const uses of reusable) {
    const path = uses.slice(KIT_REPO.length + 1, uses.lastIndexOf("@"));
    const text = await files.fileText(KIT, path, pins.release);
    if (text === null) errors.push(`${caller.path}: ${uses} names a workflow ${KIT_REPO} has no ${path} for at ${pins.release}`);
    else workflows.push({ uses, text });
  }
  return [...errors, ...checkCallerPermissions({ path: caller.path, text: head }, workflows)];
}
