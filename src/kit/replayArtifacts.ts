// What a replay Ticket's arms' jobs left, read from where a job downloaded
// their artifacts, each into a folder named after it (src/kit/replayRecord.ts
// names them): the judge job reads its arm's Implement run, and the
// replay-record job every arm's every run. Package-free, so a job that
// installs nothing can read them.
import { join } from "node:path";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { readTranscriptGzip, TRANSCRIPT_FILE } from "../agent/transcript.ts";
import { REPLAY_PATCH_FILE } from "../agent/replay.ts";
import { readBytesIfPresent, readIfPresent } from "./checkout.ts";
import { JUDGE_FAILURE_FILE, JUDGE_RESULT_FILE } from "./judge.ts";
import { REPLAY_GATES_FILE } from "./replayGates.ts";
import { ARM_JOB_FILE, type ArmArtifacts, type ArmRunArtifacts, replayArtifact, type ReplayArtifactKind } from "./replayRecord.ts";
import type { ReplayArm, ReplayRole } from "./runRecord.ts";

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
