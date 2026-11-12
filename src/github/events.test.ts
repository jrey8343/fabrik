import { describe, expect, it } from "vitest";
import { aRetroEvidenceInput } from "../__fixtures__/retroEvidence.ts";
import { aMergedPullRequest, anEscapeMarkerIssue, aRunRecord, factsOf } from "../read/builders.ts";
import { readAgentRunResult } from "../agent/result.ts";
import type { CaptureOutputs } from "../kit/pushJob.ts";
import { evidenceBundle, readEvidenceBundle } from "../kit/retroEvidence.ts";
import {
  agentFailureEventFrom,
  agentRunEventFrom,
  checkBuiltAsPlanned,
  auditEventFrom,
  loopEventFrom,
  prototypeEventFrom,
  researchEventFrom,
  retroEventFrom,
} from "./events.ts";

describe("A scheduled tick", () => {
  const NOW = new Date("2026-11-11T06:17:00Z");

  it("knows the release it runs on from the Kit workflow ref it was called at", () => {
    expect(loopEventFrom("schedule", {}, NOW, "jrey8343/fabrik/.github/workflows/schedule.yml@v1.1.0")).toEqual({
      kind: "scheduled-tick",
      now: "2026-11-11T06:17:00.000Z",
      release: "v1.1.0",
    });
  });

  it("names no release when it isn't given the workflow ref", () => {
    expect(loopEventFrom("schedule", {}, NOW)).toEqual({ kind: "scheduled-tick", now: "2026-11-11T06:17:00.000Z" });
    expect(loopEventFrom("schedule", {}, NOW, "")).toEqual({ kind: "scheduled-tick", now: "2026-11-11T06:17:00.000Z" });
  });
});

describe("A push", () => {
  const HEAD = "9".repeat(40);
  const push = (overrides: Record<string, unknown> = {}) => ({
    ref: "refs/heads/main",
    after: HEAD,
    repository: { default_branch: "main" },
    commits: [{ added: [], modified: [".fabrik/config.json"], removed: [] }],
    ...overrides,
  });

  it("to the default branch that changes the Kit config is a Kit config change, carrying main's new head", () => {
    expect(loopEventFrom("push", push())).toEqual({ kind: "kit-config-changed", head: HEAD });
  });

  it.each([
    ["adds", { added: [".fabrik/config.json"], modified: [], removed: [] }],
    ["removes, restoring the defaults,", { added: [], modified: [], removed: [".fabrik/config.json"] }],
  ])("that %s the Kit config is a Kit config change too", (_, commit) => {
    expect(loopEventFrom("push", push({ commits: [commit] }))).toEqual({ kind: "kit-config-changed", head: HEAD });
  });

  it("to another branch is nothing, since only the default branch's Kit config is read and only main moving can leave a PR conflicting", () => {
    expect(loopEventFrom("push", push({ ref: "refs/heads/tweak-config" }))).toBeNull();
  });

  it("to another branch is nothing, whatever its commits hold", () => {
    expect(loopEventFrom("push", push({ ref: "refs/heads/tweak-config", commits: [{}] }))).toBeNull();
  });

  // #304: whatever it touches, a push to main may leave an agent PR conflicting with it.
  it("to the default branch that leaves the Kit config alone is main moving, carrying its new head", () => {
    const commits = [{ added: [], modified: [".fabrik/implement.md"], removed: [] }];

    expect(loopEventFrom("push", push({ commits }))).toEqual({ kind: "main-pushed", head: HEAD });
  });

  // #307: a real push held an entry with no `added`, and it threw before the check could run.
  it.each([
    ["no lists", {}],
    ["no added", { modified: [], removed: [] }],
    ["no modified", { added: [], removed: [] }],
    ["no removed", { added: [], modified: [] }],
  ])("to the default branch with a commit that has %s may have changed the Kit config, so it's a Kit config change", (_, commit) => {
    expect(loopEventFrom("push", push({ commits: [commit] }))).toEqual({ kind: "kit-config-changed", head: HEAD });
  });

  it.each([
    ["an empty commits list", { commits: [] }],
    ["no commits list", { commits: undefined }],
    ["a null commit entry", { commits: [null] }],
  ])("to the default branch with %s may have changed the Kit config, so it's a Kit config change", (_, overrides) => {
    expect(loopEventFrom("push", push(overrides))).toEqual({ kind: "kit-config-changed", head: HEAD });
  });

  it("that deletes the default branch is nothing: there's no head to bring a PR up to date with", () => {
    expect(loopEventFrom("push", push({ after: "0".repeat(40), deleted: true, commits: [] }))).toBeNull();
  });
});

