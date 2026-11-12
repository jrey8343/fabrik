// Setup's questions: time zone, a second Subscription, Dispatch paused and
// production. The flags answer them, and the program asks only what they left
// out, and only on a terminal. Without one, a missing answer means no.
import { describe, expect, it } from "vitest";
import { aCleanProduct } from "../__fixtures__/productState.ts";
import { deploymentsOf, fakeCommands, type Script } from "../__fixtures__/setupCommands.ts";
import { gatherDeployments } from "./gather.ts";
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

/** The first three questions' tests: production's question is answered no by its flag unless a test gives it. */
async function ask(flags: FlagAnswers, prompt: Prompt | null, state: ProductState = aCleanProduct(), wroteStarter = false) {
  const said: string[] = [];
  const answers = await askQuestions({
    flags: { productionUrl: null, ...flags },
    state,
    wroteStarter,
    machineTimeZone: "Australia/Sydney",
    prompt,
    say: (line) => said.push(line),
    deployments: async () => {
      throw new Error("Read the Deployments");
    },
  });
  return { answers, said };
}

const DEPLOYMENTS = "gh api repos/acme/clinic/deployments?per_page=100";

/** Production's question, the other three answered by flag, with the repo's Deployments from a canned gh. */
async function askProduction(flags: FlagAnswers, prompt: Prompt | null, { config, script = deploymentsOf("acme/clinic", []) }: { config?: string; script?: Script } = {}) {
  const said: string[] = [];
  const commands = fakeCommands(script);
  const state = aCleanProduct(config === undefined ? {} : { files: { ".fabrik/config.json": config } });
  const answers = await askQuestions({
    flags: { timeZone: null, secondSubscription: false, paused: false, ...flags },
    state,
    wroteStarter: false,
    machineTimeZone: "Australia/Sydney",
    prompt,
    say: (line) => said.push(line),
    deployments: () => gatherDeployments(commands.run, "/clinic", state.repo),
  });
  return { production: answers.production, said, reads: commands.calls.filter((call) => call.line === DEPLOYMENTS).length };
}

const storeIn = (timeZone: string): ProductState["store"] => ({
  exists: true,
  private: true,
  files: { ".github/workflows/weekly-summary.yml": `on:\n  schedule:\n    - cron: "0 7 * * 1"\n      timezone: "${timeZone}"\n` },
  secrets: [],
});

