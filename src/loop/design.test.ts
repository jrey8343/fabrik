import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";

const startsDesignTurn = {
  kind: "act",
  actions: [
    {
      kind: "start-agent-run",
      role: "design",
      issue: 7,
      model: "claude-opus-5-5",
      effort: null,
      timeoutMinutes: 30,
    },
  ],
};

describe("Starting a Design-session turn", () => {
  it("asks the Design queue check to start round 1 when needs-design is added to an open issue", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-design" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-design-queue" }] });
  });

  it("does not start a session on a closed issue, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"], open: false });

    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-design" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 is closed" });
  });

  it("does nothing when some other label is added, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design", "docs"] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "docs" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "The Loop doesn't act on docs being added to #7" });
  });

  it("does nothing when needs-design was removed again before the run started, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-agent"] });

    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-design" }, snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 no longer has needs-design" });
  });
});

describe("Answering a Design-session round", () => {
  const commented = (commenter: string, commenterIsBot = false) =>
    ({ kind: "issue-comment-created", issue: 7, commenter, commenterIsBot, body: "yes", comment: 9001 }) as const;
  const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"] }), { operator: "jrey" });

  it("starts the next turn when the Operator comments on a needs-design issue", () => {
    const plan = planFor(commented("jrey"), inSession, kitConfig());

    expect(plan).toEqual(startsDesignTurn);
  });

  it("does nothing when someone other than the Operator comments, saying why", () => {
    const plan = planFor(commented("someone"), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "@someone isn't the Operator, so their comment on #7 doesn't drive the Design session",
    });
  });

  it.each(["fabrik-app[bot]", "dependabot[bot]"])("does nothing when the bot %s comments, saying why", (bot) => {
    const plan = planFor(commented(bot, true), inSession, kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: `@${bot} is a bot, so its comment on #7 doesn't drive the Loop`,
    });
  });

  it("does nothing when the Operator comments on an issue that isn't in a Design session", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"] });

    const plan = planFor(commented("jrey"), snapshotOf(issue, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 isn't in needs-info" });
  });

  it("does nothing when the Operator comments on a closed needs-design issue", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"], open: false });

    const plan = planFor(commented("jrey"), snapshotOf(issue, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 is closed" });
  });
});

describe("Posting a Design-session round", () => {
  const turnFinished = (output: unknown) =>
    ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;
  const round = {
    kind: "round",
    intro: "Two questions on the waitlist before I draft the brief.",
    questions: [
      { question: "Should patients who are too slow stay on the list?", recommendation: "Yes, with no follow-up text." },
      { question: "When does an entry end?", recommendation: "On booking, on STOP, or when the day passes." },
    ],
  };

  it("posts round 1 as numbered questions with recommended answers, @-mentioning the Operator", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });

    const plan = planFor(turnFinished(round), snapshotOf(issue, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-round 1 -->",
            "@jrey **Design session, round 1.** Reply with the numbers you'd answer differently, or `yes` to take every recommendation.",
            "",
            "Two questions on the waitlist before I draft the brief.",
            "",
            "**1. Should patients who are too slow stay on the list?**",
            "➡️ Recommended: Yes, with no follow-up text.",
            "",
            "**2. When does an entry end?**",
            "➡️ Recommended: On booking, on STOP, or when the day passes.",
          ].join("\n"),
        },
      ],
    });
  });

  it("numbers the round after the rounds already posted on the issue", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"], designRounds: 2 });

    const plan = planFor(turnFinished(round), snapshotOf(issue), kitConfig());

    expect(plan).toMatchObject({
      kind: "act",
      actions: [{ kind: "comment", body: expect.stringContaining("**Design session, round 3.**") }],
    });
  });

  it("@-mentions only the Operator, even when the agent's text mentions someone", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });
    const noisy = {
      ...round,
      intro: "Ask @someone-else and @org/team about this.",
      questions: [{ question: "Loop in @reviewer?", recommendation: "No, @reviewer can wait." }],
    };

    const plan = planFor(turnFinished(noisy), snapshotOf(issue, { operator: "jrey" }), kitConfig());

    expect(plan.kind).toBe("act");
    const body = plan.kind === "act" && plan.actions[0]?.kind === "comment" ? plan.actions[0].body : "";
    expect(mentionsIn(body)).toEqual(["jrey"]);
  });

  it.each([
    ["is not JSON", "a round"],
    ["has an unknown kind", JSON.stringify({ kind: "maybe" })],
    ["is a round with no questions", JSON.stringify({ kind: "round", intro: "Hm.", questions: [] })],
    [
      "is a round with a question but no recommendation",
      JSON.stringify({ kind: "round", intro: "Hm.", questions: [{ question: "Why?" }] }),
    ],
    [
      "is a brief with no acceptance criteria",
      JSON.stringify({ kind: "brief", comment: "Done.", brief: { summary: "Fix it.", acceptanceCriteria: [] } }),
    ],
    ["is a brief with no comment", JSON.stringify({ kind: "brief", brief: { summary: "Fix it.", acceptanceCriteria: ["Works"] } })],
  ])("fails the turn as an Infrastructure failure, changing nothing, when the output %s", (_, output) => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });

    const plan = planFor({ kind: "agent-run-finished", role: "design", issue: 7, output }, snapshotOf(issue), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });

  it("drops a turn's output if the issue left needs-design while the turn ran, saying why", () => {
    const issue = anIssue({ number: 7, labels: ["ready-for-human"] });

    const plan = planFor(turnFinished(round), snapshotOf(issue), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "#7 no longer has needs-design" });
  });
});

