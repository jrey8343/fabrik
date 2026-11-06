// The preview steps' program (#153, #155): the link-preview action's, for a
// UI PR, and the link-prototype-preview action's, for a prototype round, each
// with a token of its own (.github/actions/). It polls the preview until it
// answers, for PREVIEW_POLL_MINUTES at most, then links it, in the PR's
// evidence section or beside each of the round's variants, or says it never
// answered (src/kit/previewLink.ts). It writes one step-summary line saying which.
//   node src/kit/preview-main.ts
// Reads FABRIK_PREVIEW_URL, which Run the Loop passed out, and either
// FABRIK_PREVIEW_ROUND, the prototype round's comment, or
// FABRIK_PREVIEW_PULL_REQUEST, whose evidence section waiting on the preview
// is this Actions run's (GITHUB_RUN_ID), the run whose Implement job captured
// it; and FABRIK_APP_TOKEN, a Fabrik App token that can edit only that.
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { PrototypePreviewToLink } from "../github/apply.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { httpStatus, linkPreview, previewLinkSummary, type PreviewToPoll, prototypePreviewSummary } from "./previewLink.ts";

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
  const url = required("FABRIK_PREVIEW_URL");
  const forRound = (process.env["FABRIK_PREVIEW_ROUND"] ?? "") !== "";
  const preview: PreviewToPoll | PrototypePreviewToLink = forRound
    ? { round: wholeNumber("FABRIK_PREVIEW_ROUND"), url }
    : { pullRequest: wholeNumber("FABRIK_PREVIEW_PULL_REQUEST"), url, run: wholeNumber("GITHUB_RUN_ID") };
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"]);

  const outcome = await linkPreview(github, repo, preview, {
    status: (polled) => httpStatus(polled),
    wait: (ms) => sleep(ms),
    now: () => Date.now(),
  });
  const [heading, line] =
    "round" in preview
      ? ["The prototype's previews", prototypePreviewSummary(preview.round, url, outcome)]
      : ["Preview deployment", previewLinkSummary(preview.pullRequest, url, outcome)];
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### ${heading}\n\n${line}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
