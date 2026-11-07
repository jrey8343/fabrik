// A replay Ticket's run (#156), as its replay-record job, the replay's push
// job (ADR-0009's shape), writes it from what each arm's jobs left as
// artifacts (src/kit/replayArtifacts.ts): each arm's Implement and Review
// runs' Run records and transcripts, its patch and gates, and the judge's
// record and score file, every one create-only in the store. It also says
// how the run ended, for the Loop to land on the replay issue
// (src/loop/replayRun.ts), and, before the judge runs, whether it scores an
// arm. Pure but for writeReplayRun, which writes through the record writer
// (src/kit/recordWriter.ts).
import { readFailureReport } from "../agent/failure.ts";
import { isObject, parsedJson } from "../agent/stream.ts";
import { type ArmArtifacts, type ArmRunArtifacts, readArmJob } from "./replayArtifacts.ts";
import type { NeededJob } from "./pushJob.ts";
import { readReplayArmGates, readReplayArms, type ReplayArms, type ReplayTicketEnd } from "./replay.ts";
import { type StoreApi, type StoreFile, type StoreWrite, storeCommitMessage, storeJson, writeStoreFiles } from "./recordWriter.ts";
import { RUN_NAMES } from "../loop/heldRun.ts";
import { judgeRunRecordFor, REPLAY_ARMS, REPLAY_ROLES, type ReplayArm, replayGatesPath, replayPatchPath, type ReplayRole, replayRunRecordFor, type RunRecordFiles } from "./runRecord.ts";
import { JUDGE_MODEL } from "./runStore.ts";
import { judgeOutcome } from "./judge.ts";
import { type KitRubrics, scoreFileFor, scoringPlan, scoringRubrics } from "./scorer.ts";

/** Which Replay Ticket's run this is, from the Kit job's outputs (src/kit/jobs.ts) and the Actions run. */
export interface ReplayRunContext {
  /** The Product repo, as `owner/name`. */
  readonly repo: string;
  readonly runId: number;
  readonly runAttempt: number;
  /** The Kit job's sha: the pinned release, which writes every record and whose rubrics score every arm. */
  readonly kitSha: string;
  /** The replay issue. */
  readonly issue: number;
  readonly ticket: number;
  /** The Ticket's merged PR. */
  readonly pullRequest: number;
  readonly baseSha: string;
  readonly arms: ReplayArms;
  readonly subscription: string;
}

/** The Kit job's outputs a replay route gives (`replay-issue`, `ticket`, `pull-request`, `base-sha`, `replay-arms`, `subscription`, `sha`) as a run's context, or a throw naming what's missing. */
export function replayRunContextOf(
  kit: Readonly<Record<string, string>>,
  run: Pick<ReplayRunContext, "repo" | "runId" | "runAttempt">,
): ReplayRunContext {
  const output = (name: string): string => {
    const value = kit[name];
    if (value === undefined || value === "") throw new Error(`The Kit job passed out no ${name}, so this isn't a replay Ticket's run`);
    return value;
  };
  const id = (name: string): number => {
    const value = Number(output(name));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`The Kit job's ${name} isn't an issue number: ${output(name)}`);
    return value;
  };
  const arms = readReplayArms(parsedJson(output("replay-arms")));
  if (arms === null) throw new Error("The Kit job's replay-arms don't read as each arm's settings");
  return {
    ...run,
    kitSha: output("sha"),
    issue: id("replay-issue"),
    ticket: id("ticket"),
    pullRequest: id("pull-request"),
    baseSha: output("base-sha"),
    arms,
    subscription: output("subscription"),
  };
}

/**
 * How a replay Ticket's run ended, as its replay-record job saw it, for the
 * Loop to land on the replay issue (the `replay-run-finished` event, less what
 * src/main.ts adds): the replay issue, the Ticket, the Actions run its claim
 * marked it in progress in, its end, the Subscription both arms ran on, and,
 * for a weekly-limit refusal, when the limit resets, if the stream said.
 */
export interface ReplayRunEnded {
  readonly issue: number;
  readonly ticket: number;
  readonly run: number;
  readonly end: ReplayTicketEnd;
  readonly subscription: string;
  readonly resetsAt: string | null;
}

