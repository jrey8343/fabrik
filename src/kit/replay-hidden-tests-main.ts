// The replay gates job's first program (#156): reads the replayed Ticket's
// merged PR, with the job's read-only token, before any Product code runs or
// any secret loads: the commit it merged as, and its hidden tests, the test
// files it added or changed (hiddenTests, src/kit/replay.ts), which the gates
// lay over the arm's tree from that commit (src/kit/replay-gates-main.ts).
//   node src/kit/replay-hidden-tests-main.ts <output file>
// Env: GH_TOKEN, the read-only token; FABRIK_PULL_REQUEST, the merged PR.
import { writeFile } from "node:fs/promises";
import { GitHub } from "../github/client.ts";
import { filesOf } from "../github/replaySlice.ts";
import { hiddenTests } from "./replay.ts";
import type { HiddenTestsAt } from "./replayGates.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(outFile: string): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo = { owner, name };
  const number = Number(required("FABRIK_PULL_REQUEST"));
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  const pullRequest = (await github.rest("GET", `/repos/${owner}/${name}/pulls/${number}`)) as { merged?: unknown; merge_commit_sha?: unknown };
  if (pullRequest.merged !== true || typeof pullRequest.merge_commit_sha !== "string") throw new Error(`#${number} isn't a merged PR`);
  const paths = hiddenTests((await filesOf(github, repo, [number]))[number] ?? []);
  const at: HiddenTestsAt = { mergeCommit: pullRequest.merge_commit_sha, paths };
  await writeFile(outFile, `${JSON.stringify(at, null, 2)}\n`);
  console.log(paths.length === 0 ? `#${number} added or changed no test files: no hidden tests.` : `Hidden tests from #${number}: ${paths.join(", ")}`);
}

const [outFile] = process.argv.slice(2);
if (outFile === undefined) {
  console.error("Usage: node src/kit/replay-hidden-tests-main.ts <output file>");
  process.exitCode = 2;
} else {
  main(outFile).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
