// The agent job's runner (ADR-0002): runs one AFK role's agent with Sandcastle
// on the runner VM (noSandbox), behind the metered-billing preflight and the
// init check, writes the step summary, and passes the role's structured output
// out as an artifact for the push job. It holds no GitHub write credential.
//   node <kit>/src/agent/run.ts <triage|design|prototype|implement|review|audit|retro|research|replay-implement|replay-review>
//
// Run from the Product checkout. Env:
//   FABRIK_ISSUE_FILE      JSON from `gh issue view --json number,title,body,author,labels,comments`
//   FABRIK_OUT_DIR         where to write agent-result.json, the agent log and the
//                          transcript (every stream-json line, appended as it arrives)
//   FABRIK_MODEL, FABRIK_EFFORT  the model and effort the Kit job's plan chose (a Step-up, say);
//                          when unset, the role's own from Kit config; the ones it passes go out
//                          as the step outputs `model` and `effort`, for the run's Run record
//   CLAUDE_CODE_OAUTH_TOKEN, from the agent service account (ADR-0004)
// A Triage run also takes FABRIK_RECENT_ISSUES_FILE, the issues the agent-inputs
// step gathered for it to compare its issue against for a duplicate (#363).
// An Implement run instead takes the Claude token and its test secrets from
// FABRIK_SECRETS (src/agent/implement.ts), its parent Spec from FABRIK_SPEC_FILE,
// and passes its commits out as a git bundle beside agent-result.json. A retry
// runs in a checkout of its PR's branch, with FABRIK_PULL_REQUEST_FILE the PR and
// its comments, whose latest Verdict holds the findings to fix. A Request-changes
// run is a retry with FABRIK_REVIEW_FILE too: the Operator's review, its input. A
// conflict-only run (#304) is one with FABRIK_CONFLICT_MAIN: the main head it rebases onto.
// A Design-session turn takes the issue's parent Spec from FABRIK_SPEC_FILE (null if none),
// for a Ticket back in design, the agent PR it came back from in the issue's sentBack,
// and whether it may offer a Map from FABRIK_MAP_FILE; on a repo with a `ui` block,
// it is told it may offer a Prototype.
// A Design session's prototype turn (#155), `prototype`, is a design run with
// prompts/prototype.md, on the Design model and effort within the Implement
// timeout: it takes the request the Operator approved from
// FABRIK_PROTOTYPE_REQUEST, the Kit job's one line of JSON, and the Claude token
// and the test secrets from FABRIK_SECRETS, as an Implement run does. It builds
// the variants on the issue's prototype branch, which it carries on when the
// job checked it out and cuts from the default branch otherwise, and passes it
// out as a git bundle beside agent-result.json.
// A Review runs in a checkout of the PR's head: FABRIK_ISSUE_FILE is its
// Ticket, FABRIK_SPEC_FILE the Ticket's Spec and FABRIK_PULL_REQUEST_FILE the
// PR, and its result is the Reviewer's reply, a Verdict line first. A UI PR's
// Review also takes FABRIK_UI_EVIDENCE_DIR, the folder its UI evidence was
// downloaded into, if it was, and FABRIK_UI_EVIDENCE_FAILURE, why its capture
// failed, when the PR's marker records that (src/agent/review.ts).
// An Auditor run is in a checkout of the default branch at its pending Audit's
// marked commit: FABRIK_ISSUE_FILE is the Audit and FABRIK_AUDIT_FILE what the
// agent-inputs step gathered for it (src/agent/inputs.ts), and its result
// carries the hot-spot window it was given.
// A Retro run is in a checkout of the default branch: FABRIK_ISSUE_FILE is the
// pending Retro and FABRIK_RETRO_EVIDENCE_FILE the evidence bundle the Retro
// evidence job left (.github/actions/gather-retro-evidence), and it reads the
// Kit's role prompts and rubrics from this Kit checkout.
// A Researcher run is in a checkout of the default branch: FABRIK_ISSUE_FILE is
// the research Decision and FABRIK_SPEC_FILE its Map (the issue's parent, as
// the agent-inputs step wrote it), and it writes its findings to the one file
// the Kit names from the Decision (src/agent/research.ts). The runner cuts the
// Decision's throwaway branch, commits what the run left to it, and passes it
// out as a git bundle beside agent-result.json, as an Implement run does.
// A Replay arm's runs (#156, src/agent/replay.ts) take FABRIK_BASE_SHA, the
// replayed Ticket's baseSha, and leave the Product repo untouched.
// `replay-implement` is a first Implement run in a checkout at baseSha, with an
// Implement run's env and inputs but no PR or review file, and passes its
// commits out as replay.patch, its diff from baseSha, beside agent-result.json.
// `replay-review` is a Review in a checkout of that patch as a commit on
// baseSha: FABRIK_ISSUE_FILE is the Ticket and FABRIK_SPEC_FILE its Spec, it
// takes no PR file, and its result is the Reviewer's reply for the Ticket.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { captureFailureOf } from "../evidence/uiEvidence.ts";
import { readKitConfigFromCheckout } from "../kit/checkout.ts";
import type { KitConfig } from "../kit/config.ts";
import { KIT_DIR } from "../kit/kitFiles.ts";
import type { ReplayRole } from "../kit/runRecord.ts";
import { writeOutputs, writeSummary } from "../kit/stepFiles.ts";
import { prototypeRole } from "../loop/design.ts";
import { type DesignTurnOutput, type PrototypeRoundOutput, readDesignTurnOutput, readPrototypeTurnOutput } from "../loop/designOutput.ts";
import { rotationIsOn } from "../loop/subscriptions.ts";
import { IMPLEMENT_OUTPUT_READERS, type ImplementOutput, type ImplementRunKind, readImplementOutput } from "../loop/implementOutput.ts";
import { readTriageOutput, type TriageOutput } from "../loop/triageOutput.ts";
import { type AuditOutput, readAuditOutput } from "../loop/auditOutput.ts";
import { readRetroOutput, type RetroOutput } from "../loop/retroOutput.ts";
import { readResearchOutput, type ResearchOutput } from "../loop/researchOutput.ts";
import type { AgentRole, AuditWindow, GivenOperatorComment } from "../loop/types.ts";
import { type KitPrompt, kitPromptPath } from "../guard/trust-root.ts";
import { readInstallRecord } from "../skills/fetch.ts";
import { type ParsedVerdict, parseVerdict } from "../loop/verdict.ts";
import { AGENT_FAILURE_FILE, MissingVerdictError } from "./failure.ts";
import { bundleAgentBranch, cutBranch, implementInput, setImplementerEnv, setSandboxEnv } from "./implement.ts";
import { BASE_SHA_ENV, replayImplementInput, replayReviewContext, writeReplayPatch } from "./replay.ts";
import { AUDIT_ISSUE_HEADING, auditContext } from "./audit.ts";
import { triageContext } from "./triage.ts";
import { RETRO_ISSUE_HEADING, retroContext } from "./retro.ts";
import { commitResearch, RESEARCH_ISSUE_HEADING, researchContext } from "./research.ts";
import { mapCapContext, prototypeContext, sentBackContext } from "./design.ts";
import { PROTOTYPE_AUTHOR, PROTOTYPE_REQUEST_ENV, prototypeTurnContext, startPrototypeBranch } from "./prototype.ts";
import {
  claudeArgs,
  leaveFailureReport,
  type OutputContract,
  readyHook,
  replySchemaOf,
  setAgentEnv,
  settleReply,
  streamWatch,
} from "./launch.ts";
import { reviewContext } from "./review.ts";
import { AGENT_RESULT_FILE, type AgentRunResult, type BuiltBranch } from "./result.ts";
import { promptFor } from "./prompt.ts";
import { missingSkills, runSummary } from "./summary.ts";
import { TRANSCRIPT_FILE } from "./transcript.ts";

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

