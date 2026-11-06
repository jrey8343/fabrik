// What a replay Ticket's arms' jobs leave (#156). Both arms run in one
// workflow run, as a matrix, so each arm's job passes out what it did as
// artifacts whose names carry the arm, never as job outputs, which the legs
// of a matrix overwrite, with its own account of how its run went. They're
// read back from where a job downloaded them, each into a folder named after
// it: the judge job reads its arm's Implement run, and the replay-record job
// every arm's every run (src/kit/replayRecord.ts). Package-free, so a job
// that installs nothing can read them.
import { join } from "node:path";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { readTranscriptGzip, TRANSCRIPT_FILE } from "../agent/transcript.ts";
import { REPLAY_PATCH_FILE } from "../agent/replay.ts";
import { readBytesIfPresent, readIfPresent } from "./checkout.ts";
import { JUDGE_FAILURE_FILE, JUDGE_RESULT_FILE } from "./judge.ts";
import { REPLAY_GATES_FILE } from "./replayGates.ts";
import { isObject, parsedJson } from "../agent/stream.ts";
import type { NeededJob } from "./pushJob.ts";
import type { ReplayArm, ReplayRole } from "./runRecord.ts";

/**
 * What an arm's jobs leave, each as an artifact of its own: its Implement and
 * Review runs (the job's account, the result, a failure report, and the
 * Implement run's patch) and their transcripts, its gates, and the judge's
 * account, answer, failure report and transcript, the judge's named as the
 * judge action names a live run's (.github/actions/run-judge).
 */
export type ReplayArtifactKind =
  | "implement"
  | "transcript-implement"
  | "review"
  | "transcript-review"
  | "gates"
  | "score"
  | "judge-result"
  | "judge-failure"
  | "transcript-score";

/**
 * The name of what an arm's job leaves of `kind`, such as
 * `fabrik-implement-replay-baseline`: its arm last, so the two arms of one
 * workflow run never collide, and never `fabrik-agent-*`, the push job's.
 */
export function replayArtifact(kind: ReplayArtifactKind, arm: ReplayArm): string {
  return `fabrik-${kind}-replay-${arm}`;
}

/** The file each of an arm's jobs says how its run went in, beside what the run left (armJobOf). */
export const ARM_JOB_FILE = "arm-job.json";

/**
 * How one of an arm's runs went, as its job saw it: the job's result and the
 * outputs an agent job passes out (`secrets-step`, `model`, `effort`), or
 * that it never started, with why, as a Review on an arm whose Implement run
 * left no patch to judge.
 */
export type ArmJob = { readonly ran: true; readonly job: NeededJob } | { readonly ran: false; readonly why: string };

/**
 * How an arm's job's steps went, as its last step reads them from the
 * `steps` and `job` contexts: the agent step's outcome (empty when it never
 * ran), loading its secrets', the job's status, the model and effort the
 * runner passed, and why the job never started its run, or empty when it had
 * every reason to.
 */
export interface ArmSteps {
  readonly agent: string;
  readonly secrets: string;
  readonly job: string;
  readonly model: string;
  readonly effort: string;
  readonly notRun: string;
}

/**
 * The arm's job's account of its run: it passed when its agent step did;
 * cancelled when the job was, by its timeout or the workflow run's, which the
 * record reads as a timeout; failed when its agent step, or any step before
 * it, failed; and never started when the job said why, as a Review with no
 * patch to judge.
 */
export function armJobOf(steps: ArmSteps): ArmJob {
  const ranAgent = steps.agent !== "" && steps.agent !== "skipped";
  if (!ranAgent && steps.notRun !== "") return { ran: false, why: steps.notRun };
  const result = steps.agent === "success" ? "success" : steps.agent === "cancelled" || steps.job === "cancelled" ? "cancelled" : "failure";
  return { ran: true, job: { result, outputs: { "secrets-step": steps.secrets, model: steps.model, effort: steps.effort } } };
}

