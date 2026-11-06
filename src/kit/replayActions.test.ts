// The Replay's composite actions (#156), which loop.yml's replay jobs run
// (src/kit/workflows.test.ts holds those jobs). Like the workflows tests, these
// hold the wiring to the files it names and to the credentials each job may
// hold (ADR-0002, ADR-0009), since nothing runs them before a release.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_FAILURE_FILE } from "../agent/failure.ts";
import { REPLAY_PATCH_FILE } from "../agent/replay.ts";
import { AGENT_RESULT_FILE } from "../agent/result.ts";
import { JUDGE_FAILURE_FILE, JUDGE_RESULT_FILE } from "./judge.ts";
import { REPLAY_GATES_FILE } from "./replayGates.ts";
import { ARM_JOB_FILE, replayArtifact, type ReplayArtifactKind } from "./replayRecord.ts";

const root = new URL("../../", import.meta.url);
const workflows = readdirSync(new URL(".github/workflows/", root)).map((name) => ({ name, text: readFileSync(new URL(`.github/workflows/${name}`, root), "utf8") }));

/** A composite action's text and its steps, each from its `- ` line to the next one's. */
function actionNamed(name: string): { readonly text: string; readonly steps: readonly string[] } {
  const text = readFileSync(new URL(`.github/actions/${name}/action.yml`, root), "utf8");
  return { text, steps: text.split(/\n(?=    - )/).slice(1) };
}

/** The step holding `pattern`, or "" when none does. */
function stepWith(steps: readonly string[], pattern: string): string {
  return steps.find((step) => step.includes(pattern)) ?? "";
}

/** Where in the steps the step holding `pattern` is, -1 for none. */
function at(steps: readonly string[], pattern: string): number {
  return steps.findIndex((step) => step.includes(pattern));
}

/** Each artifact name the action uploads, as its YAML spells it. */
function uploadsOf(steps: readonly string[]): string[] {
  return steps.filter((step) => step.includes("uses: actions/upload-artifact@")).map((step) => /\n\s+name: (.+)\n/.exec(step)?.[1] ?? "");
}

/** An artifact's name as an arm's action spells it, its arm the action's input. */
const named = (kind: ReplayArtifactKind) => replayArtifact(kind, "baseline").replace("baseline", "${{ inputs.arm }}");

const REPLAY_ACTIONS = ["replay-implement", "replay-gates", "replay-review", "replay-score", "replay-record"];
const ARM_ACTIONS = ["replay-implement", "replay-gates", "replay-review", "replay-score"];

/** Every write credential, or way to one, an agent job must never hold (ADR-0002). */
const WRITE_CREDENTIALS = /create-github-app-token|OP_PUSH_TOKEN|op-push-token|id-token|store-token|run-loop/;

describe("The Replay's composite actions", () => {
  it.each(REPLAY_ACTIONS)("%s ships, and only loop.yml's job of the same name runs it", (name) => {
    expect(existsSync(new URL(`.github/actions/${name}/action.yml`, root))).toBe(true);
    const using = workflows.filter(({ text }) => text.includes(`./kit/.github/actions/${name}\n`));

    expect(using.map(({ name: file }) => file)).toEqual(["loop.yml"]);
    expect(using[0]!.text.split(`uses: ./kit/.github/actions/${name}\n`)).toHaveLength(2);
    expect(using[0]!.text).toMatch(new RegExp(`\\n  ${name}:\\n(?: {4}.*\\n|\\n)*? {8}uses: \\./kit/\\.github/actions/${name}\\n`));
  });

  it.each(ARM_ACTIONS)("%s leaves its artifacts under names that carry its arm, so the arms' matrix legs never collide, and never the push job's", (name) => {
    const uploads = uploadsOf(actionNamed(name).steps);

    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(upload).toMatch(/-replay-\$\{\{ inputs\.arm \}\}$/);
      expect(upload).not.toMatch(/^fabrik-agent-/);
    }
  });

  it.each(ARM_ACTIONS)("%s takes its arm as an input, baseline or variant", (name) => {
    expect(actionNamed(name).text).toMatch(/\n  arm:\n\s+description: .*baseline.*variant.*\n\s+required: true\n/);
  });

  it.each(["replay-implement", "replay-review"])(
    "%s fetches the Ticket's baseSha alone, one commit and no branch or tag, so its agent can never reach the merged result in the checkout",
    (name) => {
      const { text, steps } = actionNamed(name);
      const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));

      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toContain("ref: ${{ inputs.base-sha }}\n");
      expect(checkouts[0]).toContain("fetch-depth: 1\n");
      expect(checkouts[0]).not.toContain("fetch-tags: true");
      // Nothing fetches more once it's checked out: no default branch, no PR head, no other ref.
      expect(text).not.toMatch(/git (?:-C \S+ )?(?:fetch|pull|remote)|fetch-depth: 0|origin\/|default_branch|refs\//);
    },
  );

  it.each(["replay-implement", "replay-review"])("%s always leaves its job's account of its run, whether the run passed, failed or was cancelled", (name) => {
    const { steps } = actionNamed(name);
    const account = stepWith(steps, "replay-arm-main.ts");

    expect(account).toContain("if: always()");
    expect(account).toContain("FABRIK_AGENT_STEP: ${{ steps.agent.outcome }}");
    expect(account).toContain("FABRIK_JOB_STATUS: ${{ job.status }}");
    expect(at(steps, "replay-arm-main.ts")).toBeGreaterThan(at(steps, "id: agent\n"));
  });
});