/** The file the replay-record job leaves how the run ended in, for the Loop to land (src/main.ts). */
export const REPLAY_RUN_ENDED_FILE = "replay-run-ended.json";

/** How a replay Ticket's run ended, from the file the replay-record job left, or a throw for one that doesn't read as it writes one. */
export function readReplayRunEnded(text: string): ReplayRunEnded {
  const value = parsedJson(text);
  const ended = isObject(value) ? value : {};
  const { issue, ticket, run, end, subscription, resetsAt } = ended;
  const ids = [issue, ticket, run].every((id) => Number.isSafeInteger(id) && (id as number) > 0);
  const known = isObject(end) && (end["kind"] === "done" || end["kind"] === "weekly-limit" || (end["kind"] === "infrastructure" && typeof end["reason"] === "string"));
  if (!ids || !known || typeof subscription !== "string" || !(resetsAt === null || typeof resetsAt === "string")) {
    throw new Error(`The replay-record job's ${REPLAY_RUN_ENDED_FILE} doesn't read as how a replay Ticket's run ended`);
  }
  return { issue: issue as number, ticket: ticket as number, run: run as number, end: end as unknown as ReplayTicketEnd, subscription, resetsAt };
}

/** What the replay-record job writes, a commit message to each group of files, in order, and how the run ended. */
export interface ReplayRunFiles {
  readonly ended: ReplayRunEnded;
  readonly writes: readonly { readonly message: string; readonly files: readonly StoreFile[] }[];
}

/**
 * Every file a replay Ticket's run writes to the store, each arm in turn: its
 * Implement run's transcript and record, then its patch and gates, then its
 * Review run's, then the judge's transcript and record and the score file,
 * or the score file of a run the scoring plan skips.
 */
export function replayRunFiles(context: ReplayRunContext, arms: Readonly<Record<ReplayArm, ArmArtifacts>>, kit: KitRubrics, endedAt: string): ReplayRunFiles {
  const runs = armRunsOf(context, arms, endedAt);
  const ended = endedOf(context, runs);
  const { end } = ended;
  const writes: { message: string; files: StoreFile[] }[] = [];
  for (const { arm, implement, review } of runs) {
    const artifacts = arms[arm];
    if (implement.kind === "ran") {
      // Each arm of a Ticket has one patch and one gates file, so only the run the Ticket is done in keeps them.
      const at = { issue: context.issue, ticket: context.ticket, arm };
      const results: StoreFile[] =
        end.kind !== "done"
          ? []
          : [...(artifacts.patch === null ? [] : [{ path: replayPatchPath(context.repo, at), content: artifacts.patch }]), ...gatesFile(context, arm, artifacts.gates)];
      writes.push({ message: storeCommitMessage(implement.files.record), files: [...runFiles(implement.files, artifacts.implement), ...results] });
    }
    if (review.kind === "ran") writes.push({ message: storeCommitMessage(review.files.record), files: runFiles(review.files, artifacts.review) });
    if (implement.kind === "ran") writes.push(...scoringFiles(implement.files, artifacts.judge, kit, endedAt));
  }
  return { ended, writes };
}

/**
 * How a replay Ticket's run ended, from what its arms' jobs left, as
 * replayRunFiles says it too. It needs no rubrics and writes nothing, so the
 * replay-record job leaves it first, before anything else can fail.
 */
export function replayRunEnded(context: ReplayRunContext, arms: Readonly<Record<ReplayArm, ArmArtifacts>>, endedAt: string): ReplayRunEnded {
  return endedOf(context, armRunsOf(context, arms, endedAt));
}

/** Each arm's Implement and Review runs, in the arms' order, as their jobs left them. */
function armRunsOf(context: ReplayRunContext, arms: Readonly<Record<ReplayArm, ArmArtifacts>>, endedAt: string): ArmRuns {
  return REPLAY_ARMS.map((arm) => ({
    arm,
    implement: armRunOf(context, arm, "implement", arms[arm].implement, endedAt),
    review: armRunOf(context, arm, "review", arms[arm].review, endedAt),
  }));
}

