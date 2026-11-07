// Which 1Password account setup uses: the only one, the one --account= or
// OP_ACCOUNT names, or the one the Operator picks when there are several.
import { describe, expect, it } from "vitest";
import { ACME, type Answer, fakeCommands, PERSONAL } from "../__fixtures__/setupCommands.ts";
import { checkOp, chooseAccount } from "./account.ts";
import type { Prompt } from "./prompt.ts";

/** A prompt that answers from a script, recording each question. */
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

async function choose(
  accounts: Answer,
  options: { given?: string; env?: Record<string, string>; prompt?: Prompt | null } = {},
) {
  const said: string[] = [];
  const commands = fakeCommands({ "op account list --format json": accounts });
  const outcome = await chooseAccount({
    run: commands.run,
    cwd: "/product",
    env: options.env ?? {},
    ...(options.given === undefined ? {} : { given: options.given }),
    prompt: options.prompt === undefined ? neverAsked : options.prompt,
    say: (line) => said.push(line),
  });
  return { outcome, said };
}

const several = { stdout: JSON.stringify([PERSONAL, ACME]) };

describe("Choosing the 1Password account", () => {
  it("takes the only account without asking", async () => {
    const { outcome } = await choose({ stdout: JSON.stringify([PERSONAL]) });

    expect(outcome).toEqual({ ok: true, account: { opAccount: "my.1password.com", name: "my.1password.com (operator@example.com)" } });
  });

  it("takes the one --account= names, without asking", async () => {
    const { outcome } = await choose(several, { given: "acme.1password.com" });

    expect(outcome).toEqual({ ok: true, account: { opAccount: "acme.1password.com", name: "acme.1password.com (operator@acme.example)" } });
  });

  it("takes an OP_ACCOUNT already in the environment as the answer", async () => {
    const { outcome } = await choose(several, { env: { OP_ACCOUNT: "acme.1password.com" }, prompt: null });

    expect(outcome).toEqual({ ok: true, account: { opAccount: "acme.1password.com", name: "acme.1password.com (operator@acme.example)" } });
  });

  it("takes --account= over OP_ACCOUNT", async () => {
    const { outcome } = await choose(several, { given: "my.1password.com", env: { OP_ACCOUNT: "acme.1password.com" } });

    expect(outcome.ok && outcome.account.opAccount).toBe("my.1password.com");
  });

  it("matches an account by its email or ID, as op does", async () => {
    expect((await choose(several, { given: "operator@acme.example" })).outcome).toMatchObject({ account: { name: "acme.1password.com (operator@acme.example)" } });
    expect((await choose(several, { given: "AACME" })).outcome).toMatchObject({ account: { name: "acme.1password.com (operator@acme.example)" } });
  });

  it("passes on an account it can't match, such as a shorthand, for op to check", async () => {
    const { outcome } = await choose(several, { given: "acme" });

    expect(outcome).toEqual({ ok: true, account: { opAccount: "acme", name: "acme" } });
  });

  it("with several accounts and a terminal, lists them and asks which holds this Product's secrets", async () => {
    const prompt = scripted("2");
    const { outcome, said } = await choose(several, { prompt });

    expect(said).toEqual([
      "Your 1Password accounts:",
      "  1. my.1password.com (operator@example.com)",
      "  2. acme.1password.com (operator@acme.example)",
    ]);
    expect(prompt.questions).toEqual(["Which one holds this Product's secrets? [1-2] "]);
    expect(outcome).toEqual({ ok: true, account: { opAccount: "acme.1password.com", name: "acme.1password.com (operator@acme.example)" } });
  });

  it("asks again until the answer is one of the numbers", async () => {
    const prompt = scripted("", "3", "acme", "1");
    const { outcome, said } = await choose(several, { prompt });

    expect(prompt.questions).toHaveLength(4);
    expect(said.filter((line) => line === "Give a number from 1 to 2.")).toHaveLength(3);
    expect(outcome.ok && outcome.account.opAccount).toBe("my.1password.com");
  });

  it("stops, naming --account=, when the terminal's input ends before an answer", async () => {
    const { outcome } = await choose(several, { prompt: scripted(null) });

    expect(outcome.ok ? "" : outcome.problem).toMatch(/--account=my\.1password\.com.*--account=acme\.1password\.com/);
  });

  it("with several accounts and no terminal, stops naming --account= and each account", async () => {
    const { outcome } = await choose(several, { prompt: null });

    expect(outcome).toEqual({
      ok: false,
      problem:
        "op has several 1Password accounts, and setup can't ask which to use without a terminal. " +
        "Run it again with one of --account=my.1password.com (operator@example.com), --account=acme.1password.com (operator@acme.example).",
    });
  });

  it("names an account by its user ID when another shares its sign-in address", async () => {
    const family = { ...PERSONAL, email: "family@example.com", user_uuid: "UFAMILY", account_uuid: "AFAMILY" };
    const { outcome } = await choose({ stdout: JSON.stringify([PERSONAL, family]) }, { prompt: scripted("2") });

    expect(outcome).toEqual({ ok: true, account: { opAccount: "UFAMILY", name: "my.1password.com (family@example.com)" } });
  });

  it("stops when op has no account", async () => {
    const { outcome } = await choose({ stdout: "[]" });

    expect(outcome.ok ? "" : outcome.problem).toMatch(/^op has no 1Password account\. .*Integrate with 1Password CLI/);
  });

  it("stops when op can't list the accounts", async () => {
    const { outcome } = await choose({ code: 127, stderr: "op isn't installed, or isn't on PATH" });

    expect(outcome.ok ? "" : outcome.problem).toBe(
      "op couldn't list your 1Password accounts (op isn't installed, or isn't on PATH). Install the 1Password CLI and sign in to it, then run setup again.",
    );
  });
});

describe("Checking op reaches the account", () => {
  it("passes when op lists the account's vaults", async () => {
    const commands = fakeCommands({ "op vault list --format json": { stdout: "[]" } });

    expect(await checkOp(commands.run, "/product", { OP_ACCOUNT: "acme.1password.com" }, "acme.1password.com (operator@acme.example)")).toBeNull();
    expect(commands.calls.map((call) => call.env.OP_ACCOUNT)).toEqual(["acme.1password.com"]);
  });

  it("stops when it can't, naming the 1Password app's setting", async () => {
    const commands = fakeCommands({ "op vault list --format json": { code: 1, stderr: "[ERROR] 2026/11/07 authorization prompt dismissed" } });

    expect(await checkOp(commands.run, "/product", {}, "acme.1password.com (operator@acme.example)")).toBe(
      "op couldn't reach the 1Password account acme.1password.com (operator@acme.example) ([ERROR] 2026/11/07 authorization prompt dismissed). " +
        "Unlock the 1Password app and turn on Settings → Developer → Integrate with 1Password CLI, then run setup again.",
    );
  });
});
