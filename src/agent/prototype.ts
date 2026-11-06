// A Design session's prototype turn (#155), a mode of the design role with a
// Kit prompt of its own (prompts/prototype.md): what its prompt carries after
// the issue thread, the request the Operator approved, as the Kit job passed
// it out to the prototype job, and how the Kit builds, serves and captures
// the branch once the turn has ended. The runner runs it on the Design
// role's model and effort, within the Implement role's timeout, as it builds
// and serves the Product. Its variants go on the issue's prototype branch,
// which the job checked out when an earlier round pushed it, and which the
// runner cuts from the default branch otherwise, then passes out as a git
// bundle, as an Implement run's commits.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pageAt, variantPage } from "../evidence/uiEvidence.ts";
import type { KitConfig } from "../kit/config.ts";
import { prototypeBranchFor, variantLetter } from "../loop/designOutput.ts";
import { parsePrototypeRequest, type PrototypeRequestMarker } from "../loop/markers.ts";
import { spelled } from "../loop/readable.ts";
import { fenced } from "./design.ts";
import { cutBranch } from "./implement.ts";
import type { BuiltBranch } from "./result.ts";

const run = promisify(execFile);

/** The env var the prototype job passes the Kit job's prototype_request output in. */
export const PROTOTYPE_REQUEST_ENV = "FABRIK_PROTOTYPE_REQUEST";

/** The headings a prototype turn's inputs are set out under, in the order prompts/prototype.md reads them. */
export const PROTOTYPE_SECTIONS = {
  request: "The approved Prototype",
  sandbox: "This Product repo's Sandbox",
} as const;

/**
 * What a prototype turn's prompt carries after the issue thread: the request,
 * read from `requestText` (the Kit job's prototype_request output), and how
 * the Kit serves and captures the branch. Throws on a request that doesn't
 * read, or a Kit config with no `ui` block, so the run fails rather than
 * builds what nobody approved, or what nothing can capture.
 */
export function prototypeTurnContext(
  config: Pick<KitConfig, "ui" | "sandbox">,
  issue: number,
  requestText: string,
): { readonly request: PrototypeRequestMarker; readonly parts: string[] } {
  const request = parsePrototypeRequest(requestText);
  if (request === null) throw new Error(`${PROTOTYPE_REQUEST_ENV} holds no prototype request: a route, a variant count and a brief`);
  const { ui } = config;
  if (ui === null) throw new Error("Kit config has no ui block, so the Kit can neither serve nor capture a Prototype");
  const { route, variants, brief } = request.request;
  const letters = Array.from({ length: variants }, (_, at) => variantLetter(at));
  const served = pageAt(ui.url, route);
  const { build } = config.sandbox;
  return {
    request,
    parts: [
      `## ${PROTOTYPE_SECTIONS.request}`,
      `The Operator approved a Prototype of \`${route}\` in ${variants} variants. Build them as the variants ${spelled(letters, "and")} of that one route, each shown at \`${route}?variant=\` and its letter, on the branch \`${prototypeBranchFor(issue)}\`, which is checked out.`,
      "What the variants explore, as the Design session's request gives it:",
      fenced(brief.trimEnd(), "markdown"),
      `## ${PROTOTYPE_SECTIONS.sandbox}`,
      [build === null ? "- Build: none configured" : `- Build: \`${build}\``, `- Serve: \`${ui.serve}\`, which answers at \`${ui.url}\``].join("\n"),
      `Once you finish, the Kit builds the branch, serves it, and captures each variant at mobile and desktop widths, at \`${variantPage(served, letters[0] ?? "A")}\` and so on, so each variant must render there from its letter alone.`,
    ],
  };
}

/**
 * Who commits a prototype turn's variants: the agent, under the Kit's name
 * for a Prototype, so the commits on a prototype branch read as throwaway
 * code, never the Implementer's.
 */
export const PROTOTYPE_AUTHOR = { name: "Fabrik Prototype", email: "fabrik-prototype@users.noreply.github.com" } as const;

/**
 * Starts the issue's prototype branch: a later round carries on from the head
 * an earlier round pushed, which the prototype job checked out, so the bundle
 * holds only this round's commits and the push job fast-forwards the branch;
 * a first round cuts it from the default branch the checkout is on.
 */
export async function startPrototypeBranch(productDir: string, issue: number): Promise<BuiltBranch> {
  const name = prototypeBranchFor(issue);
  const git = async (...args: string[]) => (await run("git", args, { cwd: productDir })).stdout.trim();
  if ((await git("rev-parse", "--abbrev-ref", "HEAD")) !== name) return cutBranch(productDir, name);
  return { name, base: { ref: name, sha: await git("rev-parse", "HEAD") }, head: null };
}
