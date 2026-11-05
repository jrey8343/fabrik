// The Kit checkout's own files, as the programs that run from it read them:
// where the checkout is, and the Scorers' rubrics in it (prompts/scorers/),
// which src/kit/rubrics.ts parses and guards. The push job's record step, the
// judge and the score-record job read the rubrics through this, so it imports
// no runtime dependency.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRubric, RUBRICS_DIR, type Rubric, SCORERS } from "./rubrics.ts";

/** This Kit checkout. */
export const KIT_DIR = resolve(import.meta.dirname, "..", "..");

/** The Kit's rubrics, one per Scorer in the Kit's order, read from its rubric files. */
export async function loadRubrics(kitDir: string = KIT_DIR): Promise<readonly Rubric[]> {
  return Promise.all(
    SCORERS.map(async (name) => {
      const path = `${RUBRICS_DIR}/${name}.md`;
      return readRubric(await readFile(join(kitDir, path), "utf8"), path);
    }),
  );
}
