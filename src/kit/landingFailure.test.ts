import { describe, expect, it } from "vitest";
import { PlanNotApplied, ReplayTicketTaken } from "../github/apply.ts";
import { GitHubError } from "../github/client.ts";
import { claimLanding, jobFailureReport, landingFailureReport, pushLanding } from "./landingFailure.ts";
import type { PushJobInput } from "./pushJob.ts";

const RUN = "https://github.com/acme/shop/actions/runs/9001/attempts/1";

const implementRetry: PushJobInput = {
  kind: "agent-result",
  role: "implement",
  issue: 12,
  pullRequest: 51,
  review: null,
  startedBy: null,
};
const triage: PushJobInput = { kind: "agent-result", role: "triage", issue: 7, pullRequest: null, review: null, startedBy: null };
const verdict: PushJobInput = { kind: "review", pullRequest: 51, ticket: 12, headSha: "a".repeat(40), failedChecks: [], skippedChecks: [], withResult: true };
const redChecks: PushJobInput = { ...verdict, failedChecks: ["test"], withResult: false };
const agentFailure: PushJobInput = { kind: "agent-failure", role: "implement", issue: 12, jobResult: "failure", secretsStep: "success" };

describe("What a push job or claim job is landing, and where its failure is said (#421)", () => {
  it.each([
    ["an Implement retry's result: on its PR", implementRetry, 51, "the Implement run on #12"],
    ["a Triage run's result: on its issue", triage, 7, "the Triage run on #7"],
    ["a Review's Verdict: on the PR", verdict, 51, "the Review of #51"],
    ["a Review's red checks: on the PR", redChecks, 51, "the red required checks on #51"],
    ["a failed agent job's notice: on its issue", agentFailure, 12, "the failure notice of the Implement run on #12"],
    ["a push to main's plan: nowhere", { kind: "actions-event" } as const, null, "the push to the default branch"],
  ])("%s", (_case, input, target, doing) => {
    expect(pushLanding(input, RUN)).toMatchObject({ job: "push", target, doing });
  });

  it("a conflict-only run's failure notice goes on its PR", () => {
    expect(pushLanding({ ...agentFailure, conflict: { pullRequest: 51, main: "b".repeat(40) } }, RUN)).toMatchObject({ target: 51 });
  });

  it("lands nothing when the Kit job didn't succeed", () => {
    expect(pushLanding({ kind: "nothing", reason: "the Kit job didn't succeed" }, RUN)).toBeNull();
  });

  it("a claim goes on the issue the run is for", () => {
    expect(claimLanding(12, RUN)).toMatchObject({ job: "claim", target: 12, doing: "the claim of #12, taking its trigger label off as its run starts" });
  });
});