describe("Finishing a Design session with an agent brief", () => {
  const finished = {
    kind: "brief",
    comment: "We settled on a waitlist with SMS fan-out. Thanks @someone for the idea.",
    brief: {
      summary: "Offer a waitlist when the patient's physio is fully booked that day.",
      acceptanceCriteria: ["A fully booked day shows Join waitlist", "Joining needs SMS consent"],
    },
  };

  it("rewrites the issue in place as the agent brief, and swaps needs-design for ready-for-agent", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(finished) },
      snapshotOf(issue, { operator: "jrey" }),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "edit-issue-body",
          issue: 7,
          body: [
            "## Agent brief",
            "",
            "Offer a waitlist when the patient's physio is fully booked that day.",
            "",
            "## Acceptance criteria",
            "",
            "- [ ] A fully booked day shows Join waitlist",
            "- [ ] Joining needs SMS consent",
            "",
            "<sub>Written by the Fabrik Design session in the thread below. The original issue is in this issue's edit history.</sub>",
          ].join("\n"),
        },
        {
          kind: "comment",
          issue: 7,
          body: [
            "**Design session finished.** This issue is now its agent brief, ready for an Implementer.",
            "",
            "We settled on a waitlist with SMS fan-out. Thanks @​someone for the idea.",
          ].join("\n"),
        },
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("runs a Dispatch check once the brief has landed, so the Ticket can start straight away", () => {
    const issue = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(finished) },
      snapshotOf(issue),
      kitConfig(),
    );

    expect(plan.kind === "act" ? plan.actions : []).toContainEqual({ kind: "check-dispatch" });
  });

  it("notifies nobody: neither the body nor the comment @-mentions anyone", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });
    const noisy = { ...finished, brief: { ...finished.brief, summary: "Ping @jrey and @someone." } };

    const plan = planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(noisy) },
      snapshotOf(issue, { operator: "jrey" }),
      kitConfig(),
    );

    expect(plan.kind).toBe("act");
    const texts = plan.kind === "act" ? plan.actions.flatMap((a) => ("body" in a && typeof a.body === "string" ? [a.body] : [])) : [];
    expect(texts).toHaveLength(2);
    expect(texts.flatMap(mentionsIn)).toEqual([]);
  });
});

/** The logins GitHub would notify for this Markdown: `@name` not preceded by a word character. */
function mentionsIn(markdown: string): string[] {
  return [...markdown.matchAll(/(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[\w-]+)?)/g)].map(
    (match) => match[1] ?? "",
  );
}
