// An agent run through the real Sandcastle runner, against a stand-in for
// `claude` that writes the stream it is given and then exits or stays open,
// as an agent whose turn ended with something still pending does (#860).
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Output, type OutputDefinition } from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readImplementOutput } from "../loop/implementOutput.ts";
import { agentLaunch, replySchemaOf, runAgent, streamWatch } from "./launch.ts";
import { stopStartedProcesses } from "./stop.ts";

/** One thing the stand-in does: write a stream line, wait, start a background command, or exit. Past the last step it stays open, silent. */
type Step = { readonly line: unknown } | { readonly waitMs: number } | { readonly background: true } | { readonly exit: number };

/** The stand-in for `claude`: records how it was launched, then follows the plan in FAKE_CLAUDE_PLAN. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_PLAN, "utf8"));
const launched = { pid: process.pid, argv: process.argv.slice(2), background: null };
const record = () => fs.writeFileSync(plan.record, JSON.stringify(launched));
record();
process.stdin.resume();
(async () => {
  for (const step of plan.steps) {
    if (step.line !== undefined) process.stdout.write(JSON.stringify(step.line) + "\\n");
    if (step.waitMs !== undefined) await new Promise((done) => setTimeout(done, step.waitMs));
    if (step.background === true) {
      launched.background = spawn("sleep", ["300"], { stdio: "ignore" }).pid;
      record();
    }
    if (step.exit !== undefined) process.exit(step.exit);
  }
  setInterval(() => {}, 1000);
})();
`;

/** The grace period these runs are given, in seconds: long enough for a line to arrive, short enough to wait out. */
const GRACE_SECONDS = 0.4;
/** A silence longer than the grace period. */
const LONGER_THAN_GRACE = { waitMs: 1200 };

// With no session id, so Sandcastle has no session to resume and asks for no malformed block again.
const init = { line: { type: "system", subtype: "init", apiKeySource: "none", tools: ["Bash", "Read"] } };
const says = (text: string): Step => ({ line: { type: "assistant", message: { content: [{ type: "text", text }] } } });
const result = (text: string): Step => ({ line: { type: "result", subtype: "success", is_error: false, result: text } });
const block = (title: string) => `<implement>\n${JSON.stringify({ title, summary: "Adds the page." })}\n</implement>`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Each run starts real processes and waits out a grace period, so a busy machine gets far longer than the default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let dir: string;
let path: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fabrik-run-agent-"));
  path = process.env["PATH"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "claude"), FAKE_CLAUDE);
  await chmod(join(dir, "bin", "claude"), 0o755);
  // Sandcastle runs the agent in a git checkout.
  await mkdir(join(dir, "repo"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(dir, "repo"), stdio: "ignore" });
  git("init", "--quiet");
  git("-c", "user.name=Fabrik", "-c", "user.email=fabrik@users.noreply.github.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Empty");
});
afterEach(async () => {
  await stopStartedProcesses();
  process.env["PATH"] = path;
  delete process.env["FAKE_CLAUDE_PLAN"];
  vi.restoreAllMocks();
});

/** An Implementer's output: its block, checked against a first run's contract. */
const IMPLEMENT = Output.object({ tag: "implement", schema: replySchemaOf(readImplementOutput), maxRetries: 1 });

/** Runs an agent whose `claude` follows `steps`, an Implementer unless told, and gives its output with how the stand-in was launched. */
async function running(steps: readonly Step[], reply: OutputDefinition = IMPLEMENT) {
  const record = join(dir, "launched.json");
  await writeFile(join(dir, "plan.json"), JSON.stringify({ record, steps }));
  process.env["FAKE_CLAUDE_PLAN"] = join(dir, "plan.json");
  const abort = new AbortController();
  const watch = streamWatch(join(dir, "transcript.jsonl"), abort);
  const launch = agentLaunch("claude-opus-5-5", "high", reply);
  const output = await runAgent({
    name: "implement-7",
    launch,
    cwd: join(dir, "repo"),
    prompt: `Do the work, then end your reply with a <${reply.tag}> block.`,
    ready: { command: "true", timeoutMs: 10_000 },
    abort,
    watch,
    logPath: join(dir, "agent.log"),
    graceSeconds: GRACE_SECONDS,
    binDir: join(dir, "bin"),
  });
  const launched = JSON.parse(await readFile(record, "utf8")) as { pid: number; argv: string[]; background: number | null };
  return { output, launch, launched, watch };
}

