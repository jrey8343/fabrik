// A review's hand-off, as each job of the run it starts runs it: the Kit
// job's program (src/kit/jobs.ts) and the claim and push jobs' (src/main.ts),
// each against a GitHub that answers the review's read as a test says and
// records which token asked. Each reads the review itself, and plans nothing
// when its read gives nothing.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aReview } from "../__fixtures__/handOffReview.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
const KIT_JOB = join(KIT_DIR, "src/kit/jobs.ts");
const LOOP = join(KIT_DIR, "src/main.ts");
const CALLER_PATH = ".github/workflows/fabrik.yml";
const REVIEW_READ = "GET /repos/acme/shop/pulls/45/reviews/123";

/** What GitHub's REST API answers for review 123 on PR #45: the Operator's Request changes, the repo's owner being the Operator, unless a test says otherwise. */
const theOwnersReview = (over: Record<string, unknown> = {}) => aReview({ user: { login: "acme", type: "User" }, ...over });

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/**
 * A GitHub holding the Product repo's caller workflow and no Kit config, which
 * answers the read of review 123 on PR #45 with `review` (a status and a
 * body), takes a comment on any issue, and answers 404 for anything else. It
 * records each call as its method and path, and the token that made it.
 */
async function gitHubAnswering(review: { status: number; body: unknown }): Promise<{ url: string; calls: { call: string; token: string }[] }> {
  const caller = await readFile(join(KIT_DIR, "templates/fabrik.yml"), "utf8");
  const calls: { call: string; token: string }[] = [];
  server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0]!;
    calls.push({ call: `${request.method} ${path}`, token: (request.headers.authorization ?? "").replace(/^Bearer /, "") });
    const answer = (status: number, body: unknown, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    // Drained before answering, so a posted comment's body never holds the connection.
    request.resume().on("end", () => {
      if (request.method === "GET" && path === `/repos/acme/shop/contents/${CALLER_PATH}`) return answer(200, caller, "application/vnd.github.raw+json");
      if (request.method === "GET" && path === "/repos/acme/shop/pulls/45/reviews/123") return answer(review.status, review.body);
      if (request.method === "POST" && /^\/repos\/acme\/shop\/issues\/\d+\/comments$/.test(path)) return answer(201, {});
      answer(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

/** Runs a job's program on a `workflow_dispatch` with these inputs: its exit code, what it logged, its step outputs and its step summary. */
async function runJob(
  program: string,
  inputs: Record<string, string> | null,
  env: Record<string, string>,
): Promise<{ status: number | null; log: string; outputs: string; summary: string }> {
  const dir = await tempDir("hand-off-run");
  // The Product repo's checkout, as the Kit job's sparse one holds it: the caller workflow, and no Kit config.
  const product = join(dir, "product");
  await mkdir(dirname(join(product, CALLER_PATH)), { recursive: true });
  await writeFile(join(product, CALLER_PATH), await readFile(join(KIT_DIR, "templates/fabrik.yml"), "utf8"));
  const [event, outputs, summary] = ["event.json", "outputs", "summary.md"].map((name) => join(dir, name)) as [string, string, string];
  await writeFile(event, JSON.stringify({ inputs, ref: "refs/heads/main", repository: { default_branch: "main" }, sender: { login: "github-actions[bot]", type: "Bot" } }));
  await writeFile(outputs, "");
  await writeFile(summary, "");
  const child = spawn(process.execPath, [program, product], {
    env: {
      PATH: process.env["PATH"] ?? "",
      GITHUB_REPOSITORY: "acme/shop",
      GITHUB_WORKFLOW_REF: `acme/shop/${CALLER_PATH}@refs/heads/main`,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_SHA: "a".repeat(40),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "9001",
      GITHUB_RUN_ATTEMPT: "1",
      // Where a push job downloads the agent job's artifacts; this run had no agent job, so it holds none.
      RUNNER_TEMP: dir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, log, outputs: await readFile(outputs, "utf8"), summary: await readFile(summary, "utf8") };
}

const HAND_OFF = { pull_request: "45", review: "123" };
const NOTHING = "The hand-off names review 123 on PR #45, which isn't a submitted review of the Operator's: nothing to do.";

describe("The Kit job on a review's hand-off", () => {
  it.each([
    ["that GitHub answers 404 for", { status: 404, body: { message: "Not Found" } }],
    ["that the Operator dismissed", { status: 200, body: theOwnersReview({ state: "DISMISSED" }) }],
    ["that is still pending", { status: 200, body: theOwnersReview({ state: "PENDING" }) }],
    ["that anyone but the Operator wrote", { status: 200, body: theOwnersReview({ user: { login: "someone-else", type: "User" } }) }],
    ["that is of another pull request", { status: 200, body: theOwnersReview({ pull_request_url: "https://api.github.com/repos/acme/shop/pulls/46" }) }],
  ])("reads the review with its own read-only token, and for one %s logs that there is nothing to do and routes nowhere", async (_case, review) => {
    const github = await gitHubAnswering(review);

    const { status, log, outputs } = await runJob(KIT_JOB, HAND_OFF, { GH_TOKEN: "ghs_kit_job", GITHUB_API_URL: github.url });

    expect(log).toContain(`${NOTHING}\n`);
    expect(outputs).toContain("route=none\n");
    expect(status).toBe(0);
    // The review's read is all it asks GitHub: with no event there is no snapshot to gather.
    expect(github.calls).toEqual([{ call: REVIEW_READ, token: "ghs_kit_job" }]);
  });

  it.each([
    ["a pull request input that is no whole number", { pull_request: "45abc", review: "123" }],
    ["no review input", { pull_request: "45" }],
    ["no inputs, as a manual one's", null],
  ])("doesn't act on a dispatch with %s, as on any event the Loop ignores, and asks GitHub nothing", async (_case, inputs) => {
    const github = await gitHubAnswering({ status: 200, body: theOwnersReview() });

    const { status, log, outputs } = await runJob(KIT_JOB, inputs, { GH_TOKEN: "ghs_kit_job", GITHUB_API_URL: github.url });

    expect(log).toContain("The Loop doesn't act on workflow_dispatch.\n");
    expect(log).not.toContain("hand-off");
    expect(outputs).toContain("route=none\n");
    expect(status).toBe(0);
    expect(github.calls).toEqual([]);
  });
});

describe("The claim job and the push job on a review's hand-off", () => {
  const APP = { FABRIK_APP_TOKEN: "ghs_fabrik_app", FABRIK_APP_SLUG: "fabrik-app" };
  const CLAIM = { ...APP, FABRIK_CLAIM: "true" };
  // The Kit job routed to the push job, as for the Operator's Comment review it read.
  const PUSH = { ...APP, FABRIK_NEEDS: JSON.stringify({ kit: { result: "success", outputs: { route: "push" } } }) };

  it.each([
    ["claim", CLAIM],
    ["push", PUSH],
  ])("the %s job reads the review itself, with its own token, and plans nothing when its read gives nothing, whatever the Kit job read", async (_job, env) => {
    // Dismissed since the Kit job read it.
    const github = await gitHubAnswering({ status: 200, body: theOwnersReview({ state: "DISMISSED" }) });

    const { status, summary } = await runJob(LOOP, HAND_OFF, { ...env, GITHUB_API_URL: github.url });

    expect(summary).toContain("Nothing to do: the hand-off names review 123 on PR #45, which isn't a submitted review of the Operator's\n");
    expect(status).toBe(0);
    expect(github.calls.filter(({ call }) => call === REVIEW_READ)).toEqual([{ call: REVIEW_READ, token: "ghs_fabrik_app" }]);
    // Nothing planned: it only read.
    expect(github.calls.filter(({ call }) => !call.startsWith("GET "))).toEqual([]);
  });

  it("a claim that fails is said on the pull request the hand-off's inputs name", async () => {
    // A refusal GitHub's client doesn't try again.
    const github = await gitHubAnswering({ status: 422, body: { message: "Unprocessable Entity" } });

    const { status, summary } = await runJob(LOOP, HAND_OFF, { ...CLAIM, GITHUB_API_URL: github.url });

    expect(status).toBe(1);
    expect(summary).toContain("The claim job is landing the claim of #45, taking its trigger label off as its run starts.");
    expect(summary).toContain("The claim job failed landing the claim of #45");
    expect(github.calls.filter(({ call }) => !call.startsWith("GET "))).toEqual([{ call: "POST /repos/acme/shop/issues/45/comments", token: "ghs_fabrik_app" }]);
  });
});