/** How one AFK role runs: its prompt, its output tag and contract, and how to log what it emitted. */
interface RoleSpec<T> {
  /**
   * The role: its Kit config model, effort and timeout, the name of its
   * .fabrik/<role>.md instructions and its Extra skills, and, unless `prompt`
   * says otherwise, its prompt file under prompts/ and its output tag.
   */
  readonly role: AgentRole;
  /**
   * The prompt file under prompts/ and the output tag, when they aren't the
   * role's own. `prototype` is a prototype turn's: it builds the approved
   * variants, from FABRIK_PROTOTYPE_REQUEST, on the issue's prototype branch,
   * which it passes out as a bundle; it runs on the Design role's model and
   * effort within the Implement role's timeout, with the test secrets, and is
   * never told it may offer a Map or a Prototype.
   */
  readonly prompt?: KitPrompt;
  /**
   * The output contract: a JSON object in the tag, checked by `read`, or
   * for the Reviewer plain text, checked by `text`, which throws when it breaks the contract.
   */
  readonly output: OutputContract<T>;
  /** How the Product's own instructions for this role relate to the Kit's prompt. */
  readonly instructionsNote: string;
  readonly describe: (issue: number, output: T) => string;
  /** The heading over the issue in the prompt. */
  readonly issueHeading?: string;
  /**
   * A Design session weighs the issue's parent Spec, from FABRIK_SPEC_FILE, if
   * it has one, and the agent PR it came back from, if it did, and is told
   * whether it may offer a Map, from FABRIK_MAP_FILE, and whether it may offer
   * a Prototype, from the Kit config.
   */
  readonly readsParentSpec?: boolean;
  /** The Implementer builds on a branch, which it passes out as a bundle. */
  readonly buildsBranch?: boolean;
  /** The Reviewer judges a PR, checked out at its head; its result is for the PR, not the Ticket. */
  readonly reviewsPullRequest?: boolean;
  /**
   * A replay arm's run (#156), in a checkout of the Ticket's baseSha
   * (FABRIK_BASE_SHA) that nothing is pushed from (src/agent/replay.ts). Its
   * `implement` run builds as a first Implement run would and passes its
   * commits out as a patch from baseSha, never a bundle; its `review` judges
   * that change, a commit on baseSha, with the Ticket and its Spec in place of
   * a PR, and its result is for the Ticket.
   */
  readonly replay?: ReplayRole;
  /**
   * Triage compares its issue against the recent issues in
   * FABRIK_RECENT_ISSUES_FILE, for a duplicate (src/agent/triage.ts).
   */
  readonly comparesIssues?: boolean;
  /**
   * The Auditor reads the Product repo up to its pending Audit's marked
   * commit, with the inputs in FABRIK_AUDIT_FILE; its result names the
   * hot-spot window it was given.
   */
  readonly audits?: boolean;
  /**
   * The Retro reads the evidence bundle in FABRIK_RETRO_EVIDENCE_FILE and the
   * Kit's role prompts and rubrics, in a checkout of the default branch.
   */
  readonly retros?: boolean;
  /**
   * The Researcher reads the research Decision's Map from FABRIK_SPEC_FILE and
   * writes its findings to the one file the Kit names from the Decision, which
   * the runner commits to the Decision's throwaway branch and passes out as a bundle.
   */
  readonly researches?: boolean;
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
    output: { read: readTriageOutput },
    comparesIssues: true,
    instructionsNote:
      "The Operator wrote these for this repo. They refine the rules above but never loosen the six Fast-path tests.",
    describe: (issue, output) => `Triage sorted #${issue}: ${output.category}, ${output.state}`,
  } satisfies RoleSpec<TriageOutput>,
  design: {
    role: "design",
    output: { read: readDesignTurnOutput },
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
        case "map":
          return `The Design session on #${issue} charted it as a Map with ${output.decisions.length} Decision(s)`;
        case "prototype":
          return `The Design-session turn on #${issue} asked for a Prototype of ${output.route} in ${output.variants} variants`;
        case "prototype-round":
          return `The prototype turn on #${issue} built ${output.variants.length} variants`;
      }
    },
    readsParentSpec: true,
  } satisfies RoleSpec<DesignTurnOutput>,
  prototype: {
    role: "design",
    prompt: "prototype",
    // A prototype turn ends only in a prototype-round, so Sandcastle asks the agent to fix any other kind.
    output: { read: readPrototypeTurnOutput },
    instructionsNote:
      "The Operator wrote these for this repo's Design sessions. They refine how you build the variants here but never change the rules or the output contract above.",
    describe: (issue, output) => `The prototype turn on #${issue} built ${output.variants.length} variants`,
  } satisfies RoleSpec<PrototypeRoundOutput>,
  implement: {
    role: "implement",
    output: { read: readImplementOutput },
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
  audit: {
    role: "audit",
    output: { read: readAuditOutput },
    instructionsNote:
      "The Operator wrote these for this repo. They refine where you look and what you weigh here but never let you change anything, and never change the output contract above.",
    describe: (issue, output) => `The Auditor on #${issue} proposed ${output.candidates.length} candidate(s)`,
    issueHeading: AUDIT_ISSUE_HEADING,
    audits: true,
  } satisfies RoleSpec<AuditOutput>,
  retro: {
    role: "retro",
    output: { read: readRetroOutput },
    instructionsNote:
      "The Operator wrote these for this repo. They say where to look and what to weigh here but never lift a rule above, never let you change anything, and never change the output contract above.",
    describe: (issue, output) => `The Retro on #${issue} proposed ${output.proposals.length} change(s)`,
    issueHeading: RETRO_ISSUE_HEADING,
    retros: true,
  } satisfies RoleSpec<RetroOutput>,
  research: {
    role: "research",
    output: { read: readResearchOutput },
    instructionsNote:
      "The Operator wrote these for this repo. They say where to look and what to weigh here but never let you decide, never let you write any file but the findings file, and never change the output contract above.",
    describe: (issue, output) => `The Researcher on #${issue} found ${output.keyFacts.length} key fact(s)`,
    issueHeading: RESEARCH_ISSUE_HEADING,
    researches: true,
  } satisfies RoleSpec<ResearchOutput>,
};