describe("An agent run whose process stays open after its reply (#860)", () => {
  it("ends with the output block its last result holds, within the grace period", async () => {
    const started = Date.now();
    const { output, launched, watch } = await running([init, says("Done."), result(`All checks pass.\n\n${block("Add the booking page")}`)]);

    expect(output).toEqual({ title: "Add the booking page", summary: "Adds the page." });
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing waited for the agent's process: it is still there.
    expect(alive(launched.pid)).toBe(true);
    expect(watch.lines).toHaveLength(3);
  });

  it("isn't ended by assistant text that quotes the output block in the middle of the run", async () => {
    const { output } = await running([
      init,
      says(`I will end with a block like ${block("A block only quoted")}`),
      LONGER_THAN_GRACE,
      says("The tests pass."),
      result(block("Add the booking page")),
    ]);

    expect(output).toMatchObject({ title: "Add the booking page" });
  });

  it("goes on past a result that holds no block, and ends with a later result's", async () => {
    const { output } = await running([
      init,
      { background: true },
      result("The full test suite is running in the background; I'll pick up its result when it finishes."),
      LONGER_THAN_GRACE,
      says("The suite passed."),
      result(block("Add the booking page")),
    ]);

    expect(output).toMatchObject({ title: "Add the booking page" });
  });

  it("isn't ended by a result that only names the tag's two ends, with no block between them", async () => {
    const { output } = await running([
      init,
      result("The suite is running in the background. I will end with an <implement>…</implement> block once it passes."),
      LONGER_THAN_GRACE,
      says("The suite passed."),
      result(block("Add the booking page")),
    ]);

    expect(output).toMatchObject({ title: "Add the booking page" });
  });

  it("ends a Reviewer's run with the reply its tag holds, which is text", async () => {
    const { output } = await running(
      [init, says("Reading the diff."), result("<review>\nverdict: pass\n\nChecked each criterion against the diff.\n</review>")],
      Output.string({ tag: "review" }),
    );

    expect(output).toBe("verdict: pass\n\nChecked each criterion against the diff.");
  });

  it("takes a later result's block over an earlier one's, and keeps the block when a later result holds none", async () => {
    const { output } = await running([
      init,
      result(block("An earlier block")),
      says("The background command finished."),
      result(block("Add the booking page")),
      says("Woken again."),
      result("Nothing more to do."),
    ]);

    expect(output).toMatchObject({ title: "Add the booking page" });
  });
});

describe("An agent run whose process exits by itself", () => {
  it("ends with its last result's output block, started with the arguments the preflight is given", async () => {
    const { output, launch, launched } = await running([init, says("Done."), result(block("Add the booking page")), { exit: 0 }]);

    expect(output).toEqual({ title: "Add the booking page", summary: "Adds the page." });
    expect(launched.argv).toEqual(launch.args);
    expect(JSON.parse(process.env["FABRIK_CLAUDE_ARGS"] ?? "[]")).toEqual(launch.args);
  });

  it("ends with the block an earlier result held, as a run left open does, when a turn it was woken into afterwards failed", async () => {
    const { output } = await running([
      init,
      result(block("Add the booking page")),
      says("Woken by the background command."),
      { line: { type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: overloaded" } },
      { exit: 0 },
    ]);

    expect(output).toMatchObject({ title: "Add the booking page" });
  });

  it("fails when its reply holds no output block", async () => {
    await expect(running([init, result("I could not finish."), { exit: 0 }])).rejects.toThrow(/<implement> not found/);
  });
});

describe("Once a run has settled (#860)", () => {
  it("the agent's process and the background command it started are stopped", async () => {
    const { launched } = await running([init, { background: true }, result(block("Add the booking page"))]);
    expect(launched.background).not.toBeNull();
    expect([launched.pid, launched.background].map((pid) => alive(pid as number))).toEqual([true, true]);

    const stopped = await stopStartedProcesses();

    expect(stopped).toBeGreaterThanOrEqual(2);
    expect([launched.pid, launched.background].map((pid) => alive(pid as number))).toEqual([false, false]);
  });

  it("stops nothing when the agent's process had exited by itself", async () => {
    await running([init, result(block("Add the booking page")), { exit: 0 }]);

    expect(await stopStartedProcesses()).toBe(0);
  });
});
