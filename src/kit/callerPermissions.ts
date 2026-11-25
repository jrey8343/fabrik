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
import { type Level, type Permissions, permissionsOf, unquoted, workflowKeysOf } from "./workflowLines.ts";

const RANK: Readonly<Record<Level, number>> = { none: 0, read: 1, write: 2 };

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

/** The workflow's top-level `permissions:` and each of its jobs' `uses:` and `permissions:`. */
function workflowOf(text: string): Workflow {
  const { top, jobs } = workflowKeysOf(text);
  const permissions = top.find((key) => key.name === "permissions");
  return {
    permissions: permissions === undefined ? null : permissionsOf(permissions.value, permissions.block),
    jobs: jobs.map(({ name, keys }) => {
      const uses = keys.find((key) => key.name === "uses");
      const own = keys.find((key) => key.name === "permissions");
      return { name, uses: uses === undefined ? null : unquoted(uses.value), permissions: own === undefined ? null : permissionsOf(own.value, own.block) };
    }),
  };
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