/**
 * A replay arm's runs (#156): the Implementer and the Reviewer on their own
 * prompts and output contracts, on the arm's model and effort.
 */
const REPLAY_SPECS = {
  implement: {
    ...ROLE_SPECS.implement,
    describe: (ticket, output) => `The Implementer on the replay of #${ticket} finished: ${output.title}`,
    replay: "implement",
  } satisfies RoleSpec<ImplementOutput>,
  review: {
    ...ROLE_SPECS.review,
    describe: (ticket, output) => `The Reviewer on the replay of #${ticket} gave the Verdict ${output.verdict}`,
    reviewsPullRequest: false,
    replay: "review",
  } satisfies RoleSpec<ParsedVerdict & { ok: true }>,
};

/** The model and effort to run: what the Kit job's plan chose, else the role's own. */
function modelFor(role: { model: string; effort: string | null }): { model: string; effort: string | null } {
  const model = process.env["FABRIK_MODEL"];
  if (model === undefined || model === "") return role;
  // Kit config already refuses Fable; this keeps a bad route from ever reaching the CLI.
  if (/fable/i.test(model) || model.trim().toLowerCase() === "best") throw new Error(`Refusing to run ${model} in an AFK role`);
  const effort = process.env["FABRIK_EFFORT"];
  return { model, effort: effort === undefined || effort === "" ? null : effort };
}

