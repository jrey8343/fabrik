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

async function ask(flags: FlagAnswers, prompt: Prompt | null, state: ProductState = aCleanProduct(), wroteStarter = false) {
  const said: string[] = [];
  const answers = await askQuestions({ flags, state, wroteStarter, machineTimeZone: "Australia/Sydney", prompt, say: (line) => said.push(line) });
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

  describe("with a Kit config that lists two or more Subscriptions, a rotation setup never adds to", () => {
    const rotation = aCleanProduct({ files: { ".fabrik/config.json": '{ "subscriptions": ["Claude token", "Claude backup"] }\n' } });

    it("doesn't ask about a second Subscription, and says it leaves that list as it is", async () => {
      const prompt = scripted();
      const { answers, said } = await ask({ timeZone: null }, prompt, rotation);

      expect(prompt.questions).toEqual([]);
      expect(said).toContain(".fabrik/config.json already lists 2 Subscriptions, and Setup leaves a list of two or more as it is, so it doesn't ask about a second.");
      expect(answers).toEqual({});
    });

    it("takes --second-subscription as doing nothing, and says so, in a terminal or not", async () => {
      for (const prompt of [neverAsked, null]) {
        const { answers, said } = await ask({ timeZone: null, secondSubscription: true, paused: false }, prompt, rotation);

        expect(said).toEqual(["--second-subscription has no effect: .fabrik/config.json already lists 2 Subscriptions, and Setup leaves a list of two or more as it is."]);
        expect(answers).toEqual({});
      }
    });

    it("says nothing about it without a terminal, or with --no-second-subscription", async () => {
      expect((await ask({ timeZone: null, paused: false }, null, rotation)).said).toEqual([]);
      expect((await ask({ timeZone: null, secondSubscription: false, paused: false }, neverAsked, rotation)).said).toEqual([]);
    });

    it("still asks for a Kit config that lists one, or leaves subscriptions to its default", async () => {
      for (const config of ['{ "subscriptions": ["Claude backup"] }\n', '{ "max_in_flight": 1 }\n']) {
        const prompt = scripted("n");
        await ask({ timeZone: null }, prompt, aCleanProduct({ files: { ".fabrik/config.json": config } }));
        expect(prompt.questions).toEqual(["Add a second Subscription? [y/N] "]);
      }
    });
  });

  describe("with the starter setup wrote on its branch, which is still setup's own", () => {
    const withStarter = (maxInFlight: number) => aCleanProduct({ readyForAgent: 2, files: { ".fabrik/config.json": `{\n  "max_in_flight": ${maxInFlight}\n}\n` } });
    const PAUSE_DEFAULT_YES = "Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? [Y/n] ";
    const PAUSE_DEFAULT_NO = "Install with Dispatch paused, so no Implementer starts until you raise max_in_flight? [y/N] ";

    it("asks whether to pause, offering what the starter holds", async () => {
      const paused = scripted("", "");
      expect((await ask({ timeZone: null }, paused, withStarter(0), true)).answers).toEqual({ paused: true });
      expect(paused.questions[1]).toBe(PAUSE_DEFAULT_YES);

      const unpaused = scripted("", "");
      expect((await ask({ timeZone: null }, unpaused, withStarter(2), true)).answers).toEqual({});
      expect(unpaused.questions[1]).toBe(PAUSE_DEFAULT_NO);
    });

    it("takes the Operator's answer over what the starter holds", async () => {
      expect((await ask({ timeZone: null }, scripted("", "n"), withStarter(0), true)).answers).toEqual({});
      expect((await ask({ timeZone: null }, scripted("", "y"), withStarter(2), true)).answers).toEqual({ paused: true });
    });

    it("without a terminal, or at the end of its input, keeps what the starter holds", async () => {
      expect((await ask({}, null, withStarter(0), true)).answers).toEqual({ paused: true });
      expect((await ask({}, null, withStarter(2), true)).answers).toEqual({});
      expect((await ask({ timeZone: null }, scripted("", null), withStarter(0), true)).answers).toEqual({ paused: true });
    });

    it("takes --paused or --no-paused without asking", async () => {
      expect((await ask({ timeZone: null, secondSubscription: false, paused: true }, neverAsked, withStarter(2), true)).answers).toEqual({ paused: true });
      expect((await ask({ timeZone: null, secondSubscription: false, paused: false }, neverAsked, withStarter(0), true)).answers).toEqual({});
    });
  });

  it("takes the end of the terminal's input as no", async () => {
    expect((await ask({}, scripted(null, null, null))).answers).toEqual({});
  });
});
