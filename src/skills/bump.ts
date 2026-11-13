// The weekly skills bumps: given a pin and what upstream looks like now, decide
// whether to open (or refresh) a PR bumping it, and write that PR. Fabrik's own
// bump moves the Base skills in skills.lock.json; a Product repo's bump moves
// one of its own Skills sources in .fabrik/skills.lock.json, and cares only
// about the skills it picks. Pure, no I/O; src/skills/bump-main.ts gathers the
// input for Fabrik's own bump.
//
// Upstream text (commit messages, the diff) only ever goes into the body
// inside code fences, so it can't mention people or link issues here.
import { SKILLS_SOURCES_LOCK_PATH, type SkillsSource } from "../kit/config.ts";
import { readable } from "../loop/readable.ts";
import { foldersIn, PLUGIN_MANIFEST_PATH, type SkillsLock, shortSha, skillFolders } from "./lock.ts";

/** What the GitHub compare API says about upstream (main, or a source's default branch) against the pin. */
export interface UpstreamSkills {
  /** Upstream's head commit SHA. */
  readonly head: string;
  /** The compare status of head against the pin. */
  readonly status: "identical" | "ahead" | "behind" | "diverged";
  /** How many commits head is ahead of the pin; the list below may hold fewer. */
  readonly aheadBy: number;
  readonly commits: readonly { readonly sha: string; readonly message: string }[];
  /** The unified diff from the pin to head. */
  readonly diff: string;
  /** `.claude-plugin/plugin.json` at the pin. */
  readonly manifestAtPin: string;
  /** `.claude-plugin/plugin.json` at head; null when head has none. */
  readonly manifestAtHead: string | null;
}

export type SkillsBump =
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "pull-request";
      /** One fixed branch, so a later week refreshes the open PR instead of opening another. */
      readonly branch: string;
      readonly title: string;
      readonly body: string;
      /** The new lockfile text: skills.lock.json, or a Product repo's .fabrik/skills.lock.json. */
      readonly lockText: string;
    };

export const SKILLS_BUMP_BRANCH = "fabrik/skills-bump";

/** GitHub's limit on a PR body. */
const MAX_BODY = 65_536;
/** Room left for the closing fence and the truncation note. */
const BODY_RESERVE = 512;

export function planSkillsBump(lock: SkillsLock, upstream: UpstreamSkills): SkillsBump {
  if (!hasMoved(lock, upstream)) return { kind: "up-to-date" };

  const before = new Set(skillFolders(upstream.manifestAtPin).map((folder) => folder.name));
  if (upstream.manifestAtHead === null) throw new Error(`Upstream main at ${upstream.head} has no ${PLUGIN_MANIFEST_PATH}`);
  const after = new Set(skillFolders(upstream.manifestAtHead).map((folder) => folder.name));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));

  const notes: string[] = [];
  if (added.length > 0) notes.push(`Skills added: ${added.map((name) => `\`${name}\``).join(", ")}.`);
  if (removed.length > 0) notes.push(`Skills removed: ${removed.map((name) => `\`${name}\``).join(", ")}.`);

  return {
    kind: "pull-request",
    branch: SKILLS_BUMP_BRANCH,
    title: `Bump Matt Pocock's skills to ${shortSha(upstream.head)}`,
    body: pullRequestBody({
      pin: lock,
      upstream,
      intro: `Bumps Matt Pocock's skills (\`${lock.repository}\`) from \`${shortSha(lock.sha)}\` to \`${shortSha(upstream.head)}\` in \`skills.lock.json\`.`,
      upstreamName: "Upstream main",
      notes,
      diffHeading: "### Upstream diff",
      diff: upstream.diff,
    }),
    lockText: `${JSON.stringify({ repository: lock.repository, sha: upstream.head }, null, 2)}\n`,
  };
}

/** The branch a Product repo's bump of one Skills source always uses. */
export function sourceBumpBranch(repository: string): string {
  return `${SKILLS_BUMP_BRANCH}/${repository.replace("/", "-")}`;
}

/**
 * Plans a Product repo's bump of one of its own Skills sources (ADR-0008) to
 * the head of that source's default branch. Only the skills the Product picks
 * from it matter: a week in which none of their folders changed is up to date,
 * and the PR's diff shows those folders alone. `lockText` is the Product's
 * .fabrik/skills.lock.json on its default branch; the PR changes only this
 * source's SHA in it.
 */
