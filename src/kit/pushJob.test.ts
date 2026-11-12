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
      conflict: null,
      mainAtStart: null,
      retry: null,
      retryFlaw: null,
      keptBranch: null,
      startedBy: null,
      capture: { result: null, artifact: null, evidencePageArtifact: null, timedOut: false },
    });
  });

  it("carries a Kept-branch start from the Kit job's plan, with the closed PR and the default branch it opens against (#536)", () => {
    const input = pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "kept-branch": "true", "kept-pull-request": "230", "default-branch": "trunk" }), 7);

    expect(input).toMatchObject({ kind: "agent-result", pullRequest: null, keptBranch: { pullRequest: 230, base: "trunk" } });
  });

  it.each([
    ["it isn't one", { ticket: "7", "kept-branch": "false" }],
    ["the Kit job named no default branch", { ticket: "7", "kept-branch": "true", "kept-pull-request": "230" }],
  ])("carries no Kept-branch start when %s", (_, kit) => {
    expect(pushJobInput(needs("implement", { implement: ok() }, kit), 7)).toMatchObject({ keptBranch: null });
  });

  it("carries a Retry's number from the Kit job's plan, so a Retry left over from an earlier flaw never lands (#341)", () => {
    const input = pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "pull-request": "50", retry: "2" }), 50);

    expect(input).toMatchObject({ kind: "agent-result", retry: 2 });
  });

  it("carries main's head as the Kit job read it before the run, never anything from the agent job (#341)", () => {
    const main = "9".repeat(40);
    const implement = { ...ok(), outputs: { ...ok().outputs, "main-at-start": "8".repeat(40) } };

    const input = pushJobInput(needs("implement", { implement }, { ticket: "7", "pull-request": "50", review: "900", "main-at-start": main }), 50);

    expect(input).toMatchObject({ kind: "agent-result", mainAtStart: main });
  });

  it("applies a conflict-only run's result with the main head the Kit job's plan started it for (#304)", () => {
    const main = "9".repeat(40);

    const input = pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "pull-request": "50", conflict: main }), 50);

    expect(input).toMatchObject({ kind: "agent-result", role: "implement", issue: 7, pullRequest: 50, review: null, conflict: main });
  });

  it("names no main head for any other Implement run, and none that isn't a commit", () => {
    expect(pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "pull-request": "50" }), 50)).toMatchObject({ conflict: null });
    expect(pushJobInput(needs("implement", { implement: ok() }, { ticket: "7", "pull-request": "50", conflict: "main" }), 50)).toMatchObject({ conflict: null });
  });

  it("names a failed conflict-only run's PR and main head, so its failure hands the PR to the Operator (#304)", () => {
    const main = "9".repeat(40);

    const input = pushJobInput(needs("implement", { implement: { result: "failure", outputs: {} } }, { ticket: "7", "pull-request": "50", conflict: main }), 50);

    expect(input).toMatchObject({ kind: "agent-failure", role: "implement", issue: 7, conflict: { pullRequest: 50, main } });
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
      const input = withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": "9202", "ui-evidence-page-artifact": "9201" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: captured, artifact: 9202, evidencePageArtifact: 9201 } });
    });

    it("is none when capture recorded nothing, as in a repo without a ui block, the Implement job passing out empty outputs", () => {
      const input = withOutputs({ "ui-capture-result": "", "ui-evidence-artifact": "", "ui-evidence-page-artifact": "" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: null, artifact: null, evidencePageArtifact: null } });
    });

    it.each([
      ["isn't JSON", "{ outcome: captured"],
      ["breaks the capture result's contract", JSON.stringify({ ...captured, headSha: "4f2b9c0" })],
      ["isn't an object", "[]"],
    ])("has no capture result when the one passed out %s, and that's never a failure", (_, text) => {
      const input = withOutputs({ "ui-capture-result": text, "ui-evidence-artifact": "9202", "ui-evidence-page-artifact": "9201" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: null, artifact: 9202, evidencePageArtifact: 9201 } });
    });

    it.each(["", "abc", "0", "-3", "9.5"])("has no artifact id when the one passed out is %j", (id) => {
      const input = withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": id, "ui-evidence-page-artifact": id });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: captured, artifact: null, evidencePageArtifact: null } });
    });

    it("notes that capture ran out of time when the Implement job says its capture step's own timeout stopped it", () => {
      const input = withOutputs({ "ui-capture-result": "", "ui-capture-timed-out": "true", "ui-evidence-artifact": "", "ui-evidence-page-artifact": "" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: null, timedOut: true } });
    });

    it("notes no timeout when the Implement job says none", () => {
      const input = withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-capture-timed-out": "" });

      expect(input).toMatchObject({ kind: "agent-result", capture: { result: captured, timedOut: false } });
    });

    it("isn't read for a run other than Implement", () => {
      const input = pushJobInput(needs("triage", { triage: ok({ "ui-capture-result": JSON.stringify(captured) }) }), 12);

      expect(input).not.toHaveProperty("capture");
    });
  });

  // A Design session's prototype turn (#155), its route design, whose request comes from the Kit job's plan, never from the agent.
  describe("A prototype turn's result", () => {
    const HEAD = "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d";
    const REQUEST = { route: "/book", variants: 3, brief: "- **A**: one long form.\n- **B**: a stepper.", reply: 9001 };
    const captured = {
      outcome: "captured",
      headSha: HEAD,
      captures: [{ route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png", video: "variant-a-mobile.webm" }],
    };
    /** The push job's input when the prototype job ran #12's turn and passed out these outputs, the Design job skipped. */
    const withOutputs = (outputs: Record<string, string>, request = JSON.stringify(REQUEST)) =>
      pushJobInput(
        needs("design", { design: { result: "skipped", outputs: {} }, prototype: ok(outputs) }, { prototype: "true", prototype_request: request }),
        12,
      );

    it("is the prototype job's, with the request the Kit job built it on, and the capture result, captures and Evidence page the prototype job passed out", () => {
      expect(withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": "9202", "ui-evidence-page-artifact": "9201" })).toEqual({
        kind: "agent-result",
        role: "design",
        issue: 12,
        pullRequest: null,
        review: null,
        startedBy: null,
        prototype: {
          request: { request: { route: "/book", variants: 3, brief: "- **A**: one long form.\n- **B**: a stepper." }, reply: 9001 },
          capture: { result: captured, artifact: 9202, evidencePageArtifact: 9201, timedOut: false },
        },
      });
    });

    it("has no capture result, captures or Evidence page when capture recorded nothing, and that's never a failure", () => {
      expect(withOutputs({ "ui-capture-result": "", "ui-evidence-artifact": "", "ui-evidence-page-artifact": "" })).toMatchObject({
        kind: "agent-result",
        prototype: { capture: { result: null, artifact: null, evidencePageArtifact: null } },
      });
    });

    it.each(["", "abc", "0", "-3", "9.5"])("has no captures' artifact id when the one the prototype job passed out is %j", (id) => {
      expect(withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-artifact": id, "ui-evidence-page-artifact": "9201" })).toMatchObject({
        kind: "agent-result",
        prototype: { capture: { result: captured, artifact: null, evidencePageArtifact: 9201 } },
      });
    });

    it("has no captures' artifact id when the prototype job passed out none", () => {
      expect(withOutputs({ "ui-capture-result": JSON.stringify(captured), "ui-evidence-page-artifact": "9201" })).toMatchObject({
        kind: "agent-result",
        prototype: { capture: { result: captured, artifact: null } },
      });
    });

    it.each([["isn't JSON", "{ route"], ["isn't a request the contract takes", JSON.stringify({ ...REQUEST, variants: 9 })], ["is empty", ""]])(
      "has no request when the one the Kit job passed out %s, for the push job to refuse",
      (_name, request) => {
        expect(withOutputs({}, request)).toMatchObject({ kind: "agent-result", prototype: { request: null } });
      },
    );

    it("isn't read for an ordinary Design turn, which the Design job ran", () => {
      const input = pushJobInput(needs("design", { design: ok({ "ui-capture-result": JSON.stringify(captured) }) }, { prototype: "false" }), 12);

      expect(input).not.toHaveProperty("prototype");
      expect(input).not.toHaveProperty("capture");
    });
  });

  it("applies red checks as such: the Reviewer didn't run", () => {
    const input = pushJobInput(
      needs(
        "review",
        { "review-checks": { result: "success", outputs: { checks: "red", "head-sha": "a".repeat(40), failed: '["build","e2e"]', "ran-nothing": "[]" } }, review: { result: "skipped", outputs: {} } },
        { ticket: "7", "pull-request": "50" },
      ),
      50,
    );

    expect(input).toEqual({ kind: "review", pullRequest: 50, ticket: 7, headSha: "a".repeat(40), failedChecks: ["build", "e2e"], ranNothing: [], withResult: false });
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

    expect(input).toEqual({ kind: "review", pullRequest: 50, ticket: 7, headSha: "a".repeat(40), failedChecks: [], ranNothing: [], withResult: true });
  });

  it("carries the checks that ran nothing on green checks to the Reviewer's Verdict", () => {
    const input = pushJobInput(
      needs(
        "review",
        { "review-checks": { result: "success", outputs: { checks: "green", "head-sha": "a".repeat(40), failed: "[]", "ran-nothing": '["e2e"]' } }, review: ok() },
        { ticket: "7", "pull-request": "50" },
      ),
      50,
    );

    expect(input).toMatchObject({ kind: "review", withResult: true, ranNothing: ["e2e"] });
  });

  describe("after the Kit re-ran red checks (#462)", () => {
    const sha = "a".repeat(40);
    const red = JSON.stringify({ rerun: [{ name: "e2e", link: "https://x/actions/runs/7/job/70", run: 7 }], outside: ["Vercel"] });
    const firstWait = { result: "success", outputs: { checks: "red", "head-sha": sha, failed: '["e2e","Vercel"]', "ran-nothing": "[]", red } };
    const flaky = [{ name: "e2e", red: "https://x/actions/runs/7/job/70", green: "https://x/actions/runs/7/job/99" }];
    const reran = { result: "success", outputs: { rerun: JSON.stringify([{ name: "e2e", link: "https://x/actions/runs/7/job/70", run: 7 }]), "rerun-at": "2026-11-11T11:00:00Z", refused: "" } };
    const review = (jobs: Record<string, { result: string; outputs: Record<string, string> }>) =>
      pushJobInput(needs("review", { "review-checks": firstWait, review: { result: "skipped", outputs: {} }, ...jobs }, { ticket: "7", "pull-request": "50" }), 50);

    it("lands the checks that failed again, the outside ones and the flaky ones, as the re-run's wait read them", () => {
      const input = review({
        "rerun-checks": reran,
        "rerun-wait": { result: "success", outputs: { checks: "red", "head-sha": sha, failed: '["Vercel"]', "ran-nothing": "[]", "failed-again": "[]", flaky: JSON.stringify(flaky) } },
      });

      expect(input).toEqual({
        kind: "review",
        pullRequest: 50,
        ticket: 7,
        headSha: sha,
        failedChecks: ["Vercel"],
        ranNothing: [],
        withResult: false,
        rerun: { outside: ["Vercel"], failedAgain: [], flaky, refused: null },
      });
    });

    it("applies the Reviewer's Verdict, with the flaky checks, once the re-run went green", () => {
      const input = review({
        "rerun-checks": reran,
        "rerun-wait": { result: "success", outputs: { checks: "green", "head-sha": sha, failed: "[]", "ran-nothing": '["visual"]', "failed-again": "[]", flaky: JSON.stringify(flaky) } },
        review: ok(),
      });

      expect(input).toMatchObject({ kind: "review", withResult: true, failedChecks: [], ranNothing: ["visual"], rerun: { failedAgain: [], flaky, outside: ["Vercel"], refused: null } });
    });

    it("lands the first wait's red checks with why, when GitHub refused the re-run", () => {
      const input = review({ "rerun-checks": { result: "success", outputs: { rerun: "[]", "rerun-at": "", refused: "GitHub refused: too old" } }, "rerun-wait": { result: "skipped", outputs: {} } });

      expect(input).toMatchObject({ withResult: false, failedChecks: ["e2e", "Vercel"], rerun: { outside: ["Vercel"], failedAgain: [], flaky: [], refused: "GitHub refused: too old" } });
    });

    it("lands the first wait's red checks when the re-run job itself failed", () => {
      const input = review({ "rerun-checks": { result: "failure", outputs: {} }, "rerun-wait": { result: "skipped", outputs: {} } });

      expect(input).toMatchObject({ withResult: false, failedChecks: ["e2e", "Vercel"], rerun: { refused: "the Re-run red checks job failed" } });
    });

    it("is an Infrastructure failure when the re-run's wait gave up", () => {
      const input = review({ "rerun-checks": reran, "rerun-wait": { result: "failure", outputs: {} } });

      expect(input).toMatchObject({ kind: "agent-failure", role: "review", issue: 7, jobResult: "failure" });
    });
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

  // A prototype turn's route stays design (#155), and the Kit job's prototype output says the prototype job ran it, the Design job skipped.
  it.each(["failure", "cancelled"])("gives a prototype turn's failure as a Design-session turn's when the prototype job's result is %s", (result) => {
    const input = pushJobInput(
      needs("design", { design: { result: "skipped", outputs: {} }, prototype: { result, outputs: { "secrets-step": "failure" } } }, { prototype: "true" }),
      12,
    );

    expect(input).toEqual({ kind: "agent-failure", role: "design", issue: 12, jobResult: result, secretsStep: "failure", prototype: true });
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
