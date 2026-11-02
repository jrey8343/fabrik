// The Kit check on a Product repo's caller workflow (ADR-0003): every `uses:`
// line that names Fabrik pins the same exact release, the only place the Kit's
// version appears. Pure, no I/O.

export type CallerCheck =
  | { readonly ok: true; readonly release: string }
  | { readonly ok: false; readonly error: string };

/** A `uses:` line naming Fabrik, optionally quoted and as a list item, capturing the ref. */
const FABRIK_USES = /^\s*(?:-\s+)?uses:\s*["']?jrey8343\/fabrik(?:\/[^@\s"']*)?@([^\s"'#]+)["']?\s*(?:#.*)?$/;

/** An exact semver release tag, such as v1.2.3 or v1.2.3-pre.1. */
const EXACT_RELEASE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function checkCallerWorkflow(text: string): CallerCheck {
  const refs = text.split("\n").flatMap((line) => {
    const match = FABRIK_USES.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (refs.length === 0) {
    return { ok: false, error: "The caller workflow has no uses: line that pins a Fabrik release" };
  }
  const distinct = [...new Set(refs)];
  if (distinct.length > 1) {
    return {
      ok: false,
      error: `The caller workflow pins more than one Fabrik release (${distinct.join(", ")}); every uses: line must pin the same one`,
    };
  }
  const [release] = distinct as [string];
  if (!EXACT_RELEASE.test(release)) {
    return {
      ok: false,
      error: `The caller workflow pins Fabrik at ${release}, which isn't an exact release tag such as v1.2.3`,
    };
  }
  return { ok: true, release };
}
