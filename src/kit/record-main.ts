// The write the Run record action's program (.github/actions/write-run-record):
// builds the Run record of the agent run that just ended (src/kit/runRecord.ts)
// and writes it, its transcript first, to the store (src/kit/recordWriter.ts).
// It writes one step-summary line saying what it did, or why it wrote nothing.
// Then, for a record now in the store, it runs the scoring plan on it
// (src/kit/scoreRecord.ts, #149): a skip's score file it writes itself; a
// score it asks of the judge job through the step outputs `score` ("true")
// and `record` (the scored record's store path), with a step-summary line.
//   node src/kit/record-main.ts
// Reads FABRIK_NEEDS and the agent job's artifacts as src/main.ts does, the
// transcript from FABRIK_TRANSCRIPT_DIR, and two Fabrik App tokens:
// FABRIK_PRODUCT_TOKEN, to read the Product's Kit config, and FABRIK_STORE_TOKEN,
// scoped to the store, empty when it couldn't be minted. FABRIK_EMPTY_DIFF is
// "true" when the Loop found the Implement run's branch changed nothing.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { readTranscriptGzip, TRANSCRIPT_FILE } from "../agent/transcript.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { readBytesIfPresent, readIfPresent } from "./checkout.ts";
import { resolveKitConfig } from "./config.ts";
import { loadRubrics } from "./kitFiles.ts";
import type { Needs } from "./pushJob.ts";
import { type RecordOutcome, type RecordWrite, recordWriteSummary, writeRunRecord } from "./recordWriter.ts";
import { agentRunEnded, runRecordFor, type RunRecordFiles } from "./runRecord.ts";
import { recordedRunScoringSummary, scoreRecordedRun } from "./scoreRecord.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(heading: string, line: string): Promise<void> {
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### ${heading}\n\n${line}\n`);
}

/**
 * How writing the record went, and, once a store token was in hand, the store,
 * what was written to it and the Kit commit this job checked out, for scoring.
 */
interface Recorded {
  readonly outcome: RecordOutcome;
  readonly written: { readonly store: GitHub; readonly files: RunRecordFiles | null; readonly write: RecordWrite; readonly kitSha: string } | null;
}

async function recordRun(): Promise<Recorded> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const apiUrl = process.env["GITHUB_API_URL"];

  // Settled before anything is read through a token, so nothing can fail ahead of the quiet line.
  const needs = JSON.parse(required("FABRIK_NEEDS")) as Needs;
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const issue = (payload["issue"] as { number?: unknown } | undefined)?.number;
  const eventIssue = typeof issue === "number" ? issue : null;
  if (!agentRunEnded(needs, eventIssue)) return { outcome: { kind: "no-record" }, written: null };
  // No store, or the Fabrik App not installed on it: setup hasn't got that far, which never fails the run.
  const storeToken = process.env["FABRIK_STORE_TOKEN"] ?? "";
  if (storeToken === "") return { outcome: { kind: "no-store-token" }, written: null };
  // Every record names the Kit commit that wrote it: without one, write none.
  const kitSha = needs["kit"]?.outputs["sha"] ?? "";
  if (kitSha === "") throw new Error("The Kit job passed out no sha, so the Run record can't name its Kit commit");

  const config = resolveKitConfig(
    await readKitConfigSources(new GitHub(required("FABRIK_PRODUCT_TOKEN"), apiUrl), repo, required("GITHUB_SHA")),
  );
  if (!config.ok) throw new Error(`The Kit config is invalid: ${config.errors.join("; ")}`);

  const agentDir = process.env["FABRIK_AGENT_DIR"] || join(required("RUNNER_TEMP"), "agent");
  const transcriptDir = process.env["FABRIK_TRANSCRIPT_DIR"] || join(required("RUNNER_TEMP"), "transcript");
  // Gzipped as loop.yml uploads it; cut off by a timeout, it keeps the lines that decoded.
  const gzip = await readBytesIfPresent(join(transcriptDir, `${TRANSCRIPT_FILE}.gz`));
  const transcript = gzip === null ? null : readTranscriptGzip(gzip);

  const files = runRecordFor({
    needs,
    eventIssue,
    repo: `${owner}/${name}`,
    runId: Number(required("GITHUB_RUN_ID")),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    kitSha,
    endedAt: new Date().toISOString(),
    roles: config.config.roles,
    subscriptions: config.config.subscriptions,
    agentResult: await readIfPresent(join(agentDir, AGENT_RESULT_FILE)),
    failureReport: await readIfPresent(join(agentDir, AGENT_FAILURE_FILE)),
    transcript: transcript?.lines ?? null,
    emptyDiff: process.env["FABRIK_EMPTY_DIFF"] === "true",
  });
  const store = new GitHub(storeToken, apiUrl);
  const write = await writeRunRecord(store, files, transcript?.gzip ?? null, (ms) => sleep(ms));
  return { outcome: write, written: { store, files, write, kitSha } };
}

async function main(): Promise<void> {
  const { outcome, written } = await recordRun();
  // Before scoring, so a scoring problem never hides what happened to the record.
  await report("Run record", recordWriteSummary(outcome));
  if (written === null) return;
  // The rubrics in this job's Kit checkout, at the Kit job's sha.
  const kit = { sha: written.kitSha, rubrics: await loadRubrics() };
  const scoring = await scoreRecordedRun(written.store, written, kit, new Date().toISOString(), (ms) => sleep(ms));
  // The judge job runs on these, and the score-record job reads the scored record back from the store by its path.
  if (scoring.kind === "score") await appendFile(required("GITHUB_OUTPUT"), `score=true\nrecord=${scoring.record}\n`);
  const line = recordedRunScoringSummary(scoring);
  if (line !== null) await report("Scores", line);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
