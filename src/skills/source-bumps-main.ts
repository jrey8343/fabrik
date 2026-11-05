// A Product repo's weekly skills bumps, for the Kit's scheduled tick to run
// (src/skills/sourceBumps.ts). It reads and writes the Product repo only
// through the API, as the Fabrik App, and reads each Skills source upstream
// through the public API with no credential.
//   GH_TOKEN=<Fabrik App token> GITHUB_REPOSITORY=owner/name node src/skills/source-bumps-main.ts
// Exits non-zero when the Kit config is invalid or any source failed to bump,
// after every other source has had its turn.
import { GitHub } from "../github/client.ts";
import { pushSourceBumps, type SourceBumpOutcome } from "./sourceBumps.ts";
import { defaultBranchOf, publicGet, readUpstreamSkills } from "./upstream.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function describe(source: SourceBumpOutcome): string {
  switch (source.outcome) {
    case "up-to-date":
      return `${source.repository}: no picked skill changed upstream; nothing to bump.`;
    case "closed-unmerged":
      return `${source.repository}: the bump to this commit was closed unmerged; nothing to do until upstream moves.`;
    case "opened":
      return `${source.repository}: opened #${source.pullRequest}.`;
    case "refreshed":
      return `${source.repository}: refreshed #${source.pullRequest}.`;
    case "unchanged":
      return `${source.repository}: #${source.pullRequest} already bumps to this commit.`;
    case "failed":
      return `${source.repository}: the bump failed: ${source.error}`;
  }
}

async function main(): Promise<void> {
  const [owner = "", name = ""] = required("GITHUB_REPOSITORY").split("/");
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"] || undefined);
  const upstream = publicGet();
  const result = await pushSourceBumps(github, { owner, name }, async (source) =>
    readUpstreamSkills(upstream, source, await defaultBranchOf(upstream, source.repository)),
  );
  if (!result.ok) {
    for (const error of result.errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }
  if (result.sources.length === 0) console.log("This repo pins no Skills sources; nothing to bump.");
  for (const source of result.sources) {
    if (source.outcome === "failed") {
      console.error(`::error::${describe(source)}`);
      process.exitCode = 1;
    } else {
      console.log(describe(source));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
