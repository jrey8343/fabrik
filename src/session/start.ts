// The SessionStart hook's work in a cloud or local session (ADR-0003). The
// Product repo's hook entry (templates/claude-settings.json) reads the release
// from the caller workflow, fetches Fabrik at that tag from github.com by
// git's own shallow fetch, and runs
//   node <fabrik>/src/session/start.ts <product checkout> <release>
// This installs the skills that release locks, the same commit a Kit step
// installs in Actions, plus Fabrik's own skills and every Extra skill the
// Product repo picks (ADR-0008), since the Operator is at the wheel, and prints
// the hook's JSON. fabrik itself has no caller workflow and no release to read,
// so its own hook entry (.claude/settings.json) runs
//   node src/session/start.ts --kit <fabrik checkout>
// which installs from that checkout, the Kit, into its own .claude/skills/.
// While the Operator's personal skills hold an old copy of the fabrik-setup
// skill, it warns them in one line, and installs everything all the same.
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { type FetchSource, fetchSkills } from "../skills/fetch.ts";
import { foundOldSetupSkill, oldSetupSkillIn, personalSkillsDir, staleOldSetupSkill } from "../skills/oldSetupSkill.ts";

/** The caller workflow, the only place the Kit's version appears. */
export const CALLER_WORKFLOW_PATH = ".github/workflows/fabrik.yml";

/** Fabrik's own skills, installed beside the upstream ones under these names. */
const FABRIK_SKILLS_DIR = "skills";

/** Fabrik's own skills an earlier release installed and this one doesn't: Setup was a skill until it became a program (ADR-0013). */
const DROPPED_FABRIK_SKILLS = ["fabrik-setup"];

/** What a SessionStart hook prints on stdout for Claude Code (https://code.claude.com/docs/en/hooks). */
export interface SessionStartOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "SessionStart";
    readonly additionalContext: string;
    /** Skill discovery runs before SessionStart hooks finish, so new skills need it to load in this session. */
    readonly reloadSkills: boolean;
  };
  /**
   * A warning shown to the Operator when the hook couldn't install the skills,
   * or only the Base and Kit skills, or found an old copy of the fabrik-setup
   * skill.
   */
  readonly systemMessage?: string;
}

export interface SessionStartInput {
  /** Fabrik, checked out at `release`, or `fabrik`'s own checkout when `release` is null. */
  readonly kitDir: string;
  /** The checkout the skills go into: `kitDir` itself when `release` is null. */
  readonly productDir: string;
  /**
   * The release the hook entry read from the caller workflow and fetched Fabrik
   * at; null in `fabrik` itself, whose checkout is the Kit, so there is no
   * caller workflow to read and no pin to check.
   */
  readonly release: string | null;
  /** How each Skills source is fetched at its commit; git's own shallow fetch from github.com unless a test hands another. */
  readonly fetchSource?: FetchSource;
  /** The Operator's personal skills folder, where an old copy of the fabrik-setup skill may be. Unset, the hook doesn't look. */
  readonly personalSkills?: string;
}

export async function sessionStart({ personalSkills, ...input }: SessionStartInput): Promise<SessionStartOutput> {
  const output = await installSkills(input);
  // Never in the way of the install: a folder it can't read counts as none.
  const copy = await oldSetupSkillIn(personalSkills ?? null).catch(() => null);
  if (copy === null) return output;
  const warning = `${foundOldSetupSkill(copy)} ${staleOldSetupSkill(copy)}`;
  return { ...output, systemMessage: output.systemMessage === undefined ? warning : `${output.systemMessage}. ${warning}` };
}