describe("A comment on a pull request", () => {
  const user = (login: string, type = "User") => ({ login, type });

  it("in its conversation is a pull-request comment, naming the comment the reaction goes on", () => {
    const payload = {
      action: "created",
      issue: { number: 50, pull_request: { url: "https://api.github.com/repos/acme/shop/pulls/50" } },
      comment: { id: 7001, user: user("operator"), body: "The parking copy is right." },
    };

    expect(loopEventFrom("issue_comment", payload)).toEqual({
      kind: "pull-request-commented",
      pullRequest: 50,
      commenter: "operator",
      commenterIsBot: false,
      on: { kind: "conversation", comment: 7001 },
    });
  });

  it("from a bot, such as the Fabrik App's own Verdict, is no event", () => {
    const payload = {
      action: "created",
      issue: { number: 50, pull_request: {} },
      comment: { id: 7002, user: user("fabrik[bot]", "Bot"), body: "Verdict: pass" },
    };

    expect(loopEventFrom("issue_comment", payload)).toBeNull();
  });

  it("in a review a bot submitted is no event", () => {
    const payload = {
      action: "submitted",
      pull_request: { number: 50 },
      review: { id: 901, state: "commented", user: user("fabrik[bot]", "Bot"), body: "Noted." },
    };

    expect(loopEventFrom("pull_request_review", payload)).toBeNull();
  });

  it.each(["commented", "approved", "COMMENTED", "APPROVED"])(
    "in a submitted %s review is a pull-request comment, naming the review by its id and node id, and that it has a body",
    (state) => {
      const payload = {
        action: "submitted",
        pull_request: { number: 50 },
        review: { id: 900, node_id: "PRR_kwDO900", state, user: user("operator"), body: "Looks good." },
      };

      expect(loopEventFrom("pull_request_review", payload)).toEqual({
        kind: "pull-request-commented",
        pullRequest: 50,
        commenter: "operator",
        commenterIsBot: false,
        on: { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: true },
      });
    },
  );

  it.each([null, "", "  \n"])("in a review whose body is %j says it has no body", (body) => {
    const payload = {
      action: "submitted",
      pull_request: { number: 50 },
      review: { id: 900, node_id: "PRR_kwDO900", state: "approved", user: user("operator"), body },
    };

    expect(loopEventFrom("pull_request_review", payload)).toMatchObject({
      on: { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: false },
    });
  });

  it("in a review that requests changes is still Request changes", () => {
    const payload = {
      action: "submitted",
      pull_request: { number: 50 },
      review: { id: 900, state: "changes_requested", user: user("operator") },
    };

    expect(loopEventFrom("pull_request_review", payload)).toEqual({
      kind: "pull-request-changes-requested",
      pullRequest: 50,
      review: 900,
      reviewer: "operator",
      reviewerIsBot: false,
    });
  });
});

