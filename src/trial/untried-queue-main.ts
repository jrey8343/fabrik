// The untried queue command (#966), which the Operator, or /fabrik-trial for
// them, runs from a Fabrik download at the release the Product repo pins, in
// the Product repo's checkout:
//   node <fabrik>/src/trial/untried-queue-main.ts [<pull request>]
// With no argument it prints, as JSON, every merged agent pull request untried
// on staging, oldest merge first, each with its links and its Trial steps;
// with a pull request's number, that one, whatever its result, with its
// Standing's name and the Kit's sentence for it. Beside them it prints
// staging.url and production.url. Anything else is one line on stderr and a
// non-zero exit. It reads GitHub with the credential the checkout's gh gives,
// the Operator's own, and writes nothing, there or on disk. It needs gh and
// nothing installed: no module it reaches imports an npm package. Thin by
// design: what is untried is the read library's to say (untriedQueue.ts).
import { spawnSync } from "node:child_process";
import { GitHub } from "../read/index.ts";
import { readUntriedQueue } from "./untriedQueue.ts";

/** What `gh` prints for these arguments in the checkout; a failure names the command and gives gh's own first line. */
function gh(...args: readonly string[]): string {
  const named = `gh ${args.slice(0, 2).join(" ")}`;
  const ran = spawnSync("gh", args, { encoding: "utf8" });
  if (ran.error !== undefined) throw new Error((ran.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh isn't installed, or isn't on PATH" : `${named} failed: ${ran.error.message}`);
  if (ran.status !== 0) throw new Error(`${named} failed: ${ran.stderr.trim().split("\n")[0] || `exit ${ran.status}`}`);
  return ran.stdout.trim();
}

async function main(pullRequest: number | null): Promise<number> {
  const token = gh("auth", "token");
  const repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
  const read = await readUntriedQueue(new GitHub(token, process.env["GITHUB_API_URL"] || undefined), repo, pullRequest, new Date().toISOString());
  if (!read.ok) {
    console.error(read.problem);
    return 1;
  }
  console.log(JSON.stringify(read.printed, null, 2));
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || !args.every((arg) => /^[1-9]\d*$/.test(arg))) {
    console.error("Usage: node src/trial/untried-queue-main.ts [<pull request>], from the Product repo's checkout, where <pull request> is a merged agent pull request's number");
    process.exit(2);
  }
  // The exit code is set, not forced, so a long list is written whole before the program ends.
  main(args[0] === undefined ? null : Number(args[0])).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