describe("The replay implement action", () => {
  const { text, steps } = actionNamed("replay-implement");
  const agent = stepWith(steps, "id: agent\n");

  it("holds no write credential: only the implement service account, which loads the Claude token and the test secrets", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(text).not.toMatch(WRITE_CREDENTIALS);
    expect(text).not.toMatch(/OP_AGENT_TOKEN|op-agent-token/);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-implement-token }}");
    expect(secrets[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN: op://Fabrik/${{ inputs.subscription }}/credential");
    expect(secrets[0]).toContain("OP_ENV_FILE: ${{ runner.temp }}/fabrik-secrets.env");
  });

  it("checks out the Product repo at the Ticket's baseSha, so Kit config and Extra skills come from there, with no credential left behind", () => {
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).not.toContain("repository:");
    expect(checkouts[0]).toContain("path: product");
    expect(checkouts[0]).toContain("ref: ${{ inputs.base-sha }}");
    expect(checkouts[0]).toContain("persist-credentials: false");
  });

  it("prepares a first Implement run on the Ticket, laying a `kit` variant's candidate sha over the Kit before any secret loads", () => {
    const prepare = stepWith(steps, "uses: ./kit/.github/actions/prepare-agent");

    expect(prepare).toMatch(/\n\s+role: implement\n/);
    expect(prepare).toContain("issue: ${{ inputs.ticket }}");
    expect(prepare).toContain("kit-candidate: ${{ fromJSON(inputs.replay-arms)[inputs.arm].candidateSha }}");
    expect(prepare).not.toContain("pull-request");
    expect(at(steps, "uses: ./kit/.github/actions/prepare-agent")).toBeLessThan(at(steps, "1password/load-secrets-action@"));
  });

  it("runs the replay Implementer from the checkout, on the arm's model and effort, read only through env", () => {
    expect(agent).toMatch(/\n\s+working-directory: product\n/);
    expect(agent).toContain("run: node ../kit/src/agent/run.ts replay-implement");
    expect(agent).toContain("FABRIK_BASE_SHA: ${{ inputs.base-sha }}");
    expect(agent).toContain("FABRIK_MODEL: ${{ fromJSON(inputs.replay-arms)[inputs.arm].implement.model }}");
    expect(agent).toContain("FABRIK_EFFORT: ${{ fromJSON(inputs.replay-arms)[inputs.arm].implement.effort }}");
    expect(agent).toContain("FABRIK_SECRETS: ${{ toJSON(steps.op.outputs) }}");
    expect(agent).not.toMatch(/FABRIK_PULL_REQUEST_FILE|FABRIK_REVIEW_FILE/);
    expect(text.split("\n").filter((line) => line.includes("inputs.replay-arms") && /\brun: /.test(line))).toEqual([]);
  });

  it("passes out its result, patch, failure report and account in one artifact, and its transcript in another", () => {
    const result = stepWith(steps, `name: ${named("implement")}\n`);
    const transcript = stepWith(steps, `name: ${named("transcript-implement")}\n`);

    for (const file of [AGENT_RESULT_FILE, REPLAY_PATCH_FILE, AGENT_FAILURE_FILE, ARM_JOB_FILE]) expect(result).toContain(`/fabrik-out/${file}`);
    expect(result).toContain("if: always()");
    expect(transcript).toContain("if: always()");
    expect(transcript).toMatch(/path: .*transcript\.jsonl\.gz/);
  });
});

