// #660: the Design job fetches the head of the open agent pull request its
// issue was filed from, against real repositories on disk: a bare "GitHub"
// remote served over file://, and the job's shallow checkout of its default
// branch.
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFiledFrom, filedFromRef } from "./filedFromFetch.ts";
import type { FiledFrom } from "./inputs.ts";

const run = promisify(execFile);
const BRANCH = "fabrik/ticket-7";
const TOKEN = "ghs_theJobsReadOnlyToken";
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

let root: string;
let remote: string;
/** The Design job's checkout of the Product repo: the default branch's head alone, shallow, as actions/checkout leaves it. */
let checkout: string;
/** The older commit of main the pull request's branch was cut from. */
let cutFrom: string;
/** The pull request's head, two commits past `cutFrom`. */
let head: string;
/** Main's head, which moved on after the branch was cut. */
let main: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env })).stdout.trim();
}

async function commit(cwd: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const REMOTE = () => ({ serverUrl: `file://${root}`, repo: { owner: "acme", name: "shop" }, token: TOKEN });

/** The pull request #84 as the inputs step read it: an open agent pull request at the Merge gate, at `head`. */
const filedFrom = (over: Partial<Extract<FiledFrom, { kind: "pull-request" }>> = {}): FiledFrom => ({
  kind: "pull-request",
  number: 84,
  title: "Add a waitlist",
  body: "Adds the waitlist table and its page.",
  state: "open",
  draft: false,
  headSha: head,
  headRef: BRANCH,
  baseRef: "main",
  isAgent: true,
  ...over,
});

const lines = (text: string): string[] => (text === "" ? [] : text.split("\n"));

beforeEach(async () => {
  // The fetch's own git reads nothing of this machine's configuration.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  root = await mkdtemp(join(tmpdir(), "fabrik-filed-from-fetch-"));
  remote = join(root, "acme", "shop.git");
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  // As GitHub serves a commit by its sha.
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");

  const seed = join(root, "seed");
  await git(root, "clone", "--quiet", remote, seed);
  await git(seed, "checkout", "--quiet", "-b", "main");
  await commit(seed, { "src/cart.ts": "cart v1\n", "README.md": "shop\n" }, "Start");
  cutFrom = await commit(seed, { "src/cart.ts": "cart v2\n" }, "Total the cart");
  await git(seed, "checkout", "--quiet", "-b", BRANCH);
  await commit(seed, { "src/waitlist.ts": "waitlist v1\n" }, "Add the waitlist table");
  head = await commit(seed, { "src/waitlist.ts": "waitlist v2\n", "src/pages/waitlist.tsx": "page\n" }, "Add the waitlist page");
  await git(seed, "checkout", "--quiet", "main");
  await commit(seed, { "src/cart.ts": "cart v3\n" }, "Main moves on");
  main = await commit(seed, { "src/checkout.ts": "checkout v1\n" }, "Main moves on again");
  await git(seed, "push", "--quiet", "origin", "main", BRANCH);

  // Shallow only through file://: a clone by plain path ignores the depth.
  checkout = join(root, "product");
  await git(root, "clone", "--quiet", "--depth", "1", "--branch", "main", `file://${remote}`, checkout);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("The Design job's fetch of the pull request its issue was filed from", () => {
  it("starts from a checkout that holds the default branch's head alone, as the Design job's does", async () => {
    expect(await git(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(main);
    await expect(git(checkout, "cat-file", "-e", `${head}^{commit}`)).rejects.toThrow();
    await expect(git(checkout, "cat-file", "-e", `${cutFrom}^{commit}`)).rejects.toThrow();
  });

  it("leaves the head's commit and its merge base with the default branch in the checkout, under the Kit's ref", async () => {
    const ref = await fetchFiledFrom(checkout, REMOTE(), filedFrom());

    expect(ref).toBe("refs/fabrik/filed-from/84");
    expect(await git(checkout, "rev-parse", `${ref}^{commit}`)).toBe(head);
    expect(await git(checkout, "merge-base", "HEAD", ref!)).toBe(cutFrom);
  });

  it("lets the head be compared with the default branch: exactly the pull request's commits and the files it changes", async () => {
    const ref = (await fetchFiledFrom(checkout, REMOTE(), filedFrom()))!;

    expect(lines(await git(checkout, "log", "--format=%s", `HEAD..${ref}`))).toEqual(["Add the waitlist page", "Add the waitlist table"]);
    expect(lines(await git(checkout, "diff", "--name-status", `HEAD...${ref}`))).toEqual(["A\tsrc/pages/waitlist.tsx", "A\tsrc/waitlist.ts"]);
    expect(await git(checkout, "show", `${ref}:src/waitlist.ts`)).toBe("waitlist v2");
    // Main's own commits since the branch was cut are no part of it.
    expect(lines(await git(checkout, "log", "--format=%s", `${ref}..HEAD`))).toEqual(["Main moves on again", "Main moves on"]);
  });

  it("leaves the working tree and the checked-out commit as they were: the default branch's", async () => {
    const before = { head: await git(checkout, "rev-parse", "HEAD"), on: await git(checkout, "symbolic-ref", "HEAD"), files: await git(checkout, "ls-files", "-s") };

    await fetchFiledFrom(checkout, REMOTE(), filedFrom());

    expect({ head: await git(checkout, "rev-parse", "HEAD"), on: await git(checkout, "symbolic-ref", "HEAD"), files: await git(checkout, "ls-files", "-s") }).toEqual(before);
    expect(before).toMatchObject({ head: main, on: "refs/heads/main" });
    expect(await git(checkout, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await readFile(join(checkout, "src/cart.ts"), "utf8")).toBe("cart v3\n");
    await expect(readFile(join(checkout, "src/waitlist.ts"), "utf8")).rejects.toThrow();
  });

  it("keeps the head under a ref of the Kit's naming, which no branch of the Product repo can be, whatever it is called", async () => {
    // A Product repo may call a branch anything, the Kit's ref included.
    const seed = join(root, "seed");
    await git(seed, "push", "--quiet", "origin", "main:refs/heads/fabrik/filed-from/84", "main:refs/heads/refs/fabrik/filed-from/84");
    await git(checkout, "fetch", "--quiet", "--depth", "1", "origin", "+refs/heads/*:refs/remotes/origin/*");
    await git(checkout, "branch", "--quiet", "refs/fabrik/filed-from/84", "HEAD");
    const refs = async () => lines(await git(checkout, "for-each-ref", "--format=%(refname)"));
    const before = await refs();

    const ref = (await fetchFiledFrom(checkout, REMOTE(), filedFrom()))!;

    expect(ref).toBe(filedFromRef(84));
    expect(ref).not.toMatch(/^refs\/(heads|remotes|tags)\//);
    expect((await refs()).filter((name) => !before.includes(name))).toEqual([ref]);
    expect(before).toEqual(expect.arrayContaining(["refs/heads/refs/fabrik/filed-from/84", "refs/remotes/origin/fabrik/filed-from/84", "refs/remotes/origin/refs/fabrik/filed-from/84"]));
    // Each branch is where it was, and the ref holds the pull request's head, not a branch's.
    expect(await git(checkout, "rev-parse", "refs/heads/refs/fabrik/filed-from/84", "refs/remotes/origin/fabrik/filed-from/84")).toBe(`${main}\n${main}`);
    expect(await git(checkout, "rev-parse", `${ref}^{commit}`)).toBe(head);
  });

  it.each([
    ["has merged", { state: "merged" }],
    ["was closed unmerged", { state: "closed" }],
    ["is open but is a Plain pull request", { isAgent: false, headRef: "waitlist-by-hand" }],
    ["is a Plain pull request in draft", { isAgent: false, draft: true }],
  ] as const)("fetches nothing when the pull request %s", async (_stands, stands) => {
    const before = await gitFilesOf(checkout);

    // A remote that isn't there: any fetch from it would fail.
    const ref = await fetchFiledFrom(checkout, { ...REMOTE(), serverUrl: `file://${root}/nowhere` }, filedFrom(stands));

    expect(ref).toBeNull();
    expect(await gitFilesOf(checkout)).toEqual(before);
    await expect(git(checkout, "cat-file", "-e", `${head}^{commit}`)).rejects.toThrow();
  });

  it("fetches nothing when the issue was filed from no pull request", async () => {
    const before = await gitFilesOf(checkout);

    expect(await fetchFiledFrom(checkout, { ...REMOTE(), serverUrl: `file://${root}/nowhere` }, { kind: "none" })).toBeNull();
    expect(await gitFilesOf(checkout)).toEqual(before);
  });

  it("fetches the head of an open agent pull request still in draft, onto which a Roll-in may be settled too", async () => {
    const ref = (await fetchFiledFrom(checkout, REMOTE(), filedFrom({ draft: true })))!;

    expect(await git(checkout, "rev-parse", `${ref}^{commit}`)).toBe(head);
  });
});

// GitHub serves a repository over HTTP and asks for the token on every
// request, so the same repositories are served here as it serves them: git's
// own smart-HTTP backend, behind a server that turns away any request without
// the job's token.
describe("The fetch's credential, against a remote that asks for it as GitHub does", () => {
  const AUTHORIZATION = `basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
  let server: Server;
  let serverUrl: string;
  /** The `authorization` header of each request the server was sent. */
  let presented: (string | undefined)[];

  beforeEach(async () => {
    presented = [];
    server = createServer((request, response) => {
      presented.push(request.headers.authorization);
      if (request.headers.authorization?.toLowerCase() !== AUTHORIZATION.toLowerCase()) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end("Bad credentials");
        return;
      }
      const body: Buffer[] = [];
      request.on("data", (chunk: Buffer) => body.push(chunk));
      request.on("end", () => {
        const [path = "", query = ""] = (request.url ?? "").split("?");
        const sent = Buffer.concat(body);
        const backend = spawn("git", ["http-backend"], {
          env: {
            ...env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: request.method ?? "GET",
            PATH_INFO: path,
            QUERY_STRING: query,
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(sent.length),
            HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
            GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
          },
        });
        const answered: Buffer[] = [];
        backend.stdout.on("data", (chunk: Buffer) => answered.push(chunk));
        backend.on("close", () => {
          // A CGI answer: its headers, a blank line, then the body.
          const answer = Buffer.concat(answered);
          const end = answer.indexOf("\r\n\r\n");
          const headers = answer
            .subarray(0, end)
            .toString("latin1")
            .split("\r\n")
            .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()] as const);
          const status = Number(headers.find(([name]) => name.toLowerCase() === "status")?.[1].split(" ")[0] ?? 200);
          response.writeHead(status, Object.fromEntries(headers.filter(([name]) => name.toLowerCase() !== "status"))).end(answer.subarray(end + 4));
        });
        backend.stdin.end(sent);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("presents the job's token on every request, and fetches the head and its history as it does from GitHub", async () => {
    const ref = (await fetchFiledFrom(checkout, { ...REMOTE(), serverUrl }, filedFrom()))!;

    expect(presented.length).toBeGreaterThan(0);
    expect(new Set(presented.map((header) => header?.toLowerCase()))).toEqual(new Set([AUTHORIZATION.toLowerCase()]));
    expect(await git(checkout, "rev-parse", `${ref}^{commit}`)).toBe(head);
    expect(await git(checkout, "merge-base", "HEAD", ref)).toBe(cutFrom);
  });

  it("leaves no credential and no added header in the checkout's configuration, and the token in no file of the checkout", async () => {
    const before = await gitFilesOf(checkout);
    const configured = await git(checkout, "config", "--local", "--list");

    await fetchFiledFrom(checkout, { ...REMOTE(), serverUrl }, filedFrom());

    const after = await gitFilesOf(checkout);
    expect(after["config"]).toBe(before["config"]);
    expect(await git(checkout, "config", "--local", "--list")).toBe(configured);
    expect(configured).not.toMatch(/extraheader|credential|authorization/i);
    for (const [name, text] of Object.entries(after)) {
      expect(text, name).not.toContain(TOKEN);
      expect(text, name).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
      expect(text, name).not.toMatch(/authorization/i);
    }
    // All the fetch left beside its objects: the ref, and a checkout no longer shallow.
    expect(Object.keys(after).filter((name) => after[name] !== before[name])).toEqual(["refs/fabrik/filed-from/84"]);
    expect(Object.keys(before).filter((name) => !(name in after))).toEqual(["shallow"]);
  });

  it("runs no hook of the checkout while it holds the token", async () => {
    const ran = join(root, "hook-ran");
    const hook = join(checkout, ".git", "hooks", "reference-transaction");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\nenv >"${ran}"\n`, { mode: 0o755 });

    const ref = (await fetchFiledFrom(checkout, { ...REMOTE(), serverUrl }, filedFrom()))!;

    expect(await git(checkout, "rev-parse", `${ref}^{commit}`)).toBe(head);
    await expect(readFile(ran, "utf8")).rejects.toThrow();
  });
});

/** Every file under the checkout's .git that is no object: its configuration, its refs and whatever a fetch notes down. */
async function gitFilesOf(dir: string): Promise<Record<string, string>> {
  const home = join(dir, ".git");
  const names = (await readdir(home, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(home.length + 1))
    .filter((name) => !name.startsWith("objects/"));
  return Object.fromEntries(await Promise.all(names.sort().map(async (name) => [name, await readFile(join(home, name), "latin1")] as const)));
}

