// A Fabrik release pins its npm upstreams exactly, so a Product repo pinning one
// release pins everything (ADR-0003). Dependabot bumps these versions in
// Fabrik (.github/dependabot.yml); the skills SHA lives in skills.lock.json.
// Pure, no I/O.

/** The npm packages each release pins at one exact version. */
export const PINNED_UPSTREAMS = ["@ai-hero/sandcastle", "@anthropic-ai/claude-code"] as const;

/** Upstreams whose install script must run (the Claude Code CLI links its native binary). */
const INSTALL_SCRIPTS = ["@anthropic-ai/claude-code"] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Every way package.json breaks the release pins, or an empty list. */
export function checkUpstreamPins(packageJsonText: string): readonly string[] {
  const manifest = JSON.parse(packageJsonText) as {
    dependencies?: Record<string, unknown>;
    allowScripts?: Record<string, unknown>;
  };
  const problems: string[] = [];
  for (const name of PINNED_UPSTREAMS) {
    const version = manifest.dependencies?.[name];
    if (version === undefined) {
      problems.push(`${name} must be a runtime dependency pinned at an exact version`);
    } else if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      problems.push(`${name} must be pinned at an exact version, not ${JSON.stringify(version)}`);
    }
  }
  // An approval keyed name@version stops matching once Dependabot bumps the
  // version, and npm would then skip the install script silently.
  for (const name of INSTALL_SCRIPTS) {
    if (manifest.allowScripts?.[name] !== true) {
      problems.push(
        `allowScripts must name ${name} without a version, so its install script still runs after a Dependabot bump`,
      );
    }
  }
  return problems;
}