describe("Setup's questions", () => {
  it("asks nothing when the flags answer every question", async () => {
    const flags = {
      timeZone: "Europe/London",
      secondSubscription: true,
      paused: false,
      productionUrl: "https://clinic.example.com",
      productionEnvironment: "production",
    };
    const { answers } = await ask(flags, neverAsked);

    expect(answers).toEqual({
      timeZone: "Europe/London",
      secondSubscription: true,
      production: { url: "https://clinic.example.com", environment: "production" },
    });
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

  describe("with a Kit config that lists the second Subscription alone, which setup has nothing to list for", () => {
    const listed = aCleanProduct({ files: { ".fabrik/config.json": '{ "subscriptions": ["Claude token 2"] }\n' } });
    const LISTED = '.fabrik/config.json already lists the second Subscription, "Claude token 2"';

    it("doesn't ask about a second Subscription, and says it's listed", async () => {
      const prompt = scripted();
      const { answers, said } = await ask({ timeZone: null }, prompt, listed);

      expect(prompt.questions).toEqual([]);
      expect(said).toContain(`${LISTED}, so it doesn't ask about a second.`);
      expect(answers).toEqual({});
    });

    it("takes --second-subscription as doing nothing, and says so, in a terminal or not", async () => {
      for (const prompt of [neverAsked, null]) {
        const { answers, said } = await ask({ timeZone: null, secondSubscription: true, paused: false }, prompt, listed);

        expect(said).toEqual([`--second-subscription has no effect: ${LISTED}.`]);
        expect(answers).toEqual({});
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

describe("Setup's production question", () => {
  const ADDRESS = "Production's address, or no to leave production out: ";
  const address = (offered: string) => `Production's address, or no to leave production out [${offered}]: `;
  const environment = (offered: string) => `The environment production's deploys carry in GitHub's Deployments, or none [${offered}]: `;
  const WHICH = "Which one do production's deploys carry? Its number or name, or none: ";
  const NO_DEPLOYMENTS =
    "This repo reports no Deployments to GitHub, so merged work won't be followed to production until its deploy runs from an Actions job that names an environment. Setup can write the address alone, with environment null.";
  const live = (url: string, environment: string | null = "production") => ({ url, environment });

  it("offers production when the repo has Deployments by that name, and the address on its newest successful one, asking once", async () => {
    const script = deploymentsOf("acme/clinic", [
      { environment: "preview", url: "https://pr-4.clinic.example.dev" },
      { environment: "production", state: "failure" },
      { environment: "production", url: "https://clinic.example.com" },
    ]);
    const prompt = scripted("", "");

    const { production, reads } = await askProduction({}, prompt, { script });

    expect(prompt.questions).toEqual([environment("production"), address("https://clinic.example.com")]);
    expect(production).toEqual(live("https://clinic.example.com"));
    expect(reads).toBe(1);
  });

  it("offers the only environment the repo's Deployments carry when none is named production", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "live", url: "https://clinic.example.com" }]);
    const prompt = scripted("", "");

    const { production } = await askProduction({}, prompt, { script });

    expect(prompt.questions).toEqual([environment("live"), address("https://clinic.example.com")]);
    expect(production).toEqual(live("https://clinic.example.com", "live"));
  });

  it("lists several environments and asks which, by number or by name, offering the address of the one chosen", async () => {
    const script = deploymentsOf("acme/clinic", [
      { environment: "preview", url: "https://pr-4.clinic.example.dev" },
      { environment: "live", url: "https://clinic.example.com" },
    ]);

    for (const choice of ["2", "live"]) {
      const prompt = scripted(choice, "");
      const { production, said } = await askProduction({}, prompt, { script });

      expect(said).toContain("This repo's Deployments carry 2 environments: 1. preview, 2. live.");
      expect(prompt.questions).toEqual([WHICH, address("https://clinic.example.com")]);
      expect(production).toEqual(live("https://clinic.example.com", "live"));
    }
  });

  it("asks which again when the answer is none of them, and takes none as no environment", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "preview" }, { environment: "live" }]);
    const prompt = scripted("", "3", "none", "https://clinic.example.com");

    const { production, said } = await askProduction({}, prompt, { script });

    expect(said).toContain("Give the number of one of the 2, its name, or none.");
    expect(prompt.questions).toEqual([WHICH, WHICH, WHICH, ADDRESS]);
    expect(production).toEqual(live("https://clinic.example.com", null));
  });

  it("takes another environment name the Operator types", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "production", url: "https://clinic.example.com" }]);

    const { production } = await askProduction({}, scripted("live", "https://www.clinic.example.com"), { script });

    expect(production).toEqual(live("https://www.clinic.example.com", "live"));
  });

  it("on a repo with no Deployments, says deploys won't be tracked and what would track them, and writes the address with environment null", async () => {
    const prompt = scripted("https://clinic.example.com");

    const { production, said } = await askProduction({}, prompt);

    expect(said).toContain(NO_DEPLOYMENTS);
    expect(prompt.questions).toEqual([ADDRESS]);
    expect(production).toEqual(live("https://clinic.example.com", null));
  });

  it("offers ui.before_url over a Deployment's address", async () => {
    const config = '{ "ui": { "before_url": "https://www.clinic.example.com" } }\n';
    const script = deploymentsOf("acme/clinic", [{ environment: "production", url: "https://clinic.example.com" }]);
    const prompt = scripted("", "");

    const { production } = await askProduction({}, prompt, { config, script });

    expect(prompt.questions[1]).toBe(address("https://www.clinic.example.com"));
    expect(production).toEqual(live("https://www.clinic.example.com"));
  });

  it("offers ui.before_url on a repo with no Deployments", async () => {
    const config = '{ "ui": { "before_url": "https://www.clinic.example.com" } }\n';
    const prompt = scripted("");

    const { production } = await askProduction({}, prompt, { config });

    expect(prompt.questions).toEqual([address("https://www.clinic.example.com")]);
    expect(production).toEqual(live("https://www.clinic.example.com", null));
  });

  it("with no address to offer, takes no, an empty answer or the end of input as no block", async () => {
    for (const answer of ["no", "n", "", null]) {
      expect((await askProduction({}, scripted(answer))).production).toBeUndefined();
    }
  });

  it("asks the address again when Kit config would refuse it, and never takes it", async () => {
    const prompt = scripted("clinic.example.com", "ftp://clinic.example.com", "https://clinic.example.com");

    const { production, said } = await askProduction({}, prompt);

    expect(prompt.questions).toEqual([ADDRESS, ADDRESS, ADDRESS]);
    expect(said).toContain('Kit config would refuse that: production.url is "ftp://clinic.example.com": a URL must start with http:// or https://.');
    expect(production).toEqual(live("https://clinic.example.com", null));
  });

  it("says in one line that the Deployments read was refused, offers no environment, and carries on", async () => {
    const script = { [DEPLOYMENTS]: { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" } };
    const prompt = scripted("https://clinic.example.com");

    const { production, said } = await askProduction({}, prompt, { script });

    expect(said.filter((line) => line.includes("403"))).toEqual([
      "Setup couldn't read this repo's Deployments (gh: Resource not accessible by integration (HTTP 403)), so it offers no environment.",
    ]);
    expect(prompt.questions).toEqual([ADDRESS]);
    expect(production).toEqual(live("https://clinic.example.com", null));
  });

  describe("with its flags", () => {
    it("asks nothing and reads nothing when the flags give both", async () => {
      const { production, reads } = await askProduction({ productionUrl: "https://clinic.example.com", productionEnvironment: null }, neverAsked);

      expect(production).toEqual(live("https://clinic.example.com", null));
      expect(reads).toBe(0);
    });

    it("asks nothing with --no-production or an empty --production-url=, which both parse as no", async () => {
      const { production, said, reads } = await askProduction({ productionUrl: null }, neverAsked);

      expect([production, said, reads]).toEqual([undefined, [], 0]);
    });

    it("on a terminal, asks only the environment when the address came by flag", async () => {
      const script = deploymentsOf("acme/clinic", [{ environment: "production", url: "https://pr.clinic.example.dev" }]);
      const prompt = scripted("");

      const { production } = await askProduction({ productionUrl: "https://clinic.example.com" }, prompt, { script });

      expect(prompt.questions).toEqual([environment("production")]);
      expect(production).toEqual(live("https://clinic.example.com"));
    });

    it("on a terminal, asks only the address when the environment came by flag, offering that environment's", async () => {
      const script = deploymentsOf("acme/clinic", [
        { environment: "production", url: "https://clinic.example.com" },
        { environment: "live", url: "https://live.clinic.example.com" },
      ]);
      const prompt = scripted("");

      const { production } = await askProduction({ productionEnvironment: "live" }, prompt, { script });

      expect(prompt.questions).toEqual([address("https://live.clinic.example.com")]);
      expect(production).toEqual(live("https://live.clinic.example.com", "live"));
    });

    it("without a terminal, writes --production-url= alone with environment null, and reads nothing", async () => {
      const { production, reads } = await askProduction({ productionUrl: "https://clinic.example.com" }, null);

      expect(production).toEqual(live("https://clinic.example.com", null));
      expect(reads).toBe(0);
    });

    it("without a terminal and without the flags, writes no block and reads nothing", async () => {
      const { production, reads } = await askProduction({}, null);

      expect([production, reads]).toEqual([undefined, 0]);
    });

    it("without a terminal, says --production-environment= does nothing without an address", async () => {
      const { production, said } = await askProduction({ productionEnvironment: "production" }, null);

      expect(production).toBeUndefined();
      expect(said).toEqual(["--production-environment= has no effect without an address: give --production-url= too."]);
    });

    it("stops the run with Kit config's reason when the address it was given would be refused", async () => {
      await expect(askProduction({ productionUrl: "ftp://clinic.example.com" }, null)).rejects.toThrow(
        'Kit config would refuse --production-url=ftp://clinic.example.com: production.url is "ftp://clinic.example.com": a URL must start with http:// or https://',
      );
    });
  });

  describe("on a Kit config it doesn't ask about", () => {
    const declared = '{\n  "production": { "url": "https://clinic.example.com", "environment": "production" }\n}\n';

    it("doesn't ask a repo that already declares production, or read its Deployments", async () => {
      const { production, said, reads } = await askProduction({}, neverAsked, { config: declared });

      expect([production, said, reads]).toEqual([undefined, [], 0]);
    });

    it("says its flags have no effect on a repo that already declares production", async () => {
      const { production, said } = await askProduction({ productionUrl: "https://www.clinic.example.com" }, null, { config: declared });

      expect(production).toBeUndefined();
      expect(said).toEqual([".fabrik/config.json already declares production, which Setup leaves as it is, so production's flags have no effect."]);
    });

    it("asks about the starter on setup's branch, whose production is null", async () => {
      const prompt = scripted("https://clinic.example.com");

      const { production } = await askProduction({}, prompt, { config: '{\n  "production": null\n}\n' });

      expect(production).toEqual(live("https://clinic.example.com", null));
    });

    it("doesn't ask about a Kit config that isn't a JSON object, and says why", async () => {
      const { production, said, reads } = await askProduction({}, neverAsked, { config: "[]\n" });

      expect([production, reads]).toEqual([undefined, 0]);
      expect(said).toEqual([".fabrik/config.json isn't a JSON object, so Setup doesn't ask about production: fix it, then run setup again."]);
    });
  });
});
