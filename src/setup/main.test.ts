// The setup program run as the bootstrap command runs it where there's no
// terminal: from the Product repo's root, as `node src/setup/main.ts .
// <release> [flags]` with nothing on stdin, against a real git clone, with gh
// and op stubbed. It asks nothing, so it stops at the plan.
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ACME, PERSONAL } from "../__fixtures__/setupCommands.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const MAIN = resolve(import.meta.dirname, "main.ts");

// The stubs are sh, not node: applying calls gh once for each label, and a
// node stub's start-up for each would slow the whole suite.

/** An `op` with two accounts and no vaults, logging each call with the OP_ACCOUNT it saw. */
const FAKE_OP = `#!/bin/sh
printf 'op\\t%s\\t%s\\n' "\${OP_ACCOUNT-}" "$*" >> "$STUB_DIR/calls.log"
case "$*" in
  "account list --format json") printf '%s' "$STUB_OP_ACCOUNTS"; exit 0 ;;
  "vault list --format json") printf '[]'; exit 0 ;;
  "vault create "*) exit 0 ;;
  "service-account create "*) echo ops_fake; exit 0 ;;
esac
echo "fake op has no answer for: $*" >&2
exit 1
`;

/** A `gh` signed in as acme/clinic's admin, with the workflow scope, on a repo with nothing of Fabrik's. */
const FAKE_GH = `#!/bin/sh
printf 'gh\\t\\t%s\\n' "$*" >> "$STUB_DIR/calls.log"
case "$*" in
  "api -i user") printf 'HTTP/2.0 200 OK\\r\\nX-Oauth-Scopes: repo, workflow\\r\\n\\r\\n%s' '{"login":"acme-operator"}'; exit 0 ;;
  "repo view --json owner,name,defaultBranchRef,isInOrganization,viewerPermission")
    printf '%s' '{"owner":{"login":"acme"},"name":"clinic","defaultBranchRef":{"name":"main"},"isInOrganization":false,"viewerPermission":"ADMIN"}'; exit 0 ;;
  "label list --limit 1000 --json name"|"secret list --json name") printf '[]'; exit 0 ;;
  "api repos/acme/clinic/branches/main/protection") echo "gh: Branch not protected (HTTP 404)" >&2; exit 1 ;;
  "api repos/acme/clinic/rulesets?includes_parents=false") printf '[]'; exit 0 ;;
  "repo view jrey8343/fabrik-runs --json visibility") echo "GraphQL: Could not resolve to a Repository" >&2; exit 1 ;;
  "api repos/jrey8343/fabrik-runs/contents/"*) echo "gh: This repository is empty. (HTTP 404)" >&2; exit 1 ;;
  "label create "*|"secret set "*|"repo create "*|"api --method "*) cat > /dev/null; exit 0 ;;
esac
echo "fake gh has no answer for: $*" >&2
exit 1
`;

interface Logged {
  readonly command: string;
  /** The OP_ACCOUNT an op call saw, empty when it had none. */
  readonly account: string;
  /** The arguments, joined with spaces. */
  readonly line: string;
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

/** One run of the setup program with nothing on stdin, so no terminal. */
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
  const calls = log
    .split("\n")
    .filter((entry) => entry !== "")
    .map((entry): Logged => {
      const [command = "", account = "", line = ""] = entry.split("\t");
      return { command, account, line };
    });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls };
}

// Each run starts Node and stubs dozens of gh calls, so allow more than the default.
describe("The setup program without a terminal", { timeout: 60_000 }, () => {
  it("prints the plan without asking, on the default branch, naming the account OP_ACCOUNT set", async () => {
    const { status, stdout, stderr, calls } = await setup([".", "v1.4.2", "--time-zone=Europe/London", "--second-subscription", "--paused"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout.split("\n")[0]).toBe("Setup uses the 1Password account acme.1password.com (operator@acme.example).");
    expect(stdout).not.toMatch(/\[y\/N\]|\[1-2\]/);
    expect(stdout).toContain("Setup would:");
    const ops = calls.filter((call) => call.command === "op");
    expect(ops.map((call) => call.line)).toContain("vault list --format json");
    expect(ops.every((call) => call.account === ACME.url)).toBe(true);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("run again on the setup branch, with the files it wrote uncommitted as a run that stopped partway leaves them, still plans", async () => {
    git("switch", "-q", "-c", "fabrik/setup-v1.4.2");
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), "{}\n");
    // What that run applied, as it records it in the clone's git directory.
    await writeFile(join(checkout, ".git", "fabrik-setup-v1.4.2.done"), "write .fabrik/config.json (a starter Kit config with every v1 default)\n");

    const { status, stdout, stderr } = await setup([".", "v1.4.2"]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Setup carries the plan out only on your yes, so run it in a terminal to do it.");
  });

  it("stops before any plan on a dirty default branch, naming the change", async () => {
    await writeFile(join(checkout, "README.md"), "# Clinic, edited\n");

    const { status, stdout, stderr } = await setup([".", "v1.4.2"]);

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("This clone has uncommitted changes (README.md).");
  });
});