describe("The replay gates action", () => {
  const { text, steps } = actionNamed("replay-gates");
  const gates = stepWith(steps, "replay-gates-main.ts");

  it("holds no write credential and no Claude token: only the implement service account, for the test secrets alone", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(text).not.toMatch(WRITE_CREDENTIALS);
    expect(text).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|OP_AGENT_TOKEN|op-agent-token|prepare-agent/);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-implement-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)]).toEqual([]);
  });

  it("checks out the Ticket's baseSha with its history, which holds the merged PR's commit, and no credential left behind", () => {
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toContain("ref: ${{ inputs.base-sha }}");
    expect(checkouts[0]).toContain("fetch-depth: 0");
    expect(checkouts[0]).toContain("persist-credentials: false");
  });

  it("reads the merged PR's hidden tests with the read-only token, and lists the test secrets, before laying the arm's patch, and none of them reaches the gates", () => {
    const hidden = at(steps, "replay-hidden-tests-main.ts");
    const secrets = at(steps, "secrets-main.ts");
    const patch = at(steps, "replay-patch-main.ts");

    expect(steps[hidden]).toContain("GH_TOKEN: ${{ inputs.github-token }}");
    expect([...text.matchAll(/inputs\.github-token/g)]).toHaveLength(1);
    expect(hidden).toBeLessThan(patch);
    expect(secrets).toBeLessThan(patch);
    expect(patch).toBeLessThan(at(steps, "1password/load-secrets-action@"));
    expect(gates).not.toMatch(/GH_TOKEN|github-token/);
  });

  it("runs the gates from the checkout on the laid patch, with only the test secrets, and passes them out", () => {
    const upload = stepWith(steps, `name: ${named("gates")}\n`);

    expect(gates).toContain("run: node kit/src/kit/replay-gates-main.ts product\n");
    expect(gates).toContain("FABRIK_LAID: ${{ steps.patch.outputs.laid }}");
    expect(gates).toContain("FABRIK_SECRETS: ${{ toJSON(steps.op.outputs) }}");
    expect(upload).toContain(`/${REPLAY_GATES_FILE}`);
  });

  it("loads the test secrets only when Kit config declares some", () => {
    expect(stepWith(steps, "1password/load-secrets-action@")).toContain("if: steps.patch.outputs.laid == 'true' && steps.secrets.outputs.count != '0'");
  });
});

