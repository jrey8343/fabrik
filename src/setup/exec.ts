// How the setup program runs git, gh and op. The program takes a Run, so its
// tests can answer each command from a script instead of the real tools.
import { spawn } from "node:child_process";

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface RunOptions {
  readonly cwd: string;
  /** What the command reads on stdin. It always sees the end of it, so it can never prompt. */
  readonly input?: string;
  /** The command's whole environment. Without it the command inherits the program's. */
  readonly env?: Env;
}

export type Run = (command: string, args: readonly string[], options: RunOptions) => Promise<Ran>;

/** Runs the real command. One that isn't installed exits 127, as a shell's would. */
export const spawnRun: Run = (command, args, options) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? done({ code: 127, stdout: "", stderr: `${command} isn't installed, or isn't on PATH` }) : fail(error),
    );
    child.on("close", (code) => done({ stdout, stderr, code: code ?? 1 }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/** The command's stdout, or an error naming the command when it fails. */
export async function ok(run: Run, command: string, args: readonly string[], options: RunOptions): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} ${args[1] ?? ""} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}
