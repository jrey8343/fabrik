// The link-preview action's program (.github/actions/link-preview), the push
// job's preview step (#153): polls a UI PR's preview deployment until it
// answers, for PREVIEW_POLL_MINUTES at most, and links it in the PR's evidence
// section, or says it never answered (src/kit/previewLink.ts). It writes one
// step-summary line saying which.
//   node src/kit/preview-main.ts
// Reads FABRIK_PREVIEW_URL and FABRIK_PREVIEW_PULL_REQUEST, which Run the Loop
// passed out, and FABRIK_APP_TOKEN, a Fabrik App token that can edit the PR's
// body. The evidence section waiting on the preview is this Actions run's
// (GITHUB_RUN_ID), the run whose Implement job captured it.
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { GitHub, type Repo } from "../github/client.ts";
import { httpStatus, linkPreview, previewLinkSummary } from "./previewLink.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function wholeNumber(name: string): number {
  const n = Number(required(name));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} is not a whole number`);
  return n;
}

async function main(): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const pullRequest = wholeNumber("FABRIK_PREVIEW_PULL_REQUEST");
  const url = required("FABRIK_PREVIEW_URL");
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"]);

  const outcome = await linkPreview(
    github,
    repo,
    { pullRequest, url, run: wholeNumber("GITHUB_RUN_ID") },
    { status: (polled) => httpStatus(polled), wait: (ms) => sleep(ms), now: () => Date.now() },
  );
  const line = previewLinkSummary(pullRequest, url, outcome);
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Preview deployment\n\n${line}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
