// The setup branch's name, apart from the git and gh work on it
// (src/setup/setupBranch.ts), so the Standing rule can know a setup pull
// request by its branch without reaching a shell. Pure, no I/O.

/** The branch setup applies its plan on, and a later run of the same release picks up. */
export function setupBranch(release: string): string {
  return `fabrik/setup-${release}`;
}
