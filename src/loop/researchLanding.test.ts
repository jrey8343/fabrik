import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
const BRANCH = "research/12-which-payment-provider-fits-group-classes";
const FINDINGS = "docs/research/12-which-payment-provider-fits-group-classes.md";

type ResearchRunFinished = Extract<LoopEvent, { kind: "research-run-finished" }>;

/** A Researcher run's push job on Decision #12: its reply, and a branch that changes only its findings file. */
function finished(overrides: Partial<ResearchRunFinished> = {}): ResearchRunFinished {
  return {
    kind: "research-run-finished",
    issue: 12,
    output: JSON.stringify({
      gist: "Stripe splits a group-class payment across instructors; Square can't.",
      keyFacts: [
        "Stripe Connect splits one charge across several accounts (https://docs.stripe.com/connect/charges)",
        "Square's Payments API takes one recipient per payment (https://developer.squareup.com/docs/payments-api)",
      ],
    }),
    branch: BRANCH,
    changes: { net: [{ path: FINDINGS }], commits: [{ path: FINDINGS }] },
    runUrl: RUN,
    repoUrl: "https://github.com/acme/shop",
    ...overrides,
  };
}

/** An open research Decision under the open Map #3. */
const aDecision = (overrides: Parameters<typeof anIssue>[0] = {}) =>
  anIssue({
    number: 12,
    title: "Which payment provider fits group classes?",
    labels: ["wayfinder:research"],
    parent: 3,
    parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
    ...overrides,
  });

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("Landing a research run", () => {
  it("a good run pushes its branch, posts the resolution on the Decision, closes it as completed, appends its line to the Map's Decisions so far and asks for a Dispatch check", () => {
    const plan = planFor(finished(), snapshotOf(aDecision()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-branch", branch: BRANCH },
        {
          kind: "comment",
          issue: 12,
          key: "resolution",
          body: [
            "The Researcher's answer: Stripe splits a group-class payment across instructors; Square can't.",
            "",
            "Key facts:",
            "",
            "- Stripe Connect splits one charge across several accounts (https://docs.stripe.com/connect/charges)",
            "- Square's Payments API takes one recipient per payment (https://developer.squareup.com/docs/payments-api)",
            "",
            `[The findings](https://github.com/acme/shop/blob/${BRANCH}/${FINDINGS}) · [The run](${RUN})`,
          ].join("\n"),
        },
        { kind: "close", issue: 12, reason: "completed" },
        {
          kind: "append-to-decisions-so-far",
          issue: 3,
          line: [
            "- [Which payment provider fits group classes?](",
            { posted: "resolution" },
            "): Stripe splits a group-class payment across instructors; Square can't.",
          ],
        },
        { kind: "check-dispatch" },
      ],
    });
  });

  it.each([
    ["a closed Decision", aDecision({ open: false }), "#12 is closed"],
    [
      "a Decision no longer labelled for research",
      aDecision({ labels: ["wayfinder:grilling"] }),
      "#12 has no wayfinder:research label, so it isn't a research Decision",
    ],
    [
      "a Decision whose Map is closed",
      aDecision({ parentIssue: { number: 3, open: false, labels: ["enhancement", "wayfinder:map"] } }),
      "#12's Map #3 is closed",
    ],
    ["a Decision taken off its Map", aDecision({ parent: null, parentIssue: null }), "#12 isn't a sub-issue of a Map"],
  ])("a run that lands on %s pushes nothing and posts nothing, notes why, and asks for a Dispatch check for the slot it held", (_subject, decision, why) => {
    const plan = planFor(finished(), snapshotOf(decision), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }],
      notes: [`${why}, so the Researcher's findings aren't landed`],
    });
  });
});

