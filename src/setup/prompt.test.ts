// The setup program asks only on a terminal, reading one line per question.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isYes, readlinePrompt, terminalPrompt } from "./prompt.ts";

describe("Asking the Operator", () => {
  it("doesn't ask when stdin isn't a terminal", () => {
    const piped = Object.assign(new PassThrough(), { isTTY: undefined });

    expect(terminalPrompt(piped, new PassThrough())).toBeNull();
  });

  it("reads one line for each question, showing the question", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
    const prompt = readlinePrompt(input, output);
    input.write("Europe/London\ny\n");

    expect(await prompt.ask("Time zone? ")).toBe("Europe/London");
    expect(await prompt.ask("Paused? ")).toBe("y");
    expect(shown).toBe("Time zone? Paused? ");
    prompt.close();
  });

  it("answers null once the input ends", async () => {
    const input = new PassThrough();
    const prompt = readlinePrompt(input, new PassThrough());
    const asked = prompt.ask("Which one? ");
    input.end();

    expect(await asked).toBeNull();
    expect(await prompt.ask("Which one? ")).toBeNull();
  });

  it("takes only an answer starting with y as yes", () => {
    expect([isYes("y"), isYes("Yes"), isYes(" yes "), isYes(""), isYes("n"), isYes("sure"), isYes(null)]).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
