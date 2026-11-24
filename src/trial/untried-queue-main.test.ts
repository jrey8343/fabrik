// The untried queue command (#966), run as the Operator and /fabrik-trial run
// it: from a Product repo's checkout, with the credential `gh` gives, against
// a canned GitHub that logs every request made of it.
import { spawn } from "node:child_process";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RawRepo } from "../__fixtures__/cannedRepo.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { forbiddenImportsFrom, runtimeImportsIn } from "../read/importWalk.ts";
import { aDeployment, anAgentMerge, declaring, labelledByOperator, LIVE, type Request, stagingRepo } from "./stagingRepo.fixture.ts";

const KIT = resolve(import.meta.dirname, "..", "..");
const PROGRAM = join(KIT, "src/trial/untried-queue-main.ts");
/** The credential the checkout's `gh` gives. */
const TOKEN = "gho_the_operators_own";

/** Three merged agent pull requests, each on staging by a deploy of its own merge: 55 and 57 untried, and 56, between them, accepted by the Operator. */
const THREE_ON_STAGING: RawRepo = {
  files: declaring(),
  deployments: {
    production: [LIVE],
    staging: [aDeployment("staging", 655, 55, "2026-11-05T10:05:00Z"), aDeployment("staging", 656, 56, "2026-11-06T10:05:00Z"), aDeployment("staging", 657, 57, "2026-11-07T10:05:00Z")],
  },
  mergedPullRequests: [
    anAgentMerge(57, "2026-11-07T10:00:00Z", { title: "Show the cart's tax" }),
    anAgentMerge(56, "2026-11-06T10:00:00Z", { title: "Show the cart's count", timelineItems: { nodes: [labelledByOperator("fabrik:trial-accepted", "2026-11-08T09:00:00Z")] } }),
    anAgentMerge(55, "2026-11-05T10:00:00Z", { title: "Show the cart's total" }),
  ],
};

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** One request the canned GitHub was sent over HTTP, with the credential it carried. */
type Sent = Request & { readonly authorization: string | undefined };

/** `client` served as GitHub's API is: a GraphQL request at `/graphql`, and any other as a REST one. Its address, and every request it was sent. */
async function served(client: ReadClient): Promise<{ url: string; sent: Sent[] }> {
  const sent: Sent[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { method = "", url: path = "" } = request;
      const body = chunks.length === 0 ? null : (JSON.parse(Buffer.concat(chunks).toString()) as { query: string; variables: Record<string, unknown> });
      const graphql = method === "POST" && path === "/graphql" && body !== null;
      sent.push({ method, path, operation: !graphql ? null : /^\s*mutation\b/.test(body.query) ? "mutation" : "query", authorization: request.headers.authorization });
      const answered = graphql ? client.graphql(body.query, body.variables).then((data) => ({ data })) : client.rest(method, path);
      answered.then(
        (answer) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)),
        (error: unknown) => response.writeHead(error instanceof GitHubError ? error.status : 500, { "content-type": "application/json" }).end(error instanceof GitHubError ? error.body : JSON.stringify({ message: String(error) })),
      );
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent };
}

/** A folder holding a `gh` that gives the Operator's credential and says the checkout is `jrey8343/shop`'s, or, signed out, fails as `gh` does. */
async function aGh(signedIn = true): Promise<string> {
  const bin = await tempDir("untried-queue-gh");
  const token = signedIn ? `echo ${TOKEN}` : 'echo "no oauth token found for github.com" >&2; exit 1';
  const script = ["#!/bin/sh", 'case "$1 $2" in', `  "auth token") ${token} ;;`, '  "repo view") echo jrey8343/shop ;;', '  *) echo "unexpected: gh $*" >&2; exit 1 ;;', "esac", ""].join("\n");
  await writeFile(join(bin, "gh"), script);
  await chmod(join(bin, "gh"), 0o755);
  return bin;
}

