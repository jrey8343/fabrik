// What a Kit program writes to its Actions step's files: its outputs, as
// GITHUB_OUTPUT takes them, and its step summary, which it also logs.
// Package-free, so any Kit program can import it, whether or not its job ran
// npm ci.
import { appendFile } from "node:fs/promises";

/** Appends the step summary, when the runner gives a file for it, and logs it. */
export async function writeSummary(text: string): Promise<void> {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path !== undefined && path !== "") await appendFile(path, text);
}

/** Appends step outputs, when the runner gives a file for them, each `key=value` on a line of its own. */
export async function writeOutputs(outputs: Readonly<Record<string, string>>): Promise<void> {
  const path = process.env["GITHUB_OUTPUT"];
  if (path === undefined || path === "") return;
  await appendFile(path, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}
