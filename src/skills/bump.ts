// The weekly skills bump: given the pinned skills lock and what upstream main
// looks like now, decide whether to open (or refresh) a PR bumping the lock,
// and write that PR. Pure, no I/O; src/skills/bump-main.ts gathers the input.
//
// Upstream text (commit messages, the diff) only ever goes into the body
// inside code fences, so it can't mention people or link issues here.
import { type SkillsLock, skillFolders } from "./lock.ts";

/** What the GitHub compare API says about upstream main against the pin. */
export interface UpstreamSkills {
  /** Upstream main's commit SHA. */
  readonly head: string;
  /** The compare status of head against the pin. */
  readonly status: "identical" | "ahead" | "behind" | "diverged";
  /** How many commits head is ahead of the pin; the list below may hold fewer. */
  readonly aheadBy: number;
  readonly commits: readonly { readonly sha: string; readonly message: string }[];
  /** The unified diff from the pin to head. */
  readonly diff: string;
  /** `.claude-plugin/plugin.json` at the pin and at head. */
  readonly manifestAtPin: string;
  readonly manifestAtHead: string;
}

export type SkillsBump =
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "pull-request";
      /** One fixed branch, so a later week refreshes the open PR instead of opening another. */
      readonly branch: string;
      readonly title: string;
      readonly body: string;
      /** The new skills.lock.json text. */
      readonly lockText: string;
    };

export const SKILLS_BUMP_BRANCH = "fabrik/skills-bump";

/** GitHub's limit on a PR body. */
const MAX_BODY = 65_536;
/** Room left for the closing fence and the truncation note. */
const BODY_RESERVE = 512;

export function planSkillsBump(lock: SkillsLock, upstream: UpstreamSkills): SkillsBump {
  if (upstream.head === lock.sha || upstream.status === "identical" || upstream.status === "behind") {
    return { kind: "up-to-date" };
  }

  const before = new Set(skillFolders(upstream.manifestAtPin).map((folder) => folder.name));
  const after = new Set(skillFolders(upstream.manifestAtHead).map((folder) => folder.name));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));

  const short = (sha: string) => sha.slice(0, 7);
  const compareUrl = `https://github.com/${lock.repository}/compare/${lock.sha}...${upstream.head}`;
  const commitLines = upstream.commits.map((commit) => `${short(commit.sha)} ${commit.message.split("\n")[0]}`);
  const missing = upstream.aheadBy - upstream.commits.length;

  const head: string[] = [
    `Bumps Matt Pocock's skills (\`${lock.repository}\`) from \`${short(lock.sha)}\` to \`${short(upstream.head)}\` in \`skills.lock.json\`.`,
    "",
    `Compare on GitHub: ${compareUrl}`,
  ];
  if (upstream.status === "diverged") {
    head.push(
      "",
      "> [!WARNING]",
      "> Upstream main no longer contains the pinned commit, so its history was rewritten. The diff below runs from their merge base.",
    );
  }
  if (added.length > 0 || removed.length > 0) {
    head.push("");
    if (added.length > 0) head.push(`Skills added: ${added.map((name) => `\`${name}\``).join(", ")}.`);
    if (removed.length > 0) head.push(`Skills removed: ${removed.map((name) => `\`${name}\``).join(", ")}.`);
  }
  head.push("", `### Commits (${upstream.aheadBy})`, "", fenced("text", commitLines.join("\n") + "\n"));
  if (missing > 0) head.push("", `…and ${missing} more commits.`);
  head.push("", "### Upstream diff", "");

  const opening = head.join("\n");
  const room = MAX_BODY - BODY_RESERVE - opening.length;
  const { text: diff, cut } = cutAtLine(upstream.diff, room);
  let body = opening + fenced("diff", diff, upstream.diff);
  if (cut) body += "\n\nThe diff is cut short here; the compare link has all of it.";

  return {
    kind: "pull-request",
    branch: SKILLS_BUMP_BRANCH,
    title: `Bump Matt Pocock's skills to ${short(upstream.head)}`,
    body,
    lockText: `${JSON.stringify({ repository: lock.repository, sha: upstream.head }, null, 2)}\n`,
  };
}

/** A fenced block whose fence is longer than any backtick run in `content` (or `fenceFor`). */
function fenced(info: string, content: string, fenceFor = content): string {
  const longest = Math.max(0, ...(fenceFor.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const text = content === "" || content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${info}\n${text}${fence}`;
}

function cutAtLine(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const end = text.lastIndexOf("\n", max - 1);
  return { text: text.slice(0, end + 1), cut: true };
}
