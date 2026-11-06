// The replay-store action's first look (.github/actions/replay-store), for the
// scheduled tick's replay step (#156): whether this repo has an open replay
// issue, and, when it has, which of the fabrik-runs store's paths the tick
// checks out for it (replayStorePaths). With none open the action reads
// nothing of the store, so a repo with no experiment spends nothing new.
// Writes `open=true` or `open=false`, and `paths`, one pattern a line, to
// GITHUB_OUTPUT.
//   node src/kit/replay-store-main.ts
// Env: GH_TOKEN, a token that reads this repo's issues.
import { appendFile } from "node:fs/promises";
import { GitHub } from "../github/client.ts";
import { REPLAY_LABEL } from "../loop/labels.ts";
import { replayStorePaths } from "./replayFacts.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const repo = required("GITHUB_REPOSITORY");
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  // The issues API lists pull requests too, and anyone can put any label on one.
  const issues = (await github.rest("GET", `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(REPLAY_LABEL)}&per_page=100`)) as {
    pull_request?: unknown;
  }[];
  const open = issues.some((issue) => issue.pull_request === undefined);
  const paths = open ? replayStorePaths(repo, new Date().toISOString()) : [];
  await appendFile(required("GITHUB_OUTPUT"), `open=${open}\npaths<<FABRIK_PATHS\n${paths.map((path) => `${path}\n`).join("")}FABRIK_PATHS\n`);
  console.log(open ? `A replay issue is open, so the tick reads the store: ${paths.join(", ")}` : "No replay issue is open, so the tick reads nothing of the store for one.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