async function installSkills({ kitDir, productDir, release, fetchSource }: Omit<SessionStartInput, "personalSkills">): Promise<SessionStartOutput> {
  try {
    if (release !== null) {
      const caller = await readFile(join(productDir, CALLER_WORKFLOW_PATH), "utf8").catch(() => null);
      if (caller === null) return notInstalled(`${CALLER_WORKFLOW_PATH} was not found`);
      const pins = checkCallerWorkflow(caller);
      if (!pins.ok) return notInstalled(`${CALLER_WORKFLOW_PATH}: ${pins.error}`);
      if (pins.release !== release) {
        return notInstalled(`the hook fetched Fabrik ${release}, but ${CALLER_WORKFLOW_PATH} pins ${pins.release}`);
      }
    }

    // The Operator is at the wheel, so the session gets every role's picks; fabrik has no Kit config, so it picks none.
    const { sha, extraSkills, errors } = await fetchSkills(kitDir, productDir, fetchSource, { install: "every" });
    const own = await installFabrikSkills(kitDir, productDir);
    // A gitignored copy an earlier release installed would still offer the dropped skill.
    for (const name of DROPPED_FABRIK_SKILLS.filter((dropped) => !own.includes(dropped) && !extraSkills.includes(dropped))) {
      await rm(resolve(productDir, ".claude", "skills", name), { recursive: true, force: true });
    }
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          release === null
            ? `This checkout is Fabrik itself. The skills its skills.lock.json pins (mattpocock/skills at ${sha}) and its own skills/ are in .claude/skills/, as this branch held them when the session started, installed by the SessionStart hook; they're gitignored, so never commit or edit them there: a skill of Fabrik's own is edited under skills/.`
            : `Fabrik ${release} is installed in this repo. The skills it pins (mattpocock/skills at ${sha}) are in .claude/skills/, fetched by the SessionStart hook; they're gitignored, so never commit or edit them.`,
          extraSkills.length > 0
            ? `This repo's Extra skills are also in .claude/skills/: ${extraSkills.join(", ")}. This repo's .fabrik/<phase>.md instructions say when to use them.`
            : "",
          own.includes("fabrik-live-design")
            ? "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>."
            : "",
          own.includes("fabrik-pair")
            ? "To work through a ready-for-human or weekly-limit issue with an agent beside them (a Pairing session), the Operator runs /fabrik-pair <issue number>."
            : "",
          own.includes("fabrik-visual-evidence")
            ? "To turn Visual evidence on, or change its answers, the Operator runs /fabrik-visual-evidence."
            : "",
          own.includes("fabrik-trial")
            ? "To try the merged changes untried on staging with an agent driving their own Chrome (a Trial session), the Operator runs /fabrik-trial, or /fabrik-trial <pull request number> for one, in a local session with Claude in Chrome connected."
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
        reloadSkills: true,
      },
      // A bad pick never blocks the session where the Operator will fix it.
      ...(errors.length > 0
        ? { systemMessage: `Fabrik installed its Base and Kit skills, but not this repo's Extra skills: ${errors.join("; ")}` }
        : {}),
    };
  } catch (error) {
    return notInstalled(error instanceof Error ? error.message : String(error));
  }
}

/** Copies every folder under the Kit's skills/ into .claude/skills/, returning their names. */
async function installFabrikSkills(kitDir: string, productDir: string): Promise<readonly string[]> {
  const source = join(kitDir, FABRIK_SKILLS_DIR);
  const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names) {
    const target = resolve(productDir, ".claude", "skills", name);
    await rm(target, { recursive: true, force: true });
    await cp(join(source, name), target, { recursive: true, verbatimSymlinks: true });
  }
  return names;
}

function notInstalled(why: string): SessionStartOutput {
  const message = `Fabrik didn't install its skills: ${why}`;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${message}. Skills such as grilling, to-spec and to-tickets may be missing from this session.`,
      reloadSkills: false,
    },
    systemMessage: message,
  };
}

/** Where the skills go and which release they come from, from the hook entry's arguments, or null for a usage error. */
function parseArgs(args: readonly string[]): Pick<SessionStartInput, "kitDir" | "productDir" | "release"> | null {
  const [first, second] = args;
  if (first === undefined || second === undefined) return null;
  // fabrik's own hook entry: the checkout is the Kit, so there's no release and no download.
  if (first === "--kit") return { kitDir: second, productDir: second, release: null };
  return { kitDir: resolve(import.meta.dirname, "..", ".."), productDir: first, release: second };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error("Usage: node src/session/start.ts <product checkout> <release>\n       node src/session/start.ts --kit <fabrik checkout>");
    process.exit(2);
  }
  const personalSkills = personalSkillsDir(process.env);
  sessionStart({ ...parsed, ...(personalSkills === null ? {} : { personalSkills }) }).then((output) => console.log(JSON.stringify(output)));
}
