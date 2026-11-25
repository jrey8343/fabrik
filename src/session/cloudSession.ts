// What the SessionStart hook tells a Claude Code cloud session, an Operator
// session, once, at its start (#953). A session picked up after a night doesn't
// run the hook again, so these lines are the only report it gets, and it never
// learns its place from a refused call, which is also what a real fault looks
// like. At a terminal none of them is given.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import { OPERATOR_SESSION_PATH, operatorSessionMarker, sessionAddressOf, sessionEnvironmentOf } from "../kit/operatorSession.ts";

const run = promisify(execFile);

/** The variables of the session's environment the hook reads. */
export interface SessionEnvironment {
  /** `"true"` in a Claude Code cloud session; anything else, unset included, is a terminal. */
  readonly CLAUDE_CODE_REMOTE?: string | undefined;
  /** A cloud session's id, `cse_` and an id, from which its address is made. */
  readonly CLAUDE_CODE_REMOTE_SESSION_ID?: string | undefined;
  /** The Session environment the session was opened in, as that environment sets it. */
  readonly FABRIK_SESSION_ENVIRONMENT?: string | undefined;
}

/** Whether the session is a Claude Code cloud session, read once from `CLAUDE_CODE_REMOTE`. */
export function isCloudSession(env: SessionEnvironment): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

/**
 * The lines a cloud session's context gains, in order: where it is, the
 * Operator, the Researcher, the Session environment, the address with the
 * marker to write, and what the repo attaches. `kit` is `fabrik` itself, which
 * has no Researcher.
 */
export async function cloudSessionLines({
  productDir,
  kit,
  env,
}: {
  readonly productDir: string;
  readonly kit: boolean;
  readonly env: SessionEnvironment;
}): Promise<readonly string[]> {
  const repo = repoOf(await gitIn(productDir, "remote", "get-url", "origin"));
  const read = await readKitConfigFromCheckout(productDir).catch(() => null);
  const config = read?.ok === true ? read.config : null;
  const operator = config?.operator ?? repo?.owner ?? null;
  return [
    whereItIs(repo),
    operator === null
      ? "The Operator's login isn't known here: ask the Operator for it before you claim or assign."
      : `The Operator is ${operator}: claim and assign with that login, since REST has no @me.`,
    kit
      ? "This repo has no Researcher: fire a research subagent for each unblocked research Decision you file, as fabrik-operator-session says."
      : "This repo has a Researcher: fire no research subagent, since the Kit's Researcher takes each unblocked research Decision.",
    sessionEnvironmentLine(sessionEnvironmentOf(config), env.FABRIK_SESSION_ENVIRONMENT),
    ...addressLines(sessionAddressOf(env.CLAUDE_CODE_REMOTE_SESSION_ID)),
    await attachedLine(productDir),
  ];
}

function whereItIs(repo: Repo | null): string {
  const rest =
    "`gh issue` and `gh pr` are refused here: every tracker operation goes over REST, by the forms in .claude/skills/fabrik-operator-session/SKILL.md. Read that skill before any work.";
  return repo === null
    ? `This is a Claude Code cloud session. ${rest} This repo's name isn't known here: ask the Operator for it before you write to the tracker.`
    : `This is a Claude Code cloud session on ${repo.owner}/${repo.name}. ${rest}`;
}

function sessionEnvironmentLine(expected: string, found: string | undefined): string {
  const stop = "Say so as your first words, and do no work until the Operator says to go on or starts again.";
  if (found === expected) return `This session is in the Session environment ${expected}, the one this repo expects.`;
  if (found === undefined || found === "") {
    return `This repo expects the Session environment ${expected}, and this session's environment sets no FABRIK_SESSION_ENVIRONMENT, so it isn't one. ${stop}`;
  }
  return `This repo expects the Session environment ${expected}, and this session is in ${found}. ${stop}`;
}

function addressLines(address: string | null): readonly string[] {
  if (address === null) {
    return [
      "CLAUDE_CODE_REMOTE_SESSION_ID is missing or isn't of the cse_ form, so the hook can't give this session's address. Take it from the session link in your own attribution lines; with neither, write no marker, say so, and work on.",
    ];
  }
  return [
    `This session's address is ${address}. When you work an issue as a Pairing session, or a Map's Decision, write these two lines there as your first comment, after your skill's opening checks pass and before any work, unless the issue already holds a marker with this address:`,
    operatorSessionMarker(address),
    `This issue is being worked in [an Operator session](${address}).`,
  ];
}

/**
 * Whether the repo attaches anything to its Operator sessions, read from the
 * default branch as the checkout last fetched it, never from the working tree,
 * which a branch can change; from the working tree only when `origin/HEAD`
 * can't be read, and saying so.
 */
async function attachedLine(productDir: string): Promise<string> {
  const defaultBranch = await gitIn(productDir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}");
  const [where, has] =
    defaultBranch === null
      ? ["This checkout has", await access(join(productDir, OPERATOR_SESSION_PATH)).then(() => true, () => false)]
      : ["This repo's default branch has", (await gitIn(productDir, "cat-file", "-e", `${defaultBranch}:${OPERATOR_SESSION_PATH}`)) !== null];
  return has
    ? `${where} ${OPERATOR_SESSION_PATH}, which says what its Operator sessions can reach: read it as the default branch has it before you sort any step.`
    : `${where} no ${OPERATOR_SESSION_PATH}, so nothing is attached to its Operator sessions.`;
}

interface Repo {
  readonly owner: string;
  readonly name: string;
}

/**
 * The repo a remote's address names: the last two parts of its path, with any
 * `.git` dropped, whatever its host, for a URL (`https://github.com/o/r.git`,
 * a cloud session's proxy) or git's `host:path` form (`git@github.com:o/r`).
 * Null for no address, or one whose path has fewer than two parts.
 */
function repoOf(remote: string | null): Repo | null {
  if (remote === null) return null;
  const path = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)
    ? URL.parse(remote)?.pathname ?? ""
    : remote.replace(/^[^/:]*:/, "");
  const [owner, name] = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter((part) => part !== "").slice(-2);
  return owner === undefined || name === undefined ? null : { owner, name };
}

/** git's output in the checkout, trimmed, or null when it fails. */
async function gitIn(dir: string, ...args: string[]): Promise<string | null> {
  try {
    return (await run("git", ["-C", dir, ...args], { encoding: "utf8" })).stdout.trim();
  } catch {
    return null;
  }
}