/** Runs the command in an empty checkout, against `raw` served as GitHub; how it ended, what GitHub was sent, and what the checkout holds afterwards. */
async function command(raw: RawRepo, args: readonly string[] = [], gh: Promise<string> = aGh()) {
  const { url, sent } = await served(stagingRepo({ ...raw, readAtAnyTime: true }).client);
  const checkout = await tempDir("untried-queue-checkout");
  const child = spawn(process.execPath, [PROGRAM, ...args], { cwd: checkout, env: { PATH: await gh, GITHUB_API_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, stdout, stderr, sent, left: await readdir(checkout) };
}

describe("The untried queue command", () => {
  it("prints the untried queue as JSON, oldest merge first, each with its Trial steps, beside staging.url and production.url, and exits 0", async () => {
    const run = await command(THREE_ON_STAGING);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      repo: "jrey8343/shop",
      staging: { url: "https://staging.shop.example" },
      production: { url: "https://shop.example" },
      untried: [
        { number: 55, title: "Show the cart's total", url: "https://github.com/jrey8343/shop/pull/55", trialSteps: { summary: "A shopper now sees the cart's total.", steps: [{ url: "https://staging.shop.example/cart" }] } },
        { number: 57, title: "Show the cart's tax", url: "https://github.com/jrey8343/shop/pull/57", trialSteps: { summary: "A shopper now sees the cart's total.", steps: [{ url: "https://staging.shop.example/cart" }] } },
      ],
      unread: [],
    });
    expect((JSON.parse(run.stdout) as { untried: unknown[] }).untried).toHaveLength(2);
  });

  it("reads with the credential the checkout's gh gives, writes nothing on GitHub, and leaves nothing in the checkout", async () => {
    const run = await command(THREE_ON_STAGING);

    expect(run.status).toBe(0);
    expect(run.sent.length).toBeGreaterThan(5);
    expect(run.sent.filter(({ authorization }) => authorization !== `Bearer ${TOKEN}`)).toEqual([]);
    expect(run.sent.filter(({ method, path, operation }) => !(method === "GET" || (method === "POST" && path === "/graphql" && operation === "query")))).toEqual([]);
    expect(run.left).toEqual([]);
  });

  it("prints an empty list and exits 0 with an empty queue", async () => {
    const run = await command({ files: declaring(), deployments: { production: [LIVE] }, mergedPullRequests: [] });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ repo: "jrey8343/shop", staging: { url: "https://staging.shop.example" }, production: { url: "https://shop.example" }, untried: [], unread: [] });
  });

  it("prints one pull request, given its number, whatever its result, with its Standing's name and the Kit's sentence for it", async () => {
    const run = await command(THREE_ON_STAGING, ["56"]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      staging: { url: "https://staging.shop.example" },
      production: { url: "https://shop.example" },
      pullRequest: { number: 56, title: "Show the cart's count", result: { is: "accepted" }, standing: { name: "trial-accepted", sentence: expect.stringMatching(/^Accepted in its Staging trial .+ ago\.$/) } },
    });
  });

  it.each([
    ["the number of something that is no merged agent pull request of the repo", THREE_ON_STAGING, ["99"], "#99 is not a merged agent pull request on the Promote list of jrey8343/shop, which holds only what production has not taken.\n"],
    ["a repo with no staging block", { files: declaring({ staging: null }) }, [], "jrey8343/shop's Kit config declares no staging, so it has no Staging trials.\n"],
  ])("prints nothing, says why in one line and exits 1 for %s", async (_what, raw, args, line) => {
    const run = await command(raw, args);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(line);
  });

  it("says in one line that gh gave no credential, and asks GitHub nothing, when the Operator is signed out", async () => {
    const run = await command(THREE_ON_STAGING, [], aGh(false));

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("gh auth token failed: no oauth token found for github.com\n");
    expect(run.sent).toEqual([]);
  });

  it.each([[["fifty"]], [["55", "56"]], [["0"]], [["--all"]]])("takes at most one argument, a pull request's number: %j is refused with its usage, and GitHub is asked nothing", async (args) => {
    const run = await command(THREE_ON_STAGING, args);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^Usage: node src\/trial\/untried-queue-main\.ts \[<pull request>\], from the Product repo's checkout/);
    expect(run.sent).toEqual([]);
  });
});

describe("The untried queue command, from a bare download of a release", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("reaches no npm package, so it runs with nothing installed", () => {
    expect(forbiddenImportsFrom(PROGRAM, read).filter(({ kind }) => kind === "package")).toEqual([]);
  });

  it("reads the Kit through the read library's entry alone, as any reader does", () => {
    expect(runtimeImportsIn(read(join(KIT, "src/trial/untriedQueue.ts")))).toEqual(["../read/index.ts"]);
  });
});