/** How the run of these arms' runs ended, for the Loop to land. */
function endedOf(context: ReplayRunContext, runs: ArmRuns): ReplayRunEnded {
  const refused = runs.flatMap(({ implement, review }) => [implement, review]).find(isWeeklyLimit);
  return {
    issue: context.issue,
    ticket: context.ticket,
    run: context.runId,
    end: endOf(runs),
    subscription: context.subscription,
    resetsAt: refused?.kind === "ran" && refused.failureReport !== null ? (readFailureReport(refused.failureReport).resetsAt ?? null) : null,
  };
}

/** One of an arm's runs: it ran, with its record and failure report; its job never started it, with why; or its job left no account of it. */
type ArmRun =
  | { readonly kind: "ran"; readonly files: RunRecordFiles; readonly failureReport: string | null }
  | { readonly kind: "not-run"; readonly why: string }
  | { readonly kind: "missing" };

/** Each arm's two runs, in the arms' order. */
type ArmRuns = readonly { readonly arm: ReplayArm; readonly implement: ArmRun; readonly review: ArmRun }[];

function armRunOf(context: ReplayRunContext, arm: ReplayArm, role: ReplayRole, artifacts: ArmRunArtifacts, endedAt: string): ArmRun {
  const job = readArmJob(artifacts.job);
  if (job === null) return { kind: "missing" };
  if (!job.ran) return { kind: "not-run", why: job.why };
  return { kind: "ran", files: armRunRecord(context, arm, role, job.job, artifacts, endedAt), failureReport: artifacts.failureReport };
}

function isWeeklyLimit(run: ArmRun): boolean {
  return run.kind === "ran" && run.files.record.infrastructureFailure === "weekly-limit";
}

/**
 * How the Ticket's run ended: a weekly-limit refusal of any arm's run first,
 * a fact about the Subscription that costs the Ticket nothing; then, in the
 * arms' order, the first run that ended in another Infrastructure failure or
 * left no account of how it went; else done. Each arm's Implement run must
 * have run, while its Review may never have started, as when its patch
 * wasn't laid.
 */
function endOf(runs: ArmRuns): ReplayTicketEnd {
  if (runs.some(({ implement, review }) => isWeeklyLimit(implement) || isWeeklyLimit(review))) return { kind: "weekly-limit" };
  for (const { arm, implement, review } of runs) {
    for (const role of REPLAY_ROLES) {
      const run = role === "implement" ? implement : review;
      const name = `the ${arm} arm's ${RUN_NAMES[role]} run`;
      if (run.kind === "missing" || (run.kind === "not-run" && role === "implement")) {
        return { kind: "infrastructure", reason: `${name} left no account of how it went, as when its workflow run is cancelled` };
      }
      const failure = run.kind === "ran" ? run.files.record.infrastructureFailure : null;
      const detail = unreadInputsDetail(run);
      if (failure !== null) return { kind: "infrastructure", reason: `${name} ended in an Infrastructure failure (${failure})${detail === null ? "" : `: ${detail}`}` };
    }
  }
  return { kind: "done" };
}

/**
 * For a run whose input step failed on a GitHub read, the request and
 * GitHub's answer its failure report names (#328), so the replay issue says
 * which read to fix (#340); null for any other run.
 */
function unreadInputsDetail(run: ArmRun): string | null {
  if (run.kind !== "ran" || run.failureReport === null) return null;
  const report = readFailureReport(run.failureReport);
  return report.failure === "unread-inputs" && report.detail !== "" ? report.detail : null;
}

/** The arm's gates file, at its path beside the patch, when its gates job left one for this run. */
function gatesFile(context: ReplayRunContext, arm: ReplayArm, text: string | null): StoreFile[] {
  const gates = text === null ? null : readReplayArmGates(parsedJson(text));
  if (gates === null || gates.ticket !== context.ticket || gates.arm !== arm || gates.run !== context.runId) return [];
  return [{ path: replayGatesPath(context.repo, { issue: context.issue, ticket: context.ticket, arm }), content: storeJson(gates) }];
}

/** A run's transcript, if it left one, then its record. */
function runFiles(files: RunRecordFiles, artifacts: Pick<ArmRunArtifacts, "transcriptGzip">): StoreFile[] {
  return [
    ...(files.transcriptPath === null || artifacts.transcriptGzip === null ? [] : [{ path: files.transcriptPath, content: artifacts.transcriptGzip }]),
    { path: files.recordPath, content: storeJson(files.record) },
  ];
}

