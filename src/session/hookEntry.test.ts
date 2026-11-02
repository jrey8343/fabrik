// The SessionStart hook entry is one of the Kit's stable shims in a Product
// repo, so it can't import anything: it's run here as Claude Code runs it, with
// `curl` stubbed to serve a stand-in Fabrik release.
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const run = promisify(execFile);
const TEMPLATE = resolve(import.meta.dirname, "..", "..", "templates", "claude-settings.json");

interface HookSettings {
  hooks: { SessionStart: { hooks: { type: string; command: string; timeout: number }[] }[] };
  enabledPlugins: Record<string, boolean>;
}

async function hookCommand(): Promise<string> {
  const settings = JSON.parse(await readFile(TEMPLATE, "utf8")) as HookSettings;
  const [entry] = settings.hooks.SessionStart;
  const [hook] = entry?.hooks ?? [];
  if (hook === undefined) throw new Error("The template has no SessionStart hook");
  return hook.command;
}

/** A stand-in Fabrik release whose start.ts prints the arguments it was run with. */
async function aStandInRelease(): Promise<string> {
  const root = await tempDir("release");
  await mkdir(join(root, "fabrik-top/src/session"), { recursive: true });
  await writeFile(
    join(root, "fabrik-top/src/session/start.ts"),
    "const args: string[] = process.argv.slice(2);\nconsole.log(JSON.stringify({ ran: args }));\n",
  );
  const archive = join(root, "fabrik.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "fabrik-top"]);
  return archive;
}

/** A `curl` that logs its arguments, then serves the archive, or fails when there is none. */
async function aFakeCurl(archive: string | null): Promise<{ bin: string; log: string }> {
  const bin = await tempDir("bin");
  const log = join(bin, "curl.log");
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh\necho "$@" >> "${log}"\n${archive === null ? "exit 22" : `cat "${archive}"`}\n`,
  );
  await chmod(join(bin, "curl"), 0o755);
  return { bin, log };
}

async function aProduct(caller: string | null): Promise<string> {
  const product = await tempDir("product");
  if (caller !== null) {
    await mkdir(join(product, ".github/workflows"), { recursive: true });
    await writeFile(join(product, ".github/workflows/fabrik.yml"), caller);
  }
  return product;
}

const CALLER = `jobs:
  loop:
    uses: jrey8343/fabrik/.github/workflows/loop.yml@v1.4.2
  tick:
    uses: "jrey8343/fabrik/.github/workflows/schedule.yml@v1.4.2" # pinned
`;

async function runHook(product: string, curl: { bin: string }): Promise<string> {
  const { stdout } = await run("sh", ["-c", await hookCommand()], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: product, PATH: `${curl.bin}:${process.env["PATH"] ?? ""}` },
  });
  return stdout.trim();
}

describe("The SessionStart hook entry", () => {
  it("downloads Fabrik at the release the caller workflow pins and runs its session start on the project", async () => {
    const product = await aProduct(CALLER);
    const curl = await aFakeCurl(await aStandInRelease());

    const stdout = await runHook(product, curl);

    expect(await readFile(curl.log, "utf8")).toContain(
      "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/v1.4.2",
    );
    expect(JSON.parse(stdout)).toEqual({ ran: [product, "v1.4.2"] });
  });

  it("warns the Operator, without failing the session, when the repo pins no Fabrik release", async () => {
    const product = await aProduct(null);
    const curl = await aFakeCurl(await aStandInRelease());

    const stdout = await runHook(product, curl);

    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "Fabrik didn't install its skills: .github/workflows/fabrik.yml pins no Fabrik release",
    });
  });

  it("warns the Operator, without failing the session, when the download fails", async () => {
    const product = await aProduct(CALLER);
    const curl = await aFakeCurl(null);

    const stdout = await runHook(product, curl);

    expect(JSON.parse(stdout)).toEqual({
      systemMessage: "Fabrik didn't install its skills: downloading Fabrik v1.4.2 failed",
    });
  });

  it("disables the skills plugin, so every session runs the pinned skills", async () => {
    const settings = JSON.parse(await readFile(TEMPLATE, "utf8")) as HookSettings;

    expect(settings.enabledPlugins).toEqual({ "mattpocock-skills@claude-plugins-official": false });
  });
});