async function runRole<T>(spec: RoleSpec<T>): Promise<void> {
  const name = spec.role;
  const prompt = spec.prompt ?? name;
  const productDir = process.cwd();
  const outDir = resolve(required("FABRIK_OUT_DIR"));
  await mkdir(outDir, { recursive: true });
  const issueText = await readFile(required("FABRIK_ISSUE_FILE"), "utf8");
  const issueNumber = (JSON.parse(issueText) as { number?: unknown }).number;
  if (typeof issueNumber !== "number") throw new Error("FABRIK_ISSUE_FILE has no issue number");

  const config = await loadConfig(productDir);
  const prototypeTurn = spec.prompt === "prototype";
  const own = prototypeTurn ? prototypeRole(config.roles) : config.roles[name];
  const role = { ...own, ...modelFor(own) };
  // For the run's record (src/kit/runRecord.ts): the model and effort passed to the CLI.
  await writeOutputs({ model: role.model, effort: role.effort ?? "" });

  // The Implementer builds on its own branch from main, with its test secrets; the Researcher's findings go on the Decision's throwaway branch.
  let branch: BuiltBranch | null = null;
  // A Researcher's or any other role's run reads as a first run: its own spec's schema.
  let kind: ImplementRunKind = "first";
  // The Operator comments a run on an agent PR is given, recorded before the agent runs.
  let given: GivenOperatorComment[] | null = null;
  // The main head a Request-changes run was told to merge in (#341), recorded before the agent runs.
  let mergeMain: string | null = null;
  const extra: string[] = [];
  if (spec.buildsBranch === true) {
    setImplementerEnv(config);
    // A retry carries on its PR's branch with the findings to fix, and a
    // Request-changes run works to the Operator's review instead; a first run
    // cuts the branch from main, and a replay arm's from the Ticket's baseSha.
    const pullRequestFile = process.env["FABRIK_PULL_REQUEST_FILE"] ?? "";
    const reviewFile = process.env["FABRIK_REVIEW_FILE"] ?? "";
    const specFile = required("FABRIK_SPEC_FILE");
    if (spec.replay === "implement" && (pullRequestFile !== "" || reviewFile !== "")) {
      throw new Error("A replay arm's Implement run is a first run, so it takes no PR and no review");
    }
    const input =
      spec.replay === "implement"
        ? await replayImplementInput(productDir, issueNumber, config, specFile, required(BASE_SHA_ENV))
        : await implementInput(productDir, issueNumber, config, {
            spec: specFile,
            pullRequest: pullRequestFile,
            review: reviewFile,
            // A conflict-only run (#304) rebases its PR's branch onto this main head, from the Kit job's plan.
            conflict: process.env["FABRIK_CONFLICT_MAIN"] ?? "",
            // The branch a Request-changes run on a conflicting PR merges in (#341).
            defaultBranch: process.env["FABRIK_DEFAULT_BRANCH"] ?? "",
          });
    branch = input.branch;
    extra.push(...input.parts);
    kind = input.kind;
    given = input.operatorComments;
    mergeMain = "mergeMain" in input ? input.mergeMain : null;
  }
  if (prototypeTurn) {
    // The Claude token and the Sandbox's values and test secrets, as the Implementer's, committing as the Fabrik Prototype.
    setSandboxEnv(config, PROTOTYPE_AUTHOR);
    extra.push(...prototypeTurnContext(config, issueNumber, required(PROTOTYPE_REQUEST_ENV)).parts);
    branch = await startPrototypeBranch(productDir, issueNumber);
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
  const { issue, parts: sentBack, operatorComments: sentBackComments } = sentBackContext(JSON.parse(issueText));
  if (spec.readsParentSpec === true) {
    extra.push(...sentBack);
    // A Design turn on an issue that was never sent back is given none, and its result says nothing of them.
    if (sentBackComments.length > 0) given = sentBackComments;
    extra.push(...mapCapContext(JSON.parse(await readFile(required("FABRIK_MAP_FILE"), "utf8"))));
    extra.push(...prototypeContext(config, issueNumber));
  }
  if (spec.comparesIssues === true) extra.push(...(await triageContext(required("FABRIK_RECENT_ISSUES_FILE"))));
  // The hot-spot window an Auditor run was given, which its result passes out for the Audit to name.
  let window: AuditWindow | null = null;
  if (spec.audits === true) {
    const audit = await auditContext(required("FABRIK_AUDIT_FILE"));
    window = audit.window;
    extra.push(...audit.parts);
  }
  if (spec.retros === true) extra.push(...(await retroContext(required("FABRIK_RETRO_EVIDENCE_FILE"), KIT_DIR)));
  if (spec.researches === true) {
    const research = await researchContext(required("FABRIK_SPEC_FILE"), issue);
    extra.push(...research.parts);
    // The Decision's throwaway branch, from the default branch, which the runner commits the findings to once the run ends.
    branch = await cutBranch(productDir, research.branch);
  }
  // The Reviewer's result is for the PR it judged, which its push job checks against the event.
  let subject = issueNumber;
  if (spec.reviewsPullRequest === true) {
    // Set only for a UI PR: where its Review job downloaded the UI evidence, whether or not that worked,
    // and why its capture failed, as the PR's marker records it.
    const evidenceDir = process.env["FABRIK_UI_EVIDENCE_DIR"] ?? "";
    const review = await reviewContext(
      productDir,
      required("FABRIK_PULL_REQUEST_FILE"),
      required("FABRIK_SPEC_FILE"),
      evidenceDir === "" ? null : evidenceDir,
      captureFailureOf(process.env["FABRIK_UI_EVIDENCE_FAILURE"]),
    );
    subject = review.pullRequest;
    extra.push(...review.parts);
    given = review.operatorComments;
  }
  // A replay arm's Reviewer judges the arm's change from baseSha with no PR, so its result is for the Ticket, and names no Operator comments.
  if (spec.replay === "review") {
    extra.push(...(await replayReviewContext(productDir, required("FABRIK_SPEC_FILE"), required(BASE_SHA_ENV))));
  }
  const runsProductCode =
    spec.reviewsPullRequest !== true && spec.replay !== "review" && spec.audits !== true && spec.retros !== true && spec.researches !== true;
  // A run on an existing PR owes a fix as well, and a Request-changes run its two answers, which its push job checks too.
  const contract: OutputContract<T> =
    kind === "first" ? spec.output : ({ read: IMPLEMENT_OUTPUT_READERS[kind] } as unknown as OutputContract<T>);
  const output =
    "read" in contract
      ? Output.object({ tag: prompt, schema: replySchemaOf(contract.read), maxRetries: 1 })
      : Output.string({ tag: prompt });

  // The agent inherits this process's env (noSandbox), so set what it needs here.
  setAgentEnv(claudeArgs(role.model, role.effort));

  const abort = new AbortController();
  // With rotation on, a run that shows overage is stopped, so no Subscription spends usage credits.
  const watch = streamWatch(join(outDir, TRANSCRIPT_FILE), abort, { rotation: rotationIsOn(config) });
  const timeoutMs = role.timeoutMinutes * 60_000;

  try {
    const result = await run({
      name: `${prompt}-${subject}`,
      agent: claudeCode(
        role.model,
        role.effort === null ? {} : { effort: role.effort as "low" | "medium" | "high" | "xhigh" | "max" },
      ),
      sandbox: noSandbox(),
      cwd: productDir,
      prompt: promptFor({
        template: await readFile(join(KIT_DIR, kitPromptPath(prompt)), "utf8"),
        role: name,
        note: spec.instructionsNote,
        config,
        issue,
        heading: spec.issueHeading ?? "The issue",
        extra,
      }),
      maxIterations: 1,
      output,
      // The Reviewer, the Auditor, the Retro and the Researcher read the code and run none of it, so they need no Sandbox setup.
      hooks: {
        sandbox: {
          onSandboxReady: [{ command: readyHook(runsProductCode ? config.sandbox.setup : null), timeoutMs }],
        },
      },
      signal: abort.signal,
      logging: { type: "file", path: join(outDir, "agent.log"), onAgentStreamEvent: watch.onAgentStreamEvent },
    });
    watch.checkInit();

    // Text output is checked here, so a reply that breaks its contract fails this job, never passes.
    // Either output kind puts what the tag held on the result; a JSON reply is saved as the agent wrote it.
    const { output: checked, saved } = settleReply(contract, (result as { output?: unknown }).output);
    // The Researcher commits nothing itself: the Kit commits what it left, as the Fabrik Researcher.
    if (spec.researches === true) await commitResearch(productDir, issueNumber);
    // A replay arm's commits go out as a patch from baseSha, which nothing pushes; every other run's as a bundle.
    const built =
      branch === null
        ? null
        : spec.replay === "implement"
          ? await writeReplayPatch(productDir, branch, outDir)
          : await bundleAgentBranch(productDir, branch, outDir);
    const artifact: AgentRunResult = {
      role: name,
      issue: subject,
      output: saved,
      ...(built === null ? {} : { branch: built }),
      ...(given === null ? {} : { operatorComments: given }),
      ...(window === null ? {} : { window }),
      ...(mergeMain === null ? {} : { mergeMain }),
    };
    await writeFile(join(outDir, AGENT_RESULT_FILE), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(spec.describe(subject, checked));
  } catch (error) {
    // Left for the push job, which posts the failure notice (loop.yml).
    await leaveFailureReport(error, watch, { path: join(outDir, AGENT_FAILURE_FILE), title: "Infrastructure failure" });
    throw error;
  } finally {
    // The install record src/skills/fetch.ts wrote last, naming each source and the skills from it.
    const installed = await readInstallRecord(productDir);
    if (installed === undefined) {
      console.log("::warning title=Skills not installed::No install record was found in .claude/skills");
    } else {
      const missing = missingSkills(watch.lines, installed);
      if (missing.length > 0) {
        console.log(`::warning title=Installed skills missing at init::${missing.join(", ")}`);
      }
    }
    await writeSummary(runSummary({ role: name, effort: role.effort, lines: watch.lines, ...(installed === undefined ? {} : { installed }) }));
  }
}

const roles: Record<string, () => Promise<void>> = {
  triage: () => runRole(ROLE_SPECS.triage),
  design: () => runRole(ROLE_SPECS.design),
  prototype: () => runRole(ROLE_SPECS.prototype),
  implement: () => runRole(ROLE_SPECS.implement),
  review: () => runRole(ROLE_SPECS.review),
  audit: () => runRole(ROLE_SPECS.audit),
  retro: () => runRole(ROLE_SPECS.retro),
  research: () => runRole(ROLE_SPECS.research),
  "replay-implement": () => runRole(REPLAY_SPECS.implement),
  "replay-review": () => runRole(REPLAY_SPECS.review),
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
