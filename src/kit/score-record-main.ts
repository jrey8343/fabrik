// The score-record action's program (.github/actions/write-score-record): the
// judge run's own push job (#149). It builds the judge's Run record, in role
// `score` (src/kit/runRecord.ts), and the score file (src/kit/scorer.ts) from
// how the judge ended (src/kit/judge.ts), and writes the judge's transcript,
// its record and the score file to the store, each create-only
// (src/kit/scoreRecord.ts). It runs no agent and no Product code, and writes
// one step-summary line saying what it scored, or why it didn't.
//   node src/kit/score-record-main.ts
// Reads FABRIK_NEEDS (the judge job's entry, and the Kit job's sha), the
// scored run's record path in the store from FABRIK_SCORED_RECORD, the judge's
// artifacts from FABRIK_JUDGE_DIR and its transcript from FABRIK_TRANSCRIPT_DIR,
// and FABRIK_STORE_TOKEN, scoped to the store, empty when it couldn't be minted.
import { Buffer } from "node:buffer";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readTranscriptGzip, TRANSCRIPT_FILE } from "../agent/transcript.ts";
import { GitHub } from "../github/client.ts";
import { readBytesIfPresent, readIfPresent } from "./checkout.ts";
import { JUDGE_FAILURE_FILE, JUDGE_JOB, JUDGE_RESULT_FILE, judgeOutcome } from "./judge.ts";
import { loadRubrics } from "./kitFiles.ts";
import type { Needs } from "./pushJob.ts";
import type { StoreApi } from "./recordWriter.ts";
import { judgeRunRecordFor, type RunRecord } from "./runRecord.ts";
import { JUDGE_MODEL, RUN_STORE } from "./runStore.ts";
import { type ScoreRecordOutcome, scoreRecordSummary, writeScoreRecord } from "./scoreRecord.ts";
import { scoreFileFor } from "./scorer.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(line: string): Promise<void> {
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Scores\n\n${line}\n`);
}

/** A file's text from the store's default branch, or null if it isn't there. */
async function storeText(store: StoreApi, path: string): Promise<string | null> {
  const contents = `/repos/${RUN_STORE.owner}/${RUN_STORE.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const file = (await store.rest("GET", contents, undefined, { allowNotFound: true })) as { content?: unknown } | null;
  return typeof file?.content === "string" ? Buffer.from(file.content, "base64").toString("utf8") : null;
}

async function outcome(): Promise<ScoreRecordOutcome> {
  const needs = JSON.parse(required("FABRIK_NEEDS")) as Needs;
  const judge = needs[JUDGE_JOB];
  if (judge === undefined || judge.result === "skipped") return { kind: "no-judge" };
  const storeToken = process.env["FABRIK_STORE_TOKEN"] ?? "";
  if (storeToken === "") return { kind: "no-store-token" };
  // Every record names the Kit commit that wrote it: without one, write none.
  const kitSha = needs["kit"]?.outputs["sha"] ?? "";
  if (kitSha === "") throw new Error("The Kit job passed out no sha, so the judge's Run record can't name its Kit commit");

  const store = new GitHub(storeToken, process.env["GITHUB_API_URL"]);
  // Written by this workflow run's push job, which passed out its path.
  const scoredPath = required("FABRIK_SCORED_RECORD");
  const scoredText = await storeText(store, scoredPath);
  if (scoredText === null) throw new Error(`The store has no Run record at ${scoredPath} to score`);
  const scored = JSON.parse(scoredText) as RunRecord;

  const judgeDir = process.env["FABRIK_JUDGE_DIR"] || join(required("RUNNER_TEMP"), "judge");
  const transcriptDir = process.env["FABRIK_TRANSCRIPT_DIR"] || join(required("RUNNER_TEMP"), "judge-transcript");
  const gzip = await readBytesIfPresent(join(transcriptDir, `${TRANSCRIPT_FILE}.gz`));
  const transcript = gzip === null ? null : readTranscriptGzip(gzip);
  const failure = await readIfPresent(join(judgeDir, JUDGE_FAILURE_FILE));
  const endedAt = new Date().toISOString();

  const judgeFiles = judgeRunRecordFor({
    scored,
    judge,
    judgeModel: JUDGE_MODEL,
    kitSha,
    endedAt,
    failureReport: failure,
    transcript: transcript?.lines ?? null,
  });
  const score = scoreFileFor({
    scored,
    scoredPath,
    // The Kit's rubrics at the commit the judge ran, since both jobs check out the Kit job's sha.
    rubrics: await loadRubrics(),
    scoredAt: endedAt,
    outcome: judgeOutcome(
      { result: await readIfPresent(join(judgeDir, JUDGE_RESULT_FILE)), failure },
      { model: judgeFiles.record.model, record: judgeFiles.recordPath },
    ),
  });
  return writeScoreRecord(store, { judge: judgeFiles, judgeTranscriptGzip: transcript?.gzip ?? null, score }, (ms) => sleep(ms));
}

outcome()
  .then((result) => report(scoreRecordSummary(result)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
