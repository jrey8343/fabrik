// The Tick's word that a newly pinned release is running (#548), in the
// scheduled tick's Release running job (.github/workflows/schedule.yml): says
// "Fabrik vX is running here" on the pull request that moved the caller
// workflow's pin to this run's release, once (src/github/releaseRunning.ts),
// and writes one step-summary line. It never fails the Tick: whatever goes
// wrong is that line, and the next Tick tries again.
//   node src/kit/release-running-main.ts
// Reads FABRIK_APP_TOKEN, the Fabrik App's token on the Product repo, which
// writes the comment; FABRIK_APP_SLUG, which tells the App's comments from
// anyone else's; FABRIK_KIT_REF, the Kit workflow ref the caller pinned;
// FABRIK_TICK_STARTED_AT, when the run's first job started; and
// FABRIK_TIME_ZONE, the Operator's time zone the Tick job read from the Kit
// config (ADR-0023), unset or unknown for UTC. GITHUB_REPOSITORY, GITHUB_SHA,
// GITHUB_SERVER_URL and GITHUB_RUN_ID name the repo, the commit the Tick ran
// on and its run.
import { appendFile } from "node:fs/promises";
import { GitHub } from "../github/client.ts";
import { confirmReleaseRunning } from "../github/releaseRunning.ts";
import { knownTimeZone } from "../loop/readable.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<string> {
  const [owner = "", name = ""] = required("GITHUB_REPOSITORY").split("/");
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"]);
  return confirmReleaseRunning(github, {
    repo: { owner, name },
    headSha: required("GITHUB_SHA"),
    kitRef: required("FABRIK_KIT_REF"),
    appLogin: `${required("FABRIK_APP_SLUG")}[bot]`,
    runUrl: `${process.env["GITHUB_SERVER_URL"] || "https://github.com"}/${owner}/${name}/actions/runs/${required("GITHUB_RUN_ID")}`,
    startedAt: process.env["FABRIK_TICK_STARTED_AT"] || new Date().toISOString(),
    timeZone: knownTimeZone(process.env["FABRIK_TIME_ZONE"]),
  });
}

const line = await main().catch((error: unknown) => `Couldn't say on the pin move's pull request which release is running here: ${error instanceof Error ? error.message : String(error)}. The next Tick tries again.`);
console.log(line);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined && summary !== "") await appendFile(summary, `### Release running\n\n- ${line}\n`).catch(() => undefined);