describe("The replay review action", () => {
  const { text, steps } = actionNamed("replay-review");
  const agent = stepWith(steps, "id: agent\n");

  it("holds only the agent service account, which loads the Claude token, and no write credential", () => {
    const secrets = steps.filter((step) => step.includes("1password/load-secrets-action@"));

    expect(text).not.toMatch(WRITE_CREDENTIALS);
    expect(text).not.toMatch(/OP_IMPLEMENT_TOKEN|op-implement-token|FABRIK_SECRETS:/);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("OP_SERVICE_ACCOUNT_TOKEN: ${{ inputs.op-agent-token }}");
    expect([...secrets[0]!.matchAll(/: (op:\/\/\S.*)$/gm)].map((match) => match[1])).toEqual(["op://Fabrik/${{ inputs.subscription }}/credential"]);
  });

  it("lays the arm's patch on the Ticket's baseSha as a local commit before anything else reads the checkout, and runs nothing when it wasn't laid", () => {
    const patch = at(steps, "replay-patch-main.ts");

    expect(stepWith(steps, "uses: actions/checkout@")).toContain("ref: ${{ inputs.base-sha }}");
    expect(patch).toBeLessThan(at(steps, "uses: ./kit/.github/actions/prepare-agent"));
    for (const step of ["uses: ./kit/.github/actions/prepare-agent", "1password/load-secrets-action@", "id: agent\n"]) {
      expect(stepWith(steps, step)).toContain("if: steps.patch.outputs.laid == 'true'");
    }
  });

  it("prepares a Review of the Ticket with no PR, giving a `kit` variant its candidate's prompts too", () => {
    const prepare = stepWith(steps, "uses: ./kit/.github/actions/prepare-agent");

    expect(prepare).toMatch(/\n\s+role: review\n/);
    expect(prepare).toContain("issue: ${{ inputs.ticket }}");
    expect(prepare).toContain("kit-candidate: ${{ fromJSON(inputs.replay-arms)[inputs.arm].candidateSha }}");
    expect(prepare).not.toContain("pull-request");
  });

  it("runs the replay Reviewer on the arm's model and effort, read only through env, with no PR file", () => {
    expect(agent).toContain("run: node ../kit/src/agent/run.ts replay-review");
    expect(agent).toContain("FABRIK_BASE_SHA: ${{ inputs.base-sha }}");
    expect(agent).toContain("FABRIK_MODEL: ${{ fromJSON(inputs.replay-arms)[inputs.arm].review.model }}");
    expect(agent).toContain("FABRIK_EFFORT: ${{ fromJSON(inputs.replay-arms)[inputs.arm].review.effort }}");
    expect(agent).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ steps.op.outputs.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(agent).not.toContain("FABRIK_PULL_REQUEST_FILE");
  });

  it("says why it never started when the patch wasn't laid, in its account of the run", () => {
    expect(stepWith(steps, "replay-arm-main.ts")).toContain("FABRIK_NOT_RUN: ${{ steps.patch.outputs.why }}");
  });

  it("passes out its Verdict, failure report and account, and its transcript apart", () => {
    const result = stepWith(steps, `name: ${named("review")}\n`);

    for (const file of [AGENT_RESULT_FILE, AGENT_FAILURE_FILE, ARM_JOB_FILE]) expect(result).toContain(`/fabrik-out/${file}`);
    expect(stepWith(steps, `name: ${named("transcript-review")}\n`)).toMatch(/path: .*transcript\.jsonl\.gz/);
  });
});

describe("The replay score action", () => {
  const { text, steps } = actionNamed("replay-score");
  const judge = stepWith(steps, "uses: ./kit/.github/actions/run-judge");

  it("runs the scoring plan on the arm's Implement run before the judge, and the judge only on a run it picks", () => {
    expect(at(steps, "replay-plan-main.ts")).toBeLessThan(at(steps, "uses: ./kit/.github/actions/run-judge"));
    expect(stepWith(steps, "replay-plan-main.ts")).toContain("id: plan\n");
    expect(judge).toContain("if: steps.plan.outputs.score == 'true'");
  });

  it("runs the existing judge on the arm's Implement transcript, under artifact names carrying the arm", () => {
    expect(judge).toContain("artifact-suffix: -replay-${{ inputs.arm }}");
    expect(judge).toContain("id: judge\n");
  });

  // The judge reads the rubrics from its own Kit checkout, the pinned release's (#286).
  it("never lays a candidate Kit sha over the Kit, nor holds a write credential", () => {
    expect(text).not.toMatch(/kit-candidate|prepare-agent|overlay/);
    expect(text).not.toMatch(WRITE_CREDENTIALS);
  });

  it("leaves the judge's account of its run, why it never ran when the plan skipped it", () => {
    const account = stepWith(steps, "replay-arm-main.ts");

    expect(account).toContain("if: always()");
    expect(account).toContain("FABRIK_AGENT_STEP: ${{ steps.judge.outcome }}");
    expect(account).toContain("FABRIK_SECRETS_STEP: ${{ steps.judge.outputs.secrets-step }}");
    expect(account).toContain("FABRIK_NOT_RUN: ${{ steps.plan.outputs.score != 'true' && steps.plan.outputs.why || '' }}");
    expect(stepWith(steps, `name: ${named("score")}\n`)).toContain(`/${ARM_JOB_FILE}`);
  });
});

describe("The judge action, as the replay score action runs it", () => {
  const { text, steps } = actionNamed("run-judge");

  it("keeps its live artifact names by default, and adds the suffix it's given to each", () => {
    expect(text).toMatch(/\n  artifact-suffix:\n(?:.*\n)*?\s+default: ""\n/);
    expect(stepWith(steps, "actions/download-artifact@")).toContain("name: fabrik-transcript-implement${{ inputs.artifact-suffix }}\n");
    expect(uploadsOf(steps)).toEqual([
      "fabrik-judge-result${{ inputs.artifact-suffix }}",
      "fabrik-judge-failure${{ inputs.artifact-suffix }}",
      "fabrik-transcript-score${{ inputs.artifact-suffix }}",
    ]);
  });

  it("names, with the replay suffix, the artifacts the replay-record job reads", () => {
    for (const kind of ["transcript-implement", "judge-result", "judge-failure", "transcript-score"] as const) {
      expect(text).toContain(`${replayArtifact(kind, "baseline").replace("-replay-baseline", "")}\${{ inputs.artifact-suffix }}`);
    }
    expect(text).toContain(`/${JUDGE_RESULT_FILE}`);
    expect(text).toContain(`/${JUDGE_FAILURE_FILE}`);
  });
});