export function planSourceBump(
  source: SkillsSource,
  picked: readonly string[],
  upstream: UpstreamSkills,
  lockText: string,
): SkillsBump {
  if (!hasMoved(source, upstream)) return { kind: "up-to-date" };

  // A head manifest that's gone or unreadable lists no skills, so every pick is flagged as breaking.
  const atHead = new Set((foldersIn(upstream.manifestAtHead) ?? []).map((folder) => folder.name));
  const removed = picked.filter((name) => !atHead.has(name));
  const folders = pickedFolders(picked, upstream);
  const files = splitDiff(upstream.diff);
  const touchesPicked = (file: FileDiff) =>
    file.paths.some((path) => folders.some((folder) => path.startsWith(`${folder}/`)));
  const inPicked = files.filter(touchesPicked);
  // A diff with no file headers (GitHub refused to send one) can't be scoped, so it's shown whole.
  const unscoped = files.length === 0 && upstream.diff.trim() !== "";
  if (inPicked.length === 0 && removed.length === 0 && !unscoped) return { kind: "up-to-date" };

  const notes: string[] = [];
  if (removed.length > 0) {
    notes.push(
      "> [!CAUTION]",
      `> Breaking: the source's plugin manifest at \`${shortSha(upstream.head)}\` no longer lists ${removed.map((name) => `\`${name}\``).join(", ")}, which this repo picks. Drop the pick before merging, or every run that has it will fail.`,
      "",
    );
  }
  notes.push(`Picked skills from this source: ${picked.map((name) => `\`${name}\``).join(", ")}.`);
  const others = [...new Set(files.filter((file) => !touchesPicked(file)).flatMap((file) => file.paths))];
  if (others.length > 0) {
    notes.push("", "Other upstream changes, outside the picked skills:", "", ...pathList(others));
  }

  const diff = unscoped ? upstream.diff : inPicked.map((file) => file.text).join("");
  return {
    kind: "pull-request",
    branch: sourceBumpBranch(source.repository),
    title: `Bump the ${source.repository} Skills source to ${shortSha(upstream.head)}`,
    body: pullRequestBody({
      pin: source,
      upstream,
      intro: `Bumps the \`${source.repository}\` Skills source from \`${shortSha(source.sha)}\` to \`${shortSha(upstream.head)}\` in \`${SKILLS_SOURCES_LOCK_PATH}\`.`,
      upstreamName: "The source's default branch",
      notes,
      diffHeading: unscoped ? "### Upstream diff" : "### Diff of the picked skills",
      diff,
    }),
    lockText: bumpedLockText(lockText, source, upstream.head),
  };
}

/**
 * Whether a scheduled tick is the one a Product repo's weekly skills bump acts
 * on: the Monday tick in the 04:00 UTC hour. A dropped tick waits a week.
 */
export function isSkillsBumpTick(tickAt: Date): boolean {
  return tickAt.getUTCDay() === 1 && tickAt.getUTCHours() === 4;
}

/**
 * The scheduled tick a run belongs to: the latest time at or before
 * `observedAt` on the minute an hourly `schedule` (such as "17 * * * *")
 * names. GitHub often starts a scheduled run late, so this, not the time the
 * run got going, is what the weekly gate should check; a run up to an hour
 * late still counts as its own tick. A schedule it can't read as an hourly
 * cron leaves `observedAt` as it is.
 */
export function scheduledTickOf(observedAt: Date, schedule: string | undefined): Date {
  const minute = /^\s*(\d{1,2})\s+\*\s+\*\s+\*\s+\*\s*$/.exec(schedule ?? "")?.[1];
  if (minute === undefined || Number(minute) > 59) return observedAt;
  const tick = new Date(observedAt);
  tick.setUTCMinutes(Number(minute), 0, 0);
  if (tick > observedAt) tick.setUTCHours(tick.getUTCHours() - 1);
  return tick;
}

/**
 * The weekly gate on a scheduled run seen at `seenAt` with the caller's hourly
 * `schedule`: whether its tick is the skills bump tick, and the step
 * summary's line saying so, or when the next bump tick is. On the tick just
 * after the bump tick, the line also says the week's bump was missed if no run
 * took that tick as due: a run GitHub started more than an hour late is read
 * as this tick, and one run can't tell that from the bump tick's own run
 * having been on time, so the Operator checks the run before it. The line
 * says when in `timeZone`, the Operator's; the bump tick stays in UTC.
 */
export function skillsBumpGate(
  seenAt: Date,
  schedule: string | undefined,
  timeZone: string | null,
): { readonly due: boolean; readonly summary: string } {
  const tick = scheduledTickOf(seenAt, schedule);
  if (isSkillsBumpTick(tick)) {
    return { due: true, summary: `Skills bump: due, as the tick scheduled for ${readable(tick.getTime(), timeZone)} is the weekly skills bump tick` };
  }
  const next = new Date(tick);
  do next.setUTCHours(next.getUTCHours() + 1);
  while (!isSkillsBumpTick(next));
  const notDue = `Skills bump: not due (next: ${readable(next.getTime(), timeZone)})`;
  const previous = new Date(tick);
  previous.setUTCHours(previous.getUTCHours() - 1);
  if (!isSkillsBumpTick(previous)) return { due: false, summary: notDue };
  return {
    due: false,
    summary: `${notDue}. This week's bump tick was ${readable(previous.getTime(), timeZone)}: if no run took it as due, GitHub started it more than an hour late or dropped it, and this week's bump was missed`,
  };
}

