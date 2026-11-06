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
import type { KitConfig } from "../kit/config.ts";
import { prototypeBranchFor, variantLetter } from "../loop/designOutput.ts";
import { type PrototypeRequestMarker, readPrototypeRequest } from "../loop/markers.ts";
import { spelled } from "../loop/readable.ts";
import { fenced } from "./design.ts";

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
  const request = readPrototypeRequest(jsonOrNull(requestText));
  if (request === null) throw new Error(`${PROTOTYPE_REQUEST_ENV} holds no prototype request: a route, a variant count and a brief`);
  const { ui } = config;
  if (ui === null) throw new Error("Kit config has no ui block, so the Kit can neither serve nor capture a Prototype");
  const { route, variants, brief } = request.request;
  const letters = Array.from({ length: variants }, (_, at) => variantLetter(at));
  const served = `${ui.url.replace(/\/+$/, "")}${route}`;
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
      `Once you finish, the Kit builds the branch, serves it, and captures each variant at mobile and desktop widths, at \`${served}?variant=${letters[0] ?? "A"}\` and so on, so each variant must render there from its letter alone.`,
    ],
  };
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
