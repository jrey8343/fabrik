import { describe, expect, it } from "vitest";
import { PlanNotApplied, ReplayTicketTaken } from "../github/apply.ts";
import { UnverifiedBundle } from "../github/branch.ts";
import { GitHubError } from "../github/client.ts";
import { implementRunFailedIn, researchRunFailedIn } from "../github/threads.ts";
import { aTicket, dispatchSnapshotOf, kitConfig } from "../__fixtures__/snapshots.ts";
import { planFor } from "../loop/rules.ts";
import { claimLanding, jobFailureReport, landingFailedOf, landingFailureMention, landingFailureReport, pushLanding } from "./landingFailure.ts";
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
const verdict: PushJobInput = { kind: "review", pullRequest: 51, ticket: 12, headSha: "a".repeat(40), failedChecks: [], ranNothing: [], withResult: true };
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

// A first run's landing that failed leaves the Ticket ready-for-agent with no PR, so unless its comment reads as the
// run's failure, the next tick's Dispatch releases it again, and the same landing fails every hour (#535).
describe("A failed landing read as its run's failure (#535)", () => {
  const firstRun: PushJobInput = { kind: "agent-result", role: "implement", issue: 12, pullRequest: null, review: null, startedBy: null };
  const research: PushJobInput = { kind: "agent-result", role: "research", issue: 14, pullRequest: null, review: null, startedBy: null };
  const failed = { kind: "error", error: new Error("Command failed: git bundle verify") } as const;
  const byApp = (body: string) => [{ body, byApp: true }];

  it("holds a Ticket whose first Implement run's landing failed back from the next tick's Dispatch, saying why", () => {
    const { comment } = landingFailureReport(pushLanding(firstRun, RUN)!, failed, "operator");
    const lastRunFailed = implementRunFailedIn(byApp(comment!.body));

    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 12, lastRunFailed })]), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "No Ticket can be dispatched: #12's last Implement run failed, so only adding agent:implement again runs it",
    });
  });

  it("holds a research Decision whose Research run's landing failed back the same way", () => {
    const { comment } = landingFailureReport(pushLanding(research, RUN)!, failed, "operator");

    expect(researchRunFailedIn(byApp(comment!.body))).toBe(true);
  });

  it("holds a Ticket whose failed run's notice couldn't be landed back too", () => {
    const { comment } = landingFailureReport(pushLanding(agentFailure, RUN)!, failed, "operator");

    expect(implementRunFailedIn(byApp(comment!.body))).toBe(true);
  });

  it("doesn't offer re-running the job for a bundle that doesn't verify, which only fails again, and says how to run the work again", () => {
    const error = new UnverifiedBundle("The bundle of fabrik/ticket-12 doesn't verify: error: Repository lacks these prerequisite commits:");

    const { summary, comment } = landingFailureReport(pushLanding(firstRun, RUN)!, { kind: "error", error }, "operator");

    expect(summary).toContain("Repository lacks these prerequisite commits");
    expect(comment!.body).not.toContain("Re-run failed jobs");
    expect(comment!.body).toContain("downloads the same bundle");
    expect(comment!.body).toContain("Re-add `agent:implement` on #12 to run it again.");
  });

  it("marks a conflict-only run's failure notice that couldn't be landed on its PR, as the notice itself is marked there (#424)", () => {
    const conflicted: PushJobInput = { ...agentFailure, conflict: { pullRequest: 51, main: "b".repeat(40) } };
    const { comment } = landingFailureReport(pushLanding(conflicted, RUN)!, failed, "operator");

    expect(comment!.issue).toBe(51);
    expect(implementRunFailedIn(byApp(comment!.body))).toBe(true);
  });

  it("reads no other run's failed landing as a failed Implement or Research run", () => {
    for (const input of [implementRetry, triage, verdict]) {
      const { comment } = landingFailureReport(pushLanding(input, RUN)!, failed, "operator");
      expect(implementRunFailedIn(byApp(comment!.body))).toBe(false);
      expect(researchRunFailedIn(byApp(comment!.body))).toBe(false);
    }
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

// #487: the Run record says how the push job's landing failed, sorted as the failure comment sorts it.
describe("A failed landing as its Run record keeps it", () => {
  const ready = { kind: "mark-ready-for-review", pullRequest: 36 } as const;
  const comment = { kind: "comment", issue: 36, body: "Verdict" } as const;

  it("keeps a plan GitHub failed partway through with a 5xx as GitHub's own failure: the action, the request, its status and request id", () => {
    const cause = new GitHubError("x", 502, { request: "PATCH /repos/o/r/pulls/36", body: "Bad Gateway", requestId: "C0DE:36" });
    const error = new PlanNotApplied(ready, [comment], [], cause);

    expect(landingFailedOf({ kind: "error", error })).toEqual({
      loopOutcome: "failure",
      action: { kind: "mark-ready-for-review", description: "take #36 out of draft" },
      request: "PATCH /repos/o/r/pulls/36",
      status: 502,
      requestId: "C0DE:36",
      class: "github",
      refusal: null,
      reason: null,
    });
  });

  it.each([
    [
      "a missing permission as refused",
      new GitHubError("403", 403, { request: "POST /repos/o/r/pulls", body: JSON.stringify({ message: "Resource not accessible by integration" }) }),
      { class: "refused", refusal: "missing-permission", status: 403, request: "POST /repos/o/r/pulls" },
    ],
    ["a rate limit as refused", new GitHubError("429", 429, { request: "GET /repos/o/r" }), { class: "refused", refusal: "rate-limited", status: 429 }],
    ["a call GitHub never answered as GitHub's", new GitHubError("x", 0, { request: "GET /repos/o/r", body: "fetch failed" }), { class: "github", status: 0 }],
    ["any other refusal as the Kit's", new GitHubError("x", 422, { request: "POST /repos/o/r/pulls" }), { class: "kit", refusal: null, status: 422 }],
    [
      "a file that wasn't there as a missing file",
      Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/tmp/agent/result.json" }),
      { class: "missing-file", request: null, status: null, requestId: null },
    ],
    ["anything else as the Kit's", new Error("The agent's result is for #13"), { class: "kit", refusal: null, request: null, status: null, action: null }],
  ])("keeps %s", (_case, error, kept) => {
    expect(landingFailedOf({ kind: "error", error })).toMatchObject({ loopOutcome: "failure", ...kept });
  });

  it("keeps the Loop refusing to land a plan as the Kit's, with the Loop's reason", () => {
    expect(landingFailedOf({ kind: "fail", failure: "infrastructure", reason: "The Review of #51 gave no valid Verdict" })).toEqual({
      loopOutcome: "failure",
      action: null,
      request: null,
      status: null,
      requestId: null,
      class: "kit",
      refusal: null,
      reason: "The Review of #51 gave no valid Verdict",
    });
  });
});

describe("Whom a push job's or claim job's landing failure @-mentions (#531)", () => {
  it("the repo's owner, once a Kit config that leaves the Operator unset has loaded", () => {
    expect(landingFailureMention({ operator: null }, "acme/shop")).toBe("acme");
  });

  it("the Operator the Kit config names, once it has loaded", () => {
    expect(landingFailureMention({ operator: "someone" }, "acme/shop")).toBe("someone");
  });

  it("the repo's owner when the job fails before the Kit config loads", () => {
    expect(landingFailureMention(null, "acme/shop")).toBe("acme");
  });

  it("nobody when not even the repo is known", () => {
    expect(landingFailureMention(null, undefined)).toBeNull();
    expect(landingFailureMention(null, "")).toBeNull();
  });

  it("so a config leaving the Operator unset still has the comment begin with the owner's mention", () => {
    const comment = landingFailureReport(pushLanding(triage, RUN)!, { kind: "error", error: new Error("boom") }, landingFailureMention({ operator: null }, "acme/shop"));
    expect(comment.comment?.body).toMatch(/^@acme /);
  });
});