/** An arm's job's account of its run (ARM_JOB_FILE), or null when it left none that reads. */
export function readArmJob(text: string | null): ArmJob | null {
  const value = text === null ? null : parsedJson(text);
  if (!isObject(value)) return null;
  if (value["ran"] === false) return typeof value["why"] === "string" ? { ran: false, why: value["why"] } : null;
  const job = value["job"];
  if (value["ran"] !== true || !isObject(job) || typeof job["result"] !== "string" || !isObject(job["outputs"])) return null;
  const outputs = Object.fromEntries(Object.entries(job["outputs"]).flatMap(([name, output]) => (typeof output === "string" ? [[name, output]] : [])));
  return { ran: true, job: { result: job["result"], outputs } };
}

/** What one of an arm's runs left: how its job went (ARM_JOB_FILE), its result, its failure report and its transcript; null for each it left none of. */
export interface ArmRunArtifacts {
  readonly job: string | null;
  readonly agentResult: string | null;
  readonly failureReport: string | null;
  /** The transcript's stream-json lines, and its gzip as the store keeps it. */
  readonly transcript: readonly string[] | null;
  readonly transcriptGzip: Uint8Array | null;
}

/** What one arm's jobs left, from its Implement run to its judge run. */
export interface ArmArtifacts {
  readonly implement: ArmRunArtifacts;
  readonly review: ArmRunArtifacts;
  /** The Implement run's patch, its diff from baseSha (empty when it committed nothing), or null when it left none. */
  readonly patch: Uint8Array | null;
  /** The gates job's ReplayArmGates, or null when it left none. */
  readonly gates: string | null;
  /** The judge's run: its job's account (ARM_JOB_FILE), its answer or failure report, and its transcript. */
  readonly judge: Omit<ArmRunArtifacts, "agentResult" | "failureReport"> & { readonly result: string | null; readonly failure: string | null };
}

/** Where one file of an arm's artifact of `kind` is in `dir`, the job's downloads, whether or not the artifact left it. */
function fileOf(dir: string, kind: ReplayArtifactKind, arm: ReplayArm, file: string): string {
  return join(dir, replayArtifact(kind, arm), file);
}

/** A transcript, gzipped as the arm's job uploaded it, with the lines that decoded. */
async function transcriptIn(path: string): Promise<Pick<ArmRunArtifacts, "transcript" | "transcriptGzip">> {
  const gzip = await readBytesIfPresent(path);
  const read = gzip === null ? null : readTranscriptGzip(gzip);
  return { transcript: read?.lines ?? null, transcriptGzip: read?.gzip ?? null };
}

/** What one of an arm's runs, its Implement or its Review run, left in `dir`. */
export async function armRunArtifactsIn(dir: string, role: ReplayRole, arm: ReplayArm): Promise<ArmRunArtifacts> {
  return {
    job: await readIfPresent(fileOf(dir, role, arm, ARM_JOB_FILE)),
    agentResult: await readIfPresent(fileOf(dir, role, arm, AGENT_RESULT_FILE)),
    failureReport: await readIfPresent(fileOf(dir, role, arm, AGENT_FAILURE_FILE)),
    ...(await transcriptIn(fileOf(dir, `transcript-${role}`, arm, `${TRANSCRIPT_FILE}.gz`))),
  };
}

/** Everything one arm's jobs left in `dir`. */
export async function armArtifactsIn(dir: string, arm: ReplayArm): Promise<ArmArtifacts> {
  const patch = await readBytesIfPresent(fileOf(dir, "implement", arm, REPLAY_PATCH_FILE));
  return {
    implement: await armRunArtifactsIn(dir, "implement", arm),
    review: await armRunArtifactsIn(dir, "review", arm),
    patch: patch === null ? null : new Uint8Array(patch),
    gates: await readIfPresent(fileOf(dir, "gates", arm, REPLAY_GATES_FILE)),
    judge: {
      job: await readIfPresent(fileOf(dir, "score", arm, ARM_JOB_FILE)),
      result: await readIfPresent(fileOf(dir, "judge-result", arm, JUDGE_RESULT_FILE)),
      failure: await readIfPresent(fileOf(dir, "judge-failure", arm, JUDGE_FAILURE_FILE)),
      ...(await transcriptIn(fileOf(dir, "transcript-score", arm, `${TRANSCRIPT_FILE}.gz`))),
    },
  };
}