describe("A pull request closing", () => {
  it("says whether it merged, and whether a bot closed it, so an agent PR the Operator closed by hand stops its Ticket (#428)", () => {
    const byHand = { action: "closed", pull_request: { number: 50, merged: false }, sender: { login: "operator", type: "User" } };
    const byTheKit = { action: "closed", pull_request: { number: 50, merged: false }, sender: { login: "fabrik[bot]", type: "Bot" } };
    const merged = { action: "closed", pull_request: { number: 50, merged: true }, sender: { login: "operator", type: "User" } };

    expect(loopEventFrom("pull_request_target", byHand)).toEqual({ kind: "pull-request-closed", pullRequest: 50, merged: false, closedByBot: false });
    expect(loopEventFrom("pull_request_target", byTheKit)).toEqual({ kind: "pull-request-closed", pullRequest: 50, merged: false, closedByBot: true });
    expect(loopEventFrom("pull_request_target", merged)).toEqual({ kind: "pull-request-closed", pullRequest: 50, merged: true, closedByBot: false });
  });
});

describe("A comment on an issue", () => {
  it("is still an issue comment", () => {
    const payload = {
      action: "created",
      issue: { number: 7 },
      comment: { id: 7003, user: { login: "operator", type: "User" }, body: "Yes, the second option." },
    };

    expect(loopEventFrom("issue_comment", payload)).toEqual({
      kind: "issue-comment-created",
      issue: 7,
      commenter: "operator",
      commenterIsBot: false,
      body: "Yes, the second option.",
      comment: 7003,
    });
  });
});

describe("A finished Design-session turn", () => {
  const result = { role: "design", issue: 7, output: "{}" } as const;

  it("names the Operator's reply that started it", () => {
    expect(agentRunEventFrom(result, null, null, 7003)).toEqual({
      kind: "agent-run-finished",
      role: "design",
      issue: 7,
      output: "{}",
      startedBy: 7003,
    });
  });

  it("names no reply when adding needs-design started it", () => {
    expect(agentRunEventFrom(result)).toEqual({ kind: "agent-run-finished", role: "design", issue: 7, output: "{}" });
  });
});

