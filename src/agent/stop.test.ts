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

/** Runs a Kit program that starts a command which stays open, as a settled run's agent can, then ends with `code`. */
async function programEnding(code: number, starts: string) {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-stop-"));
  const program = join(dir, "program.mjs");
  await writeFile(
    program,
    [
      `import { spawn } from "node:child_process";`,
      `import { endAgentProgram } from ${JSON.stringify(join(import.meta.dirname, "stop.ts"))};`,
      starts,
      `await endAgentProgram(${code});`,
    ].join("\n"),
  );
  const started = Date.now();
  const ended = spawnSync(process.execPath, [program], { encoding: "utf8", timeout: 60_000 });
  return { status: ended.status, lines: ended.stdout.trim().split("\n"), took: Date.now() - started };
}

describe("A Kit program that ran an agent, once its run has settled (#860)", () => {
  it("ends with its code without waiting for a process the run left open, and leaves none running", { timeout: 60_000 }, async () => {
    // A child with open pipes is what kept the runner's step waiting: Node doesn't exit while one is open.
    const { status, lines, took } = await programEnding(
      1,
      `const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], { stdio: ["ignore", "pipe", "pipe"] });
       const background = await new Promise((read) => child.stdout.once("data", (text) => read(Number(String(text).trim()))));
       console.log(JSON.stringify({ child: child.pid, background }));`,
    );

    expect(status).toBe(1);
    expect(took).toBeLessThan(30_000);
    const { child, background } = JSON.parse(lines[0] ?? "{}") as { child: number; background: number };
    expect([alive(child), alive(background)]).toEqual([false, false]);
    expect(lines[1]).toBe("::notice title=Agent process stopped::The run settled with 2 processes still running, which the Kit stopped");
  });

  it("ends with its code, saying nothing, when the run left nothing running", { timeout: 60_000 }, async () => {
    const { status, lines } = await programEnding(0, `console.log("done");`);

    expect(status).toBe(0);
    expect(lines).toEqual(["done"]);
  });
});
