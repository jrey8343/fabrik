// A Digest run's way through the Kit's jobs (ADR-0022): what the Kit job
// passes out for it, what the push job applies after it, the event that
// stands for it, and what a failed landing says.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aPullRequest, HEAD_SHA, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import type { AgentRunResult } from "../agent/result.ts";
import { agentFailureEventFrom, agentRunEventFrom, digestEventFrom } from "../github/events.ts";
import { DIGEST_JOB_NAME, isAgentJobNamed } from "../github/snapshot.ts";
import { planFor } from "../loop/rules.ts";
import { DIGEST_FOLDS_MARKER, type DigestGiven, digestCommentOf, noDigestLine } from "../loop/digestContract.ts";
import type { Plan } from "../loop/types.ts";
import { kitJobOutputs } from "./jobs.ts";
import { kitSaidOf } from "./kitSaid.ts";
import { pushLanding } from "./landingFailure.ts";
import { type Needs, pushJobInput } from "./pushJob.ts";
import { agentRunEnded } from "./runRecord.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

/** The plan `agent:digest` on #50, passed at its head, comes to: a Digest run. */
function digestPlan(): Plan {
  const passed = aPullRequest({ draft: false, labels: ["agent:digest"], verdicts: [{ verdict: "pass", source: "reviewer", requestChanges: false, headSha: HEAD_SHA }] });
  return planFor({ kind: "pull-request-labeled", pullRequest: 50, label: "agent:digest" }, snapshotOfPullRequest(passed), kitConfig());
}

/** The push job's `needs` after a Digest run on #50, Ticket #7, with the Digest job as given. */
function needs(digest: Needs[string] | undefined, kitOutputs: Record<string, string> = {}): Needs {
  const kit = { result: "success", outputs: { route: "digest", ticket: "7", "pull-request": "50", "head-sha": HEAD_SHA, review: "", ...kitOutputs } };
  return digest === undefined ? { kit } : { kit, digest };
}

const ok = { result: "success", outputs: { "secrets-step": "success" } };

describe("The Kit job's routing of a Digest run", () => {
  it("routes agent:digest on a passed pull request to the Digest job, at the head the pass was given on, within roles.digest's time limit", () => {
    const outputs = kitJobOutputs(digestPlan(), 7, kitConfig());

    expect(outputs).toMatchObject({
      route: "digest",
      "pull-request": "50",
      ticket: "7",
      "head-sha": HEAD_SHA,
      "digest-timeout-minutes": "10",
      model: "claude-opus-5-5",
      subscription: "Claude token",
    });
  });

  it("passes out roles.digest's time limit whatever it routes to, as it does every role's, and no head for any other run", () => {
    const config = kitConfig();
    const own = { ...config, roles: { ...config.roles, digest: { ...config.roles.digest, timeoutMinutes: 4 } } };

    expect(kitJobOutputs(null, null, own)).toMatchObject({ route: "none", "digest-timeout-minutes": "4", "head-sha": "" });
  });

  it("says a Digest run's Ticket and the agent pull request it is on, as it says a Review's", () => {
    expect(kitSaidOf(digestPlan(), 7)).toEqual({
      fabrik: 1,
      route: "digest",
      run: { role: "digest", issue: 7, pullRequest: 50, kind: null, retry: 0, model: "claude-opus-5-5" },
      held: [],
      replay: null,
    });
  });
});

describe("The Digest job's name", () => {
  it.each(["Digest PR #50", "loop / Digest PR #50"])("%s is a Digest job's, as a caller workflow shows it or not", (name) => {
    expect(isAgentJobNamed("digest", name)).toBe(true);
  });

  it.each(["Digest", "Digest PR #", "Review PR #50", "Digest PR #50 again"])("%s is not", (name) => {
    expect(isAgentJobNamed("digest", name)).toBe(false);
  });
});

describe("What the push job applies after a Digest run", () => {
  it("applies the Digest writer's reply for the pull request and head the Kit job's plan named, once the Digest job succeeded", () => {
    expect(pushJobInput(needs(ok), null)).toEqual({ kind: "digest", pullRequest: 50, ticket: 7, headSha: HEAD_SHA });
  });

  it.each(["failure", "cancelled"])("gives the run's failure on its Ticket, naming the pull request and head, when the Digest job's result is %s", (result) => {
    expect(pushJobInput(needs({ result, outputs: { "secrets-step": "success" } }, { subscription: "Second token" }), null)).toEqual({
      kind: "agent-failure",
      role: "digest",
      issue: 7,
      jobResult: result,
      secretsStep: "success",
      subscription: "Second token",
      digest: { pullRequest: 50, headSha: HEAD_SHA },
    });
  });

  it.each([
    ["no pull request", { "pull-request": "" }, "the Digest run names no PR"],
    ["no Ticket", { ticket: "" }, "the Digest run names no PR"],
    ["no head", { "head-sha": "main" }, "the Digest run names no head to write a Digest as of"],
  ])("applies nothing when the Kit job named %s", (_what, outputs, reason) => {
    expect(pushJobInput(needs(ok, outputs), null)).toEqual({ kind: "nothing", reason });
  });

  it("applies nothing for a digest route whose needs don't name the Digest job, rather than guess at a result", () => {
    expect(pushJobInput(needs(undefined), null)).toEqual({ kind: "nothing", reason: "the digest job ended unknown" });
  });

  it("has a Run record to write for a Digest run that ended, on its Ticket and pull request, and for one that failed", () => {
    expect(agentRunEnded(needs(ok), null)).toBe(true);
    expect(agentRunEnded(needs({ result: "failure", outputs: {} }), null)).toBe(true);
  });
});

