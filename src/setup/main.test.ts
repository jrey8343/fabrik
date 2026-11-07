// The setup program run as the setup skill runs it: from the Product repo's
// root, with no terminal, OP_ACCOUNT set and every answer a flag. Its steps 4
// and 5 are run verbatim against a real git clone, with gh and op stubbed.
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ACME, PERSONAL } from "../__fixtures__/setupCommands.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const MAIN = resolve(import.meta.dirname, "main.ts");

/** An `op` with two accounts and no vaults, logging each call with the OP_ACCOUNT it saw. */
const FAKE_OP = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_DIR + "/calls.log", JSON.stringify({ command: "op", args, account: process.env.OP_ACCOUNT ?? null }) + "\\n");
const line = args.join(" ");
if (line === "account list --format json") { process.stdout.write(process.env.STUB_OP_ACCOUNTS); process.exit(0); }
if (line === "vault list --format json") { process.stdout.write("[]"); process.exit(0); }
if (args[0] === "vault" && args[1] === "create") process.exit(0);
if (args[0] === "service-account" && args[1] === "create") { process.stdout.write("ops_fake\\n"); process.exit(0); }
process.stderr.write("fake op has no answer for: " + line + "\\n");
process.exit(1);
`;

/** A `gh` signed in as acme/clinic's admin, with the workflow scope, on a repo with nothing of Fabrik's. */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_DIR + "/calls.log", JSON.stringify({ command: "gh", args }) + "\\n");
const line = args.join(" ");
const answer = (text) => { process.stdout.write(text); process.exit(0); };
const fail = (text) => { process.stderr.write(text + "\\n"); process.exit(1); };
if (line === "api -i user") answer("HTTP/2.0 200 OK\\r\\nX-Oauth-Scopes: repo, workflow\\r\\n\\r\\n" + JSON.stringify({ login: "acme-operator" }));
if (line === "repo view --json owner,name,defaultBranchRef,isInOrganization,viewerPermission") {
  answer(JSON.stringify({ owner: { login: "acme" }, name: "clinic", defaultBranchRef: { name: "main" }, isInOrganization: false, viewerPermission: "ADMIN" }));
}
if (line === "label list --limit 1000 --json name" || line === "secret list --json name") answer("[]");
if (line === "api repos/acme/clinic/branches/main/protection") fail("gh: Branch not protected (HTTP 404)");
if (line === "api repos/acme/clinic/rulesets?includes_parents=false") answer("[]");
if (line === "repo view jrey8343/fabrik-runs --json visibility") fail("GraphQL: Could not resolve to a Repository");
if (line.startsWith("api repos/jrey8343/fabrik-runs/contents/")) fail("gh: This repository is empty. (HTTP 404)");
if (["label create", "secret set", "repo create", "api --method"].some((start) => line.startsWith(start))) process.exit(0);
fail("fake gh has no answer for: " + line);
`;

interface Logged {
  command: string;
  args: string[];
  account?: string | null;
}

let bin: string;
let checkout: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Operator", "-c", "user.email=operator@example.com", ...args], { cwd: checkout, encoding: "utf8" });

beforeEach(async () => {
  bin = await tempDir("setup-bin");
  for (const [name, script] of [["op", FAKE_OP], ["gh", FAKE_GH]] as const) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  const origin = await tempDir("setup-origin");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  checkout = await tempDir("setup-checkout");
  git("init", "-q", "-b", "main");
  await writeFile(join(checkout, "README.md"), "# Clinic\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Start");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
});

/** One run of the setup program, as the skill's Bash call makes it: stdin piped, so no terminal. */
async function setup(args: string[]) {
  const run = spawnSync(process.execPath, [MAIN, ...args], {
    cwd: checkout,
    input: "",
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: bin,
      STUB_DIR: bin,
      STUB_OP_ACCOUNTS: JSON.stringify([PERSONAL, ACME]),
      OP_ACCOUNT: ACME.url,
    },
  });
  const log = await readFile(join(bin, "calls.log"), "utf8").catch(() => "");
  const calls = log.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Logged);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls };
}

// Applying runs a stubbed gh for every label, so a run takes seconds.
describe("The setup skill's commands", { timeout: 60_000 }, () => {
  it("step 4 prints the plan without asking, on the default branch, naming the account OP_ACCOUNT set", async () => {
    const { status, stdout, stderr, calls } = await setup([".", "v1.4.2", "--time-zone=Europe/London", "--second-subscription", "--paused"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout.split("\n")[0]).toBe("Setup uses the 1Password account acme.1password.com (operator@acme.example).");
    expect(stdout).not.toMatch(/\[y\/N\]|\[1-2\]/);
    expect(stdout).toContain("Setup would:");
    expect(calls.filter((call) => call.command === "op").every((call) => call.account === ACME.url)).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("step 5 applies the plan on the setup branch it has just made", async () => {
    git("switch", "-q", "-c", "fabrik/setup-v1.4.2");
    const { status, stdout, stderr, calls } = await setup([".", "v1.4.2", "--time-zone=Europe/London", "--paused", "--apply"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Done.");
    expect(await readFile(join(checkout, ".fabrik", "config.json"), "utf8")).toContain('"max_in_flight": 0');
    const ops = calls.filter((call) => call.command === "op");
    expect(ops.some((call) => call.args[0] === "service-account")).toBe(true);
    expect(ops.every((call) => call.account === ACME.url)).toBe(true);
  });

  it("step 4 run again after a partway failure, on the setup branch with setup's own files uncommitted, still plans", async () => {
    git("switch", "-q", "-c", "fabrik/setup-v1.4.2");
    expect((await setup([".", "v1.4.2", "--apply"])).status).toBe(0);

    const { status, stderr } = await setup([".", "v1.4.2"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("stops before any plan on a dirty default branch, naming the change", async () => {
    await writeFile(join(checkout, "README.md"), "# Clinic, edited\n");

    const { status, stdout, stderr } = await setup([".", "v1.4.2"]);

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("This clone has uncommitted changes (README.md).");
  });
});
