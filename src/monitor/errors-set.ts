// The gate on the Monitor's Sentry token, for the scheduled tick's Monitor
// job: writes `errors=true` to the step's outputs when the Product repo's Kit
// config sets monitor.errors, else `errors=false`, so the job loads the Sentry
// token only for a repo that reads production errors.
//   GITHUB_OUTPUT=<file> FABRIK_APP_TOKEN=<token> node src/monitor/errors-set.ts
// It reads the Kit config through the API at the commit the run is for, the
// default branch's head on the scheduled tick, as the Monitor does
// (src/monitor/main.ts), and never checks out Product code. An invalid Kit
// config gives `errors=false`: the Monitor then reports it and does nothing.
import { appendFile } from "node:fs/promises";
import { GitHub, type Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { resolveKitConfig } from "../kit/config.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const output = required("GITHUB_OUTPUT");
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const github = new GitHub(required("FABRIK_APP_TOKEN"), process.env["GITHUB_API_URL"] || undefined);

  const result = resolveKitConfig(await readKitConfigSources(github, repo, required("GITHUB_SHA")));
  const errors = result.ok && result.config.monitor.errors !== null;
  console.log(
    !result.ok
      ? "The Kit config is invalid, so no Sentry token loads; the Monitor says why."
      : errors
        ? "The Kit config sets monitor.errors, so the Sentry token loads."
        : "The Kit config leaves monitor.errors off, so no Sentry token loads.",
  );
  await appendFile(output, `errors=${errors}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
