// What the push job applies, decided from how the jobs before it ended (its
// `needs`, as `toJSON(needs)` gives it), so the workflow holds no routing of
// its own: the Actions event itself, an agent job's result, a Review's red
// checks or Verdict, or, when the routed agent job failed or was cancelled,
// its failure notice. Pure, no I/O.
import { type CaptureResult, parseCaptureResult } from "../evidence/uiEvidence.ts";
import { parsePrototypeRequest, type PrototypeRequestMarker } from "../loop/markers.ts";
import type { AgentRole } from "../loop/types.ts";
import { FULL_SHA } from "../skills/lock.ts";

/** One job's `needs.<job>`: its result and its outputs. */
export interface NeededJob {
  readonly result: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export type Needs = Readonly<Record<string, NeededJob>>;

/**
 * What an Implement job passed out about UI evidence (#153), read leniently:
 * anything missing or malformed is none, never a failure. The core decides
 * whether the run is UI, and so whether any of it reaches the PR.
 */
export interface CaptureOutputs {
  /** The capture step's result (`ui-capture-result`), or null when it passed out none that reads. */
  readonly result: CaptureResult | null;
  /** The id of the zipped artifact of the screenshots and the capture result (`ui-evidence-artifact`). */
  readonly artifact: number | null;
  /** The id of the unzipped gallery artifact (`ui-gallery-artifact`). */
  readonly galleryArtifact: number | null;
}

export type PushJobInput =
  | { readonly kind: "actions-event" }
  | {
      readonly kind: "agent-result";
      readonly role: Exclude<AgentRole, "review">;
      /** The issue the run was for, which its result must name. */
      readonly issue: number;
      /** For an Implement run on an agent PR: that PR. */
      readonly pullRequest: number | null;
      /** For a Request-changes run: the Operator's review. */
      readonly review: number | null;
      /** For an Implement run: the default branch head a conflict-only run (#304) was started for, else null. */
      readonly conflict?: string | null;
      /** For an Implement run on an agent PR: the default branch head as the Kit job read it, before the run (#341). */
      readonly mainAtStart?: string | null;
      /** For a Design-session turn the Operator's reply started: that comment, which must still exist for the turn to post. */
      readonly startedBy: number | null;
      /** For an Implement run: what its job passed out about UI evidence. */
      readonly capture?: CaptureOutputs;
      /** For a Design session's prototype turn (#155), which the prototype job ran. */
      readonly prototype?: PrototypeTurnOutputs;
    }
  | {
      readonly kind: "review";
      readonly pullRequest: number;
      /** The Ticket the PR builds, the Review's subject. */
      readonly ticket: number;
      readonly headSha: string;
      readonly failedChecks: readonly string[];
      /** Whether green checks let the Reviewer run, so its result is there to apply. */
      readonly withResult: boolean;
    }
  | {
      readonly kind: "agent-failure";
      readonly role: AgentRole;
      readonly issue: number;
      readonly jobResult: string;
      readonly secretsStep: string;
      /** The Subscription the run used, as the Kit job passed it out; absent when it passed none. */
      readonly subscription?: string;
      /** For a Design-session turn: true when it was the session's prototype turn, which the prototype job ran. */
      readonly prototype?: true;
      /** For a conflict-only run (#304): its PR and the default branch head it was started for. */
      readonly conflict?: { readonly pullRequest: number; readonly main: string };
    }
  | { readonly kind: "nothing"; readonly reason: string };

/**
 * What the push job knows of a prototype turn (#155) beside its result: the
 * request the Kit job's plan built it on, from the Kit job's
 * `prototype_request` output, never from the agent, or null when that doesn't
 * read; and what the prototype job passed out about capturing its variants,
 * read leniently, as an Implement job's UI evidence is.
 */
export interface PrototypeTurnOutputs {
  readonly request: PrototypeRequestMarker | null;
  readonly capture: CaptureOutputs;
}

const FAILED = ["failure", "cancelled"];

/**
 * The key of a Retro run's first job (#151), which gathers its evidence from
 * fabrik-runs (.github/actions/gather-retro-evidence) before the Retro job,
 * keyed `retro`, runs the agent on it.
 */
export const RETRO_EVIDENCE_JOB = "retro-evidence";

/**
 * The key of the job that runs a Design session's prototype turn (#155). The
 * turn's route and role stay `design`, so it's the Kit job's `prototype`
 * output that says this job ran it, and the Design job was skipped.
 */
export const PROTOTYPE_JOB = "prototype";

/** Whether the run the Kit job routed to `route` is a Design session's prototype turn: a Design run, with the Kit job's `prototype` output true. */
export function isPrototypeTurn(needs: Needs, route: string): boolean {
  return route === "design" && needs["kit"]?.outputs["prototype"] === "true";
}

/** The job that ran the agent the Kit job routed to: the prototype job for a prototype turn, else the route's own. */
export function routedJob(needs: Needs, route: AgentRole): NeededJob | undefined {
  return needs[isPrototypeTurn(needs, route) ? PROTOTYPE_JOB : route];
}

/**
 * What the push job applies. `eventIssue` is the Actions event's issue number,
 * the run's subject for Triage, Design, the Auditor, the Retro and the
 * Researcher (whose subjects are the pending Audit and the pending Retro the
 * App opened, and the research Decision agent:research went on), and
 * `eventComment` its comment's id when a comment on that issue started the
 * run; an Implement or Review run's Ticket and PR come from the Kit job's
 * plan, which no agent can rewrite.
 */
export function pushJobInput(needs: Needs, eventIssue: number | null, eventComment: number | null = null): PushJobInput {
  const kit = needs["kit"];
  if (kit?.result !== "success") return { kind: "nothing", reason: "the Kit job didn't succeed" };
  const route = kit.outputs["route"] ?? "";
  const ticket = numberOr(kit.outputs["ticket"]);
  const pullRequest = numberOr(kit.outputs["pull-request"]);
  switch (route) {
    case "push":
      return { kind: "actions-event" };
    case "triage":
    case "design":
    case "implement":
    case "audit":
    case "retro":
    case "research": {
      const issue = route === "implement" ? ticket : eventIssue;
      if (issue === null) return { kind: "nothing", reason: `the ${route} run names no issue` };
      // A Retro whose evidence job failed never ran its agent, and is that run's failure.
      const evidence = route === "retro" ? needs[RETRO_EVIDENCE_JOB] : undefined;
      if (evidence !== undefined && FAILED.includes(evidence.result)) return failure(route, issue, evidence, kit);
      const job = routedJob(needs, route);
      const prototype = isPrototypeTurn(needs, route);
      const conflict = route === "implement" ? shaOr(kit.outputs["conflict"]) : null;
      if (job !== undefined && FAILED.includes(job.result)) {
        const failed = failure(route, issue, job, kit);
        if (prototype) return { ...failed, prototype: true };
        return conflict === null || pullRequest === null ? failed : { ...failed, conflict: { pullRequest, main: conflict } };
      }
      if (job?.result !== "success") return { kind: "nothing", reason: `the ${route} job ended ${job?.result ?? "unknown"}` };
      return {
        kind: "agent-result",
        role: route,
        issue,
        pullRequest: route === "implement" ? pullRequest : null,
        review: route === "implement" ? numberOr(kit.outputs["review"]) : null,
        ...(route === "implement" ? { conflict, mainAtStart: shaOr(kit.outputs["main-at-start"]) } : {}),
        // A Design turn routed from a comment answers that reply (src/loop/design.ts).
        startedBy: route === "design" ? eventComment : null,
        ...(route === "implement" ? { capture: captureOutputs(job.outputs) } : {}),
        ...(prototype ? { prototype: { request: requestOf(kit.outputs["prototype_request"]), capture: captureOutputs(job.outputs) } } : {}),
      };
    }
    case "review": {
      if (pullRequest === null || ticket === null) return { kind: "nothing", reason: "the Review names no PR" };
      const checks = needs["review-checks"];
      const reviewer = needs["review"];
      // Waiting on checks or in the Reviewer, a Review that failed is an Infrastructure failure, never a pass.
      if (checks !== undefined && FAILED.includes(checks.result)) return failure("review", ticket, checks, kit);
      if (reviewer !== undefined && FAILED.includes(reviewer.result)) return failure("review", ticket, reviewer, kit);
      if (checks?.result !== "success") return { kind: "nothing", reason: `the Review checks job ended ${checks?.result ?? "unknown"}` };
      const outcome = checks.outputs["checks"];
      const headSha = checks.outputs["head-sha"] ?? "";
      const failedChecks = readNames(checks.outputs["failed"]);
      if (outcome === "red") return { kind: "review", pullRequest, ticket, headSha, failedChecks, withResult: false };
      if (outcome === "green" && reviewer?.result === "success") {
        return { kind: "review", pullRequest, ticket, headSha, failedChecks, withResult: true };
      }
      return { kind: "nothing", reason: `#${pullRequest}'s checks ended ${outcome ?? "unknown"}, so there's no Verdict to post` };
    }
    default:
      return { kind: "nothing", reason: `the Kit job routed to ${route || "nothing"}` };
  }
}

function failure(role: AgentRole, issue: number, job: NeededJob, kit: NeededJob): Extract<PushJobInput, { kind: "agent-failure" }> {
  const subscription = kit.outputs["subscription"] ?? "";
  return {
    kind: "agent-failure",
    role,
    issue,
    // The Implement job's agent step stops at its own timeout, failing the job, so the
    // job notes it (loop.yml): read as V1's job timeout left it, cancelled.
    jobResult: job.outputs["agent-timed-out"] === "true" ? "cancelled" : job.result,
    secretsStep: job.outputs["secrets-step"] ?? "",
    ...(subscription === "" ? {} : { subscription }),
  };
}

function captureOutputs(outputs: NeededJob["outputs"]): CaptureOutputs {
  const text = outputs["ui-capture-result"] ?? "";
  const read = text === "" ? null : parseCaptureResult(text);
  return {
    result: read?.ok === true ? read.result : null,
    artifact: numberOr(outputs["ui-evidence-artifact"]),
    galleryArtifact: numberOr(outputs["ui-gallery-artifact"]),
  };
}

/** The prototype request the Kit job passed out, as one line of JSON, or null when it doesn't read. */
function requestOf(text: string | undefined): PrototypeRequestMarker | null {
  return text === undefined || text === "" ? null : parsePrototypeRequest(text);
}

/** A full commit sha, as the Kit job passes one out, or null for anything else. */
function shaOr(text: string | undefined): string | null {
  return text !== undefined && FULL_SHA.test(text) ? text : null;
}

function numberOr(text: string | undefined): number | null {
  const n = Number(text);
  return text === undefined || text === "" || !Number.isInteger(n) || n < 1 ? null : n;
}

function readNames(text: string | undefined): string[] {
  const value: unknown = JSON.parse(text === undefined || text === "" ? "[]" : text);
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new Error("The Review checks job's failed checks are not a list of names");
  }
  return value;
}