describe("A finished Implement run's UI evidence", () => {
  const HEAD = "4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d";
  const result = {
    role: "implement",
    issue: 7,
    output: "{}",
    branch: { name: "fabrik/ticket-7", base: { ref: "main", sha: "b".repeat(40) }, head: HEAD },
  } as const;
  const changes = { net: [{ path: "src/pages/book.astro" }], commits: [{ path: "src/pages/book.astro" }] };
  const captured = {
    outcome: "captured",
    headSha: HEAD,
    captures: [{ route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" }],
  } as const;
  /** Run 9100's push job, in acme/shop, with what its Implement job passed out. */
  const pushJob = (capture: Omit<CaptureOutputs, "timedOut"> & { timedOut?: boolean }) => ({ timedOut: false, ...capture, run: 9100, repoUrl: "https://github.com/acme/shop" });
  const RUN = "https://github.com/acme/shop/actions/runs/9100/attempts/1";

  it("carries the capture result, the head the run built, and where the push job's own run keeps the images and the Evidence page", () => {
    const event = agentRunEventFrom(result, changes, null, null, pushJob({ result: captured, artifact: 9202, evidencePageArtifact: 9201 }), RUN);

    expect(event).toMatchObject({
      kind: "implement-run-finished",
      // Its push job's run, which an empty diff's comment links to, a first run's too (#429).
      runUrl: RUN,
      evidence: {
        result: captured,
        headSha: HEAD,
        run: 9100,
        artifact: 9202,
        evidencePage: "https://github.com/acme/shop/actions/runs/9100/artifacts/9201",
      },
    });
  });

  it("carries no capture result when capture recorded nothing, as in a repo without a ui block, the Implement job having passed out none", () => {
    const event = agentRunEventFrom(result, changes, null, null, pushJob({ result: null, artifact: null, evidencePageArtifact: null }), RUN);

    expect(event).toMatchObject({ evidence: { headSha: HEAD, run: 9100, artifact: null, evidencePage: null } });
    expect(event).not.toHaveProperty("evidence.result");
  });

  it("carries a timeout as the capture result when the capture step's own timeout stopped it before it recorded one", () => {
    const event = agentRunEventFrom(result, changes, null, null, pushJob({ result: null, timedOut: true, artifact: null, evidencePageArtifact: null }), RUN);

    expect(event).toMatchObject({ evidence: { result: { outcome: "failed", reason: "timeout", headSha: HEAD, captures: [] }, headSha: HEAD } });
  });

  it("links no Evidence page when the run kept no Evidence page artifact, though it kept the images", () => {
    const event = agentRunEventFrom(result, changes, null, null, pushJob({ result: captured, artifact: 9202, evidencePageArtifact: null }), RUN);

    expect(event).toMatchObject({ evidence: { artifact: 9202, evidencePage: null } });
  });
});

describe("A finished Audit run", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
  const REPO = "https://github.com/acme/shop";
  const artifact = (window: unknown) =>
    JSON.stringify({ role: "audit", issue: 97, output: '{"candidates":[],"topRecommendation":null}', ...(window === undefined ? {} : { window }) });

  it("carries the Auditor's output, unparsed, with the window its inputs gave it, this run and the Product repo its candidates open issues on", () => {
    const window = { kind: "since-audit", audit: 90, commit: "c".repeat(40) };

    expect(auditEventFrom(readAgentRunResult(artifact(window)), RUN, REPO)).toEqual({
      kind: "audit-run-finished",
      issue: 97,
      output: '{"candidates":[],"topRecommendation":null}',
      window,
      runUrl: RUN,
      repoUrl: "https://github.com/acme/shop",
    });
  });

  it("carries a window of the last 30 days", () => {
    expect(auditEventFrom(readAgentRunResult(artifact({ kind: "last-days", days: 30 })), RUN, REPO)).toMatchObject({
      window: { kind: "last-days", days: 30 },
    });
  });

  it("refuses an Auditor's result with no window", () => {
    expect(() => auditEventFrom(readAgentRunResult(artifact(undefined)), RUN, REPO)).toThrow(/window/);
  });

  it.each([
    ["names no kind", { audit: 90, commit: "c".repeat(40) }],
    ["names no Audit", { kind: "since-audit", commit: "c".repeat(40) }],
    ["names no commit", { kind: "since-audit", audit: 90, commit: "main" }],
    ["counts no days", { kind: "last-days", days: 0 }],
  ])("refuses a result whose window %s", (_, window) => {
    expect(() => readAgentRunResult(artifact(window))).toThrow(/window/);
  });

  it("isn't an agent-run-finished event", () => {
    expect(() => agentRunEventFrom(readAgentRunResult(artifact({ kind: "last-days", days: 30 })))).toThrow(/auditEventFrom/);
  });
});

describe("A finished Retro run", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
  const REPO = "https://github.com/acme/shop";
  const RESULT = JSON.stringify({ role: "retro", issue: 120, output: '{"proposals":[]}' });
  const RECORD = "runs/owner/product/2026-11/1001-1-review.json";
  const TRANSCRIPT = "transcripts/owner/product/2026-11/1001-1-review.jsonl.gz";

  /**
   * The evidence job's artifact, as the push job downloads it: the bundle for
   * Retro 120's window, holding escape #80 against #50, whose passing Review
   * run left its transcript, and #51, whose Implement run left none.
   */
  const artifact = JSON.stringify(
    evidenceBundle(
      aRetroEvidenceInput({
        records: [
          aRunRecord({ runId: 1001, role: "review", pullRequest: 50, verdict: "pass", endedAt: "2026-11-01T00:00:00Z", transcript: TRANSCRIPT }),
          aRunRecord({ runId: 1002, role: "implement", issue: 8, pullRequest: 51, endedAt: "2026-11-02T00:00:00Z" }),
        ],
        facts: factsOf({
          pullRequests: [
            aMergedPullRequest("2026-11-02T00:00:00Z", { number: 50, ticket: 7 }),
            aMergedPullRequest("2026-11-03T00:00:00Z", { number: 51, ticket: 8 }),
          ],
          escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #50 #51 -->", { number: 80 })],
        }),
      }),
    ),
  );

  it("carries the Retro's output, unparsed, with the bundle's window, refs and streak table, each record's transcript, this run and the Product repo", () => {
    const event = retroEventFrom(readAgentRunResult(RESULT), readEvidenceBundle(artifact), RUN, REPO);

    expect(event).toEqual({
      kind: "retro-run-finished",
      issue: 120,
      output: '{"proposals":[]}',
      evidence: {
        window: { start: "2026-10-31T00:00:00.000Z", end: "2026-11-07T00:00:00.000Z" },
        refs: [
          { ref: "#80", kind: "escape" },
          { ref: "#50", kind: "pull-request" },
          { ref: "#7", kind: "issue" },
          { ref: RECORD, kind: "record" },
          { ref: "#51", kind: "pull-request" },
          { ref: "#8", kind: "issue" },
          { ref: "runs/owner/product/2026-11/1002-1-implement.json", kind: "record" },
        ],
        streakTable: [
          expect.objectContaining({ ref: "#50", number: 50, escaped: true, reverted: false, requestChanges: false }),
          expect.objectContaining({ ref: "#51", number: 51, escaped: true, reverted: false, requestChanges: false }),
        ],
        transcripts: { [RECORD]: TRANSCRIPT },
      },
      runUrl: RUN,
      repoUrl: REPO,
    });
  });

  it("refuses another role's result", () => {
    const audit = readAgentRunResult(JSON.stringify({ role: "audit", issue: 97, output: "{}", window: { kind: "last-days", days: 30 } }));

    expect(() => retroEventFrom(audit, readEvidenceBundle(artifact), RUN, REPO)).toThrow(/audit result/);
  });

  it("isn't an agent-run-finished event", () => {
    expect(() => agentRunEventFrom(readAgentRunResult(RESULT))).toThrow(/retroEventFrom/);
  });

  it.each([
    ["isn't JSON", "{"],
    ["isn't an object", "[]"],
    ["has no window", JSON.stringify({ ...JSON.parse(artifact), window: undefined })],
    ["has a window that isn't two times", JSON.stringify({ ...JSON.parse(artifact), window: { start: "last week", end: "2026-11-07T00:00:00.000Z" } })],
    ["has no streak table", JSON.stringify({ ...JSON.parse(artifact), streakTable: undefined })],
    ["has a streak row with no flags", JSON.stringify({ ...JSON.parse(artifact), streakTable: [{ ref: "#50", number: 50 }] })],
    ["has no history", JSON.stringify({ ...JSON.parse(artifact), history: undefined })],
    ...["escapes", "feedback", "followUps", "lowScores", "sample"].map((part): [string, string] => [`has no ${part}`, JSON.stringify({ ...JSON.parse(artifact), [part]: undefined })]),
  ])("refuses evidence that %s", (_, text) => {
    expect(() => readEvidenceBundle(text)).toThrow(/evidence\.json/);
  });
});

