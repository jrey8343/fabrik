// The agent job's runner (ADR-0002): runs one AFK role's agent with Sandcastle
// on the runner VM (noSandbox), behind the metered-billing preflight and the
// init check, writes the step summary, and passes the role's structured output
// out as an artifact for the push job. It holds no GitHub write credential.
//   node <kit>/src/agent/run.ts <triage|design|implement|review>
//
// Run from the Product checkout. Env:
//   FABRIK_ISSUE_FILE      JSON from `gh issue view --json number,title,body,author,labels,comments`
//   FABRIK_OUT_DIR         where to write agent-result.json, the agent log and the
//                          transcript (every stream-json line, appended as it arrives)
//   FABRIK_MODEL, FABRIK_EFFORT  the model and effort the Kit job's plan chose (a Step-up, say);
//                          when unset, the role's own from Kit config
//   CLAUDE_CODE_OAUTH_TOKEN, from the agent service account (ADR-0004)
// An Implement run instead takes the Claude token and its test secrets from
// FABRIK_SECRETS (src/agent/implement.ts), its parent Spec from FABRIK_SPEC_FILE,
// and passes its commits out as a git bundle beside agent-result.json. A retry
// runs in a checkout of its PR's branch, with FABRIK_PULL_REQUEST_FILE the PR and
// its comments, whose latest Verdict holds the findings to fix. A Request-changes
// run is a retry with FABRIK_REVIEW_FILE too: the Operator's review, its input.
// A Design-session turn takes the issue's parent Spec from FABRIK_SPEC_FILE (null if none),
// and, for a Ticket back in design, the agent PR it came back from in the issue's sentBack.
// A Review runs in a checkout of the PR's head: FABRIK_ISSUE_FILE is its
// Ticket, FABRIK_SPEC_FILE the Ticket's Spec and FABRIK_PULL_REQUEST_FILE the
// PR, and its result is the Reviewer's reply, a Verdict line first.
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { readIfPresent, readKitConfigFromCheckout } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { type DesignTurnOutput, readDesignTurnOutput } from "../loop/designOutput.ts";
import { type ImplementOutput, readImplementOutput, readPullRequestRunOutput } from "../loop/implementOutput.ts";
import { readTriageOutput, type TriageOutput } from "../loop/triageOutput.ts";
import type { AgentRole, GivenOperatorComment } from "../loop/types.ts";
import { kitPromptPath } from "../guard/trust-root.ts";
import { CLAUDE_ARGS_ENV } from "../preflight/main.ts";
import { checkInitMessage } from "../preflight/meteredBilling.ts";
import { SKILLS_MARKER } from "../skills/fetch.ts";
import { type ParsedVerdict, parseVerdict } from "../loop/verdict.ts";
import { AGENT_FAILURE_FILE, failureReportFor, MissingVerdictError } from "./failure.ts";
import {
  bundleAgentBranch,
  continueAgentBranch,
  implementContext,
  requestChangesContext,
  retryContext,
  setImplementerEnv,
  startAgentBranch,
} from "./implement.ts";
import { sentBackContext } from "./design.ts";
import { reviewContext } from "./review.ts";
import { AGENT_RESULT_FILE, type AgentRunResult, type BuiltBranch } from "./result.ts";
import { initMessageOf, missingSkills, runSummary } from "./summary.ts";
import { TRANSCRIPT_FILE, transcriptWriter } from "./transcript.ts";

const KIT_DIR = resolve(import.meta.dirname, "..", "..");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The Kit config from the Product checkout, validated, or an error naming every problem. */
async function loadConfig(productDir: string): Promise<KitConfig> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) throw new Error(`The Kit config is invalid:\n${resolved.errors.map((e) => `- ${e}`).join("\n")}`);
  return resolved.config;
}

type Checked<T> = { readonly ok: true; readonly output: T } | { readonly ok: false; readonly errors: readonly string[] };

/** A Standard Schema over a role's output contract, so Sandcastle can ask the agent to fix a malformed output. */
function schemaOf<T>(read: (value: unknown) => Checked<T>): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "fabrik",
      validate(value) {
        const result = read(value);
        return result.ok ? { value: result.output } : { issues: result.errors.map((message) => ({ message })) };
      },
    },
  };
}