// ADR-0009's shape: Kit only, no agent, no Product code, the store token and the App token.
describe("The replay-record action, the replay's push job", () => {
  const { text, steps } = actionNamed("replay-record");
  const record = stepWith(steps, "replay-record-main.ts");
  const land = stepWith(steps, "uses: ./kit/.github/actions/run-loop");

  it("runs no agent and no Product code: no Product checkout, no Claude token, nothing installed", () => {
    const checkouts = steps.filter((step) => step.includes("uses: actions/checkout@"));

    for (const checkout of checkouts) expect(checkout).toContain("repository: jrey8343/fabrik-runs");
    expect(text).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|OP_AGENT_TOKEN|OP_IMPLEMENT_TOKEN|prepare-agent|npm ci|src\/agent\/run\.ts/);
  });

  it("mints the store's token through the store-token action, and writes with it", () => {
    expect(stepWith(steps, "uses: ./kit/.github/actions/store-token")).toContain("op-push-token: ${{ inputs.op-push-token }}");
    expect(record).toContain("FABRIK_STORE_TOKEN: ${{ steps.tokens.outputs.store-token }}");
    expect(text).not.toContain("create-github-app-token");
  });

  it("takes every arm's every artifact, each into a folder of its own, and goes on without the ones a run never left", () => {
    const download = stepWith(steps, "actions/download-artifact@");

    expect(download).toContain("pattern: fabrik-*-replay-*\n");
    expect(download).not.toContain("merge-multiple");
    expect(download).toContain("continue-on-error: true");
    expect(record).toContain("FABRIK_REPLAY_DIR: ${{ runner.temp }}/replay");
  });

  it("reads the store back, after writing to it, from a checkout of this repo's paths with no credential left behind", () => {
    const checkout = stepWith(steps, "uses: actions/checkout@");

    expect(at(steps, "uses: actions/checkout@")).toBeGreaterThan(at(steps, "replay-record-main.ts"));
    expect(checkout).toContain("token: ${{ steps.tokens.outputs.store-token }}");
    expect(checkout).toContain("if: steps.tokens.outputs.store-token != ''");
    expect(checkout).toMatch(/runs\/\$\{\{ github\.repository \}\}\n/);
    expect(checkout).toMatch(/scores\/\$\{\{ github\.repository \}\}\n/);
    expect(checkout).toMatch(/replays\/\$\{\{ github\.repository \}\}\n/);
    expect(checkout).toContain("persist-credentials: false");
  });

  it("lands the run on the replay issue through the Loop, as the Fabrik App, even when the store couldn't be written", () => {
    expect(record).toContain("continue-on-error: true");
    expect(land).toContain("if: always() && steps.record.outputs.ended != ''");
    expect(land).toContain("op-push-token: ${{ inputs.op-push-token }}");
    expect(land).toContain("replay-run-ended: ${{ steps.record.outputs.ended }}");
    expect(land).toContain("store-dir: ${{ steps.store.outcome == 'success' && format('{0}/store', github.workspace) || '' }}");
  });
});

describe("The run the Loop action, as the replay-record action runs it", () => {
  const { text, steps } = actionNamed("run-loop");
  const loop = stepWith(steps, "run: node src/main.ts");

  it("hands the Loop how the replay Ticket's run ended, and the store's checkout, only when it's given them", () => {
    expect(text).toMatch(/\n  replay-run-ended:\n(?:.*\n)*?\s+default: ""\n/);
    expect(text).toMatch(/\n  store-dir:\n(?:.*\n)*?\s+default: ""\n/);
    expect(loop).toContain("FABRIK_REPLAY_RUN_ENDED: ${{ inputs.replay-run-ended }}");
    expect(loop).toContain("FABRIK_STORE_DIR: ${{ inputs.store-dir }}");
  });
});
