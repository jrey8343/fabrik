// The setup program's checks, before any planning: Node 24.3, op as the Operator
// rather than a service account, the root of the Product repo's clone, gh as
// the repo's admin with the workflow scope, and a clean, up-to-date branch.
// The first that fails stops setup, with a message naming what to fix. Once
// they pass, setup offers to delete an old personal copy of the fabrik-setup
// skill.
import { realpath, rm } from "node:fs/promises";
import { foundOldSetupSkill, oldSetupSkillIn, personalSkillsDir, staleOldSetupSkill } from "../skills/oldSetupSkill.ts";
import { type Env, ok, type Run } from "./exec.ts";
import type { ProductState } from "./plan.ts";
import { isYes, type Prompt } from "./prompt.ts";

export interface CheckInputs {
  readonly run: Run;
  /** The Product checkout setup was given, as an absolute path. */
  readonly productDir: string;
  readonly release: string;
  readonly env: Env;
  /** This Node's version, such as 24.11.0. */
  readonly nodeVersion: string;
  /** Every file setup may write, which its own branch may hold uncommitted after a run that stopped partway. */
  readonly setupWrites: readonly string[];
}

export type Checked =
  | {
      readonly ok: true;
      readonly repo: ProductState["repo"];
      /** The branch the clone is on: the default branch, or setup's own. */
      readonly branch: string;
      readonly origin: OriginTips;
    }
  | { readonly ok: false; readonly problem: string };

/** The tips of the two branches setup works with, as the checks found them on origin. */
export interface OriginTips {
  readonly defaultBranch: string;
  /** Null when origin has no setup branch for this release. */
  readonly setupBranch: string | null;
}

type SignedIn = { readonly ok: true; readonly repo: ProductState["repo"] } | { readonly ok: false; readonly problem: string };

export async function checkSetup(inputs: CheckInputs): Promise<Checked> {
  const problem = checkNode(inputs.nodeVersion) ?? checkServiceAccount(inputs.env) ?? (await checkRoot(inputs));
  if (problem !== null) return { ok: false, problem };
  const signedIn = await checkGitHub(inputs);
  if (!signedIn.ok) return signedIn;
  const branch = (await inputs.run("git", ["branch", "--show-current"], { cwd: inputs.productDir })).stdout.trim();
  const onBranch = await checkBranch(inputs, signedIn.repo.defaultBranch, branch);
  if (typeof onBranch === "string") return { ok: false, problem: onBranch };
  return { ok: true, repo: signedIn.repo, branch, origin: onBranch };
}

export interface OldCopyInputs {
  readonly env: Env;
  /** Null when setup mustn't ask, as without a terminal or with --plan: then it only warns. */
  readonly prompt: Prompt | null;
  readonly say: (line: string) => void;
}

/** Offers to delete the Operator's old personal copy of the fabrik-setup skill, warning that it's stale when it's kept. */
export async function offerToDeleteOldSetupSkill({ env, prompt, say }: OldCopyInputs): Promise<void> {
  const copy = await oldSetupSkillIn(personalSkillsDir(env));
  if (copy === null) return;
  say(foundOldSetupSkill(copy));
  if (prompt === null) say(staleOldSetupSkill(copy));
  else if (isYes(await prompt.ask("Delete it? [y/N] "))) {
    await rm(copy, { recursive: true, force: true });
    say(`Deleted ${copy}.`);
  } else say(`Kept it. ${staleOldSetupSkill(copy)}`);
  say("");
}

/** The branch setup applies its plan on, and a later run of the same release picks up. */
export function setupBranch(release: string): string {
  return `fabrik/setup-${release}`;
}

/** From 24.3, import.meta.main is true for setup's .ts entry point. */
function checkNode(version: string): string | null {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 24 || (major === 24 && minor >= 3)) return null;
  return `Setup needs Node 24.3 or later, and this is Node ${version}. Install Node 24.3 or later, then run setup again.`;
}

/** Setup acts with the Operator's own 1Password access, which a service account's token would limit. It never unsets the token. */
function checkServiceAccount(env: Env): string | null {
  if (env.OP_SERVICE_ACCOUNT_TOKEN === undefined) return null;
  return "OP_SERVICE_ACCOUNT_TOKEN is set, so op would use a service account instead of your own 1Password account. Run setup again without it, such as in a new terminal.";
}

/** Setup reads and writes the repo's files from the checkout it's given, so that must be the clone's root. */
async function checkRoot({ run, productDir }: CheckInputs): Promise<string | null> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: productDir });
  if (top.code !== 0) return `${productDir} isn't in a git clone. Run setup from the root of the Product repo's clone.`;
  const root = top.stdout.trim();
  // git gives the real path, and a temporary folder on macOS is under a symlink.
  if ((await realpath(productDir)) === (await realpath(root).catch(() => root))) return null;
  return `${productDir} isn't the root of its clone. Run setup from ${root}.`;
}