describe("A finished Researcher run", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
  const REPO = "https://github.com/acme/shop";
  const OUTPUT = '{"gist":"Stripe Checkout takes one payment for every seat.","keyFacts":["A line item has a quantity."]}';
  const branch = {
    name: "research/42-which-payment-provider-takes-group-bookings",
    base: { ref: "main", sha: "b".repeat(40) },
    head: "a".repeat(40),
  };
  const artifact = (fields: Record<string, unknown> = {}) => JSON.stringify({ role: "research", issue: 42, output: OUTPUT, branch, ...fields });
  const changes = {
    net: [{ path: "docs/research/42-which-payment-provider-takes-group-bookings.md" }],
    commits: [{ path: "docs/research/42-which-payment-provider-takes-group-bookings.md" }],
    updatedFromMain: false,
  };

  it("carries the Researcher's output, unparsed, with the branch it built and what that changes, this run and the Product repo", () => {
    expect(researchEventFrom(readAgentRunResult(artifact()), changes, RUN, REPO)).toEqual({
      kind: "research-run-finished",
      issue: 42,
      output: OUTPUT,
      branch: "research/42-which-payment-provider-takes-group-bookings",
      changes,
      runUrl: RUN,
      repoUrl: REPO,
    });
  });

  it("keeps the branch the run built when the result is read, as it does an Implement run's", () => {
    expect(readAgentRunResult(artifact()).branch).toEqual(branch);
  });

  it.each([
    ["names no branch", { branch: undefined }],
    ["names a branch that isn't a ref", { branch: { ...branch, name: "research/42 findings" } }],
    ["names a base with no commit", { branch: { ...branch, base: { ref: "main", sha: "main" } } }],
  ])("refuses a result that %s", (_, fields) => {
    expect(() => readAgentRunResult(artifact(fields))).toThrow(/branch/);
  });

  it("refuses another role's result", () => {
    const audit = readAgentRunResult(JSON.stringify({ role: "audit", issue: 97, output: "{}", window: { kind: "last-days", days: 30 } }));

    expect(() => researchEventFrom(audit, changes, RUN, REPO)).toThrow(/audit result/);
  });

  it("isn't an agent-run-finished event", () => {
    expect(() => agentRunEventFrom(readAgentRunResult(artifact()))).toThrow(/researchEventFrom/);
  });
});

