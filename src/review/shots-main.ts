// The review job's Evidence shots steps (#820), on a UI pull request in a
// Product repo whose Kit config has ui.shots, once the Required checks have
// been waited for. Kit code with the job's read-only token, which reaches
// GitHub only through env; the Reviewer never holds it.
//   node src/review/shots-main.ts find
//     Finds the newest attempt of the named check at the head, and the artifact it uploaded (src/review/shotsRun.ts).
//     Env: GH_TOKEN (actions: read), GITHUB_REPOSITORY, FABRIK_UI_SHOTS (the Kit job's ui-shots), FABRIK_HEAD_SHA.
//     Writes step outputs: run (the workflow run, empty for none), artifact (its id, empty for none).
//   node src/review/shots-main.ts read
//     Reads the artifact the workflow downloaded against the pull request's names, and writes the Evidence page
//     (src/review/shotsRead.ts).
//     Env: FABRIK_UI_SHOTS, FABRIK_HEAD_SHA, FABRIK_SHOTS_DIR (where it was downloaded), FABRIK_SHOTS_ARTIFACT (the find
//     step's artifact, empty for none), FABRIK_REVIEW_NEEDS (the Review's jobs, as JSON, for whether the named check is
//     still red), FABRIK_TICKET, FABRIK_OUT_DIR.
//     Writes step outputs: shots (what it collected, one line of JSON holding agent text, so read through `env:`),
//     reviewer ("skip" when a miss that sends back stops the Reviewer, or the found artifact's download left nothing to
//     read, when shots is empty; else "run"), page ("true" when it wrote the
//     Evidence page, EVIDENCE_PAGE_FILE in FABRIK_OUT_DIR).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EVIDENCE_PAGE_FILE } from "../evidence/capture.ts";
import { reviewShotsFrom } from "../evidence/shotsCollect.ts";
import { GitHub } from "../github/client.ts";
import { type Needs, reviewChecksOf } from "../kit/pushJob.ts";
import { writeOutputs } from "../kit/stepFiles.ts";
import { readDownloadedShots } from "./shotsRead.ts";
import { findShotsArtifact } from "./shotsRun.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function find(): Promise<void> {
  const [owner = "", name = ""] = required("GITHUB_REPOSITORY").split("/");
  const shots = reviewShotsFrom(required("FABRIK_UI_SHOTS"));
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  const found = await findShotsArtifact(github, { owner, name }, { headSha: required("FABRIK_HEAD_SHA"), check: shots.check, artifact: shots.artifact });
  await writeOutputs({ run: String(found?.run ?? ""), artifact: String(found?.artifact ?? "") });
}

async function read(): Promise<void> {
  const given = reviewShotsFrom(required("FABRIK_UI_SHOTS"));
  const { outcome, failedChecks } = reviewChecksOf(JSON.parse(required("FABRIK_REVIEW_NEEDS")) as Needs);
  const { collected, page } = await readDownloadedShots({
    dir: required("FABRIK_SHOTS_DIR"),
    found: (process.env["FABRIK_SHOTS_ARTIFACT"] ?? "") !== "",
    given,
    head: required("FABRIK_HEAD_SHA"),
    // Red after everything the Kit could do: the Reviewer's judgment of the check decides, and evidence sends nothing back.
    red: outcome === "red" && failedChecks.includes(given.check),
    ticket: Number(required("FABRIK_TICKET")),
  });
  const outDir = required("FABRIK_OUT_DIR");
  if (page !== null) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, EVIDENCE_PAGE_FILE), page);
  }
  // Nothing read of an artifact the check uploaded stops the Reviewer with no shots, which the push job lands as nothing.
  await writeOutputs({ shots: collected === null ? "" : JSON.stringify(collected), reviewer: collected === null || collected.sendsBack ? "skip" : "run", page: String(page !== null) });
}

const step = process.argv[2];
if (step === "find") await find();
else if (step === "read") await read();
else throw new Error(`Usage: node src/review/shots-main.ts find|read, not ${step ?? "nothing"}`);