describe("A research branch that changes more than its findings file", () => {
  it("is refused: nothing is pushed or closed, and the failure notice on the Decision tells the Operator which paths and how to run it again", () => {
    const event = finished({
      changes: {
        net: [{ path: FINDINGS }, { path: "src/checkout.ts" }],
        commits: [{ path: FINDINGS }, { path: "src/checkout.ts" }],
      },
    });

    const plan = planFor(event, snapshotOf(aDecision()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 12, label: "agent:research" },
        {
          kind: "comment",
          issue: 12,
          body: [
            "<!-- fabrik:research-run-failed -->",
            `@operator The Researcher's branch for #12 changes more than its findings file, \`${FINDINGS}\`, the one file a research run may change, so the Kit didn't push it:`,
            "",
            "- `src/checkout.ts`",
            "",
            "The Decision stays open. Re-add `agent:research` on this Decision to run it again.",
            "",
            `[The run](${RUN})`,
          ].join("\n"),
        },
        { kind: "check-dispatch" },
      ],
    });
  });

  it.each([
    ["a change made in one commit and undone in a later one", { net: [{ path: FINDINGS }], commits: [{ path: FINDINGS }, { path: "src/checkout.ts" }] }],
    ["a file moved into the findings file", { net: [{ path: FINDINGS, from: "src/checkout.ts" }], commits: [{ path: FINDINGS, from: "src/checkout.ts" }] }],
  ])("%s is refused too", (_how, changes) => {
    const plan = planFor(finished({ changes }), snapshotOf(aDecision()), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["remove-label", "comment", "check-dispatch"]);
    expect(commentsOf(plan)[0]).toContain("- `src/checkout.ts`");
  });
});