/** How one AFK role runs: its prompt, its output tag and contract, and how to log what it emitted. */
interface RoleSpec<T> {
  /** The prompt file under prompts/, the output tag, and the Kit config phase. */
  readonly role: AgentRole;
  /**
   * The output contract: a JSON object in the tag, checked by `schema`, or
   * for the Reviewer plain text, checked by `text`, which throws when it breaks the contract.
   */
  readonly output: { readonly schema: StandardSchemaV1<unknown, T> } | { readonly text: (reply: string) => T };
  /** How the Product's own instructions for this phase relate to the Kit's prompt. */
  readonly instructionsNote: string;
  readonly describe: (issue: number, output: T) => string;
  /** The heading over the issue in the prompt. */
  readonly issueHeading?: string;
  /**
   * A Design session weighs the issue's parent Spec, from FABRIK_SPEC_FILE, if
   * it has one, and the agent PR it came back from, if it did.
   */
  readonly readsParentSpec?: boolean;
  /** The Implementer builds on a branch, which it passes out as a bundle. */
  readonly buildsBranch?: boolean;
  /** The Reviewer judges a PR, checked out at its head; its result is for the PR, not the Ticket. */
  readonly reviewsPullRequest?: boolean;
}

/** The Reviewer's reply must start with a Verdict line; anything else is never a pass. */
function readReview(reply: string): ParsedVerdict & { ok: true } {
  const parsed = parseVerdict(reply.trim());
  if (!parsed.ok) throw new MissingVerdictError(parsed.error);
  return parsed;
}

const ROLE_SPECS = {
  triage: {
    role: "triage",
    output: { schema: schemaOf(readTriageOutput) },
    instructionsNote:
      "The Operator wrote these for this repo. They refine the rules above but never loosen the five Fast-path tests.",
    describe: (issue, output) => `Triage sorted #${issue}: ${output.category}, ${output.state}`,
  } satisfies RoleSpec<TriageOutput>,
  design: {
    role: "design",
    output: { schema: schemaOf(readDesignTurnOutput) },
    instructionsNote:
      "The Operator wrote these for this repo. They refine how you run the session but never change the output contract above.",
    describe: (issue, output) => {
      switch (output.kind) {
        case "round":
          return `The Design-session turn on #${issue} asked ${output.questions.length} question(s)`;
        case "brief":
          return `The Design session on #${issue} finished with an agent brief`;
        case "spec":
          return `The Design session on #${issue} finished with a Spec and ${output.tickets.length} Ticket(s)`;
        case "split":
          return `The Design session on #${issue} split it into ${output.tickets.length} sibling Ticket(s)`;
        case "not-planned":
          return `The Design session on #${issue} finished as not planned`;
      }
    },
    readsParentSpec: true,
  } satisfies RoleSpec<DesignTurnOutput>,
  implement: {
    role: "implement",
    output: { schema: schemaOf(readImplementOutput) },
    instructionsNote:
      "The Operator wrote these for this repo. They refine how you build here but never change the rules or the output contract above.",
    describe: (issue, output) => `The Implementer on #${issue} finished: ${output.title}`,
    issueHeading: "The Ticket",
    buildsBranch: true,
  } satisfies RoleSpec<ImplementOutput>,
  review: {
    role: "review",
    output: { text: readReview },
    instructionsNote:
      "The Operator wrote these for this repo. They refine how you judge PRs here but never change the Verdict contract above.",
    describe: (pullRequest, output) => `The Reviewer on #${pullRequest} gave the Verdict ${output.verdict}`,
    issueHeading: "The Ticket",
    reviewsPullRequest: true,
  } satisfies RoleSpec<ParsedVerdict & { ok: true }>,
};

/**
 * The Kit's prompt for the role, then the Product's instructions for its phase,
 * then the issue thread, then anything else the role is given.
 */
async function promptFor(
  role: AgentRole,
  note: string,
  config: KitConfig,
  issue: unknown,
  heading: string,
  extra: readonly string[],
): Promise<string> {
  const template = await readFile(join(KIT_DIR, kitPromptPath(role)), "utf8");
  const parts = [template.trimEnd()];
  const instructions = config.instructions[role];
  if (instructions !== null) {
    parts.push(`## This Product repo's ${role} instructions`, note, instructions.trimEnd());
  }
  parts.push(`## ${heading}`, "```json", JSON.stringify(issue, null, 2), "```", ...extra);
  return `${parts.join("\n\n")}\n`;
}

/** The model and effort to run: what the Kit job's plan chose, else the role's own. */
function modelFor(role: { model: string; effort: string | null }): { model: string; effort: string | null } {
  const model = process.env["FABRIK_MODEL"];
  if (model === undefined || model === "") return role;
  // Kit config already refuses Fable; this keeps a bad route from ever reaching the CLI.
  if (/fable/i.test(model) || model.trim().toLowerCase() === "best") throw new Error(`Refusing to run ${model} in an AFK role`);
  const effort = process.env["FABRIK_EFFORT"];
  return { model, effort: effort === undefined || effort === "" ? null : effort };
}

