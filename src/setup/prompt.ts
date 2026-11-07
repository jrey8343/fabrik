// How the setup program asks the Operator a question. It asks only when stdin
// is a terminal: without one there's no prompt, and a missing answer means no,
// so a run without a terminal stops at its plan.
import { createInterface } from "node:readline";

export interface Prompt {
  /** The Operator's answer, or null when their input ends first. */
  ask(question: string): Promise<string | null>;
}

/** A yes-or-no answer, as the wizard reads one: only an answer starting with y is yes. */
export function isYes(answer: string | null): boolean {
  return answer !== null && /^[Yy]/.test(answer.trim());
}

/** A prompt on the terminal, or null when stdin isn't one. Close it when done, or the program waits on stdin. */
export function terminalPrompt(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  output: NodeJS.WritableStream,
): (Prompt & { close(): void }) | null {
  if (input.isTTY !== true) return null;
  return readlinePrompt(input, output);
}

/** A prompt reading lines from any stream. A line typed ahead answers the next question. */
export function readlinePrompt(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompt & { close(): void } {
  const lines = createInterface({ input, terminal: false });
  const typed: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  lines.on("line", (line) => (waiting.length > 0 ? waiting.shift()!(line) : typed.push(line)));
  lines.once("close", () => {
    ended = true;
    for (const answer of waiting.splice(0)) answer(null);
  });
  return {
    ask: (question) => {
      output.write(question);
      if (typed.length > 0) return Promise.resolve(typed.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((answer) => waiting.push(answer));
    },
    close: () => lines.close(),
  };
}
