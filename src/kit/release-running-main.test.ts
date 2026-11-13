// The Release running job's program, run as schedule.yml runs it: whatever
// goes wrong, it exits green and writes one step-summary line (#548).
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const PROGRAM = join(resolve(import.meta.dirname, "..", ".."), "src/kit/release-running-main.ts");

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A GitHub API that refuses every call, as one would the App's read of a repo it can't reach. */
async function refusingGitHub(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Not Found" }));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Runs the program with this environment and a fresh step summary; its exit code and what it wrote there. */
async function runProgram(env: Record<string, string>): Promise<{ status: number | null; summary: string }> {
  const summary = join(await tempDir("release-running"), "summary.md");
  await writeFile(summary, "");
  const child = spawn(process.execPath, [PROGRAM], { env: { PATH: process.env["PATH"] ?? "", GITHUB_STEP_SUMMARY: summary, ...env }, stdio: "ignore" });
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, summary: await readFile(summary, "utf8") };
}

const RUN_ENV = {
  FABRIK_APP_TOKEN: "ghs_test",
  FABRIK_APP_SLUG: "fabrik-app",
  FABRIK_KIT_REF: "jrey8343/fabrik/.github/workflows/schedule.yml@v1.4.0",
  FABRIK_TICK_STARTED_AT: "2026-11-13T04:17:09Z",
  GITHUB_REPOSITORY: "acme/shop",
  GITHUB_SHA: "head0",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "42",
};

describe("The Release running program", () => {
  it("exits green and writes one step-summary line saying why when GitHub refuses its read", async () => {
    const { status, summary } = await runProgram({ ...RUN_ENV, GITHUB_API_URL: await refusingGitHub() });

    expect(status).toBe(0);
    expect(summary).toMatch(/^### Release running\n\n- Couldn't say on the pin move's pull request that Fabrik v1\.4\.0 is running here: GET \/repos\/acme\/shop\/commits\?\S+ failed with 404: Not Found\. The next Tick tries again\.\n$/);
  });

  it("exits green and writes one step-summary line when its environment is missing", async () => {
    const { status, summary } = await runProgram({});

    expect(status).toBe(0);
    expect(summary).toBe(
      "### Release running\n\n- Couldn't say on the pin move's pull request which release is running here: GITHUB_REPOSITORY is not set. The next Tick tries again.\n",
    );
  });
});