describe("What a landed research run writes", () => {
  it("mentions nobody: not in the resolution, and not in the Map's line", () => {
    const output = JSON.stringify({ gist: "Ask @operator about Stripe", keyFacts: ["cc @operator", "Stripe Connect splits charges"] });

    const plan = planFor(finished({ output }), snapshotOf(aDecision({ title: "Ping @operator: which provider?" })), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toContain("append-to-decisions-so-far");
    expect(notificationsOf(plan)).toEqual([]);
  });

  it("names the Decision in the Map's line with its brackets escaped, so its title can't break the link", () => {
    const plan = planFor(finished(), snapshotOf(aDecision({ title: "Pick a provider [payments] \\" })), kitConfig());

    expect(actionsOf(plan)).toContainEqual({
      kind: "append-to-decisions-so-far",
      issue: 3,
      line: [
        "- [Pick a provider \\[payments\\] \\\\](",
        { posted: "resolution" },
        "): Stripe splits a group-class payment across instructors; Square can't.",
      ],
    });
  });

  it("keeps a key fact of several lines in its one list item", () => {
    const output = JSON.stringify({
      gist: "Stripe.",
      keyFacts: ["Stripe Connect splits one charge.\nSource: https://docs.stripe.com/connect/charges", "Square can't."],
    });

    const [resolution] = commentsOf(planFor(finished({ output }), snapshotOf(aDecision()), kitConfig()));

    expect(resolution).toContain(
      "- Stripe Connect splits one charge.\n  Source: https://docs.stripe.com/connect/charges\n- Square can't.\n",
    );
  });
});

describe("A research run whose output breaks its contract", () => {
  it.each([
    ["isn't JSON", "The answer is Stripe."],
    ["has no gist", JSON.stringify({ keyFacts: ["Stripe Connect splits charges"] })],
    ["has a gist of two lines", JSON.stringify({ gist: "Stripe.\nNot Square.", keyFacts: ["Stripe Connect splits charges"] })],
    ["has no key facts", JSON.stringify({ gist: "Stripe.", keyFacts: [] })],
  ])("that %s fails as Infrastructure, and nothing lands", (_how, output) => {
    const plan = planFor(finished({ output }), snapshotOf(aDecision()), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it("fails as Infrastructure on a branch named for another Decision, so no findings land on the wrong one", () => {
    const plan = planFor(finished({ branch: "research/13-which-payment-provider-fits-group-classes" }), snapshotOf(aDecision()), kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "`research/13-which-payment-provider-fits-group-classes` isn't #12's research branch",
    });
  });
});

describe("A research branch with no findings file", () => {
  it.each([
    ["changes nothing", { net: [], commits: [] }],
    ["writes its findings file and removes it again", { net: [], commits: [{ path: FINDINGS }] }],
  ])("that %s lands nothing, and the failure notice on the Decision says so", (_how, changes) => {
    const plan = planFor(finished({ changes }), snapshotOf(aDecision()), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["remove-label", "comment", "check-dispatch"]);
    const [notice] = commentsOf(plan);
    expect(notice).toMatch(/^<!-- fabrik:research-run-failed -->\n/);
    expect(notice).toContain(`@operator The Researcher's branch for #12 doesn't write its findings file, \`${FINDINGS}\`, so there's nothing to land.`);
  });
});

describe("The trust-root guard on a research branch", () => {
  it("refuses a branch that touched a trust root, even in a commit a later one undid, naming the file and ADR-0005", () => {
    const event = finished({
      changes: { net: [{ path: FINDINGS }], commits: [{ path: FINDINGS }, { path: ".github/workflows/ci.yml" }] },
    });

    const plan = planFor(event, snapshotOf(aDecision()), kitConfig());

    expect(actionsOf(plan).map(({ kind }) => kind)).toEqual(["remove-label", "comment", "check-dispatch"]);
    const [notice] = commentsOf(plan);
    expect(notice).toMatch(/^<!-- fabrik:research-run-failed -->\n/);
    expect(notice).toContain(
      "@operator The Researcher's branch for #12 changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):\n\n- `.github/workflows/ci.yml`\n",
    );
  });
});

describe("A failed research run", () => {
  /** A Researcher job that failed on Decision #12, as its push job sees it. */
  const failed = (overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent => ({
    kind: "agent-run-failed",
    role: "research",
    issue: 12,
    runUrl: RUN,
    jobResult: "failure",
    secretsStep: "success",
    report: null,
    ...overrides,
  });

  it("posts the usual failure notice on the Decision, opening with the research failure marker that Dispatch reads as its last run failing, and naming no retries, which a Decision hasn't", () => {
    const plan = planFor(failed({ jobResult: "cancelled", secretsStep: null }), snapshotOf(aDecision()), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 12, label: "agent:research" },
        {
          kind: "comment",
          issue: 12,
          body: [
            "<!-- fabrik:research-run-failed -->",
            "@operator The Research run on #12 failed: it was cancelled, by its 30-minute timeout or by hand.",
            "",
            "This is an Infrastructure failure, so neither the Loop nor Dispatch runs it again by itself. Re-add `agent:research` on this Decision to run it again.",
            "",
            `[The run](${RUN})`,
          ].join("\n"),
        },
      ],
    });
  });

  it.each([
    ["crash", failed(), "it crashed"],
    ["missing output", failed({ report: { failure: "missing-output", detail: "" } }), "the agent gave no valid output"],
    ["provider error", failed({ report: { failure: "provider-error", detail: "" } }), "the model provider returned an error"],
    ["1Password outage", failed({ secretsStep: "failure" }), "its secrets couldn't be loaded from 1Password"],
  ])("a %s is classed as for any other role, under the marker", (_name, event, how) => {
    const [notice] = commentsOf(planFor(event, snapshotOf(aDecision()), kitConfig()));

    expect(notice).toMatch(/^<!-- fabrik:research-run-failed -->\n@operator /);
    expect(notice).toContain(`The Research run on #12 failed: ${how}.`);
  });

  it("a dead token opens the repo's token-rotation issue, and the Decision's notice still opens with the marker and points there", () => {
    const plan = planFor(
      failed({ report: { failure: "dead-token", detail: "authentication_failed (401)" } }),
      snapshotOf(aDecision()),
      kitConfig(),
    );

    expect(actionsOf(plan)).toContainEqual(expect.objectContaining({ kind: "open-issue", title: "Rotate the Claude token" }));
    const [notice] = commentsOf(plan);
    expect(notice).toMatch(/^<!-- fabrik:research-run-failed -->\nThe Research run on #12 failed: /);
  });
});
