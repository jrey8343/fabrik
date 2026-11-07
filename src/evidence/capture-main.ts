// The Implement job's UI evidence capture step (#153), run once the
// Implementer's agent has ended, and the prototype job's capture of a
// prototype turn's variants (#155), run once its agent has ended: the
// Playwright shell around captureEvidence and capturePrototype
// (src/evidence/capture.ts), which make every decision. This file only does
// what it's told on the runner: reads Kit config from the default branch's
// commit, the one the push job reads to say whether the PR is UI, never from
// the branch's own files, which may be older; diffs a PR's branch against that
// same commit, installs Chromium (with the ffmpeg its videos need), runs
// `sandbox.build`, frees `ui.url`'s port, starts `ui.serve`, runs the
// `ui.sign_in` commands the routes need (ADR-0012), screenshots each
// shot headless, or, for a variant, screenshots it and films a short scripted
// load-and-scroll, and writes the screenshots, any videos, the capture result
// and the gallery into the agent's output directory, passing the result out
// as the step output `ui-capture-result`. No model turns, no MCP. Capture's
// own failures are in the capture result, never this step's exit code. Its
// tests run it where it stops before the browser; playwrightCapturer.test.ts
// drives the Playwright capturer itself against a local fixture.
//   node <kit>/src/evidence/capture-main.ts             a pull request's UI evidence
//   node <kit>/src/evidence/capture-main.ts prototype   a prototype turn's variants
//
// The real Capturer that does it is src/evidence/playwrightCapturer.ts.
// Run from the Product checkout, after prepare-agent's npm ci (the only Kit
// program that imports Playwright). Env:
//   FABRIK_OUT_DIR            the agent's output directory, holding agent-result.json
//   FABRIK_DEFAULT_BRANCH     the default branch, fetched as origin/<it>: Kit config is read, and
//                             a PR's branch diffed against, at its commit
//   FABRIK_ISSUE_FILE         for a PR, the Ticket, as prepare-agent read it; its body names routes
//   FABRIK_PROTOTYPE_REQUEST  for a prototype turn, the Kit job's request, whose route it captures
// Nothing here holds a secret, and the build, server and sign-ins get none (buildAndServeEnv).
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROTOTYPE_REQUEST_ENV } from "../agent/prototype.ts";
import { AGENT_RESULT_FILE, readAgentRunResult } from "../agent/result.ts";
import { readKitConfigWith } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { writeOutputs, writeSummary } from "../kit/stepFiles.ts";
import { parsePrototypeTurnOutput } from "../loop/designOutput.ts";
import { parsePrototypeRequest } from "../loop/markers.ts";
import {
  buildAndServeEnv,
  CAPTURE_RESULT_FILE,
  captureEvidence,
  capturePrototype,
  captureStepFiles,
  captureStepOutputs,
  captureStepSummary,
  EVIDENCE_DIR,
  GALLERY_FILE,
  implementerRoutesIn,
  PROTOTYPE_GALLERY_FILE,
  prototypeCaptureFiles,
  prototypeCaptureSummary,
} from "./capture.ts";
import { PlaywrightCapturer } from "./playwrightCapturer.ts";

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The commit a ref names in the Product checkout, which fails when the checkout lacks it. */
async function commitOf(productDir: string, ref: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: productDir });
  return stdout.trim();
}

/** A file's text at a commit the checkout has, or null when the commit has no such file. */
async function fileAt(productDir: string, commit: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: productDir, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    // The commit itself is known to be there (commitOf), so it's the file that isn't.
    return null;
  }
}

/**
 * The default branch's commit, which a pull request's branch is diffed
 * against, and its Kit config; or, when that Kit config no longer reads,
 * null, once it has warned of it and written the step's outputs as nothing
 * captured, so the caller stops there.
 */
async function defaultBranchKitOrSkip(productDir: string): Promise<{ readonly base: string; readonly config: KitConfig } | null> {
  const base = await commitOf(productDir, `origin/${required("FABRIK_DEFAULT_BRANCH")}`);
  const resolved = await readKitConfigWith((path) => fileAt(productDir, base, path));
  if (resolved.ok) return { base, config: resolved.config };
  // The Kit job checked Kit config as this run started, so the default branch's has changed since.
  for (const error of resolved.errors) console.log(`::warning title=UI evidence not captured::${error}`);
  await writeOutputs(captureStepOutputs({ kind: "skipped", why: "Kit config doesn't read" }));
  return null;
}

