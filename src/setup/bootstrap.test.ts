// The bootstrap script, setup.sh, run as the README gives its command: piped
// into `bash -s -- [release] [setup's flags]` from the Product repo's clone,
// the release named first or as --release=.
// curl, gh and node are stubbed on a PATH holding nothing else the script
// could reach for, and the release it downloads is a stand-in whose setup
// program only records how it was run.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const SETUP_SH = resolve(import.meta.dirname, "..", "..", "setup.sh");
const BASH = "/bin/bash";

/** How the stand-in setup program was run. */
interface Ran {
  readonly args: string[];
  readonly cwd: string;
  /** The folder the program ran from, inside the release's download. */
  readonly dir: string;
  /** Whether its stdin was a terminal. */
  readonly tty: boolean;
  /** What it read on stdin, when that wasn't a terminal. */
  readonly stdin: string | null;
}

/** A stand-in Fabrik release, laid out as codeload serves one, whose setup program records how it ran, then exits with STUB_EXIT. */
async function aStandInRelease(): Promise<string> {
  const root = await tempDir("bootstrap-release");
  await mkdir(join(root, "fabrik-0.0.0/src/setup"), { recursive: true });
  await writeFile(join(root, "fabrik-0.0.0/package.json"), '{ "type": "module" }\n');
  await writeFile(
    join(root, "fabrik-0.0.0/src/setup/main.ts"),
    `import { appendFileSync, readFileSync } from "node:fs";
const tty = process.stdin.isTTY === true;
const ran = { args: process.argv.slice(2), cwd: process.cwd(), dir: import.meta.dirname, tty, stdin: tty ? null : readFileSync(0, "utf8") };
appendFileSync(process.env["STUB_DIR"] + "/ran.jsonl", JSON.stringify(ran) + "\\n");
process.exitCode = Number(process.env["STUB_EXIT"] ?? "0");
`,
  );
  const archive = join(root, "fabrik.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "fabrik-0.0.0"]);
  return archive;
}

/** curl serves the stand-in release, or fails as it does on a 404 when STUB_ARCHIVE is empty, or as STUB_CURL_SAID and STUB_CURL_EXIT say. */
const FAKE_CURL = `#!/bin/sh
echo "$@" >> "$STUB_DIR/curl.log"
[ -n "$STUB_ARCHIVE" ] && exec cat "$STUB_ARCHIVE"
echo "\${STUB_CURL_SAID:-curl: (22) The requested URL returned error: 404}" >&2
exit "\${STUB_CURL_EXIT:-22}"
`;

/** gh answers the latest release with STUB_LATEST, or fails as when it's signed out. */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$STUB_DIR/gh.log"
if [ "$*" = "release view --repo jrey8343/fabrik --json tagName --jq .tagName" ]; then
  [ -n "$STUB_LATEST" ] && { echo "$STUB_LATEST"; exit 0; }
  echo "To get started with GitHub CLI, please run:  gh auth login" >&2
  exit 4
fi
exit 1
`;

/** node is this one, reporting STUB_NODE_VERSION as its version when that's set. */
const fakeNode = () => `#!/bin/sh
if [ "$1" = --version ] && [ -n "$STUB_NODE_VERSION" ]; then echo "$STUB_NODE_VERSION"; exit 0; fi
exec '${process.execPath}' "$@"
`;

/** The tools the script and the stubs use, and nothing else. */
const TOOLS = ["cat", "gzip", "mkdir", "mktemp", "rm", "tar"];

interface World {
  readonly product: string;
  readonly stubs: string;
  /** The TMPDIR the script makes its temporary folder in. */
  readonly tmp: string;
  readonly archive: string;
  readonly path: string;
}

let world: World;

beforeEach(async () => {
  const stubs = await tempDir("bootstrap-stubs");
  const bin = join(stubs, "bin");
  await mkdir(bin);
  for (const [name, script] of [["curl", FAKE_CURL], ["gh", FAKE_GH], ["node", fakeNode()]] as const) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  const tools = join(stubs, "tools");
  await mkdir(tools);
  for (const tool of TOOLS) {
    const found = execFileSync("/bin/sh", ["-c", `command -v ${tool} || true`], { encoding: "utf8" }).trim();
    if (found !== "") await symlink(found, join(tools, tool));
  }
  world = { product: await tempDir("bootstrap-product"), stubs, tmp: await tempDir("bootstrap-tmp"), archive: await aStandInRelease(), path: `${bin}:${tools}` };
});

interface Options {
  /** The latest release gh reports, or none when gh can't say. */
  readonly latest?: string | null;
  /** curl serves the release. */
  readonly serves?: boolean;
  /** When curl doesn't serve it, how it fails instead of a 404: what it says and its exit status. */
  readonly curlFails?: { readonly said: string; readonly exit: number };
  /** The exit status the setup program ends with. */
  readonly exit?: number;
  readonly nodeVersion?: string;
}

function envFor({ latest = "v1.4.2", serves = true, curlFails, exit = 0, nodeVersion = "" }: Options): NodeJS.ProcessEnv {
  return {
    PATH: world.path,
    HOME: world.stubs,
    TMPDIR: world.tmp,
    SHELL: "/bin/sh",
    STUB_DIR: world.stubs,
    STUB_ARCHIVE: serves ? world.archive : "",
    STUB_LATEST: latest ?? "",
    STUB_EXIT: String(exit),
    STUB_NODE_VERSION: nodeVersion,
    ...(curlFails === undefined ? {} : { STUB_CURL_SAID: curlFails.said, STUB_CURL_EXIT: String(curlFails.exit) }),
  };
}

interface Bootstrapped {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Each run of the setup program. */
  readonly ran: Ran[];
  readonly curl: string[];
  readonly gh: string[];
}

async function linesOf(path: string): Promise<string[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
}

async function outcome(code: number | null, stdout: string, stderr: string): Promise<Bootstrapped> {
  return {
    code,
    stdout,
    stderr,
    ran: (await linesOf(join(world.stubs, "ran.jsonl"))).map((line) => JSON.parse(line) as Ran),
    curl: await linesOf(join(world.stubs, "curl.log")),
    gh: await linesOf(join(world.stubs, "gh.log")),
  };
}

/** Runs a command detached, in a session of its own, so it has no controlling terminal unless it makes one. */
function detached(command: string, args: string[], env: NodeJS.ProcessEnv, input: string | null): Promise<Bootstrapped> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: world.product, env, detached: true, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => void outcome(code, stdout, stderr).then(done, fail));
    if (input !== null) child.stdin?.end(input);
  });
}

/** The script piped into bash, as `curl -fsSL .../setup.sh | bash -s -- <args>` runs it, with no terminal, as in CI. */
async function bootstrap(args: string[], options: Options = {}): Promise<Bootstrapped> {
  return detached(BASH, ["-s", "--", ...args], envFor(options), await readFile(SETUP_SH, "utf8"));
}

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** script(1) runs a command on a new terminal; macOS and util-linux take it differently. */
const SCRIPT = execFileSync("/bin/sh", ["-c", "command -v script || true"], { encoding: "utf8" }).trim();
const onATerminal = (command: string) => (process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", command] : ["-qec", command, "/dev/null"]);
/** Whether script(1) gives a command a terminal here, which some CI runners can't. */
const CAN_GIVE_A_TERMINAL =
  SCRIPT !== "" &&
  spawnSync(SCRIPT, onATerminal("test -t 0 && echo on-a-terminal"), { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10_000 }).stdout?.includes(
    "on-a-terminal",
  ) === true;

/** The same, run from the Operator's terminal. */
async function bootstrapInATerminal(args: string[], options: Options = {}): Promise<Bootstrapped> {
  const command = `cat ${quoted(SETUP_SH)} | ${BASH} -s -- ${args.map(quoted).join(" ")}`;
  return detached(SCRIPT, onATerminal(command), envFor(options), null);
}

describe("The bootstrap command", { timeout: 30_000 }, () => {
  it("with a release named, runs that release's setup program from the Operator's clone, with every other argument", async () => {
    const { code, stderr, ran, curl, gh } = await bootstrap(["v1.2.3", "--paused", "--time-zone=Europe/London"]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(curl).toEqual(["-fsSL https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v1.2.3"]);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.args).toEqual([".", "v1.2.3", "--paused", "--time-zone=Europe/London"]);
    expect(ran[0]?.cwd).toBe(await realpath(world.product));
    expect(gh.filter((line) => line.startsWith("release "))).toEqual([]);
  });

  it("with no release named, runs Fabrik's latest release, passing every argument on", async () => {
    const { code, stdout, stderr, ran, curl } = await bootstrap(["--paused"], { latest: "v1.4.2" });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe("Running Setup from Fabrik v1.4.2.\n");
    expect(curl).toEqual(["-fsSL https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v1.4.2"]);
    expect(ran.map((run) => run.args)).toEqual([[".", "v1.4.2", "--paused"]]);
  });

  it.each(["v1", "v1.2", "1.2.3", "main", "latest", "v1.2.3/../main", "v1.2.3 "])("refuses %j, which isn't an exact release tag, downloading nothing", async (release) => {
    const { code, stdout, stderr, ran, curl } = await bootstrap([release, "--paused"]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`${release} isn't an exact Fabrik release tag such as v1.2.3. Name one from https://github.com/jrey8343/fabrik/releases, or leave it out for the latest.\n`);
    expect(curl).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("takes a release tag with a pre-release part, as the caller workflow does", async () => {
    const { code, ran } = await bootstrap(["v2.0.0-rc.1"]);

    expect(code).toBe(0);
    expect(ran.map((run) => run.args)).toEqual([[".", "v2.0.0-rc.1"]]);
  });

  it("refuses a latest release gh gives that isn't an exact tag", async () => {
    const { code, stderr, curl } = await bootstrap([], { latest: "nightly" });

    expect(code).toBe(1);
    expect(stderr).toContain("nightly isn't an exact Fabrik release tag");
    expect(curl).toEqual([]);
  });

  it.each(["v24.3.0", "v25.0.0"])("runs the release's program on Node %s", async (nodeVersion) => {
    const { code, ran } = await bootstrap(["v1.2.3"], { nodeVersion });

    expect(code).toBe(0);
    expect(ran.map((run) => run.args)).toEqual([[".", "v1.2.3"]]);
  });

  describe("with the release named as --release=", () => {
    it("alone, runs that release's setup program, and never passes --release= on", async () => {
      const { code, stderr, ran, curl, gh } = await bootstrap(["--release=v1.0.0"]);

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(curl).toEqual(["-fsSL https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v1.0.0"]);
      expect(ran.map((run) => run.args)).toEqual([[".", "v1.0.0"]]);
      expect(gh.filter((line) => line.startsWith("release "))).toEqual([]);
    });

    it("after other flags, takes it from among them and passes the rest on in order", async () => {
      const { code, ran, curl } = await bootstrap(["--paused", "--release=v1.0.0", "--time-zone=Europe/London"]);

      expect(code).toBe(0);
      expect(curl).toEqual(["-fsSL https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v1.0.0"]);
      expect(ran.map((run) => run.args)).toEqual([[".", "v1.0.0", "--paused", "--time-zone=Europe/London"]]);
    });

    it("as well as first, runs it when the two agree", async () => {
      const { code, ran } = await bootstrap(["v1.0.0", "--paused", "--release=v1.0.0"]);

      expect(code).toBe(0);
      expect(ran.map((run) => run.args)).toEqual([[".", "v1.0.0", "--paused"]]);
    });

    it.each([
      ["first and as --release=", ["v1.0.0", "--release=v1.2.0"]],
      ["as --release= twice", ["--release=v1.0.0", "--paused", "--release=v1.2.0"]],
    ])("refuses two different releases, named %s, downloading nothing", async (_, args) => {
      const { code, stdout, stderr, ran, curl } = await bootstrap(args);

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("The release is named twice, as v1.0.0 and v1.2.0. Name it once, then run setup again.\n");
      expect(curl).toEqual([]);
      expect(ran).toEqual([]);
    });

    it("refuses an empty --release=, downloading nothing", async () => {
      const { code, stderr, ran, curl, gh } = await bootstrap(["--release=", "--paused"]);

      expect(code).toBe(1);
      expect(stderr).toBe(
        "--release= names no release. Name one from https://github.com/jrey8343/fabrik/releases, such as --release=v1.2.3, or leave it out for the latest.\n",
      );
      expect(curl).toEqual([]);
      expect(gh).toEqual([]);
      expect(ran).toEqual([]);
    });

    it("refuses one that isn't an exact release tag, downloading nothing", async () => {
      const { code, stderr, ran, curl } = await bootstrap(["--release=v1.2"]);

      expect(code).toBe(1);
      expect(stderr).toBe("v1.2 isn't an exact Fabrik release tag such as v1.2.3. Name one from https://github.com/jrey8343/fabrik/releases, or leave it out for the latest.\n");
      expect(curl).toEqual([]);
      expect(ran).toEqual([]);
    });

    it("refuses --release with its tag after a space, downloading nothing", async () => {
      const { code, stderr, ran, curl } = await bootstrap(["--release", "v1.0.0"]);

      expect(code).toBe(1);
      expect(stderr).toBe("--release takes its release after an =, such as --release=v1.2.3.\n");
      expect(curl).toEqual([]);
      expect(ran).toEqual([]);
    });
  });

  it("run with nothing after --, runs the latest release with no flags", async () => {
    const { code, ran } = await bootstrap([], { latest: "v1.4.2" });

    expect(code).toBe(0);
    expect(ran.map((run) => run.args)).toEqual([[".", "v1.4.2"]]);
  });

  describe("stops before downloading anything", () => {
    // Before 24.3, import.meta.main isn't true for setup's .ts entry point, so the program would exit 0 having done nothing.
    it.each(["v22.11.0", "v24.2.0"])("on a Node before 24.3, such as %s", async (nodeVersion) => {
      const { code, stderr, curl, gh } = await bootstrap(["v1.2.3"], { nodeVersion });

      expect(code).toBe(1);
      expect(stderr).toBe(
        `Setup needs Node 24.3 or later, and this is Node ${nodeVersion.slice(1)}. Install Node 24.3 or later, then run setup again.\n`,
      );
      expect(curl).toEqual([]);
      expect(gh).toEqual([]);
    });

    it("without node", async () => {
      await rm(join(world.stubs, "bin", "node"));

      const { code, stderr, curl } = await bootstrap(["v1.2.3"]);

      expect(code).toBe(1);
      expect(stderr).toBe("Setup needs Node 24.3 or later, and node isn't installed. Install Node 24.3 or later, then run setup again.\n");
      expect(curl).toEqual([]);
    });

    it("without gh", async () => {
      await rm(join(world.stubs, "bin", "gh"));

      const { code, stderr, curl } = await bootstrap(["v1.2.3"]);

      expect(code).toBe(1);
      expect(stderr).toBe("Setup needs gh, GitHub's CLI, and it isn't installed. Install it from https://cli.github.com, then run setup again.\n");
      expect(curl).toEqual([]);
    });

    it("when gh can't find the latest release, saying what gh said", async () => {
      const { code, stderr, curl, ran } = await bootstrap(["--paused"], { latest: null });

      expect(code).toBe(1);
      expect(stderr).toBe(
        "gh couldn't find Fabrik's latest release (To get started with GitHub CLI, please run:  gh auth login). " +
          "Sign in with gh auth login --scopes workflow, or name the release, then run setup again.\n",
      );
      expect(curl).toEqual([]);
      expect(ran).toEqual([]);
    });
  });

  describe("deletes the temporary folder it downloaded the release into", () => {
    it("once setup has run", async () => {
      const { code, ran } = await bootstrap(["v1.2.3"]);

      expect(code).toBe(0);
      expect(ran[0]?.dir.startsWith(await realpath(world.tmp))).toBe(true);
      expect(await readdir(world.tmp)).toEqual([]);
    });

    it("when setup stops, ending with setup's exit status", async () => {
      const { code, ran } = await bootstrap(["v1.2.3"], { exit: 3 });

      expect(code).toBe(3);
      expect(ran[0]?.dir.startsWith(await realpath(world.tmp))).toBe(true);
      expect(await readdir(world.tmp)).toEqual([]);
    });

    it("when the download fails, saying so with what curl said", async () => {
      const { code, stderr, ran } = await bootstrap(["v9.9.9"], { serves: false });

      expect(code).toBe(1);
      expect(stderr).toContain(
        "Downloading Fabrik v9.9.9 failed (curl: (22) The requested URL returned error: 404). Check it's a release at https://github.com/jrey8343/fabrik/releases, then run setup again.",
      );
      expect(ran).toEqual([]);
      expect(await readdir(world.tmp)).toEqual([]);
    });

    it("when curl can't reach GitHub, as behind a proxy or on a TLS failure, saying so rather than doubting the release", async () => {
      const said = "curl: (60) SSL certificate problem: unable to get local issuer certificate";
      const { code, stderr, ran } = await bootstrap(["v1.2.3"], { serves: false, curlFails: { said, exit: 60 } });

      expect(code).toBe(1);
      expect(stderr).toContain(`Downloading Fabrik v1.2.3 failed (${said}). Check this machine can reach codeload.github.com, through its proxy if it has one, then run setup again.`);
      expect(stderr).not.toContain("Check it's a release");
      expect(ran).toEqual([]);
    });
  });

  // Piped into bash, the script is bash's stdin, so setup would see no terminal and ask nothing.
  it.runIf(CAN_GIVE_A_TERMINAL)("run from a terminal, gives the setup program that terminal, so it can ask its questions", async () => {
    const { code, ran } = await bootstrapInATerminal(["v1.2.3", "--paused"]);

    expect(code).toBe(0);
    expect(ran.map((run) => [run.args, run.tty])).toEqual([[[".", "v1.2.3", "--paused"], true]]);
    expect(await readdir(world.tmp)).toEqual([]);
  });

  it("with no terminal, gives the setup program none, and never the rest of the piped script", async () => {
    const { code, ran } = await bootstrap(["v1.2.3"]);

    expect(code).toBe(0);
    expect(ran.map((run) => [run.tty, run.stdin])).toEqual([[false, ""]]);
  });
});
