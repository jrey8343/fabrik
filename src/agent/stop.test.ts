import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs a Kit program that does what `starts` says, as a run's agent can leave a command open, then ends as `settled`, its run's promise, does. */
async function programEnding(settled: string, starts: string) {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-stop-"));
  const program = join(dir, "program.mjs");
  await writeFile(
    program,
    [
      `import { spawn } from "node:child_process";`,
      `import { endAgentProgram } from ${JSON.stringify(join(import.meta.dirname, "stop.ts"))};`,
      starts,
      `await endAgentProgram(${settled}, "Agent run failed");`,
    ].join("\n"),
  );
  const started = Date.now();
  const ended = spawnSync(process.execPath, [program], { encoding: "utf8", timeout: 60_000 });
  return { status: ended.status, lines: ended.stdout.trim().split("\n"), took: Date.now() - started };
}

describe("A Kit program that ran an agent, once its run has settled (#860)", () => {
  it("fails, naming the failure, without waiting for a process the failed run left open, and leaves none running", { timeout: 60_000 }, async () => {
    // A child with open pipes is what kept the runner's step waiting: Node doesn't exit while one is open.
    const { status, lines, took } = await programEnding(
      `Promise.reject(new Error("Agent idle for 600 seconds"))`,
      `const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], { stdio: ["ignore", "pipe", "pipe"] });
       const background = await new Promise((read) => child.stdout.once("data", (text) => read(Number(String(text).trim()))));
       console.log(JSON.stringify({ child: child.pid, background }));`,
    );

    expect(status).toBe(1);
    expect(took).toBeLessThan(30_000);
    const { child, background } = JSON.parse(lines[0] ?? "{}") as { child: number; background: number };
    expect([alive(child), alive(background)]).toEqual([false, false]);
    expect(lines.slice(1)).toEqual([
      "::error title=Agent run failed::Agent idle for 600 seconds",
      "::notice title=Agent process stopped::The run settled with 2 processes still running, which the Kit stopped",
    ]);
  });

  it("succeeds, saying nothing, when the run passed and left nothing running", { timeout: 60_000 }, async () => {
    const { status, lines } = await programEnding(`Promise.resolve()`, `console.log("done");`);

    expect(status).toBe(0);
    expect(lines).toEqual(["done"]);
  });
});
