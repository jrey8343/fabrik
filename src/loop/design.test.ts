import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { roundLineIn, withoutRoundLines } from "./roundLine.ts";
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
      subscription: "Claude token",
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
  const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), {
    operator: "jrey",
  });

  it("starts the next turn when the Operator replies to a round", () => {
    const plan = planFor(commented("jrey"), inSession, kitConfig());

    expect(plan).toEqual(startsDesignTurn);
  });

  it("starts the turn again when the Operator replies after a turn failed, since the session keeps its slot", () => {
    const failed = anIssue({ number: 7, labels: ["enhancement", "needs-design"], turnFailed: true });

    const plan = planFor(commented("jrey"), snapshotOf(failed, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual(startsDesignTurn);
  });

  it("starts the next turn when the Operator comments while round 1's turn is running, since it holds a slot", () => {
    const running = anIssue({ number: 7, labels: ["enhancement", "needs-design"], firstTurnClaimed: true });

    const plan = planFor(commented("jrey"), snapshotOf(running, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual(startsDesignTurn);
  });

  it("starts nothing when the Operator comments on an issue waiting for a Design session slot: the comment is context for round 1", () => {
    const waiting = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    const plan = planFor(commented("jrey"), snapshotOf(waiting, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "#7 holds no Design session slot yet, so the Operator's comment is context for its round 1, not a turn of its own",
    });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("starts nothing when someone else comments on a waiting issue, saying why", () => {
    const waiting = anIssue({ number: 7, labels: ["enhancement", "needs-design"] });

    const plan = planFor(commented("someone"), snapshotOf(waiting, { operator: "jrey" }), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "@someone isn't the Operator, so their comment on #7 doesn't drive the Design session",
    });
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

    // Its hidden line aside (#635), the comment is as it always was.
    const withoutLine = plan.kind === "act" ? { ...plan, actions: plan.actions.map((action) => (action.kind === "comment" ? { ...action, body: withoutRoundLines(action.body) } : action)) } : plan;
    expect(withoutLine).toEqual({
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

describe("A Design-session round carries its fields in a hidden line", () => {
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
  const bodyOf = (plan: ReturnType<typeof planFor>): string =>
    plan.kind === "act" && plan.actions[0]?.kind === "comment" ? plan.actions[0].body : "";

  it("puts the line second, under the round's marker, and reads back the round's number, intro and questions", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"], designRounds: 2 });

    const body = bodyOf(planFor(turnFinished(round), snapshotOf(issue, { operator: "jrey" }), kitConfig()));

    expect(body.split("\n")[0]).toBe("<!-- fabrik:design-round 3 -->");
    expect(body.split("\n")[1]).toMatch(/^<!-- fabrik:round-line \{.*\} -->$/);
    expect(roundLineIn(body)).toEqual({
      v: 1,
      kind: "round",
      round: 3,
      intro: "Two questions on the waitlist before I draft the brief.",
      questions: [
        { question: "Should patients who are too slow stay on the list?", recommendation: "Yes, with no follow-up text." },
        { question: "When does an entry end?", recommendation: "On booking, on STOP, or when the day passes." },
      ],
    });
  });

  it("writes fields holding -->, <, > or @ so they can't end the line's comment or mention anyone, and reads them back as the comment shows them", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });
    const awkward = {
      kind: "round",
      intro: "Does `a --> b` close <details> for @someone?",
      questions: [{ question: "Keep <!-- this --> in?", recommendation: "Ask @org/team, then -->" }],
    };

    const body = bodyOf(planFor(turnFinished(awkward), snapshotOf(issue, { operator: "jrey" }), kitConfig()));

    const line = body.split("\n")[1] ?? "";
    expect(line.indexOf("-->")).toBe(line.length - "-->".length);
    expect(line.slice("<!--".length, -"-->".length)).not.toMatch(/[<>@]/);
    expect(mentionsIn(body)).toEqual(["jrey"]);
    const shown = withoutRoundLines(body).split("\n");
    expect(roundLineIn(body)).toMatchObject({
      intro: shown[3],
      questions: [{ question: shown[5]?.replace(/^\*\*1\. (.*)\*\*$/, "$1"), recommendation: shown[6]?.replace(/^➡️ Recommended: /, "") }],
    });
    expect(roundLineIn(body)?.intro).toBe("Does `a --> b` close <details> for @​someone?");
  });

  describe("a round too long for GitHub with its line", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });
    const bodyWith = (intro: string) => bodyOf(planFor(turnFinished({ ...round, intro }), snapshotOf(issue, { operator: "jrey" }), kitConfig()));
    /** An intro whose round, with its line, is exactly GitHub's 65,536 characters: each `a` adds 2 (once shown, once in the line) and a `<` adds 7 (its escape is 6). */
    const introAtTheLimit = (): string => {
      const short = bodyWith("a").length;
      const odd = (65_536 - short) % 2 === 1;
      const left = 65_536 - short - (odd ? 7 - 2 : 0);
      return `${odd ? "<" : "a"}${"a".repeat(left / 2)}`;
    };

    it("keeps its line at exactly 65,536 characters", () => {
      const body = bodyWith(introAtTheLimit());

      expect(body).toHaveLength(65_536);
      expect(roundLineIn(body)).not.toBeNull();
    });

    it("is posted without its line one character past, as it would have been", () => {
      const intro = `${introAtTheLimit()}b`;
      const body = bodyWith(intro);

      expect(roundLineIn(body)).toBeNull();
      expect(body.split("\n")[1]).toBe(
        "@jrey **Design session, round 1.** Reply with the numbers you'd answer differently, or `yes` to take every recommendation.",
      );
      expect(body.split("\n")[3]).toBe(intro);
    });

    it("counts the Operator comments it weighed toward the limit", () => {
      const sentBack = anIssue({ number: 7, labels: ["needs-design"], sentBack: { pullRequest: 50, verdictUrl: null } });
      const finished = {
        ...turnFinished({ ...round, intro: introAtTheLimit(), operatorCommentsConsidered: ["inline-8"] }),
        operatorComments: [{ id: "inline-8", url: "https://github.com/acme/shop/pull/50#discussion_r8" }],
      };

      const body = bodyOf(planFor(finished, snapshotOf(sentBack, { operator: "jrey" }), kitConfig()));

      expect(body).toContain("### Operator comments considered");
      expect(roundLineIn(body)).toBeNull();
    });
  });

  it("marks a round whose output asks the Map question", () => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });

    const body = bodyOf(planFor(turnFinished({ ...round, asksMap: true }), snapshotOf(issue), kitConfig()));

    expect(roundLineIn(body)).toMatchObject({ round: 1, asksMap: true });
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ["malformed", "yes"],
  ])("leaves the mark out when asksMap is %s, and lands the round all the same", (_, asksMap) => {
    const issue = anIssue({ number: 7, labels: ["needs-design"] });

    const plan = planFor(turnFinished({ ...round, asksMap }), snapshotOf(issue), kitConfig());

    expect(plan.kind).toBe("act");
    expect(roundLineIn(bodyOf(plan))).not.toHaveProperty("asksMap");
    expect(bodyOf(plan)).toBe(bodyOf(planFor(turnFinished(round), snapshotOf(issue), kitConfig())));
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

describe("Setting a Stepped-up start from a Design session's agent brief", () => {
  const brief = {
    summary: "Offer a waitlist when the patient's physio is fully booked that day.",
    acceptanceCriteria: ["A fully booked day shows Join waitlist"],
  };
  const finish = (output: unknown, labels: string[]) =>
    planFor(
      { kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) },
      snapshotOf(anIssue({ number: 7, labels }), { operator: "jrey" }),
      kitConfig(),
    );
  const labelMoves = (plan: ReturnType<typeof planFor>) =>
    plan.kind === "act" ? plan.actions.filter((a) => a.kind === "add-labels" || a.kind === "remove-label") : [];

  it("adds fabrik:step-up along with ready-for-agent when the brief has stepUp: true", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, stepUp: true } }, ["needs-design"]);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent", "fabrik:step-up"] },
    ]);
  });

  it("keeps fabrik:step-up, removing nothing, when the brief has stepUp: true on an issue already marked", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, stepUp: true } }, ["needs-design", "fabrik:step-up"]);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent", "fabrik:step-up"] },
    ]);
  });

  it("takes fabrik:step-up off an issue that has it when the brief has stepUp: false", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, stepUp: false } }, ["needs-design", "fabrik:step-up"]);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "remove-label", issue: 7, label: "fabrik:step-up" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
    ]);
  });

  it("removes nothing more when the brief has stepUp: false on an issue without the mark", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, stepUp: false } }, ["needs-design"]);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
    ]);
  });

  it.each([
    ["keeps the mark on an issue that has it", ["needs-design", "fabrik:step-up"]],
    ["doesn't add the mark to an issue that doesn't have it", ["needs-design"]],
  ])("leaves fabrik:step-up as it stands when the brief has no stepUp: %s", (_, labels) => {
    const plan = finish({ kind: "brief", comment: "Done.", brief }, labels);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
    ]);
  });

  it("refuses a stepUp that isn't a boolean, naming the field", () => {
    const plan = finish({ kind: "brief", comment: "Done.", brief: { ...brief, stepUp: "yes" } }, ["needs-design"]);

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: a brief needs stepUp to be true or false, if it has one",
    });
  });

  it.each([true, false])("neither adds nor removes fabrik:step-up for an Operator brief with stepUp: %s", (stepUp) => {
    const operatorBrief = { operator: true, summary: "Rotate the SMS token.", steps: ["Rotate it"], stepUp };

    const plan = finish({ kind: "brief", comment: "Done.", brief: operatorBrief }, ["needs-design", "fabrik:step-up"]);

    expect(labelMoves(plan)).toEqual([
      { kind: "remove-label", issue: 7, label: "needs-design" },
      { kind: "add-labels", issue: 7, labels: ["ready-for-human"] },
    ]);
  });
});

/** The logins GitHub would notify for this Markdown: `@name` not preceded by a word character. */
function mentionsIn(markdown: string): string[] {
  return [...markdown.matchAll(/(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[\w-]+)?)/g)].map(
    (match) => match[1] ?? "",
  );
}