/** Each of these files capture wrote to the evidence folder, by name, leaving out any it didn't. */
async function filesIn(evidenceDir: string, names: readonly string[]): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    const bytes = await readFile(join(evidenceDir, name)).catch(() => null);
    if (bytes !== null) files.set(name, bytes);
  }
  return files;
}

/** A pull request's UI evidence, in the Implement job. */
async function main(): Promise<void> {
  const productDir = process.cwd();
  const outDir = required("FABRIK_OUT_DIR");
  const evidenceDir = join(outDir, EVIDENCE_DIR);
  // Whatever an agent left where capture writes isn't evidence.
  await rm(evidenceDir, { recursive: true, force: true });
  await rm(join(outDir, GALLERY_FILE), { force: true });

  const known = await defaultBranchKitOrSkip(productDir);
  if (known === null) return;
  const { base, config } = known;
  const result = readAgentRunResult(await readFile(join(outDir, AGENT_RESULT_FILE), "utf8"));
  const issue = JSON.parse(await readFile(required("FABRIK_ISSUE_FILE"), "utf8")) as { body?: unknown };
  const capturer = new PlaywrightCapturer(productDir, evidenceDir, base, buildAndServeEnv(process.env, config.sandbox.env));
  const outcome = await captureEvidence(
    {
      ui: config.ui,
      build: config.sandbox.build,
      headSha: result.branch?.head ?? null,
      ticketBody: typeof issue.body === "string" ? issue.body : "",
      implementerRoutes: implementerRoutesIn(result.output),
    },
    capturer,
  );
  if (outcome.kind === "recorded") {
    const images = await filesIn(evidenceDir, outcome.result.captures.map(({ image }) => image));
    const files = captureStepFiles(outcome.result, images, result.issue);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, CAPTURE_RESULT_FILE), files.result);
    if (files.gallery !== null) await writeFile(join(outDir, GALLERY_FILE), files.gallery);
  }
  await writeOutputs(captureStepOutputs(outcome));
  const summary = captureStepSummary(outcome);
  if (summary !== null) await writeSummary(summary);
}

/**
 * A prototype turn's variants (#155), in the prototype job: the route the
 * Operator approved, from the Kit job's request, and the variants the turn's
 * output named, at the head the turn left the issue's prototype branch at.
 */
async function prototypeMain(): Promise<void> {
  const productDir = process.cwd();
  const outDir = required("FABRIK_OUT_DIR");
  const evidenceDir = join(outDir, EVIDENCE_DIR);
  // Whatever the agent left where capture writes isn't a capture.
  await rm(evidenceDir, { recursive: true, force: true });
  await rm(join(outDir, PROTOTYPE_GALLERY_FILE), { force: true });

  const known = await defaultBranchKitOrSkip(productDir);
  if (known === null) return;
  const { base, config } = known;
  const request = parsePrototypeRequest(required(PROTOTYPE_REQUEST_ENV));
  if (request === null) throw new Error(`${PROTOTYPE_REQUEST_ENV} holds no prototype request`);
  const result = readAgentRunResult(await readFile(join(outDir, AGENT_RESULT_FILE), "utf8"));
  // The runner checked the output against the contract, so only a run that broke it names no variant.
  const round = parsePrototypeTurnOutput(result.output);
  const variants = round.ok ? round.output.variants : [];
  const { route } = request.request;
  const capturer = new PlaywrightCapturer(productDir, evidenceDir, base, buildAndServeEnv(process.env, config.sandbox.env));
  const outcome = await capturePrototype(
    { ui: config.ui, build: config.sandbox.build, headSha: result.branch?.head ?? null, route, variants: variants.map(({ letter }) => letter) },
    capturer,
  );
  if (outcome.kind === "recorded") {
    const taken = await filesIn(evidenceDir, outcome.result.captures.flatMap(({ image, video }) => (video === undefined ? [image] : [image, video])));
    const files = prototypeCaptureFiles(outcome.result, taken, variants, { issue: result.issue, route });
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, CAPTURE_RESULT_FILE), files.result);
    if (files.gallery !== null) await writeFile(join(outDir, PROTOTYPE_GALLERY_FILE), files.gallery);
  }
  await writeOutputs(captureStepOutputs(outcome));
  const summary = prototypeCaptureSummary(outcome);
  if (summary !== null) await writeSummary(summary);
}

(process.argv[2] === "prototype" ? prototypeMain() : main()).catch((error: unknown) => {
  // A fault in this shell, not in capture: the step goes on (continue-on-error), and the push job reads no result.
  console.log(`::warning title=UI evidence not captured::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
