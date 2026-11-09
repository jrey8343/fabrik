// The agent's transcript: every stream-json line it emits, appended to a file
// in FABRIK_OUT_DIR as it arrives. Written synchronously, line by line, because
// a job killed at its timeout-minutes runs no finally; the workflow gzips and
// uploads whatever reached the file (loop.yml, if: always()).
import { appendFileSync } from "node:fs";
import { constants, gunzipSync, gzipSync } from "node:zlib";

/** The transcript file's name in FABRIK_OUT_DIR, which loop.yml uploads. */
export const TRANSCRIPT_FILE = "transcript.jsonl";

/**
 * The file in FABRIK_OUT_DIR holding what a run on an agent PR was asked
 * beyond the Ticket (src/agent/implement.ts, ImplementInput's `brief`), which
 * loop.yml keeps beside the transcript for the judge (#450). A first run
 * leaves none.
 */
export const RUN_BRIEF_FILE = "brief.md";

/** A stream handler that appends each line it's given to the transcript at `path`. */
export function transcriptWriter(path: string): (line: string) => void {
  return (line) => appendFileSync(path, `${line}\n`);
}

/** A gzipped transcript read back: its lines, and the gzip to keep of them. */
export interface TranscriptGzip {
  readonly lines: readonly string[];
  readonly gzip: Uint8Array;
}

/**
 * The lines of a gzipped transcript, as loop.yml uploads it. A job its timeout
 * cancelled can leave the gzip cut off: then it keeps every whole line that
 * decoded, gzipped again so the copy kept opens. null for bytes that aren't gzip.
 */
export function readTranscriptGzip(gzip: Uint8Array): TranscriptGzip | null {
  try {
    return { lines: linesOf(gunzipSync(gzip).toString("utf8")), gzip };
  } catch {
    // Cut off: decode what's there, and keep only the lines that ended.
  }
  try {
    const text = gunzipSync(gzip, { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
    const lines = linesOf(text.slice(0, text.lastIndexOf("\n") + 1));
    if (lines.length === 0) return null;
    return { lines, gzip: gzipSync(lines.map((line) => `${line}\n`).join("")) };
  } catch {
    return null;
  }
}

function linesOf(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}