describe("A finished prototype turn", () => {
  const RUN = "https://github.com/acme/shop/actions/runs/9100/attempts/1";
  const REPO = "https://github.com/acme/shop";
  const HEAD = "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d";
  const OUTPUT = '{"kind":"prototype-round","intro":"Two ways.","variants":[],"recommendation":"A"}';
  const branch = { name: "prototype/7", base: { ref: "main", sha: "b".repeat(40) }, head: HEAD };
  const result = readAgentRunResult(JSON.stringify({ role: "design", issue: 7, output: OUTPUT, branch }));
  const request = { request: { route: "/book", variants: 2, brief: "Two ways." }, reply: 9001 };
  const changes = { net: [{ path: "src/pages/book/A.tsx" }], commits: [{ path: "src/pages/book/A.tsx" }], updatedFromMain: false };
  const captured = {
    outcome: "captured",
    headSha: HEAD,
    captures: [{ route: "/book", variant: "A", viewport: "mobile", status: 200, image: "variant-a-mobile.png" }],
  } as const;
  /** Run 9100's push job, in acme/shop, with what the prototype job passed out. */
  const pushJob = (capture: Omit<CaptureOutputs, "timedOut"> & { timedOut?: boolean }) => ({ timedOut: false, ...capture, run: 9100, repoUrl: REPO });

  it("carries the turn's output, unparsed, the request the Kit job built it on, the branch, what it changes and the head the push leaves, what capture recorded, and the Evidence page in the push job's own run", () => {
    const event = prototypeEventFrom(result, request, { changes, head: HEAD }, pushJob({ result: captured, artifact: null, evidencePageArtifact: 9201 }), RUN);

    expect(event).toEqual({
      kind: "prototype-run-finished",
      issue: 7,
      output: OUTPUT,
      request,
      branch: "prototype/7",
      changes,
      headSha: HEAD,
      capture: captured,
      evidencePage: `${REPO}/actions/runs/9100/artifacts/9201`,
      runUrl: RUN,
      repoUrl: REPO,
    });
  });

  it("carries no capture result or Evidence page when the prototype job passed out none, and no head when the turn made no commit", () => {
    const event = prototypeEventFrom(
      result,
      request,
      { changes: { net: [], commits: [], updatedFromMain: false }, head: null },
      pushJob({ result: null, artifact: null, evidencePageArtifact: null }),
      RUN,
    );

    expect(event).toMatchObject({ kind: "prototype-run-finished", headSha: null, evidencePage: null });
    expect(event).not.toHaveProperty("capture");
  });

  it("refuses a result that names no branch, or is another role's", () => {
    const evidence = pushJob({ result: null, artifact: null, evidencePageArtifact: null });
    const noBranch = readAgentRunResult(JSON.stringify({ role: "design", issue: 7, output: OUTPUT }));
    const triage = readAgentRunResult(JSON.stringify({ role: "triage", issue: 7, output: "{}" }));

    expect(() => prototypeEventFrom(noBranch, request, { changes, head: HEAD }, evidence, RUN)).toThrow(/names no branch/);
    expect(() => prototypeEventFrom(triage, request, { changes, head: HEAD }, evidence, RUN)).toThrow(/triage result/);
  });
});