describe("The report of a landing that failed (#421)", () => {
  it("names the job, the run, what it was landing and GitHub's own failure, and says re-running the failed jobs lands the agent's work before its artifact expires", () => {
    const error = new GitHubError("GitHub PATCH failed: 502", 502, { request: "PATCH /repos/acme/shop/pulls/51", body: "Bad Gateway" });

    const { summary, comment } = landingFailureReport(pushLanding(implementRetry, RUN)!, { kind: "error", error });

    expect(summary).toContain("The push job failed landing the Implement run on #12");
    expect(summary).toContain("GitHub failed `PATCH /repos/acme/shop/pulls/51` with a 502");
    expect(comment?.issue).toBe(51);
    expect(comment?.body).toContain(`[push job](${RUN})`);
    expect(comment?.body).toContain("`fabrik-agent-result` artifact");
    expect(comment?.body).toContain("7 days");
    expect(comment?.body).toContain("Re-run failed jobs");
  });

  it.each([
    [
      "a rate limit",
      new GitHubError("403", 403, { request: "POST /repos/acme/shop/issues/12/comments", body: JSON.stringify({ message: "You have exceeded a secondary rate limit." }) }),
      "GitHub rate-limited the Fabrik App on `POST /repos/acme/shop/issues/12/comments`",
    ],
    [
      "a missing permission",
      new GitHubError("403", 403, { request: "POST /repos/acme/shop/pulls", body: JSON.stringify({ message: "Resource not accessible by integration" }) }),
      "The Fabrik App lacks a permission `POST /repos/acme/shop/pulls` needs: Resource not accessible by integration",
    ],
    ["a call GitHub never answered", new GitHubError("x", 0, { request: "GET /repos/acme/shop", body: "fetch failed" }), "GitHub never answered `GET /repos/acme/shop`: fetch failed"],
    [
      "any other refusal",
      new GitHubError("x", 422, { request: "POST /repos/acme/shop/pulls", body: JSON.stringify({ message: "Validation Failed" }) }),
      "GitHub refused `POST /repos/acme/shop/pulls` with a 422: Validation Failed",
    ],
    [
      "a file the job reads that isn't there",
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT", path: "/tmp/agent/result.json" }),
      "`/tmp/agent/result.json` wasn't there to read",
    ],
    ["anything else, the Kit's own failure", new Error("The agent's result is for #13, not #12"), "The Kit failed: The agent's result is for #13, not #12"],
  ])("classifies %s", (_case, error, said) => {
    expect(landingFailureReport(pushLanding(triage, RUN)!, { kind: "error", error }).summary).toContain(said);
  });

  it("names the action that failed, the ones applied and the ones never applied", () => {
    const comment = { kind: "comment", issue: 51, body: "Verdict" } as const;
    const ready = { kind: "mark-ready-for-review", pullRequest: 51 } as const;
    const review = { kind: "request-review", pullRequest: 51, reviewer: "operator" } as const;
    const error = new PlanNotApplied(ready, [comment], [review], new GitHubError("x", 502, { request: "POST /graphql" }));

    const { summary } = landingFailureReport(pushLanding(verdict, RUN)!, { kind: "error", error });

    expect(summary).toContain("GitHub failed `POST /graphql` with a 502");
    expect(summary).toContain("It failed to:\n\n- take #51 out of draft");
    expect(summary).toContain("Already applied:\n\n- comment on #51");
    expect(summary).toContain("Never applied:\n\n- request operator's review on #51");
  });

  it("says why the Loop refused to land a fail plan", () => {
    const { summary, comment } = landingFailureReport(pushLanding(verdict, RUN)!, {
      kind: "fail",
      failure: "infrastructure",
      reason: "The Review of #51 gave no valid Verdict: no verdict line",
    });

    expect(summary).toContain("The Loop wouldn't land it (an Infrastructure failure): The Review of #51 gave no valid Verdict: no verdict line");
    expect(comment?.issue).toBe(51);
  });

  it("for a claim, says re-running the failed jobs retries it, with no agent's work to point at", () => {
    const { comment } = landingFailureReport(claimLanding(12, RUN), { kind: "error", error: new GitHubError("x", 503, { request: "DELETE /repos/acme/shop/issues/12/labels/agent%3Aimplement" }) });

    expect(comment?.issue).toBe(12);
    expect(comment?.body).toContain(`The [claim job](${RUN}) failed`);
    expect(comment?.body).toContain("Re-run failed jobs");
    expect(comment?.body).not.toContain("fabrik-agent-result");
  });

  it("@-mentions the Operator once the Kit config naming them has loaded, as any failed Kit run does", () => {
    const failure = { kind: "error", error: new Error("boom") } as const;

    expect(landingFailureReport(pushLanding(triage, RUN)!, failure, "octo").comment?.body).toMatch(/^@octo /);
    expect(landingFailureReport(pushLanding(triage, RUN)!, failure, null).comment?.body).not.toContain("@");
  });

  it("for a replay claim another run won first, says so in the summary and comments nothing, as nothing needs the Operator", () => {
    const mark = { kind: "mark-replay-started", issue: 140, ticket: 12 } as const;
    const error = new PlanNotApplied(mark, [], [], new ReplayTicketTaken(12, 140, 9001));

    const { summary, comment } = landingFailureReport(claimLanding(140, RUN), { kind: "error", error }, "octo");

    expect(summary).toContain("Another run claimed #12 on replay #140 first");
    expect(summary).not.toContain("Re-run");
    expect(comment).toBeNull();
  });

  it("posts no comment when the landing has no issue or PR", () => {
    expect(landingFailureReport(pushLanding({ kind: "actions-event" }, RUN)!, { kind: "error", error: new Error("boom") }).comment).toBeNull();
  });
});

describe("The report of a job that lands no run, such as the scheduled tick, failing (#438)", () => {
  it("names the action that failed, the ones applied before it and the ones never applied, in the summary and the ::error line", () => {
    const resumed = { kind: "add-labels", issue: 7, labels: ["needs-triage"] } as const;
    const review = { kind: "add-labels", issue: 12, labels: ["agent:review"] } as const;
    const close = { kind: "close", issue: 50, reason: "completed" } as const;
    const error = new PlanNotApplied(review, [resumed], [close], new GitHubError("Bad Gateway", 502, { request: "POST /repos/acme/shop/issues/12/labels" }));

    const { summary, annotation } = jobFailureReport(error);

    expect(summary).toContain("The Loop failed partway through its plan.");
    expect(summary).toContain("It failed to:\n\n- add labels on #12: agent:review");
    expect(summary).toContain("Already applied:\n\n- add labels on #7: needs-triage");
    expect(summary).toContain("Never applied:\n\n- close #50 as completed");
    expect(annotation).toBe(
      "It failed to add labels on #12: agent:review: GitHub failed `POST /repos/acme/shop/issues/12/labels` with a 502, its own failure rather than the Kit's: Bad Gateway",
    );
  });

  it("keeps its ::error line to one line when the error's message runs over several", () => {
    const { summary, annotation } = jobFailureReport(new Error("boom\nat line two"));

    expect(summary).toContain("boom\nat line two");
    expect(annotation).toBe("The Kit failed: boom");
  });

  it("says what failed when the job failed before applying any plan", () => {
    const { summary, annotation } = jobFailureReport(new Error("boom"));

    expect(summary).toBe("The Loop failed.\n\n**What failed:** The Kit failed: boom");
    expect(annotation).toBe("The Kit failed: boom");
  });
});
