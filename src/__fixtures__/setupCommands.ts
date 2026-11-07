// A fake command runner for the setup program's tests: it answers each git, gh
// and op command from a script, and logs every call with the environment it
// ran in, so a test can say which commands ran and with which 1Password account.
import type { Env, Ran, Run, RunOptions } from "../setup/exec.ts";

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input?: string;
  readonly env: Env;
  /** The command and its arguments joined with spaces, as the script keys them. */
  readonly line: string;
}

export type Answer = Partial<Ran> | ((call: Call) => Partial<Ran>);

/**
 * The script maps a command line to its answer. A key matches that exact line,
 * or any line it starts, followed by a space: the longest key wins. A line
 * nothing matches throws, so a test sees the command it didn't expect.
 */
export type Script = Readonly<Record<string, Answer>>;

export interface FakeCommands {
  readonly run: Run;
  readonly calls: Call[];
}

export function fakeCommands(script: Script): FakeCommands {
  const calls: Call[] = [];
  const run: Run = async (command: string, args: readonly string[], options: RunOptions) => {
    const line = [command, ...args].join(" ");
    const call: Call = {
      command,
      args,
      cwd: options.cwd,
      ...(options.input === undefined ? {} : { input: options.input }),
      env: { ...options.env },
      line,
    };
    calls.push(call);
    const key = Object.keys(script)
      .filter((candidate) => line === candidate || line.startsWith(`${candidate} `))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`The fake runner has no answer for: ${line}`);
    const answer = script[key]!;
    const ran = typeof answer === "function" ? answer(call) : answer;
    return { code: 0, stdout: "", stderr: "", ...ran };
  };
  return { run, calls };
}

export const HEAD_SHA = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";
export const OTHER_SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";

export const PERSONAL = { url: "my.1password.com", email: "operator@example.com", user_uuid: "UPERSONAL", account_uuid: "APERSONAL" };
export const ACME = { url: "acme.1password.com", email: "operator@acme.example", user_uuid: "UACME", account_uuid: "AACME" };

/** What `gh api -i user` prints: the status line, the headers, a blank line and the body. */
export function ghUser(login: string, scopes: string | null): string {
  const headers = ["HTTP/2.0 200 OK", "Content-Type: application/json; charset=utf-8", ...(scopes === null ? [] : [`X-Oauth-Scopes: ${scopes}`])];
  return `${headers.join("\r\n")}\r\n\r\n${JSON.stringify({ login, id: 1 })}`;
}

export const REPO_VIEW = "gh repo view --json owner,name,defaultBranchRef,isInOrganization,viewerPermission";
export const STATUS = "git --no-optional-locks status --porcelain=v1 -z --untracked-files=all";

/** `git ls-remote` asking for the default branch and the setup branch. */
export function lsRemote(release: string, branch = "main"): string {
  return `git ls-remote origin refs/heads/${branch} refs/heads/fabrik/setup-${release}`;
}

/**
 * The Operator in a clean, up-to-date clone of acme/clinic, on main, signed in
 * to gh as the repo's admin with the workflow scope, and to one 1Password
 * account that has no vaults yet. The repo has nothing of Fabrik's yet.
 */
export function aReadyOperator(productDir: string, release = "v1.4.2"): Record<string, Answer> {
  return {
    "git rev-parse --show-toplevel": { stdout: `${productDir}\n` },
    "gh api -i user": { stdout: ghUser("acme-operator", "gist, read:org, repo, workflow") },
    [REPO_VIEW]: {
      stdout: JSON.stringify({
        owner: { login: "acme" },
        name: "clinic",
        defaultBranchRef: { name: "main" },
        isInOrganization: false,
        viewerPermission: "ADMIN",
      }),
    },
    "git branch --show-current": { stdout: "main\n" },
    [STATUS]: { stdout: "" },
    "git rev-parse HEAD": { stdout: `${HEAD_SHA}\n` },
    [lsRemote(release)]: { stdout: `${HEAD_SHA}\trefs/heads/main\n` },
    "git merge-base --is-ancestor": { code: 1 },
    [`git merge-base --is-ancestor ${HEAD_SHA} HEAD`]: { code: 0 },
    "op account list --format json": { stdout: JSON.stringify([PERSONAL]) },
    "op vault list --format json": { stdout: "[]" },
    // What setup gathers about the repo and the fabrik-runs store.
    "gh label list --limit 1000 --json name": { stdout: "[]" },
    "gh secret list --json name": { stdout: "[]" },
    "gh api repos/acme/clinic/branches/main/protection": { code: 1, stderr: "gh: Branch not protected (HTTP 404)" },
    "gh api repos/acme/clinic/rulesets?includes_parents=false": { stdout: "[]" },
    "gh repo view jrey8343/fabrik-runs --json visibility": { code: 1, stderr: "GraphQL: Could not resolve to a Repository" },
  };
}

/** Every command that changes something: none may run before the Operator's yes. */
export const APPLYING = {
  "gh label create": {},
  "gh secret set": {},
  "gh repo create": {},
  "gh api --method": {},
  "op vault create": {},
  "op service-account create": { stdout: "ops_token\n" },
} satisfies Record<string, Answer>;