describe("A failed agent run", () => {
  const job = {
    role: "triage" as const,
    issue: 7,
    runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    jobResult: "failure",
    secretsStep: "success",
    report: { failure: "weekly-limit" as const, detail: "seven_day", resetsAt: "2026-11-09T04:00:00.000Z" },
  };

  it("carries the Subscription the run used", () => {
    expect(agentFailureEventFrom({ ...job, subscription: "Claude token 2" })).toEqual({
      kind: "agent-run-failed",
      role: "triage",
      issue: 7,
      runUrl: job.runUrl,
      jobResult: "failure",
      secretsStep: "success",
      report: job.report,
      subscription: "Claude token 2",
    });
  });

  it("names no Subscription when the Kit job passed none out", () => {
    expect(agentFailureEventFrom(job)).not.toHaveProperty("subscription");
  });

  it("says a failed Design-session turn was the session's prototype turn when the push job found it was, and says nothing of it otherwise", () => {
    expect(agentFailureEventFrom({ ...job, role: "design", prototype: true })).toMatchObject({ role: "design", prototype: true });
    expect(agentFailureEventFrom({ ...job, role: "design" })).not.toHaveProperty("prototype");
  });
});

describe("A finished Kept-branch start (#536)", () => {
  const built = (ref: string) => ({ name: "fabrik/ticket-7", base: { ref, sha: "b".repeat(40) }, head: "c".repeat(40) });
  const RUN = "https://github.com/acme/shop/actions/runs/9100/attempts/1";
  const changes = { net: [{ path: "src/waitlist.ts" }], commits: [{ path: "src/waitlist.ts" }] };
  const kept = { pullRequest: 230, base: "main" };

  it("is a first run on the branch it carried on, opening against the default branch the Kit job named, naming the closed PR", () => {
    const result = { role: "implement", issue: 7, output: "{}", branch: built("fabrik/ticket-7") } as const;

    const event = agentRunEventFrom(result, changes, null, null, null, RUN, kept);

    expect(event).toMatchObject({ kind: "implement-run-finished", branch: "fabrik/ticket-7", base: "main", keptBranch: { pullRequest: 230 } });
    expect(event).not.toHaveProperty("fixes");
  });

  it.each([
    ["a first run that built on its own branch without the Kit job's plan", built("fabrik/ticket-7"), null, null, "built on fabrik/ticket-7 itself, but it isn't a retry or a Kept-branch start"],
    ["a Kept-branch start that cut its branch from main", built("main"), null, kept, "didn't carry on fabrik/ticket-7"],
    ["a retry that cut its branch from main", built("main"), { pullRequest: 50 }, null, "didn't build on fabrik/ticket-7"],
  ])("refuses %s", (_, branch, retry, keptBranch, message) => {
    expect(() => checkBuiltAsPlanned(7, branch, retry, keptBranch)).toThrow(message);
  });

  it.each([
    ["a first run from main", built("main"), null, null],
    ["a retry on its PR's branch", built("fabrik/ticket-7"), { pullRequest: 50 }, null],
    ["a Kept-branch start on its Kept branch", built("fabrik/ticket-7"), null, kept],
  ])("takes %s", (_, branch, retry, keptBranch) => {
    expect(() => checkBuiltAsPlanned(7, branch, retry, keptBranch)).not.toThrow();
  });
});