/**
 * Whether the judge scores an arm's Implement run, decided in the judge's job
 * before it runs, from the same record the replay-record job builds of the
 * run, so a run the scoring plan skips never spends a judge run (#286): with
 * why, for the step summary.
 */
export function armScoring(context: ReplayRunContext, arm: ReplayArm, implement: ArmRunArtifacts, endedAt: string): { readonly score: boolean; readonly why: string } {
  const run = armRunOf(context, arm, "implement", implement, endedAt);
  if (run.kind !== "ran") return { score: false, why: `the ${arm} arm's Implement run ${run.kind === "missing" ? "left no account of how it went" : `never started: ${run.why}`}` };
  const plan = scoringPlan(run.files.record);
  switch (plan.kind) {
    case "score":
      return { score: true, why: "the scoring plan picks every Replay arm's Implement run" };
    case "skip":
      return { score: false, why: `the scoring plan skips it: ${plan.skip.reason}` };
    case "not-sampled":
      return { score: false, why: "the scoring plan doesn't sample it" };
  }
}

/** The score file of the arm's Implement run, and the judge's run when the scoring plan had the judge score it. */
function scoringFiles(
  scored: RunRecordFiles,
  judge: ArmArtifacts["judge"],
  kit: KitRubrics,
  scoredAt: string,
): { message: string; files: StoreFile[] }[] {
  const plan = scoringPlan(scored.record);
  // The rubrics of the arm's pinned release, never its candidate Kit sha's.
  const rubrics = scoringRubrics(scored.record, kit);
  if (plan.kind === "skip") {
    const score = scoreFileFor({ scored: scored.record, scoredPath: scored.recordPath, rubrics, scoredAt, outcome: plan });
    return [{ message: storeCommitMessage(scored.record), files: [{ path: score.path, content: storeJson(score.file) }] }];
  }
  const ran = readArmJob(judge.job);
  if (plan.kind !== "score" || ran === null || !ran.ran) return [];
  const judged = judgeRunRecordFor({
    scored: scored.record,
    judge: ran.job,
    judgeModel: JUDGE_MODEL,
    kitSha: kit.sha,
    endedAt: scoredAt,
    failureReport: judge.failure,
    transcript: judge.transcript,
  });
  const score = scoreFileFor({
    scored: scored.record,
    scoredPath: scored.recordPath,
    rubrics,
    scoredAt,
    outcome: judgeOutcome({ result: judge.result, failure: judge.failure }, { model: judged.record.model, record: judged.recordPath }),
  });
  return [{ message: storeCommitMessage(judged.record), files: [...runFiles(judged, judge), { path: score.path, content: storeJson(score.file) }] }];
}

/** The record of one of an arm's runs, from its job's account and what the run left. */
function armRunRecord(context: ReplayRunContext, arm: ReplayArm, role: ReplayRole, job: NeededJob, artifacts: ArmRunArtifacts, endedAt: string): RunRecordFiles {
  const settings = context.arms[arm];
  return replayRunRecordFor({
    replay: { issue: context.issue, arm, ticket: context.ticket, candidateSha: settings.candidateSha },
    role,
    pullRequest: context.pullRequest,
    baseSha: context.baseSha,
    repo: context.repo,
    runId: context.runId,
    runAttempt: context.runAttempt,
    kitSha: context.kitSha,
    endedAt,
    job,
    settings: settings[role],
    subscription: context.subscription,
    agentResult: artifacts.agentResult,
    failureReport: artifacts.failureReport,
    transcript: artifacts.transcript,
  });
}

/**
 * Writes each group of a replay Ticket's files to the store, in order, each
 * file create-only and retrying a write a parallel commit beat: nothing when
 * the store isn't private.
 */
export async function writeReplayRun(store: StoreApi, files: ReplayRunFiles, wait: (ms: number) => Promise<void>): Promise<StoreWrite> {
  const written: string[] = [];
  const existing: string[] = [];
  for (const group of files.writes) {
    const write = await writeStoreFiles(store, group.files, group.message, wait);
    if (write.kind === "public-store") return write;
    written.push(...write.written);
    existing.push(...write.existing);
  }
  return { kind: "written", written, existing };
}
