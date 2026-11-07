// Setup's questions: time zone, a second Subscription and Dispatch paused. The
// flags answer them, and the program asks only what they left out, and only on
// a terminal. Without one, a missing answer means no.
import { describe, expect, it } from "vitest";
import { aCleanProduct } from "../__fixtures__/productState.ts";
import type { ProductState } from "./plan.ts";
import type { Prompt } from "./prompt.ts";
import { askQuestions } from "./questions.ts";
import type { FlagAnswers } from "./args.ts";

function scripted(...answers: (string | null)[]): Prompt & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    ask: async (question) => {
      questions.push(question);
      if (answers.length === 0) throw new Error(`Asked more than the script answers: ${question}`);
      return answers.shift()!;
    },
  };
}

const neverAsked: Prompt = {
  ask: async (question) => {
    throw new Error(`Asked: ${question}`);
  },
};

async function ask(flags: FlagAnswers, prompt: Prompt | null, state: ProductState = aCleanProduct()) {
  const said: string[] = [];
  const answers = await askQuestions({ flags, state, machineTimeZone: "Australia/Sydney", prompt, say: (line) => said.push(line) });
  return { answers, said };
}

const storeIn = (timeZone: string): ProductState["store"] => ({
  exists: true,
  private: true,
  files: { ".github/workflows/weekly-summary.yml": `on:\n  schedule:\n    - cron: "0 7 * * 1"\n      timezone: "${timeZone}"\n` },
  secrets: [],
});

describe("Setup's questions", () => {
  it("asks nothing when the flags answer every question", async () => {
    const { answers } = await ask({ timeZone: "Europe/London", secondSubscription: true, paused: false }, neverAsked);

    expect(answers).toEqual({ timeZone: "Europe/London", secondSubscription: true });
  });

  it("takes a no from the flags without asking", async () => {
    const { answers } = await ask({ timeZone: null, secondSubscription: false, paused: false }, neverAsked);

    expect(answers).toEqual({});
  });

  it("without a terminal, asks nothing and takes a missing answer as no", async () => {
    expect((await ask({}, null)).answers).toEqual({});
    expect((await ask({ paused: true }, null)).answers).toEqual({ paused: true });
  });

  it("on a terminal, asks only what the flags left out", async () => {
    const prompt = scripted("y");
    const { answers } = await ask({ timeZone: "Europe/London", paused: false }, prompt);

    expect(prompt.questions).toEqual(["Add a second Subscription? [y/N] "]);
    expect(answers).toEqual({ timeZone: "Europe/London", secondSubscription: true });
  });

  it("offers this machine's time zone when fabrik-runs holds none", async () => {
    const prompt = scripted("", "", "");
    const { answers } = await ask({}, prompt);

    expect(prompt.questions[0]).toBe("Your time zone, or no to leave fabrik-runs out [Australia/Sydney]: ");
    expect(answers).toEqual({ timeZone: "Australia/Sydney" });
  });

  it("offers the time zone fabrik-runs already holds", async () => {
    const prompt = scripted("", "", "");
    const { answers } = await ask({}, prompt, aCleanProduct({ store: storeIn("Europe/Berlin") }));

    expect(prompt.questions[0]).toBe("Your time zone, or no to leave fabrik-runs out [Europe/Berlin]: ");
    expect(answers).toEqual({ timeZone: "Europe/Berlin" });
  });

  it("takes another time zone, or no", async () => {
    expect((await ask({}, scripted("America/New_York", "", ""))).answers).toEqual({ timeZone: "America/New_York" });
    expect((await ask({}, scripted("no", "", ""))).answers).toEqual({});
  });

  it("asks the time zone again when the answer isn't one", async () => {
    const prompt = scripted("Sydney", "Australia/Perth", "", "");
    const { answers, said } = await ask({}, prompt);

    expect(said).toContain("Sydney isn't an IANA time zone, such as Europe/London.");
    expect(answers).toEqual({ timeZone: "Australia/Perth" });
  });

  it("gives the count of open ready-for-agent issues before asking whether to pause", async () => {
    const prompt = scripted("", "y");
    const { answers, said } = await ask({ timeZone: null }, prompt, aCleanProduct({ readyForAgent: 3 }));

    expect(said).toContain("3 open issues are labelled ready-for-agent. Dispatch starts releasing them to Implementers as soon as the setup PR merges.");
    expect(prompt.questions[1]).toBe("Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? [y/N] ");
    expect(answers).toEqual({ paused: true });
  });

  it("doesn't ask whether to pause when the repo already has a Kit config, which --paused never changes", async () => {
    const prompt = scripted("");
    const { answers } = await ask({ timeZone: null }, prompt, aCleanProduct({ files: { ".fabrik/config.json": "{}\n" } }));

    expect(prompt.questions).toEqual(["Add a second Subscription? [y/N] "]);
    expect(answers).toEqual({});
  });

  it("takes the end of the terminal's input as no", async () => {
    expect((await ask({}, scripted(null, null, null))).answers).toEqual({});
  });
});
