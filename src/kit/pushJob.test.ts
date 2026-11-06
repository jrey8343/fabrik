import { describe, expect, it } from "vitest";
import { type Needs, pushJobInput } from "./pushJob.ts";

/** The push job's `needs`, as `toJSON(needs)` gives it: the Kit job routed to `route`, and the other jobs as given. */
function needs(route: string, jobs: Needs = {}, kitOutputs: Record<string, string> = {}): Needs {
  return { kit: { result: "success", outputs: { route, ticket: "", "pull-request": "", review: "", ...kitOutputs } }, ...jobs };
}

const ok = (outputs: Record<string, string> = {}) => ({ result: "success", outputs: { "secrets-step": "success", ...outputs } });

describe("What the push job applies", () => {
  it("applies the Actions event itself when the Kit job routed straight to it", () => {
    expect(pushJobInput(needs("push"), 12)).toEqual({ kind: "actions-event" });
  });

  it("applies the Triage result for the event's issue once Triage succeeded", () => {
    expect(pushJobInput(needs("triage", { triage: ok() }), 12)).toEqual({
      kind: "agent-result",
      role: "triage",
      issue: 12,
      pullRequest: null,
      review: null,
      startedBy: null,
    });
  });

  it("applies a Design-session turn's result with the Operator's reply that started it, from the Actions event", () => {
    expect(pushJobInput(needs("design", { design: ok() }), 12, 7003)).toEqual({
      kind: "agent-result",
      role: "design",
      issue: 12,
      pullRequest: null,
      review: null,
      startedBy: 7003,
    });
  });

  it("applies the first round's result with no starting reply, as adding needs-design started it", () => {
    expect(pushJobInput(needs("design", { design: ok() }), 12)).toMatchObject({ kind: "agent-result", role: "design", startedBy: null });
  });

  it("names no starting reply for a Triage run, even one a reply restarted", () => {
    expect(pushJobInput(needs("triage", { triage: ok() }), 12, 7003)).toMatchObject({ kind: "agent-result", startedBy: null });
  });

  it("applies an Auditor run's result for the event's issue, the pending Audit, once the Audit job succeeded", () => {
    expect(pushJobInput(needs("audit", { audit: ok() }), 98)).toEqual({
      kind: "agent-result",
      role: "audit",
      issue: 98,
      pullRequest: null,
      review: null,
      startedBy: null,
    });
  });

  it("applies a Retro run's result for the event's issue, the pending Retro, once the Retro job succeeded", () => {
    expect(pushJobInput(needs("retro", { "retro-evidence": ok(), retro: ok() }), 120)).toEqual({
      kind: "agent-result",
      role: "retro",
      issue: 120,
      pullRequest: null,
      review: null,
      startedBy: null,
    });
  });

  it("applies a Researcher run's result for the event's issue, the research Decision agent:research went on, once the Research job succeeded", () => {
    expect(pushJobInput(needs("research", { research: ok() }), 42)).toEqual({
      kind: "agent-result",
      role: "research",
      issue: 42,
      pullRequest: null,
      review: null,
      startedBy: null,
    });
  });

  // loop.yml's push job needs the Research job (src/kit/workflows.test.ts), so this is only ever a miswiring.
  it("applies nothing for a research route whose needs don't name the Research job, rather than guess at a result", () => {
    expect(pushJobInput(needs("research"), 42)).toEqual({ kind: "nothing", reason: "the research job ended unknown" });
  });

  // loop.yml's push job needs both of a Retro run's jobs (src/kit/workflows.test.ts), so this is only ever a miswiring.
  it("applies nothing for a Retro route whose needs name neither of the Retro's jobs, rather than guess at a result", () => {
    expect(pushJobInput(needs("retro"), 120)).toEqual({ kind: "nothing", reason: "the retro job ended unknown" });
  });

  it("applies an Implement run's result for the Ticket the Kit job's plan named, with a retry's PR and a Request-changes run's review", () => {
    const input = pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "pull-request": "50", review: "900" }), 50);

    expect(input).toEqual({
      kind: "agent-result",
      role: "implement",
      issue: 7,
      pullRequest: 50,
      review: 900,
      startedBy: null,
      capture: { result: null, artifact: null, galleryArtifact: null },
    });
  });

  describe("An Implement run's UI evidence", () => {
    const HEAD = "4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d";
    const captured = {
      outcome: "captured",
      headSha: HEAD,
      captures: [{ route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" }],
    };
    /** The push job's input when the Implement job passed out these outputs. */
    const withOutputs = (outputs: Record<string, string>) =>
      pushJobInput(needs("implement", { implement: ok(outputs) }, { ticket: "7" }), null);

    it("is the capture result and artifact ids the Implement job passed out", () => {
      const input = withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": "9202", "ui-gallery-artifact": "9201" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: captured, artifact: 9202, galleryArtifact: 9201 } });
    });

    it("is none when capture recorded nothing, as in a repo without a ui block, the Implement job passing out empty outputs", () => {
      const input = withOutputs({ "ui-capture-result": "", "ui-evidence-artifact": "", "ui-gallery-artifact": "" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: null, artifact: null, galleryArtifact: null } });
    });

    it.each([
      ["isn't JSON", "{ outcome: captured"],
      ["breaks the capture result's contract", JSON.stringify({ ...captured, headSha: "4f2b9c0" })],
      ["isn't an object", "[]"],
    ])("has no capture result when the one passed out %s, and that's never a failure", (_, text) => {
      const input = withOutputs({ "ui-capture-result": text, "ui-evidence-artifact": "9202", "ui-gallery-artifact": "9201" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: null, artifact: 9202, galleryArtifact: 9201 } });
    });

    it.each(["", "abc", "0", "-3", "9.5"])("has no artifact id when the one passed out is %j", (id) => {
      const input = withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": id, "ui-gallery-artifact": id });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: captured, artifact: null, galleryArtifact: null } });
    });

    it("isn't read for a run other than Implement", () => {
      const input = pushJobInput(needs("triage", { triage: ok({ "ui-capture-result": JSON.stringify(captured) }) }), 12);

      expect(input).not.toHaveProperty("capture");
    });
  });

  it("applies red checks as such: the Reviewer didn't run", () => {
    const input = pushJobInput(
      needs(
        "review",
        { "review-checks": { result: "success", outputs: { checks: "red", "head-sha": "a".repeat(40), failed: '["build"]' } }, review: { result: "skipped", outputs: {} } },
        { ticket: "7", "pull-request": "50" },
      ),
      50,
    );

    expect(input).toEqual({ kind: "review", pullRequest: 50, ticket: 7, headSha: "a".repeat(40), failedChecks: ["build"], withResult: false });
  });

  it("applies the Reviewer's Verdict once green checks let it run", () => {
    const input = pushJobInput(
      needs(
        "review",
        { "review-checks": { result: "success", outputs: { checks: "green", "head-sha": "a".repeat(40), failed: "[]" } }, review: ok() },
        { ticket: "7", "pull-request": "50" },
      ),
      50,
    );

    expect(input).toEqual({ kind: "review", pullRequest: 50, ticket: 7, headSha: "a".repeat(40), failedChecks: [], withResult: true });
  });

  it("does nothing when the PR moved on while its checks were awaited", () => {
    const input = pushJobInput(
      needs("review", { "review-checks": { result: "success", outputs: { checks: "stale", "head-sha": "", failed: "[]" } }, review: { result: "skipped", outputs: {} } }, { "pull-request": "50" }),
      50,
    );

    expect(input.kind).toBe("nothing");
  });

  it.each(["failure", "cancelled"])("posts the failure notice when the agent job's result is %s", (result) => {
    const input = pushJobInput(needs("design", { design: { result, outputs: { "secrets-step": "failure" } } }), 12);

    expect(input).toEqual({ kind: "agent-failure", role: "design", issue: 12, jobResult: result, secretsStep: "failure" });
  });

  // A timeout cancels the job: the Audit then fails, rather than staying pending and blocking the next one.
  it.each(["failure", "cancelled"])("gives an Auditor run's failure on the pending Audit when the Audit job's result is %s", (result) => {
    const input = pushJobInput(needs("audit", { audit: { result, outputs: { "secrets-step": "success" } } }), 98);

    expect(input).toEqual({ kind: "agent-failure", role: "audit", issue: 98, jobResult: result, secretsStep: "success" });
  });

  it.each(["failure", "cancelled"])("gives a Retro run's failure on the pending Retro when the Retro job's result is %s", (result) => {
    const input = pushJobInput(needs("retro", { "retro-evidence": ok(), retro: { result, outputs: { "secrets-step": "success" } } }), 120);

    expect(input).toEqual({ kind: "agent-failure", role: "retro", issue: 120, jobResult: result, secretsStep: "success" });
  });

  // The Research job's timeout cancels it; either way the Decision gets the research failure notice, which Dispatch won't release again past.
  it.each(["failure", "cancelled"])("gives a Researcher run's failure on the research Decision when the Research job's result is %s", (result) => {
    const input = pushJobInput(needs("research", { research: { result, outputs: { "secrets-step": "success" } } }), 42);

    expect(input).toEqual({ kind: "agent-failure", role: "research", issue: 42, jobResult: result, secretsStep: "success" });
  });

  // The Retro job never starts without its evidence, so the Retro would otherwise stay pending and block the next one.
  it.each(["failure", "cancelled"])("gives a Retro run's failure on the pending Retro when the Retro evidence job's result is %s", (result) => {
    const input = pushJobInput(
      needs("retro", { "retro-evidence": { result, outputs: { "secrets-step": "failure" } }, retro: { result: "skipped", outputs: {} } }),
      120,
    );

    expect(input).toEqual({ kind: "agent-failure", role: "retro", issue: 120, jobResult: result, secretsStep: "failure" });
  });

  it("names the Ticket for a failed Implement or Review run, where the core finds its PR", () => {
    const implement = pushJobInput(needs("implement", { implement: { result: "failure", outputs: {} } }, { ticket: "7", "pull-request": "50" }), 50);
    const checks = pushJobInput(
      needs("review", { "review-checks": { result: "cancelled", outputs: {} }, review: { result: "skipped", outputs: {} } }, { ticket: "7", "pull-request": "50" }),
      50,
    );

    expect(implement).toMatchObject({ kind: "agent-failure", role: "implement", issue: 7, jobResult: "failure", secretsStep: "" });
    expect(checks).toMatchObject({ kind: "agent-failure", role: "review", issue: 7, jobResult: "cancelled" });
  });

  // The Implement job's agent step has a timeout of its own (#153), which fails the job where V1's job timeout
  // cancelled it, so its job notes it, and the push job reads it as V1 did: an Infrastructure failure by timeout, never of another kind.
  it("reads an Implement job whose agent step its timeout stopped as cancelled, as its job timeout left it", () => {
    const input = pushJobInput(
      needs("implement", { implement: { result: "failure", outputs: { "secrets-step": "success", "agent-timed-out": "true" } } }, { ticket: "7" }),
      7,
    );

    expect(input).toEqual({ kind: "agent-failure", role: "implement", issue: 7, jobResult: "cancelled", secretsStep: "success" });
  });

  it("names the Implement job's result as it ended when its agent step didn't time out", () => {
    const input = pushJobInput(
      needs("implement", { implement: { result: "failure", outputs: { "secrets-step": "success", "agent-timed-out": "" } } }, { ticket: "7" }),
      7,
    );

    expect(input).toMatchObject({ kind: "agent-failure", jobResult: "failure" });
  });

  it("names a failed Reviewer, after green checks, as the Review's failure", () => {
    const input = pushJobInput(
      needs(
        "review",
        { "review-checks": { result: "success", outputs: { checks: "green", "head-sha": "a".repeat(40), failed: "[]" } }, review: { result: "failure", outputs: { "secrets-step": "success" } } },
        { ticket: "7", "pull-request": "50" },
      ),
      50,
    );

    expect(input).toEqual({ kind: "agent-failure", role: "review", issue: 7, jobResult: "failure", secretsStep: "success" });
  });

  it("names the Subscription a failed run used, from the Kit job's subscription output", () => {
    const input = pushJobInput(
      needs("implement", { implement: { result: "failure", outputs: { "secrets-step": "success" } } }, { ticket: "7", subscription: "Claude token 2" }),
      50,
    );

    expect(input).toEqual({
      kind: "agent-failure",
      role: "implement",
      issue: 7,
      jobResult: "failure",
      secretsStep: "success",
      subscription: "Claude token 2",
    });
  });

  it("names the Subscription a failed Retro run used, its evidence job's failure included", () => {
    const evidenceFailed = pushJobInput(
      needs(
        "retro",
        { "retro-evidence": { result: "failure", outputs: { "secrets-step": "success" } }, retro: { result: "skipped", outputs: {} } },
        { subscription: "Claude token 2" },
      ),
      120,
    );
    const retroFailed = pushJobInput(
      needs("retro", { "retro-evidence": ok(), retro: { result: "failure", outputs: { "secrets-step": "success" } } }, { subscription: "Claude token 2" }),
      120,
    );

    expect(evidenceFailed).toMatchObject({ kind: "agent-failure", role: "retro", issue: 120, subscription: "Claude token 2" });
    expect(retroFailed).toMatchObject({ kind: "agent-failure", role: "retro", issue: 120, subscription: "Claude token 2" });
  });

  it("does nothing when the Kit job routed nowhere, or failed", () => {
    expect(pushJobInput(needs("none"), 12).kind).toBe("nothing");
    expect(pushJobInput({ kit: { result: "failure", outputs: {} } }, 12).kind).toBe("nothing");
  });
});
