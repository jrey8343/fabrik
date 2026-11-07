// The setup program from its command line to its plan: the checks, the
// 1Password account, the questions, then the plan, with every git, gh and op
// command answered by a fake runner and no terminal unless a test gives one.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACME,
  aReadyOperator,
  APPLYING,
  type Answer,
  type Call,
  fakeCommands,
  ghUser,
  lsRemote,
  OTHER_SHA,
  PERSONAL,
  REPO_VIEW,
  STATUS,
} from "../__fixtures__/setupCommands.ts";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { runSetup } from "./program.ts";
import type { Prompt } from "./prompt.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");
/** The usage line, as the Operator runs setup: through the bootstrap command, which fills in the checkout. */
const BOOTSTRAP_USAGE =
  "Usage: curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- [release] [--account=<1Password account>]" +
  " [--time-zone=<IANA zone> | --no-time-zone] [--second-subscription | --no-second-subscription] [--paused | --no-paused] [--plan]";

let productDir: string;

beforeEach(async () => {
  productDir = await tempDir("setup-program");
});

function scripted(...answers: string[]): Prompt & { questions: string[] } {
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

interface Options {
  readonly script?: Record<string, Answer>;
  readonly env?: Record<string, string>;
  readonly prompt?: Prompt | null;
  readonly nodeVersion?: string;
}

async function setup(args: string[], options: Options = {}) {
  const commands = fakeCommands({ ...aReadyOperator(productDir), ...APPLYING, ...options.script });
  const said: string[] = [];
  const complaints: string[] = [];
  const code = await runSetup(args, {
    run: commands.run,
    env: options.env ?? {},
    cwd: productDir,
    prompt: options.prompt === undefined ? null : options.prompt,
    say: (line) => said.push(...line.split("\n")),
    complain: (line) => complaints.push(line),
    kitDir: KIT_DIR,
    nodeVersion: options.nodeVersion ?? "24.11.0",
    machineTimeZone: "Australia/Sydney",
    wizard: async () => {
      throw new Error("These runs stop at the plan, or only apply it, so never reach the wizard.");
    },
  });
  return { code, said, complaints, calls: commands.calls };
}

const severalAccounts = { "op account list --format json": { stdout: JSON.stringify([PERSONAL, ACME]) } };
/** No earlier run left a setup branch, here or on origin, so a run in a terminal goes on to ask for the yes. */
const NO_EARLIER_RUN = {
  "git rev-parse --verify --quiet refs/heads/fabrik/setup-v1.4.2": { code: 1 },
};
const withFabrikVault = {
  "op vault list --format json": { stdout: JSON.stringify([{ name: "Fabrik" }]) },
  "op item list --vault Fabrik --format json": { stdout: "[]" },
};

/** The commands that only read: the checks, the account and what setup gathers. */
const READ_ONLY = [
  /^git rev-parse /,
  /^git branch --show-current$/,
  /^git --no-optional-locks status /,
  /^git ls-remote /,
  /^git merge-base --is-ancestor /,
  /^gh api (?!--method)/,
  /^gh repo view /,
  /^gh (label|secret|issue) list /,
  /^op account list /,
  /^op vault list /,
  /^op item list /,
];

const isReadOnly = (call: Call) => READ_ONLY.some((pattern) => pattern.test(call.line));

describe("The setup program", () => {
  it("prints the plan, naming the 1Password account on its first line", async () => {
    const { code, said, complaints } = await setup([".", "v1.4.2"]);

    expect(complaints).toEqual([]);
    expect(code).toBe(0);
    expect(said[0]).toBe("Setup uses the 1Password account my.1password.com (operator@example.com).");
    expect(said).toContain("Setup would:");
  });

  it("plans the Fabrik vaults an account lacks as ordinary steps, not a warning", async () => {
    const { said } = await setup([".", "v1.4.2"]);

    expect(said).toContain('- create the 1Password vault "Fabrik"');
    expect(said).toContain('- create the 1Password vault "Fabrik App"');
    expect(said.filter((line) => /vault/i.test(line) && !line.startsWith("- create"))).toEqual([]);
  });

  describe("stops before any plan when a check fails", () => {
    const failing: [string, Record<string, Answer>, Omit<Options, "script">?][] = [
      ["Node before 24", {}, { nodeVersion: "22.11.0" }],
      ["outside a git clone", { "git rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" } }],
      ["gh signed out", { "gh api -i user": { code: 4, stderr: "gh auth login" } }],
      ["no workflow scope", { "gh api -i user": { stdout: ghUser("acme-operator", "repo") } }],
      [
        "not the repo's admin",
        {
          [REPO_VIEW]: {
            stdout: JSON.stringify({ owner: { login: "acme" }, name: "clinic", defaultBranchRef: { name: "main" }, isInOrganization: false, viewerPermission: "WRITE" }),
          },
        },
      ],
      ["another branch", { "git branch --show-current": { stdout: "ticket-12\n" } }],
      ["uncommitted changes", { [STATUS]: { stdout: " M README.md\0" } }],
      ["behind origin", { [lsRemote("v1.4.2")]: { stdout: `${OTHER_SHA}\trefs/heads/main\n` } }],
      ["op can't reach 1Password", { "op vault list --format json": { code: 1, stderr: "account is locked" } }],
      ["OP_SERVICE_ACCOUNT_TOKEN set", {}, { env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_limited" } }],
    ];

    it.each(failing)("%s", async (_, script, options) => {
      const { code, said, complaints, calls } = await setup([".", "v1.4.2"], { ...options, script });

      expect(code).toBe(1);
      expect(complaints).toHaveLength(1);
      expect(complaints[0]).toMatch(/then run setup again\.$|Run setup again without it, such as in a new terminal\.$|Run setup from the root/);
      expect(said).toEqual([]);
      expect(calls.filter((call) => /^gh label list|^op item list/.test(call.line))).toEqual([]);
    });
  });

  it("with OP_SERVICE_ACCOUNT_TOKEN set, runs no op command at all", async () => {
    const { complaints, calls } = await setup([".", "v1.4.2"], { env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_limited" } });

    expect(complaints[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN is set");
    expect(calls.filter((call) => call.command === "op")).toEqual([]);
  });

  it("with several 1Password accounts, asks which, and every later op call uses it", async () => {
    // The Operator answers the account, the three questions, then no to the plan.
    const prompt = scripted("2", "no", "", "", "n");
    const { code, said, calls } = await setup([".", "v1.4.2"], { script: { ...severalAccounts, ...withFabrikVault, ...NO_EARLIER_RUN }, prompt });

    expect(code).toBe(0);
    expect(prompt.questions[0]).toBe("Which one holds this Product's secrets? [1-2] ");
    const later = calls.slice(calls.findIndex((call) => call.line.startsWith("op account list")) + 1).filter((call) => call.command === "op");
    expect(later.map((call) => call.line)).toEqual(expect.arrayContaining(["op vault list --format json", "op item list --vault Fabrik --format json"]));
    expect(new Set(later.map((call) => call.env.OP_ACCOUNT))).toEqual(new Set(["acme.1password.com"]));
    expect(said).toContain("Setup uses the 1Password account acme.1password.com (operator@acme.example).");
  });

  it("with --account=, asks nothing about the account and sets OP_ACCOUNT from it", async () => {
    const { calls } = await setup([".", "v1.4.2", "--plan", "--account=acme.1password.com", "--no-time-zone", "--no-second-subscription", "--no-paused"], {
      script: severalAccounts,
      prompt: neverAsked,
    });

    const vaults = calls.find((call) => call.line === "op vault list --format json");
    expect(vaults?.env.OP_ACCOUNT).toBe("acme.1password.com");
  });

  it("with every answer given as a flag, asks nothing", async () => {
    const { code, said } = await setup(
      [".", "v1.4.2", "--plan", "--account=my.1password.com", "--time-zone=Europe/London", "--second-subscription", "--paused"],
      { script: severalAccounts, prompt: neverAsked },
    );

    expect(code).toBe(0);
    expect(said).toContain("- create jrey8343/fabrik-runs, private, to hold Run records, their transcripts and the Weekly summary");
    expect(said.some((line) => line.includes("Dispatch paused (max_in_flight 0)"))).toBe(true);
  });

  it("without a terminal, asks nothing and takes the account from OP_ACCOUNT", async () => {
    const { code, said, calls } = await setup([".", "v1.4.2", "--time-zone=Europe/London"], {
      script: severalAccounts,
      env: { OP_ACCOUNT: "acme.1password.com" },
      prompt: null,
    });

    expect(code).toBe(0);
    expect(said[0]).toBe("Setup uses the 1Password account acme.1password.com (operator@acme.example).");
    expect(calls.filter((call) => call.command === "op").every((call) => call.env.OP_ACCOUNT === "acme.1password.com")).toBe(true);
  });

  it("without a terminal or an answer for the account, stops naming --account=", async () => {
    const { code, complaints, said } = await setup([".", "v1.4.2"], { script: severalAccounts, prompt: null });

    expect(code).toBe(1);
    expect(complaints[0]).toContain("--account=my.1password.com (operator@example.com), --account=acme.1password.com (operator@acme.example)");
    expect(said).toEqual([]);
  });

  it("with --plan, runs only commands that read, and writes nothing in the checkout", async () => {
    const { code, said, calls } = await setup([".", "v1.4.2", "--plan", "--time-zone=Europe/London", "--second-subscription", "--paused"]);

    expect(code).toBe(0);
    expect(said).toContain("Setup would:");
    expect(calls.filter((call) => !isReadOnly(call)).map((call) => call.line)).toEqual([]);
    expect(await readdir(productDir)).toEqual([]);
  });

  it("without a terminal, stops at the plan, since it carries a plan out only on the Operator's yes", async () => {
    const { code, said, calls } = await setup([".", "v1.4.2", "--time-zone=Europe/London"], { prompt: null });

    expect(code).toBe(0);
    expect(said).toContain("Setup carries the plan out only on your yes, so run it in a terminal to do it.");
    expect(calls.filter((call) => !isReadOnly(call)).map((call) => call.line)).toEqual([]);
    expect(await readdir(productDir)).toEqual([]);
  });

  it("with --plan in a terminal, stops at the plan and says how to carry it out", async () => {
    const { code, said } = await setup([".", "v1.4.2", "--plan", "--no-time-zone", "--no-second-subscription", "--no-paused"], { prompt: neverAsked });

    expect(code).toBe(0);
    expect(said).toContain("Run setup again without --plan to do it.");
  });

  it("refuses a flag it doesn't know with the usage line, before running anything", async () => {
    const { code, complaints, calls } = await setup([".", "v1.4.2", "--pause"]);

    expect(code).toBe(2);
    expect(complaints[0]).toBe("Unknown flag --pause.");
    expect(complaints[1]).toBe(BOOTSTRAP_USAGE);
    expect(calls).toEqual([]);
  });

  it("run with no arguments, prints only the usage line", async () => {
    const { code, complaints, calls } = await setup([]);

    expect(code).toBe(2);
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toBe(BOOTSTRAP_USAGE);
    expect(calls).toEqual([]);
  });

  it("refuses a release that isn't an exact tag, before running anything", async () => {
    const { code, complaints, calls } = await setup([".", "v1"]);

    expect(code).toBe(1);
    expect(complaints[0]).toMatch(/^Can't set up Fabrik v1: /);
    expect(calls).toEqual([]);
  });
});

describe("An old personal copy of the fabrik-setup skill", () => {
  let home: string;
  let copy: string;

  beforeEach(async () => {
    home = await tempDir("setup-home");
    copy = join(home, ".claude", "skills", "fabrik-setup");
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "SKILL.md"), "---\nname: fabrik-setup\n---\n# Fabrik setup\n");
    await mkdir(join(home, ".claude", "skills", "grilling"));
  });

  const exists = async (path: string) => (await readdir(join(path, "..")).catch(() => [] as string[])).includes("fabrik-setup");
  const FOUND = () => `${copy} is an out-of-date copy of the fabrik-setup skill, which Setup no longer uses.`;
  const STALE = () => `It's stale: delete it with rm -rf '${copy}'.`;
  /** A run in a terminal with every question answered by a flag, that the Operator says no to at the plan. */
  const ANSWERED = [".", "v1.4.2", "--no-time-zone", "--no-second-subscription", "--no-paused"];

  it("is offered for deletion once the checks pass, and deleted on a yes, leaving the other personal skills", async () => {
    const prompt = scripted("y", "n");
    const { code, said } = await setup(ANSWERED, { env: { HOME: home }, prompt, script: NO_EARLIER_RUN });

    expect(code).toBe(0);
    expect(said[0]).toBe(FOUND());
    expect(prompt.questions[0]).toBe("Delete it? [y/N] ");
    expect(said).toContain(`Deleted ${copy}.`);
    expect(await exists(copy)).toBe(false);
    expect(await readdir(join(home, ".claude", "skills"))).toEqual(["grilling"]);
  });

  it("is kept on anything but a yes, with a warning that it's stale", async () => {
    const { said } = await setup(ANSWERED, { env: { HOME: home }, prompt: scripted("", "n"), script: NO_EARLIER_RUN });

    expect(said).toContain(`Kept it. ${STALE()}`);
    expect(await exists(copy)).toBe(true);
  });

  it("without a terminal, is kept with the warning, and nothing is asked", async () => {
    const { code, said } = await setup([".", "v1.4.2"], { env: { HOME: home }, prompt: null });

    expect(code).toBe(0);
    expect(said.slice(0, 2)).toEqual([FOUND(), STALE()]);
    expect(await exists(copy)).toBe(true);
  });

  it("with --plan, which changes nothing, is kept with the warning, and nothing is asked about it", async () => {
    const { said } = await setup([...ANSWERED, "--plan"], { env: { HOME: home }, prompt: neverAsked });

    expect(said.slice(0, 2)).toEqual([FOUND(), STALE()]);
    expect(await exists(copy)).toBe(true);
  });

  it("is found in CLAUDE_CONFIG_DIR's skills when that's set, as Claude Code keeps them there", async () => {
    const config = await tempDir("setup-claude-config");
    await mkdir(join(config, "skills", "fabrik-setup"), { recursive: true });

    const { said } = await setup([".", "v1.4.2"], { env: { HOME: home, CLAUDE_CONFIG_DIR: config }, prompt: null });

    expect(said[0]).toBe(`${join(config, "skills", "fabrik-setup")} is an out-of-date copy of the fabrik-setup skill, which Setup no longer uses.`);
  });

  it("isn't mentioned when there's none", async () => {
    const { said } = await setup([".", "v1.4.2"], { env: { HOME: await tempDir("setup-home") }, prompt: null });

    expect(said[0]).toBe("Setup uses the 1Password account my.1password.com (operator@example.com).");
  });

  it("isn't offered when a check fails, since setup stops first", async () => {
    const { code, said } = await setup([".", "v1.4.2"], { env: { HOME: home }, prompt: neverAsked, nodeVersion: "22.11.0" });

    expect(code).toBe(1);
    expect(said).toEqual([]);
    expect(await exists(copy)).toBe(true);
  });
});
