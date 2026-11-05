// Reads the Ticket a scored run built, for the judge (src/kit/judge-main.ts):
// its title and body only, through the judge job's read-only token, in a step
// of its own before the Claude token loads, so the token stays out of the
// judge's env. That keeps things tidy but is no boundary (ADR-0004): the judge
// can't write because its job holds only that read-only token. The Ticket may
// have been edited since the run; the judge sees it as it is now, which is
// close enough.
//   node src/kit/judge-ticket-main.ts <out file>
// Env: GH_TOKEN, the job's read-only GITHUB_TOKEN; FABRIK_TICKET, the Ticket's number.
import { writeFile } from "node:fs/promises";
import { GitHub } from "../github/client.ts";
import type { JudgedTicket } from "./scorerPrompt.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(outFile: string): Promise<void> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const number = Number(required("FABRIK_TICKET"));
  if (!Number.isInteger(number) || number < 1) throw new Error(`FABRIK_TICKET is not an issue number: ${process.env["FABRIK_TICKET"]}`);
  const github = new GitHub(required("GH_TOKEN"), process.env["GITHUB_API_URL"]);
  const issue = (await github.rest("GET", `/repos/${owner}/${name}/issues/${number}`)) as { title?: unknown; body?: unknown };
  const ticket: JudgedTicket = {
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.body === "string" ? issue.body : "",
  };
  await writeFile(outFile, `${JSON.stringify(ticket, null, 2)}\n`);
  console.log(`Read #${number} for the judge: ${ticket.title}`);
}

const outFile = process.argv[2];
if (outFile === undefined) {
  console.error("Usage: node src/kit/judge-ticket-main.ts <out file>");
  process.exitCode = 2;
} else {
  main(outFile).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
