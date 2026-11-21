// Setup's questions: time zone, a second Subscription, Dispatch paused,
// production and staging. The flags answer them, and the program asks only what they left
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

/** The first three questions' tests: production's and staging's questions are each answered no by its flag unless a test gives it. */
async function ask(flags: FlagAnswers, prompt: Prompt | null, state: ProductState = aCleanProduct(), wroteStarter = false) {
  const said: string[] = [];
  const answers = await askQuestions({
    flags: { productionUrl: null, stagingUrl: null, ...flags },
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

const DEPLOYMENTS = "gh api repos/acme/clinic/deployments?per_page=100&page=1";

/** Production's question, the other four answered by flag, with the repo's Deployments from a canned gh. */
async function askProduction(flags: FlagAnswers, prompt: Prompt | null, { config, script = deploymentsOf("acme/clinic", []) }: { config?: string; script?: Script } = {}) {
  const said: string[] = [];
  const commands = fakeCommands(script);
  const state = aCleanProduct(config === undefined ? {} : { files: { ".fabrik/config.json": config } });
  const answers = await askQuestions({
    flags: { timeZone: null, secondSubscription: false, paused: false, stagingUrl: null, ...flags },
    state,
    wroteStarter: false,
    machineTimeZone: "Australia/Sydney",
    prompt,
    say: (line) => said.push(line),
    deployments: () => gatherDeployments(commands.run, "/clinic", state.repo),
  });
  return { production: answers.production, said, reads: commands.calls.filter((call) => call.line === DEPLOYMENTS).length };
}

/** Staging's question, the first three answered by flag and production's too unless a test gives it, with the repo's Deployments from a canned gh. */
async function askStaging(flags: FlagAnswers, prompt: Prompt | null, { config, script = deploymentsOf("acme/clinic", []) }: { config?: string; script?: Script } = {}) {
  const said: string[] = [];
  const commands = fakeCommands(script);
  const state = aCleanProduct(config === undefined ? {} : { files: { ".fabrik/config.json": config } });
  const answers = await askQuestions({
    flags: { timeZone: null, secondSubscription: false, paused: false, productionUrl: null, ...flags },
    state,
    wroteStarter: false,
    machineTimeZone: "Australia/Sydney",
    prompt,
    say: (line) => said.push(line),
    deployments: () => gatherDeployments(commands.run, "/clinic", state.repo),
  });
  return { staging: answers.staging, production: answers.production, said, reads: commands.calls.filter((call) => call.line === DEPLOYMENTS).length };
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
      stagingUrl: "https://staging.clinic.example.com",
      stagingEnvironment: "staging",
    };
    const { answers } = await ask(flags, neverAsked);

    expect(answers).toEqual({
      timeZone: "Europe/London",
      secondSubscription: true,
      production: { url: "https://clinic.example.com", environment: "production" },
      staging: { url: "https://staging.clinic.example.com", environment: "staging" },
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

  it("offers the Kit config's time_zone when fabrik-runs holds none", async () => {
    const prompt = scripted("", "", "");
    const { answers } = await ask({}, prompt, aCleanProduct({ files: { ".fabrik/config.json": '{ "time_zone": "Europe/Berlin" }\n' } }));

    expect(prompt.questions[0]).toBe("Your time zone, or no to leave fabrik-runs out [Europe/Berlin]: ");
    expect(answers).toEqual({ timeZone: "Europe/Berlin" });
  });

  it("offers fabrik-runs' zone before the Kit config's, which it brings back in step", async () => {
    const prompt = scripted("", "", "");
    await ask({}, prompt, aCleanProduct({ store: storeIn("Europe/London"), files: { ".fabrik/config.json": '{ "time_zone": "Europe/Berlin" }\n' } }));

    expect(prompt.questions[0]).toBe("Your time zone, or no to leave fabrik-runs out [Europe/London]: ");
  });

  it("offers this machine's zone over a Kit config time_zone that isn't one", async () => {
    const prompt = scripted("", "", "");
    await ask({}, prompt, aCleanProduct({ files: { ".fabrik/config.json": '{ "time_zone": "Mars/Olympus_Mons" }\n' } }));

    expect(prompt.questions[0]).toBe("Your time zone, or no to leave fabrik-runs out [Australia/Sydney]: ");
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

describe("Setup's staging question", () => {
  const ADDRESS = "Staging's address, or no to leave staging out: ";
  const address = (offered: string) => `Staging's address, or no to leave staging out [${offered}]: `;
  const ENVIRONMENT = "The environment staging's deploys carry in GitHub's Deployments, or none to leave staging out: ";
  const environment = (offered: string) => `The environment staging's deploys carry in GitHub's Deployments, or none to leave staging out [${offered}]: `;
  const WHICH = "Which one do staging's deploys carry? Its number or name, or none to leave staging out: ";
  const trial = (url: string, environment = "staging") => ({ url, environment });

  it("offers staging when the repo has Deployments by that name, and the address on its newest successful one", async () => {
    const script = deploymentsOf("acme/clinic", [
      { environment: "staging", state: "failure" },
      { environment: "production", url: "https://clinic.example.com" },
      { environment: "staging", url: "https://staging.clinic.example.com" },
    ]);
    const prompt = scripted("", "");

    const { staging, reads } = await askStaging({}, prompt, { script });

    expect(prompt.questions).toEqual([environment("staging"), address("https://staging.clinic.example.com")]);
    expect(staging).toEqual(trial("https://staging.clinic.example.com"));
    expect(reads).toBe(1);
  });

  it("says what the block is for before it asks", async () => {
    const { said } = await askStaging({}, scripted("none"));

    expect(said).toEqual([
      "Kit config can also say where this repo's staging site is, and the environment its deploys carry in GitHub's Deployments, so a merged pull request is followed to staging, where you try it before you deploy production.",
    ]);
  });

  it("lists the repo's other environments when none is named staging, and takes one by its number or its name", async () => {
    const script = deploymentsOf("acme/clinic", [
      { environment: "preview", url: "https://pr-4.clinic.example.dev" },
      { environment: "qa", url: "https://qa.clinic.example.com" },
    ]);

    for (const pick of ["2", "qa"]) {
      const prompt = scripted(pick, "");
      const { staging, said } = await askStaging({}, prompt, { script });

      expect(said).toContain("This repo's Deployments carry 2 environments: 1. preview, 2. qa.");
      expect(prompt.questions).toEqual([WHICH, address("https://qa.clinic.example.com")]);
      expect(staging).toEqual(trial("https://qa.clinic.example.com", "qa"));
    }
  });

  it("offers a repo's only other environment as a pick, never for an Enter, which leaves staging out", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "preview", url: "https://pr-4.clinic.example.dev" }]);
    const prompt = scripted("");

    const { staging, said } = await askStaging({}, prompt, { script });

    expect(said).toContain("This repo's Deployments carry one environment: 1. preview.");
    expect(prompt.questions).toEqual([WHICH]);
    expect(staging).toBeUndefined();
  });

  it("asks which again for a number that is none of them, and takes a name the Deployments don't carry yet", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "preview" }, { environment: "qa" }]);
    const prompt = scripted("3", "uat", "https://uat.clinic.example.com");

    const { staging, said } = await askStaging({}, prompt, { script });

    expect(said).toContain("Give the number of one of the 2, a name, or none.");
    expect(prompt.questions).toEqual([WHICH, WHICH, ADDRESS]);
    expect(staging).toEqual(trial("https://uat.clinic.example.com", "uat"));
  });

  it("leaves the environment production's deploys carry out of what it offers, as the Operator just answered it", async () => {
    const script = deploymentsOf("acme/clinic", [
      { environment: "staging", url: "https://clinic.example.com" },
      { environment: "next", url: "https://next.clinic.example.com" },
    ]);
    const prompt = scripted("staging", "", "1", "");

    const { production, staging, said, reads } = await askStaging({ productionUrl: undefined }, prompt, { script });

    expect(production).toEqual({ url: "https://clinic.example.com", environment: "staging" });
    expect(said).toContain("This repo's Deployments carry one environment besides production's: 1. next.");
    expect(prompt.questions.slice(2)).toEqual([WHICH, address("https://next.clinic.example.com")]);
    expect(staging).toEqual(trial("https://next.clinic.example.com", "next"));
    expect(reads).toBe(1);
  });

  it("leaves out the environment a declared production block names, and asks again when the Operator types it", async () => {
    const config = '{\n  "production": { "url": "https://clinic.example.com", "environment": "live" }\n}\n';
    const script = deploymentsOf("acme/clinic", [{ environment: "live", url: "https://clinic.example.com" }]);
    const prompt = scripted("live", "staging", "https://staging.clinic.example.com");

    const { staging, said } = await askStaging({ productionUrl: undefined }, prompt, { config, script });

    expect(prompt.questions).toEqual([ENVIRONMENT, ENVIRONMENT, ADDRESS]);
    expect(said).toContain(`Kit config would refuse that: staging.environment is "live": production.environment names it, and staging's environment is never production's.`);
    expect(staging).toEqual(trial("https://staging.clinic.example.com"));
  });

  it("writes no block on none or no for the environment, on no for the address, on an Enter with nothing offered, and when the input ends", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "staging" }]);

    for (const answers of [["none"], ["no"], ["N"], ["", "no"], ["", ""], [null], ["", null]]) {
      expect((await askStaging({}, scripted(...answers), { script })).staging, JSON.stringify(answers)).toBeUndefined();
    }
    expect((await askStaging({}, scripted(""))).staging).toBeUndefined();
  });

  it("asks the address again when Kit config would refuse it, and never takes it", async () => {
    const script = deploymentsOf("acme/clinic", [{ environment: "staging" }]);
    const prompt = scripted("", "ftp://staging.clinic.example.com", "https://staging.clinic.example.com");

    const { staging, said } = await askStaging({}, prompt, { script });

    expect(prompt.questions).toEqual([environment("staging"), ADDRESS, ADDRESS]);
    expect(said).toContain('Kit config would refuse that: staging.url is "ftp://staging.clinic.example.com": a URL must start with http:// or https://.');
    expect(staging).toEqual(trial("https://staging.clinic.example.com"));
  });

  it("says once, for production's question and its own, that the Deployments read was refused, and still takes a name", async () => {
    const script = { [DEPLOYMENTS]: { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" } };
    const prompt = scripted("https://clinic.example.com", "staging", "https://staging.clinic.example.com");

    const { production, staging, said, reads } = await askStaging({ productionUrl: undefined }, prompt, { script });

    expect(said.filter((line) => line.includes("403"))).toEqual([
      "Setup couldn't read this repo's Deployments (gh: Resource not accessible by integration (HTTP 403)), so it offers no environment.",
    ]);
    expect(prompt.questions.slice(1)).toEqual([ENVIRONMENT, ADDRESS]);
    expect([production, staging]).toEqual([{ url: "https://clinic.example.com", environment: null }, trial("https://staging.clinic.example.com")]);
    expect(reads).toBe(1);
  });

  it("says a refused Deployments read itself when production's question never did", async () => {
    const script = { [DEPLOYMENTS]: { code: 1, stderr: "gh: Not Found (HTTP 404)" } };

    const { said } = await askStaging({}, scripted("none"), { script });

    expect(said.filter((line) => line.includes("404"))).toEqual(["Setup couldn't read this repo's Deployments (gh: Not Found (HTTP 404)), so it offers no environment."]);
  });

  describe("with flags", () => {
    it("asks nothing, and reads nothing, when the flags give both", async () => {
      const flags = { stagingUrl: "https://staging.clinic.example.com", stagingEnvironment: "staging" };

      for (const prompt of [neverAsked, null]) {
        const { staging, said, reads } = await askStaging(flags, prompt);

        expect([staging, said, reads]).toEqual([trial("https://staging.clinic.example.com"), [], 0]);
      }
    });

    it("asks nothing with --no-staging, an empty --staging-url= or an empty --staging-environment=, which each answer no", async () => {
      for (const flags of [{ stagingUrl: null }, { stagingEnvironment: null }, { stagingUrl: "https://staging.clinic.example.com", stagingEnvironment: null }]) {
        const { staging, said, reads } = await askStaging(flags, neverAsked);

        expect([staging, said, reads], JSON.stringify(flags)).toEqual([undefined, [], 0]);
      }
    });

    it("asks only the environment when --staging-url= gives the address", async () => {
      const script = deploymentsOf("acme/clinic", [{ environment: "staging", url: "https://pr.clinic.example.dev" }]);
      const prompt = scripted("");

      const { staging } = await askStaging({ stagingUrl: "https://staging.clinic.example.com" }, prompt, { script });

      expect(prompt.questions).toEqual([environment("staging")]);
      expect(staging).toEqual(trial("https://staging.clinic.example.com"));
    });

    it("asks only the address when --staging-environment= names the environment, offering that environment's", async () => {
      const script = deploymentsOf("acme/clinic", [
        { environment: "staging", url: "https://staging.clinic.example.com" },
        { environment: "qa", url: "https://qa.clinic.example.com" },
      ]);
      const prompt = scripted("");

      const { staging } = await askStaging({ stagingEnvironment: "qa" }, prompt, { script });

      expect(prompt.questions).toEqual([address("https://qa.clinic.example.com")]);
      expect(staging).toEqual(trial("https://qa.clinic.example.com", "qa"));
    });

    it("without a terminal, writes no block from one flag alone, and says which it lacks", async () => {
      const url = await askStaging({ stagingUrl: "https://staging.clinic.example.com" }, null);
      const named = await askStaging({ stagingEnvironment: "staging" }, null);

      expect([url.staging, url.reads, named.staging, named.reads]).toEqual([undefined, 0, undefined, 0]);
      expect(url.said).toEqual(["--staging-url= has no effect without an environment, which staging needs: give --staging-environment= too."]);
      expect(named.said).toEqual(["--staging-environment= has no effect without an address: give --staging-url= too."]);
    });

    it("without a terminal or a flag, writes no block and reads nothing", async () => {
      const { staging, said, reads } = await askStaging({}, null);

      expect([staging, said, reads]).toEqual([undefined, [], 0]);
    });

    it.each([
      [{ stagingUrl: "ftp://staging.clinic.example.com" }, 'staging.url is "ftp://staging.clinic.example.com": a URL must start with http:// or https://'],
      [{ stagingUrl: "ftp://staging.clinic.example.com", stagingEnvironment: "staging" }, 'staging.url is "ftp://staging.clinic.example.com": a URL must start with http:// or https://'],
      [
        { productionUrl: "https://clinic.example.com", productionEnvironment: "live", stagingUrl: "https://staging.clinic.example.com", stagingEnvironment: "live" },
        `staging.environment is "live": production.environment names it, and staging's environment is never production's`,
      ],
    ])("stops the run, with Kit config's reason, when a flag gives what it would refuse: %j", async (flags, reason) => {
      await expect(askStaging(flags, null)).rejects.toThrow(`Kit config would refuse staging's flags: ${reason}`);
      await expect(askStaging(flags, neverAsked)).rejects.toThrow(`Kit config would refuse staging's flags: ${reason}`);
    });
  });

  describe("on a re-run", () => {
    const declared = '{\n  "staging": { "url": "https://staging.clinic.example.com", "environment": "staging" }\n}\n';

    it("doesn't ask a repo that already declares staging, or read its Deployments", async () => {
      const { staging, said, reads } = await askStaging({}, neverAsked, { config: declared });

      expect([staging, said, reads]).toEqual([undefined, [], 0]);
    });

    it("says its flags have no effect on a repo that already declares staging", async () => {
      const { staging, said } = await askStaging({ stagingUrl: "https://next.clinic.example.com", stagingEnvironment: "next" }, null, { config: declared });

      expect(staging).toBeUndefined();
      expect(said).toEqual([".fabrik/config.json already declares staging, which Setup leaves as it is, so staging's flags have no effect."]);
    });

    it("asks a repo whose Kit config has no staging member, or a null one, as a starter from before it does", async () => {
      for (const config of ['{\n  "production": null\n}\n', '{\n  "staging": null\n}\n']) {
        const prompt = scripted("staging", "https://staging.clinic.example.com");

        expect((await askStaging({}, prompt, { config })).staging).toEqual(trial("https://staging.clinic.example.com"));
      }
    });

    it("doesn't ask when the Kit config isn't a JSON object, and says why", async () => {
      const { staging, said, reads } = await askStaging({}, neverAsked, { config: "[]\n" });

      expect([staging, reads]).toEqual([undefined, 0]);
      expect(said).toEqual([".fabrik/config.json isn't a JSON object, so Setup doesn't ask about staging: fix it, then run setup again."]);
    });
  });
});
