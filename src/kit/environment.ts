// The name of the GitHub environment that holds the Kit's tokens. Pure, with no imports.

/**
 * The `fabrik` environment: the one GitHub environment of a repo whose
 * secrets are the Kit's service-account tokens. Only the default branch may
 * use it, so GitHub gives a token to no run on any other ref (ADR-0004).
 * Each job of the Kit's workflows that reads a token names it. Setup makes it
 * and holds it to the default branch by one branch rule naming that branch,
 * and stores each token straight into it, never as a repo-level secret.
 */
export const KIT_ENVIRONMENT = "fabrik";
