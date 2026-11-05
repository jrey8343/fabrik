// The write the Run record action's program (.github/actions/write-run-record):
// builds the Run record of the agent run that just ended (src/kit/runRecord.ts)
// and writes it, its transcript first, to the store (src/kit/recordWriter.ts).
// It writes one step-summary line saying what it did, or why it wrote nothing.
//   node src/kit/record-main.ts
// Reads FABRIK_NEEDS and the agent job's artifacts as src/main.ts does, the
// transcript from FABRIK_TRANSCRIPT_DIR, and two Fabrik App tokens:
// FABRIK_PRODUCT_TOKEN, to read the Product's Kit config, and FABRIK_STORE_TOKEN,
// scoped to the store, empty when it couldn't be minted.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { TRANSCRIPT_FILE } from "../agent/transcript.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { readIfPresent } from "./checkout.ts";
import { resolveKitConfig } from "./config.ts";
import type { Needs } from "./pushJob.ts";
import { type RecordOutcome, recordWriteSummary, writeRunRecord } from "./recordWriter.ts";
import { runRecordFor } from "./runRecord.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(line: string): Promise<void> {
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Run record\n\n${line}\n`);
}

/** The transcript the agent job kept, gzipped as loop.yml uploads it, or null if none survived the run. */
async function readTranscript(): Promise<Buffer | null> {
  const dir = process.env["FABRIK_TRANSCRIPT_DIR"] || join(required("RUNNER_TEMP"), "transcript");
  try {
    return await readFile(join(dir, `${TRANSCRIPT_FILE}.gz`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function outcome(): Promise<RecordOutcome> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const apiUrl = process.env["GITHUB_API_URL"];

  const config = resolveKitConfig(
    await readKitConfigSources(new GitHub(required("FABRIK_PRODUCT_TOKEN"), apiUrl), repo, required("GITHUB_SHA")),
  );
  if (!config.ok) throw new Error(`The Kit config is invalid: ${config.errors.join("; ")}`);

  const needs = JSON.parse(required("FABRIK_NEEDS")) as Needs;
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as Record<string, unknown>;
  const eventIssue = (payload["issue"] as { number?: unknown } | undefined)?.number;
  const agentDir = process.env["FABRIK_AGENT_DIR"] || join(required("RUNNER_TEMP"), "agent");
  const transcript = await readTranscript();

  const files = runRecordFor({
    needs,
    eventIssue: typeof eventIssue === "number" ? eventIssue : null,
    repo: `${owner}/${name}`,
    runId: Number(required("GITHUB_RUN_ID")),
    runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    kitSha: needs["kit"]?.outputs["sha"] ?? "",
    endedAt: new Date().toISOString(),
    roles: config.config.roles,
    agentResult: await readIfPresent(join(agentDir, AGENT_RESULT_FILE)),
    failureReport: await readIfPresent(join(agentDir, AGENT_FAILURE_FILE)),
    transcript: transcript === null ? null : gunzipSync(transcript).toString("utf8").split("\n").filter((line) => line !== ""),
  });
  if (files === null) return { kind: "no-record" };

  // No store, or the Fabrik App not installed on it: setup hasn't got that far, which never fails the run.
  const storeToken = process.env["FABRIK_STORE_TOKEN"] ?? "";
  if (storeToken === "") return { kind: "no-store-token" };
  return writeRunRecord(new GitHub(storeToken, apiUrl), files, transcript, (ms) => sleep(ms));
}

outcome()
  .then((result) => report(recordWriteSummary(result)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