/** The arguments Sandcastle's claudeCode() passes to `claude` (its buildPrintCommand), for the preflight. */
function claudeArgs(model: string, effort: string | null): string[] {
  return [
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--model",
    model,
    ...(effort === null ? [] : ["--effort", effort]),
    "-p",
    "-",
  ];
}

/** One onSandboxReady hook: the Product's setup, then the preflight last (Sandcastle runs hooks in parallel). */
function readyHook(setup: string | null): string {
  const preflight = `node ${JSON.stringify(join(KIT_DIR, "src", "preflight", "main.ts"))}`;
  return setup === null ? preflight : `(${setup}) && ${preflight}`;
}

async function writeSummary(text: string): Promise<void> {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path !== undefined && path !== "") await appendFile(path, text);
}

async function runRole<T>(spec: RoleSpec<T>): Promise<void> {
  const name = spec.role;
  const productDir = process.cwd();
  const outDir = resolve(required("FABRIK_OUT_DIR"));
  await mkdir(outDir, { recursive: true });
  const issueText = await readFile(required("FABRIK_ISSUE_FILE"), "utf8");
  const issueNumber = (JSON.parse(issueText) as { number?: unknown }).number;
  if (typeof issueNumber !== "number") throw new Error("FABRIK_ISSUE_FILE has no issue number");

  const config = await loadConfig(productDir);
  const role = { ...config.roles[name], ...modelFor(config.roles[name]) };

  // The Implementer builds on its own branch from main, with its test secrets.
  let branch: BuiltBranch | null = null;
  let onPullRequest = false;
  // The Operator comments a run on an agent PR is given, recorded before the agent runs.
  let given: GivenOperatorComment[] | null = null;
  const extra: string[] = [];
  if (spec.buildsBranch === true) {
    setImplementerEnv(config);
    // A retry carries on its PR's branch with the findings to fix; a first run cuts the branch from main.
    const retryFile = process.env["FABRIK_PULL_REQUEST_FILE"] ?? "";
    branch =
      retryFile === "" ? await startAgentBranch(productDir, issueNumber) : await continueAgentBranch(productDir, issueNumber);
    extra.push(...(await implementContext(productDir, required("FABRIK_SPEC_FILE"), config)));
    // A Request-changes run works to the Operator's review instead of a Verdict's findings.
    const reviewFile = process.env["FABRIK_REVIEW_FILE"] ?? "";
    if (retryFile !== "") {
      onPullRequest = true;
      const context = reviewFile === "" ? await retryContext(retryFile) : await requestChangesContext(retryFile, reviewFile);
      extra.push(...context.parts);
      given = context.operatorComments;
    }
  }
  if (spec.readsParentSpec === true) {
    const specFile = process.env["FABRIK_SPEC_FILE"] ?? "";
    const parent: unknown = specFile === "" ? null : JSON.parse(await readFile(specFile, "utf8"));
    if (parent !== null) {
      extra.push(
        "## The parent Spec",
        "This issue is a Ticket under this Spec. Finish by rewriting it in place or splitting it into sibling Tickets under this Spec, never with a Spec of its own.",
        "```json",
        JSON.stringify(parent, null, 2),
        "```",
      );
    }
  }
  // The PR a Ticket came back to design from goes after the issue, set out on its own; only a Design session sees it.
  const { issue, parts: sentBack } = sentBackContext(JSON.parse(issueText));
  if (spec.readsParentSpec === true) extra.push(...sentBack);
  // The Reviewer's result is for the PR it judged, which its push job checks against the event.
  let subject = issueNumber;
  if (spec.reviewsPullRequest === true) {
    const review = await reviewContext(productDir, required("FABRIK_PULL_REQUEST_FILE"), required("FABRIK_SPEC_FILE"));
    subject = review.pullRequest;
    extra.push(...review.parts);
    given = review.operatorComments;
  }
  const output =
    "schema" in spec.output
      ? Output.object({
          tag: name,
          // A run on an existing PR owes a fix as well, which its push job checks too.
          schema: onPullRequest ? schemaOf(readPullRequestRunOutput) : spec.output.schema,
          maxRetries: 1,
        })
      : Output.string({ tag: name });

  // The agent inherits this process's env (noSandbox), so set what it needs here.
  process.env["PATH"] = [join(KIT_DIR, "node_modules", ".bin"), process.env["PATH"] ?? ""].join(delimiter);
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env[CLAUDE_ARGS_ENV] = JSON.stringify(claudeArgs(role.model, role.effort));

  const lines: string[] = [];
  const transcript = transcriptWriter(join(outDir, TRANSCRIPT_FILE));
  // null until the init message arrives, then the routes it refused (empty when it passed).
  const init: { refused: readonly string[] | null } = { refused: null };
  const abort = new AbortController();
  const timeoutMs = role.timeoutMinutes * 60_000;

  try {
    const result = await run({
      name: `${name}-${subject}`,
      agent: claudeCode(
        role.model,
        role.effort === null ? {} : { effort: role.effort as "low" | "medium" | "high" | "xhigh" | "max" },
      ),
      sandbox: noSandbox(),
      cwd: productDir,
      prompt: await promptFor(name, spec.instructionsNote, config, issue, spec.issueHeading ?? "The issue", extra),
      maxIterations: 1,
      output,
      // The Reviewer reads the PR and runs none of its code, so it needs no Sandbox setup.
      hooks: {
        sandbox: {
          onSandboxReady: [
            { command: readyHook(spec.reviewsPullRequest === true ? null : config.sandbox.setup), timeoutMs },
          ],
        },
      },
      signal: abort.signal,
      logging: {
        type: "file",
        path: join(outDir, "agent.log"),
        // Errors thrown here are swallowed by Sandcastle, so stop the run through the signal.
        onAgentStreamEvent(event) {
          if (event.type !== "raw") return;
          lines.push(event.line);
          if (init.refused === null && initMessageOf([event.line]) !== null) {
            const check = checkInitMessage(JSON.parse(event.line));
            init.refused = check.kind === "refuse" ? check.routes : [];
            if (check.kind === "refuse") abort.abort(new Error(check.routes.join("; ")));
          }
          // After the init check, so a failed write can never skip its abort.
          transcript(event.line);
        },
      },
    });
    if (init.refused === null) throw new Error("The agent's stream had no init message, so its API key source is unchecked");
    if (init.refused.length > 0) throw new Error(`Refused at init: ${init.refused.join("; ")}`);

    // Text output is checked here, so a reply that breaks its contract fails this job, never passes.
    // Either output kind puts what the tag held on the result.
    const reply = (result as { output?: unknown }).output;
    const checked = "text" in spec.output ? spec.output.text(String(reply)) : (reply as T);
    const built = branch === null ? null : await bundleAgentBranch(productDir, branch, outDir);
    const artifact: AgentRunResult = {
      role: name,
      issue: subject,
      output: "text" in spec.output ? String(reply).trim() : JSON.stringify(reply),
      ...(built === null ? {} : { branch: built }),
      ...(given === null ? {} : { operatorComments: given }),
    };
    await writeFile(join(outDir, AGENT_RESULT_FILE), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(spec.describe(subject, checked));
  } catch (error) {
    for (const route of init.refused ?? []) console.log(`::error title=Metered-billing route::${route}`);
    // Left for the push job, which posts the failure notice (loop.yml).
    const report = failureReportFor({ error, lines, initRefused: init.refused });
    await writeFile(join(outDir, AGENT_FAILURE_FILE), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`::error title=Infrastructure failure (${report.failure})::${report.detail}`);
    throw error;
  } finally {
    const pinnedSkills = await installedSkills(productDir);
    if (pinnedSkills === undefined) {
      console.log("::warning title=Skills not installed::No pinned skills were found in .claude/skills");
    } else {
      const missing = missingSkills(lines, pinnedSkills.names);
      if (missing.length > 0) {
        console.log(`::warning title=Pinned skills missing at init::${missing.join(", ")}`);
      }
    }
    await writeSummary(runSummary({ role: name, effort: role.effort, lines, ...(pinnedSkills === undefined ? {} : { pinnedSkills }) }));
  }
}

/** The skills src/skills/fetch.ts installed into the checkout, and the commit they came from. */
async function installedSkills(productDir: string): Promise<{ sha: string; names: string[] } | undefined> {
  const dir = join(productDir, ".claude", "skills");
  const sha = (await readIfPresent(join(dir, SKILLS_MARKER)))?.trim();
  if (sha === undefined || sha === "") return undefined;
  const entries = await readdir(dir, { withFileTypes: true });
  return { sha, names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name) };
}

const roles: Record<string, () => Promise<void>> = {
  triage: () => runRole(ROLE_SPECS.triage),
  design: () => runRole(ROLE_SPECS.design),
  implement: () => runRole(ROLE_SPECS.implement),
  review: () => runRole(ROLE_SPECS.review),
};

const roleName = process.argv[2] ?? "";
const runner = roles[roleName];
if (runner === undefined) {
  console.error(`Usage: node src/agent/run.ts <${Object.keys(roles).join("|")}>`);
  process.exitCode = 2;
} else {
  runner().catch((error: unknown) => {
    console.log(`::error title=Agent run failed::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