/** gh is signed in with the workflow scope, which pushing the caller workflow needs, as the repo's admin. */
async function checkGitHub({ run, productDir }: CheckInputs): Promise<SignedIn> {
  const cwd = productDir;
  const fail = (problem: string): SignedIn => ({ ok: false, problem });
  const user = await run("gh", ["api", "-i", "user"], { cwd });
  if (user.code !== 0) {
    return fail(`gh couldn't reach GitHub as you (${firstLine(user.stderr)}). Sign in with gh auth login --scopes workflow, then run setup again.`);
  }
  const { login, scopes } = parseUser(user.stdout);
  if (scopes === null) {
    return fail(
      `gh's token for ${login} names no scopes, so setup can't tell it has the workflow scope. ` +
        "Unset GH_TOKEN and GITHUB_TOKEN if either is set, sign in with gh auth login --scopes workflow, then run setup again.",
    );
  }
  if (!scopes.includes("workflow")) {
    return fail(`gh is signed in as ${login} without the workflow scope, which pushing the caller workflow needs. Run gh auth refresh --scopes workflow, then run setup again.`);
  }
  const view = await run("gh", ["repo", "view", "--json", "owner,name,defaultBranchRef,isInOrganization,viewerPermission"], { cwd });
  if (view.code !== 0) return fail(`gh can't find this clone's repo on GitHub (${firstLine(view.stderr)}). Run setup from a clone of the Product repo.`);
  const repo = JSON.parse(view.stdout) as RepoView;
  if (repo.viewerPermission !== "ADMIN") {
    return fail(
      `gh is signed in as ${login}, who has ${repo.viewerPermission ?? "no access"} on ${repo.owner.login}/${repo.name}, and setup needs ADMIN. ` +
        "Sign in to gh as the repo's admin with gh auth login, then run setup again.",
    );
  }
  return { ok: true, repo: repoOf(repo) };
}

/** The login and OAuth scopes from `gh api -i user`. The scopes are null when the token names none, as a fine-grained token doesn't. */
function parseUser(response: string): { login: string; scopes: string[] | null } {
  const [head = "", ...body] = response.split(/\r?\n\r?\n/);
  const login = (JSON.parse(body.join("\n\n")) as { login: string }).login;
  const header = /^x-oauth-scopes:(.*)$/im.exec(head)?.[1];
  if (header === undefined) return { login, scopes: null };
  return { login, scopes: header.split(",").map((scope) => scope.trim()).filter((scope) => scope !== "") };
}

interface RepoView {
  readonly owner: { readonly login: string };
  readonly name: string;
  readonly defaultBranchRef: { readonly name: string } | null;
  readonly isInOrganization: boolean;
  readonly viewerPermission: string | null;
}

function repoOf(view: RepoView): ProductState["repo"] {
  return { owner: view.owner.login, name: view.name, defaultBranch: view.defaultBranchRef?.name ?? "", inOrganization: view.isInOrganization };
}

/**
 * The clone is on its default branch, clean and the same as on origin. Or it's
 * on setup's own branch for this release, built on origin's default branch,
 * with nothing uncommitted but setup's own files. "The same as on origin" is
 * read with git ls-remote, so the checks fetch nothing and write no refs.
 * Returns what's wrong, or the tips origin has.
 */
async function checkBranch(
  { run, productDir, release, setupWrites }: CheckInputs,
  defaultBranch: string,
  current: string,
): Promise<string | OriginTips> {
  const cwd = productDir;
  const ownBranch = setupBranch(release);
  if (current !== defaultBranch && current !== ownBranch) {
    const where = current === "" ? "This clone isn't on a branch" : `This clone is on ${current}, not ${defaultBranch}`;
    return `${where}. Switch to ${defaultBranch} with git switch ${defaultBranch}, then run setup again.`;
  }

  const changed = await uncommittedPaths(run, cwd);
  if (current === defaultBranch && changed.length > 0) {
    return `This clone has uncommitted changes (${changed.join(", ")}). Commit or stash them, then run setup again.`;
  }
  const others = changed.filter((path) => !setupWrites.includes(path));
  if (current === ownBranch && others.length > 0) {
    return `${ownBranch} has uncommitted changes setup didn't make (${others.join(", ")}). Commit or stash them, then run setup again.`;
  }

  const refs = [`refs/heads/${defaultBranch}`, `refs/heads/${ownBranch}`] as const;
  const remote = await run("git", ["ls-remote", "origin", ...refs], { cwd });
  if (remote.code !== 0) return `git can't reach origin (${firstLine(remote.stderr)}). Check the clone's origin remote, then run setup again.`;
  const tips = new Map(
    remote.stdout.split("\n").flatMap((line) => {
      const [sha, ref] = line.split("\t");
      return sha === undefined || ref === undefined ? [] : [[ref.trim(), sha.trim()] as const];
    }),
  );
  const originDefault = tips.get(refs[0]);
  if (originDefault === undefined) return `origin has no ${defaultBranch} branch. Push ${defaultBranch}, then run setup again.`;
  const originOwn = tips.get(refs[1]);
  const origin: OriginTips = { defaultBranch: originDefault, setupBranch: originOwn ?? null };

  if (current === defaultBranch) {
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    if (head === originDefault) return origin;
    return `${defaultBranch} here isn't the same as on origin (${short(head)} here, ${short(originDefault)} on origin). Pull or push so they match, then run setup again.`;
  }
  // A commit this clone lacks isn't its ancestor either: git says so by failing.
  const holds = async (sha: string) => (await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd })).code === 0;
  if (!(await holds(originDefault))) {
    return `${ownBranch} doesn't hold origin's latest ${defaultBranch} (${short(originDefault)}). Merge it in with git pull origin ${defaultBranch}, then run setup again.`;
  }
  if (originOwn !== undefined && !(await holds(originOwn))) {
    return `origin's ${ownBranch} has commits this clone lacks (${short(originOwn)}). Pull them with git pull origin ${ownBranch}, then run setup again.`;
  }
  return origin;
}

/**
 * Every path the clone has uncommitted, untracked ones included. The checks
 * and the setup commit both read it, so they agree on what's uncommitted.
 */
export async function uncommittedPaths(run: Run, cwd: string): Promise<string[]> {
  return changedPaths(await ok(run, "git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }));
}

/** Every path `git status --porcelain=v1 -z` names, a rename's old path included. */
function changedPaths(status: string): string[] {
  const entries = status.split("\0").filter((entry) => entry !== "");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++i] ?? "");
  }
  return paths.filter((path) => path !== "");
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
