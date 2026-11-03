// The agent's transcript: every stream-json line it emits, appended to a file
// in FABRIK_OUT_DIR as it arrives. Written synchronously, line by line, because
// a job killed at its timeout-minutes runs no finally; the workflow gzips and
// uploads whatever reached the file (loop.yml, if: always()).
import { appendFileSync } from "node:fs";

/** The transcript file's name in FABRIK_OUT_DIR, which loop.yml uploads. */
export const TRANSCRIPT_FILE = "transcript.jsonl";

/** A stream handler that appends each line it's given to the transcript at `path`. */
export function transcriptWriter(path: string): (line: string) => void {
  return (line) => appendFileSync(path, `${line}\n`);
}
