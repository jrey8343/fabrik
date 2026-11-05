// The SessionStart hook's work in a cloud or local session (ADR-0003). The
// Product repo's hook entry (templates/claude-settings.json) reads the release
// from the caller workflow, downloads Fabrik at that tag, and runs
//   node <fabrik>/src/session/start.ts <product checkout> <release>
// This installs the skills that release locks, the same commit a Kit step
// installs in Actions, plus Fabrik's own skills and every Extra skill the
// Product repo picks (ADR-0008), since the Operator is at the wheel, and prints
// the hook's JSON.
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkCallerWorkflow } from "../kit/caller.ts";
import { type Download, fetchSkills } from "../skills/fetch.ts";

/** The caller workflow, the only place the Kit's version appears. */
export const CALLER_WORKFLOW_PATH = ".github/workflows/fabrik.yml";

/** Fabrik's own skills, installed beside the upstream ones under these names. */
const FABRIK_SKILLS_DIR = "skills";

/** What a SessionStart hook prints on stdout for Claude Code (https://code.claude.com/docs/en/hooks). */
export interface SessionStartOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "SessionStart";
    readonly additionalContext: string;
    /** Skill discovery runs before SessionStart hooks finish, so new skills need it to load in this session. */
    readonly reloadSkills: boolean;
  };
  /** A warning shown to the Operator when the hook couldn't install the skills, or only the Base and Kit skills. */
  readonly systemMessage?: string;
}

export interface SessionStartInput {
  /** Fabrik, checked out at `release`. */
  readonly kitDir: string;
  readonly productDir: string;
  /** The release the hook entry read from the caller workflow and fetched Fabrik at. */
  readonly release: string;
  readonly download?: Download;
}

export async function sessionStart({
  kitDir,
  productDir,
  release,
  download,
}: SessionStartInput): Promise<SessionStartOutput> {
  try {
    const caller = await readFile(join(productDir, CALLER_WORKFLOW_PATH), "utf8").catch(() => null);
    if (caller === null) return notInstalled(`${CALLER_WORKFLOW_PATH} was not found`);
    const pins = checkCallerWorkflow(caller);
    if (!pins.ok) return notInstalled(`${CALLER_WORKFLOW_PATH}: ${pins.error}`);
    if (pins.release !== release) {
      return notInstalled(`the hook fetched Fabrik ${release}, but ${CALLER_WORKFLOW_PATH} pins ${pins.release}`);
    }

    // The Operator is at the wheel, so the session gets every role's picks.
    const { sha, extraSkills, errors } = await fetchSkills(kitDir, productDir, download, { install: "every" });
    const own = await installFabrikSkills(kitDir, productDir);
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          `Fabrik ${release} is installed in this repo. The skills it pins (mattpocock/skills at ${sha}) are in .claude/skills/, fetched by the SessionStart hook; they're gitignored, so never commit or edit them.`,
          extraSkills.length > 0
            ? `This repo's Extra skills are also in .claude/skills/: ${extraSkills.join(", ")}. This repo's .fabrik/<phase>.md instructions say when to use them.`
            : "",
          own.includes("fabrik-live-design")
            ? "To take an issue's Design session live, the Operator runs /fabrik-live-design <issue number>."
            : "",
          own.includes("fabrik-pair")
            ? "To work through a ready-for-human or weekly-limit issue with an agent beside them (a Pairing session), the Operator runs /fabrik-pair <issue number>."
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

if (import.meta.main) {
  const [productDir, release] = process.argv.slice(2);
  if (productDir === undefined || release === undefined) {
    console.error("Usage: node src/session/start.ts <product checkout> <release>");
    process.exit(2);
  }
  const kitDir = resolve(import.meta.dirname, "..", "..");
  sessionStart({ kitDir, productDir, release }).then((output) => console.log(JSON.stringify(output)));
}
