// What the push job applies, decided from how the jobs before it ended (its
// `needs`, as `toJSON(needs)` gives it), so the workflow holds no routing of
// its own: the Actions event itself, an agent job's result, a Review's red
// checks or Verdict, or, when the routed agent job failed or was cancelled,
// its failure notice. Pure, no I/O.
import { type CaptureResult, parseCaptureResult } from "../evidence/uiEvidence.ts";
import type { AgentRole } from "../loop/types.ts";

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
      /** For a Design-session turn the Operator's reply started: that comment, which must still exist for the turn to post. */
      readonly startedBy: number | null;
      /** For an Implement run: what its job passed out about UI evidence. */
      readonly capture?: CaptureOutputs;
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
    }
  | { readonly kind: "nothing"; readonly reason: string };

const FAILED = ["failure", "cancelled"];

/**
 * The key of a Retro run's first job (#151), which gathers its evidence from
 * fabrik-runs (.github/actions/gather-retro-evidence) before the Retro job,
 * keyed `retro`, runs the agent on it.
 */
export const RETRO_EVIDENCE_JOB = "retro-evidence";

/**
 * What the push job applies. `eventIssue` is the Actions event's issue number,
 * the run's subject for Triage, Design, the Auditor and the Retro (whose
 * subjects are the pending Audit and the pending Retro the App opened), and
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
    case "retro": {
      const issue = route === "implement" ? ticket : eventIssue;
      if (issue === null) return { kind: "nothing", reason: `the ${route} run names no issue` };
      // A Retro whose evidence job failed never ran its agent, and is that run's failure.
      const evidence = route === "retro" ? needs[RETRO_EVIDENCE_JOB] : undefined;
      if (evidence !== undefined && FAILED.includes(evidence.result)) return failure(route, issue, evidence, kit);
      const job = needs[route];
      if (job !== undefined && FAILED.includes(job.result)) return failure(route, issue, job, kit);
      if (job?.result !== "success") return { kind: "nothing", reason: `the ${route} job ended ${job?.result ?? "unknown"}` };
      return {
        kind: "agent-result",
        role: route,
        issue,
        pullRequest: route === "implement" ? pullRequest : null,
        review: route === "implement" ? numberOr(kit.outputs["review"]) : null,
        // A Design turn routed from a comment answers that reply (src/loop/design.ts).
        startedBy: route === "design" ? eventComment : null,
        ...(route === "implement" ? { capture: captureOutputs(job.outputs) } : {}),
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

function failure(role: AgentRole, issue: number, job: NeededJob, kit: NeededJob): PushJobInput {
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