function hasMoved(pin: { readonly sha: string }, upstream: UpstreamSkills): boolean {
  return !(upstream.head === pin.sha || upstream.status === "identical" || upstream.status === "behind");
}

interface BodyParts {
  readonly pin: { readonly repository: string; readonly sha: string };
  readonly upstream: UpstreamSkills;
  readonly intro: string;
  /** What the diverged-history warning calls the branch the bump follows. */
  readonly upstreamName: string;
  /** Lines between the warning and the commits. */
  readonly notes: readonly string[];
  readonly diffHeading: string;
  readonly diff: string;
}

/** The PR body both bumps share: the compare link, any warning, the commits, then the diff cut to fit. */
function pullRequestBody({ pin, upstream, intro, upstreamName, notes, diffHeading, diff }: BodyParts): string {
  const compareUrl = `https://github.com/${pin.repository}/compare/${pin.sha}...${upstream.head}`;
  const commitLines = upstream.commits.map((commit) => `${shortSha(commit.sha)} ${commit.message.split("\n")[0]}`);
  const missing = upstream.aheadBy - upstream.commits.length;

  const head: string[] = [intro, "", `Compare on GitHub: ${compareUrl}`];
  if (upstream.status === "diverged") {
    head.push(
      "",
      "> [!WARNING]",
      `> ${upstreamName} no longer contains the pinned commit, so its history was rewritten. The diff below runs from their merge base.`,
    );
  }
  if (notes.length > 0) head.push("", ...notes);
  head.push("", `### Commits (${upstream.aheadBy})`, "", fenced("text", commitLines.join("\n") + "\n"));
  if (missing > 0) head.push("", `…and ${missing} more commits.`);
  head.push("", diffHeading, "");

  const opening = head.join("\n");
  const room = MAX_BODY - BODY_RESERVE - opening.length;
  const { text, cut } = cutAtLine(diff, room);
  let body = opening + fenced("diff", text, diff);
  if (cut) body += "\n\nThe diff is cut short here; the compare link has all of it.";
  return body;
}

/** Room in the PR body for the other changed paths, so a large upstream refactor still leaves room for the diff. */
const OTHER_PATHS_BUDGET = 8_192;

/** The paths on one fenced line, cut to the budget with a count of the rest. */
function pathList(paths: readonly string[]): readonly string[] {
  let shown = 0;
  let length = 0;
  for (const path of paths) {
    if (length + path.length + 1 > OTHER_PATHS_BUDGET) break;
    length += path.length + 1;
    shown++;
  }
  const list = [fenced("text", paths.slice(0, shown).join(" "))];
  const rest = paths.length - shown;
  if (rest > 0) list.push("", `…and ${rest} more paths; see the compare link.`);
  return list;
}

/** The lockfile with only this source's SHA changed, keeping the rest of the text as the Operator wrote it. */
function bumpedLockText(lockText: string, source: SkillsSource, head: string): string {
  const entries = JSON.parse(lockText) as { repository: string; sha: string }[];
  const entry = entries.find((pin) => pin.repository.toLowerCase() === source.repository.toLowerCase());
  if (entry === undefined) throw new Error(`${SKILLS_SOURCES_LOCK_PATH} no longer pins ${source.repository}`);
  const quoted = JSON.stringify(entry.sha);
  if (lockText.split(quoted).length === 2) return lockText.replace(quoted, JSON.stringify(head));
  // The old SHA isn't unique in the text, so rewrite the whole list instead.
  const bumped = entries.map((pin) => (pin === entry ? { ...pin, sha: head } : pin));
  return `${JSON.stringify(bumped, null, 2)}\n`;
}

/** The folders of the picked skills at the pin and at head, so a folder that moved still counts. */
function pickedFolders(picked: readonly string[], upstream: UpstreamSkills): readonly string[] {
  const wanted = new Set(picked);
  return [...skillFolders(upstream.manifestAtPin), ...(foldersIn(upstream.manifestAtHead) ?? [])]
    .filter((folder) => wanted.has(folder.name))
    .map((folder) => folder.from);
}

interface FileDiff {
  /** The file's path before and after, from its `diff --git a/… b/…` header. */
  readonly paths: readonly string[];
  readonly text: string;
}

/** A unified diff split into its files. */
function splitDiff(diff: string): readonly FileDiff[] {
  const files: FileDiff[] = [];
  for (const text of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(text);
    if (header === null || !text.startsWith("diff --git ")) continue;
    files.push({ paths: [header[1] ?? "", header[2] ?? ""], text });
  }
  return files;
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
