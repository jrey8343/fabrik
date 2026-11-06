// Lays a Replay arm's candidate Kit sha over the pinned Kit checkout (#156,
// src/kit/overlay.ts): its prompts and Base skills pin, and nothing else, so
// the agent job's skills fetch and prompt read the candidate's while every
// program and workflow stays the pinned release (ADR-0003). It runs before the
// skills fetch (.github/actions/prepare-agent, its kit-candidate input).
//   node <kit>/src/kit/overlay-main.ts <kit checkout> <candidate sha>
// Env: GH_TOKEN, the job's read-only token, which reads the Fabrik repo;
// GITHUB_API_URL. A refused sha fails the step, before any secret loads.
import { GitHub } from "../github/client.ts";
import { overlayCandidate } from "./overlay.ts";
import { writeSummary } from "./stepFiles.ts";

async function main(kitDir: string, sha: string): Promise<void> {
  const token = process.env["GH_TOKEN"];
  if (token === undefined || token === "") throw new Error("GH_TOKEN is not set");
  const result = await overlayCandidate(kitDir, sha, new GitHub(token, process.env["GITHUB_API_URL"]));
  if (result.kind === "refused") {
    console.log(`::error title=Candidate Kit sha refused::${result.reason}`);
    process.exitCode = 1;
    return;
  }
  await writeSummary(`Laid the candidate Kit sha ${result.sha}'s ${result.paths.map((path) => `\`${path}\``).join(", ")} over the pinned Kit.\n`);
}

const [kitDir, sha] = process.argv.slice(2);
if (kitDir === undefined || sha === undefined) {
  console.error("Usage: node src/kit/overlay-main.ts <kit checkout> <candidate sha>");
  process.exitCode = 2;
} else {
  main(kitDir, sha).catch((error: unknown) => {
    console.log(`::error title=Candidate Kit overlay failed::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
