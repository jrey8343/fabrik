// Stops what a Kit program started and left running (#860). Sandcastle's
// noSandbox gives no way to stop the agent it launched, and Node waits on a
// child that is still open, so a run that settled with its agent's process
// open, as one ended by its output block or its idle limit is, kept its step
// running until that process closed by itself. The agent runner
// (src/agent/run.ts) and the judge (src/kit/judge-main.ts) end through this
// once everything they write is written.
import { spawnSync } from "node:child_process";

/** How long a process told to stop is given before it is killed. */
const STOP_GRACE_MS = 3000;

/** Every process running now that `root` started, or that one of those did, from the system's process table. */
function startedBy(root: number): number[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const row of (ps.stdout ?? "").split("\n")) {
    const [pid, parent] = row.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || Number.isNaN(pid) || Number.isNaN(parent) || pid === ps.pid) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  const toRead = [root];
  for (let next = toRead.shift(); next !== undefined; next = toRead.shift()) {
    const started = children.get(next) ?? [];
    found.push(...started);
    toRead.push(...started);
  }
  return found;
}

function sendSignal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Gone already.
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops every process this one started that is still running, and what those
 * started, as far as the process table still ties them to it: the agent's
 * `claude` and the background commands it holds. Each is asked to stop, then
 * killed if it hasn't within `graceMs`. Gives how many it found running, 0
 * for a run whose agent had exited by itself. A process whose own parent has
 * already exited is tied to nothing here, so it is left to the job's end.
 */
export async function stopStartedProcesses(graceMs: number = STOP_GRACE_MS): Promise<number> {
  const started = startedBy(process.pid);
  if (started.length === 0) return 0;
  sendSignal(started, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (started.some(isRunning) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  // Whatever outlived the request, and anything started since the first look.
  sendSignal([...started.filter(isRunning), ...startedBy(process.pid)], "SIGKILL");
  return started.length;
}

/**
 * Ends a Kit program that ran an agent, once `program` has settled, by which
 * time everything it writes is written: says how it failed, if it did, under
 * `failureTitle`, stops what the run left running, says so, and exits with 0
 * or 1, so its step ends without waiting for the agent's process to close.
 */
export async function endAgentProgram(program: Promise<void>, failureTitle: string): Promise<never> {
  const code = await program.then(
    () => 0,
    (error: unknown) => {
      console.log(`::error title=${failureTitle}::${error instanceof Error ? error.message : String(error)}`);
      return 1;
    },
  );
  const stopped = await stopStartedProcesses();
  if (stopped > 0) {
    console.log(`::notice title=Agent process stopped::The run settled with ${stopped} process${stopped === 1 ? "" : "es"} still running, which the Kit stopped`);
  }
  process.exit(code);
}
