// Reads `git diff --name-status -z` and `git log --name-status -z` output into
// the paths the trust-root guard checks. Pure, no I/O.
import type { ChangedPath } from "./trust-root.ts";

/** A status letter, with a similarity score after R and C. */
const STATUS = /^([ACDMRTUX])(\d*)$/;

/** The changed paths in NUL-separated name-status output, in order. Throws on anything it can't read. */
export function parseNameStatus(output: string): ChangedPath[] {
  const tokens = output.split("\0");
  const changes: ChangedPath[] = [];
  let i = 0;
  const next = (): string => {
    const token = tokens[i++];
    if (token === undefined || token === "") throw new Error("name-status output ends in the middle of an entry");
    return token;
  };
  while (i < tokens.length) {
    const token = tokens[i++]!;
    // Commits are separated by blank tokens.
    if (token === "") continue;
    const status = STATUS.exec(token)?.[1];
    if (status === undefined) throw new Error(`name-status output has an unknown status: ${JSON.stringify(token)}`);
    if (status === "R") {
      const from = next();
      changes.push({ path: next(), from });
    } else if (status === "C") {
      // A copy leaves its source as it was.
      next();
      changes.push({ path: next() });
    } else {
      changes.push({ path: next() });
    }
  }
  return changes;
}
