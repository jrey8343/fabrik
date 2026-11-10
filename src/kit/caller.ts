// The Kit check on a Product repo's caller workflow (ADR-0003): every `uses:`
// line that names Fabrik pins the same exact release, the only place the Kit's
// version appears. Every run makes it, with the Kit config's own check, before
// any agent starts. Pure, no I/O.
import type { KitConfig, KitConfigResult } from "./config.ts";

export type CallerCheck =
  | { readonly ok: true; readonly release: string }
  | { readonly ok: false; readonly error: string };

/**
 * The Kit's own repo, as owner/name: the one every caller `uses:` line names,
 * where a proposal to change the Kit is filed (src/loop/retroLanding.ts), and
 * the only repo a Replay's candidate Kit sha may come from (src/kit/overlay.ts).
 * A Kit constant, like the run store.
 */
export const KIT_REPO = "jrey8343/fabrik";

/** A `uses:` line naming Fabrik, optionally quoted and as a list item, capturing the path within Fabrik (if any) and the ref. */
const FABRIK_USES = /^\s*(?:-\s+)?uses:\s*["']?jrey8343\/fabrik(\/[^@\s"']*)?@([^\s"'#]+)["']?\s*(?:#.*)?$/;

/** An exact semver release tag, such as v1.2.3 or v1.2.3-pre.1. */
const EXACT_RELEASE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The caller workflow's job keys (templates/fabrik.yml). Each Kit job they
 * start reports a check run on the commit it ran for, named after its key:
 * `loop` or `loop / <job>`, `tick` or `tick / <job>`.
 */
export const CALLER_JOBS = ["loop", "tick"] as const;

/** The refs of every `uses:` line in the workflow that names Fabrik, in order. */
export function fabrikRefsIn(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = FABRIK_USES.exec(line);
    return match?.[2] === undefined ? [] : [match[2]];
  });
}

/** What every `uses:` line in the workflow that names Fabrik uses, `jrey8343/fabrik/<path>@<ref>`, unquoted, in order. */
export function fabrikUsesIn(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = FABRIK_USES.exec(line);
    return match?.[2] === undefined ? [] : [`${KIT_REPO}${match[1] ?? ""}@${match[2]}`];
  });
}

export function checkCallerWorkflow(text: string): CallerCheck {
  const refs = fabrikRefsIn(text);
  if (refs.length === 0) {
    return { ok: false, error: "The caller workflow has no uses: line that pins a Fabrik release" };
  }
  const distinct = [...new Set(refs)];
  if (distinct.length > 1) {
    return {
      ok: false,
      error: `The caller workflow pins more than one Fabrik release (${distinct.join(", ")}); every uses: line must pin the same one`,
    };
  }
  const [release] = distinct as [string];
  if (!EXACT_RELEASE.test(release)) {
    return {
      ok: false,
      error: `The caller workflow pins Fabrik at ${release}, which isn't an exact release tag such as v1.2.3`,
    };
  }
  return { ok: true, release };
}

/**
 * A workflow ref, `owner/repo/<path>@<ref>` as GITHUB_WORKFLOW_REF or
 * `github.workflow_ref` gives it, split at its last `@`: what comes before it
 * and the ref. Null when it has no `@`.
 */
export function splitWorkflowRef(workflowRef: string): { readonly workflow: string; readonly ref: string } | null {
  const at = workflowRef.lastIndexOf("@");
  return at === -1 ? null : { workflow: workflowRef.slice(0, at), ref: workflowRef.slice(at + 1) };
}

/** The caller workflow's path in the Product repo, from GITHUB_WORKFLOW_REF: `owner/repo/<path>@<ref>`. */
export function callerWorkflowPath(workflowRef: string, repo: { readonly owner: string; readonly name: string }): string {
  const prefix = `${repo.owner}/${repo.name}/`;
  const split = splitWorkflowRef(workflowRef);
  if (split === null || !split.workflow.startsWith(prefix) || split.workflow.length < prefix.length) {
    throw new Error(`GITHUB_WORKFLOW_REF is not ${prefix}<path>@<ref>: ${workflowRef}`);
  }
  return split.workflow.slice(prefix.length);
}

export type KitCheck =
  | { readonly ok: true; readonly config: KitConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The check every run starts with: the Kit config is valid and the caller
 * workflow pins one exact Fabrik release. It names every problem at once.
 */
export function checkKit(
  resolved: KitConfigResult,
  caller: { readonly path: string; readonly text: string | null },
): KitCheck {
  const errors: string[] = resolved.ok ? [] : [...resolved.errors];
  if (caller.text === null) {
    errors.push(`${caller.path} was not found`);
  } else {
    const pins = checkCallerWorkflow(caller.text);
    if (!pins.ok) errors.push(`${caller.path}: ${pins.error}`);
  }
  return errors.length > 0 || !resolved.ok ? { ok: false, errors } : { ok: true, config: resolved.config };
}
