// Which 1Password account setup uses. It reaches every op call, and the
// wizard, as OP_ACCOUNT, which op reads itself. --account= sets it, and an
// OP_ACCOUNT already in the environment counts as the answer. Otherwise the
// only account is taken, and with several the Operator picks one.
import type { Env, Run } from "./exec.ts";
import type { Prompt } from "./prompt.ts";

/** One account, as `op account list --format json` lists it. */
interface OpAccount {
  readonly url: string;
  readonly email: string;
  readonly user_uuid: string;
  readonly account_uuid: string;
}

export interface ChosenAccount {
  /** What OP_ACCOUNT is set to: a value op's --account takes. */
  readonly opAccount: string;
  /** How the plan names it: its sign-in address and email. */
  readonly name: string;
}

export interface AccountInputs {
  readonly run: Run;
  readonly cwd: string;
  readonly env: Env;
  /** The account --account= gave. */
  readonly given?: string;
  /** Null without a terminal. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
}

export type Chosen = { readonly ok: true; readonly account: ChosenAccount } | { readonly ok: false; readonly problem: string };

export async function chooseAccount({ run, cwd, env, given, prompt, say }: AccountInputs): Promise<Chosen> {
  const listed = await run("op", ["account", "list", "--format", "json"], { cwd, env });
  if (listed.code !== 0) {
    return {
      ok: false,
      problem: `op couldn't list your 1Password accounts (${listed.stderr.trim().split("\n")[0]}). Install the 1Password CLI and sign in to it, then run setup again.`,
    };
  }
  const accounts = (listed.stdout.trim() === "" ? [] : JSON.parse(listed.stdout)) as OpAccount[];
  const answer = given ?? (env.OP_ACCOUNT === "" ? undefined : env.OP_ACCOUNT);
  if (answer !== undefined) {
    const match = accounts.find((account) => matches(account, answer));
    return { ok: true, account: { opAccount: answer, name: match === undefined ? answer : nameOf(match) } };
  }
  if (accounts.length === 0) {
    return {
      ok: false,
      problem:
        "op has no 1Password account. In the 1Password app, turn on Settings → Developer → Integrate with 1Password CLI, " +
        "or add one with op account add, then run setup again.",
    };
  }
  const chosen = accounts.length === 1 ? accounts[0] : await pick(accounts, prompt, say);
  if (chosen === undefined) {
    const flags = accounts.map((account) => `--account=${opAccountOf(account, accounts)} (${account.email})`).join(", ");
    const why = prompt === null ? "setup can't ask which to use without a terminal" : "no account was chosen";
    return { ok: false, problem: `op has several 1Password accounts, and ${why}. Run it again with one of ${flags}.` };
  }
  return { ok: true, account: { opAccount: opAccountOf(chosen, accounts), name: nameOf(chosen) } };
}

/** The account the Operator picks by its number, or undefined when they can't be asked or their input ends. */
async function pick(accounts: readonly OpAccount[], prompt: Prompt | null, say: (line: string) => void): Promise<OpAccount | undefined> {
  if (prompt === null) return undefined;
  say("Your 1Password accounts:");
  accounts.forEach((account, i) => say(`  ${i + 1}. ${nameOf(account)}`));
  for (;;) {
    const answer = await prompt.ask(`Which one holds this Product's secrets? [1-${accounts.length}] `);
    if (answer === null) return undefined;
    const chosen = /^\d+$/.test(answer.trim()) ? accounts[Number(answer.trim()) - 1] : undefined;
    if (chosen !== undefined) return chosen;
    say(`Give a number from 1 to ${accounts.length}.`);
  }
}

/** Whether op would take the value as this account: its sign-in address, email, account ID or user ID. */
function matches(account: OpAccount, value: string): boolean {
  const wanted = address(value);
  return [account.url, account.email, account.account_uuid, account.user_uuid].some((field) => field !== undefined && address(field) === wanted);
}

function address(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function nameOf(account: OpAccount): string {
  return `${account.url} (${account.email})`;
}

/** The account's sign-in address, as the setup skill sets OP_ACCOUNT, unless another account shares it: then its user ID. */
function opAccountOf(account: OpAccount, accounts: readonly OpAccount[]): string {
  const shared = accounts.filter((other) => address(other.url) === address(account.url)).length > 1;
  return shared ? account.user_uuid : account.url;
}

/** op reaches the chosen account. `op vault list` asks the 1Password app to authorize; `op whoami` fails in a terminal-less session. */
export async function checkOp(run: Run, cwd: string, env: Env, name: string): Promise<string | null> {
  const vaults = await run("op", ["vault", "list", "--format", "json"], { cwd, env });
  if (vaults.code === 0) return null;
  return (
    `op couldn't reach the 1Password account ${name} (${vaults.stderr.trim().split("\n")[0]}). ` +
    "Unlock the 1Password app and turn on Settings → Developer → Integrate with 1Password CLI, then run setup again."
  );
}