describe("The Loop event a Digest run's push job applies", () => {
  const given: DigestGiven = { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN };
  const result: AgentRunResult = { role: "digest", issue: 50, output: '{"whatItDoes":"…"}' };

  it("is the Digest writer's reply for the pull request and head the Kit job named, with what Kit code hands the contract", () => {
    expect(digestEventFrom(result, { pullRequest: 50, headSha: HEAD_SHA }, given, RUN)).toEqual({
      kind: "digest-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output: '{"whatItDoes":"…"}',
      given,
      runUrl: RUN,
    });
  });

  it("refuses a result for another pull request, or another role's", () => {
    expect(() => digestEventFrom({ ...result, issue: 51 }, { pullRequest: 50, headSha: HEAD_SHA }, given, RUN)).toThrow("The Digest writer's result is for #51, not #50");
    expect(() => digestEventFrom({ ...result, role: "review" }, { pullRequest: 50, headSha: HEAD_SHA }, given, RUN)).toThrow("A Digest's push job was handed a review result");
  });

  it("is never applied as another role's result", () => {
    expect(() => agentRunEventFrom(result)).toThrow("A Digest writer's result is applied through digestEventFrom");
  });

  it("a failed run's event names its pull request and head", () => {
    const event = agentFailureEventFrom({ role: "digest", issue: 7, runUrl: RUN, jobResult: "cancelled", secretsStep: "success", report: null, digest: { pullRequest: 50, headSha: HEAD_SHA } });

    expect(event).toMatchObject({ kind: "agent-run-failed", role: "digest", issue: 7, jobResult: "cancelled", digest: { pullRequest: 50, headSha: HEAD_SHA } });
  });
});

describe("What a Digest run's push job says it is landing", () => {
  it("is the Digest of the pull request, on the pull request, with the writer's work waiting in the run's artifact", () => {
    expect(pushLanding({ kind: "digest", pullRequest: 50, ticket: 7, headSha: HEAD_SHA }, RUN)).toEqual({
      job: "push",
      runUrl: RUN,
      doing: "the Digest of #50",
      target: 50,
      agentWork: true,
      role: "digest",
    });
  });

  it("is the no-Digest line of a failed run, on the pull request too, never on its Ticket", () => {
    const landing = pushLanding(
      { kind: "agent-failure", role: "digest", issue: 7, jobResult: "failure", secretsStep: "success", digest: { pullRequest: 50, headSha: HEAD_SHA } },
      RUN,
    );

    expect(landing).toEqual({ job: "push", runUrl: RUN, doing: "the no-Digest line of the Digest run on #50", target: 50, agentWork: false, role: "digest" });
  });
});

describe("The README's Digest section", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  const section = readme.split("\n## Digest\n")[1]?.split("\n## ")[0] ?? "";

  it("comes straight after Review's", () => {
    expect(headings[headings.indexOf("Review") + 1]).toBe("Digest");
  });

  it("says what the label is honoured on, what the writer is, and the first line of the comment and of the no-Digest line, as the contract writes them", () => {
    const digest = digestCommentOf({ whatItDoes: "w", howItGotHere: "h", walkthrough: "t", decided: "d" }, { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: HEAD_SHA, runUrl: RUN });
    const firstLine = (body: string) => (body.split("\n")[0] ?? "").replace(/"[0-9a-f]{40}"/, "…").replace(/"how":"[a-z-]+"/, '"how":…');

    expect(section).toContain("- **The label**: adding `agent:digest` to an agent pull request");
    expect(section).toContain("whose latest Verdict is a pass on its current head");
    expect(section).toContain(`\`${DIGEST_JOB_NAME} PR #<agent PR>\``);
    expect(section).toContain("`roles.digest`");
    expect(section).toContain("`.fabrik/digest.md`");
    expect(section).toContain(`\`${firstLine(digest.ok ? digest.body : "")}\``);
    expect(section).toContain(`\`${DIGEST_FOLDS_MARKER}\``);
    expect(section).toContain(`\`${firstLine(noDigestLine({ head: HEAD_SHA, how: "failed" }))}\``);
    expect(section).toContain('"No Digest could be written for this head"');
  });

  it("names every way an attempt that ran can end with no Digest", () => {
    const noDigest = section.split("\n").find((line) => line.startsWith("- **No Digest**")) ?? "";

    for (const how of ["failed", "timed-out", "refused"]) expect(noDigest).toContain(`\`${how}\``);
    expect(noDigest).toContain("mentions nobody");
  });
});
