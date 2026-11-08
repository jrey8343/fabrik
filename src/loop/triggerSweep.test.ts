// The stuck-trigger sweep (#419), through the scheduled tick that runs it.
import { describe, expect, it } from "vitest";
import { aReplayIssue, replaySlice } from "../__fixtures__/replay.ts";
import {
  aDesignQueueIssue,
  aLabelledTrigger,
  anIssue,
  aResearchDecision,
  aTicket,
  designQueueSnapshotOf,
  dispatchSnapshotOf,
  kitConfig,
  NOTHING_UNDER_WAY,
  snapshotOf,
  tickSnapshot,
} from "../__fixtures__/snapshots.ts";
import { designTurnFailedIn, implementRunFailedIn, researchRunFailedIn } from "../github/threads.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";
import type { Action, LabelledTrigger, Plan, RolesUnderWay } from "./types.ts";

/** Monday 04:00 UTC: no Audit or Retro is due, so the tick's own plan is just its queue checks. */
const tick = { kind: "scheduled-tick", now: "2026-11-09T04:00:00.000Z" } as const;

function sweep(labelled: readonly LabelledTrigger[], underWay: RolesUnderWay | null = NOTHING_UNDER_WAY): Plan {
  return planFor(tick, tickSnapshot({ triggers: { underWay, labelled } }), kitConfig());
}

describe("The stuck-trigger sweep on the scheduled tick", () => {
  it("re-adds agent:implement left on an hour with no Implement job under way, saying so without mentioning anyone, before the queue checks", () => {
    const plan = sweep([aLabelledTrigger({ number: 7, label: "agent:implement", lastAddedAt: "2026-11-09T03:00:00Z" })]);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
        {
          kind: "comment",
          issue: 7,
          body: "<!-- fabrik:stuck-trigger-readded agent:implement -->\n`agent:implement` sat 60 minutes with no run behind it, so the Kit added it again.",
        },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("leaves one added under 30 minutes ago alone: its run may still be starting", () => {
    const plan = sweep([aLabelledTrigger({ lastAddedAt: "2026-11-09T03:31:00Z" })]);

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });

  it("leaves one whose timeline doesn't show it being added alone, since how long it sat isn't known", () => {
    const plan = sweep([aLabelledTrigger({ lastAddedAt: null })]);

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });

  it.each<[LabelledTrigger["label"], Partial<RolesUnderWay>]>([
    ["agent:implement", { implement: true }],
    ["agent:research", { research: true }],
    ["agent:review", { review: true }],
    ["agent:design", { designTurns: [7] }],
    ["agent:replay", { claim: true }],
    ["agent:replay", { implement: true }],
    ["agent:replay", { review: true }],
  ])("leaves %s alone while a job of its role is under way anywhere in the repo (%o)", (label, underWay) => {
    const plan = sweep([aLabelledTrigger({ number: 7, label })], { ...NOTHING_UNDER_WAY, ...underWay });

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });

  it.each<[LabelledTrigger["label"], Partial<RolesUnderWay>]>([
    ["agent:implement", { research: true, review: true, claim: true, designTurns: [7] }],
    ["agent:research", { implement: true, review: true, claim: true, designTurns: [7] }],
    ["agent:review", { implement: true, research: true, claim: true, designTurns: [7] }],
    ["agent:design", { implement: true, research: true, review: true, claim: true, designTurns: [8] }],
    ["agent:replay", { research: true, designTurns: [7] }],
  ])("sweeps %s while only other roles' jobs are under way (%o)", (label, underWay) => {
    const plan = sweep([aLabelledTrigger({ number: 7, label })], { ...NOTHING_UNDER_WAY, ...underWay });

    expect(plan).toEqual({
      kind: "act",
      actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: [label] }]),
    });
  });

  it("takes agent:implement off on a second strike, parking the Ticket with the Implement failure marker and @-mentioning the Operator once", () => {
    const plan = sweep([aLabelledTrigger({ number: 7, label: "agent:implement", readded: true })]);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "agent:implement" },
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:implement-run-failed -->",
            "<!-- fabrik:stuck-trigger-gave-up agent:implement -->",
            "@operator `agent:implement` came off: nothing started when it was added, nor when the Kit added it again. Check the Loop's Actions runs (an invalid Kit config is the usual cause), then add `agent:implement` again once it's fixed.",
          ].join("\n"),
        },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it.each<[LabelledTrigger["label"], string[]]>([
    ["agent:research", ["<!-- fabrik:research-run-failed -->", "<!-- fabrik:stuck-trigger-gave-up agent:research -->"]],
    ["agent:design", ["<!-- fabrik:design-turn-failed -->", "<!-- fabrik:stuck-trigger-gave-up agent:design -->"]],
    ["agent:review", ["<!-- fabrik:stuck-trigger-gave-up agent:review -->"]],
    ["agent:replay", ["<!-- fabrik:stuck-trigger-gave-up agent:replay -->"]],
  ])("parks %s on a second strike as its role's failed run does", (label, markers) => {
    const plan = sweep([aLabelledTrigger({ number: 7, label, readded: true })]);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label },
        { kind: "comment", issue: 7, body: expect.stringMatching(new RegExp(`^${markers.join("\n")}\n@operator \`${label}\` came off`)) },
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });

  it("leaves every label alone when the Actions API can't be read, saying so in the step summary", () => {
    const plan = sweep([aLabelledTrigger(), aLabelledTrigger({ number: 8, readded: true })], null);

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }],
      notes: ["The stuck-trigger sweep left every trigger label alone: the Actions API couldn't be read, so whether a run is behind one isn't known"],
    });
  });

  it("sweeps each stuck label in one tick, alongside the rest of the tick's plan", () => {
    const plan = planFor(
      { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" },
      tickSnapshot({ triggers: { underWay: NOTHING_UNDER_WAY, labelled: [aLabelledTrigger({ number: 7, lastAddedAt: "2026-11-08T03:00:00Z" }), aLabelledTrigger({ number: 8, label: "agent:review", lastAddedAt: "2026-11-08T02:00:00Z", readded: true })] } }),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "add-labels", issue: 7, labels: ["agent:implement"] },
        expect.objectContaining({ kind: "comment", issue: 7 }),
        { kind: "remove-label", issue: 8, label: "agent:review" },
        expect.objectContaining({ kind: "comment", issue: 8 }),
        // Sunday: the tick opens the week's pending Audit after the sweep.
        expect.objectContaining({ kind: "open-issue", labels: ["fabrik:audit"] }),
        { kind: "check-dispatch" },
        { kind: "check-design-queue" },
      ],
    });
  });
});

/** The comment the sweep posts on #7 for this label, on its second strike. */
function giveUpComment(label: LabelledTrigger["label"]): string {
  const plan = sweep([aLabelledTrigger({ number: 7, label, readded: true })]);
  const comment = (plan.kind === "act" ? plan.actions : []).find((action): action is Extract<Action, { kind: "comment" }> => action.kind === "comment");
  if (comment === undefined) throw new Error("The sweep posted no comment");
  return comment.body;
}

describe("After the sweep gives up, no check adds the label back by itself", () => {
  it("Dispatch reads the Ticket's last Implement run as failed, and skips it", () => {
    const kitWord = [{ body: giveUpComment("agent:implement"), byApp: true }];
    expect(implementRunFailedIn(kitWord)).toBe(true);

    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([aTicket({ number: 7, lastRunFailed: implementRunFailedIn(kitWord) })]), kitConfig());

    expect(plan).toEqual({ kind: "nothing", reason: "No Ticket can be dispatched: #7's last Implement run failed, so only adding agent:implement again runs it" });
  });

  it("Dispatch reads the research Decision's last run as failed, and skips it", () => {
    const kitWord = [{ body: giveUpComment("agent:research"), byApp: true }];
    const decision = aResearchDecision({ number: 7, lastRunFailed: researchRunFailedIn(kitWord) });

    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([], { researchDecisions: [decision] }), kitConfig());

    expect(plan).toMatchObject({ kind: "nothing", reason: expect.stringContaining("#7's last Research run failed") });
  });

  it("the Design queue reads a failed turn: the session keeps its slot and waits for the Operator", () => {
    const turnFailed = designTurnFailedIn([{ body: giveUpComment("agent:design"), byBot: true }]);
    expect(turnFailed).toBe(true);

    const plan = planFor(
      { kind: "design-queue-check" },
      designQueueSnapshotOf([aDesignQueueIssue({ number: 7, turnFailed }), aDesignQueueIssue({ number: 8 })]),
      kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "caps.design_sessions is 1 and #7 holds a slot, so #8 waits" });
  });

  it("the replay step reads the give-up and starts nothing on that replay issue", () => {
    const plan = planFor({ kind: "scheduled-tick", now: "2026-11-11T04:00:00.000Z" }, tickSnapshot({ replay: replaySlice([aReplayIssue({ gaveUp: true })]) }), kitConfig());

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "check-dispatch" }, { kind: "check-design-queue" }] });
  });
});

describe("Scenario: agent:implement added while the Kit config is invalid (#419)", () => {
  // The Kit job exits 1 before any claim, so agent:implement stays on #7 with no run behind it.
  const stuck = aTicket({ number: 7, labels: ["enhancement", "ready-for-agent", "agent:implement"] });
  const next = aTicket({ number: 8 });

  it("holds a slot as 'dispatched and waiting' until the Kit config is fixed", () => {
    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([stuck, next]), kitConfig({ maxInFlight: 1 }));

    expect(plan).toEqual({ kind: "nothing", reason: expect.stringContaining("1 dispatched and waiting") });
  });

  it("once fixed, the next tick re-adds the label, whose event starts the Implement run", () => {
    const tickPlan = sweep([aLabelledTrigger({ number: 7, label: "agent:implement", lastAddedAt: "2026-11-09T02:10:00Z" })]);
    expect(tickPlan).toMatchObject({ kind: "act", actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["agent:implement"] }]) });

    const runPlan = planFor({ kind: "label-added", issue: 7, label: "agent:implement" }, snapshotOf(anIssue({ number: 7, labels: stuck.labels })), kitConfig());

    expect(runPlan).toMatchObject({ kind: "act", actions: expect.arrayContaining([expect.objectContaining({ kind: "start-agent-run", role: "implement", issue: 7 })]) });
  });

  it("if the re-add starts nothing either, the next tick takes it off, and Dispatch no longer counts it but starts the next Ticket", () => {
    const tickPlan = sweep([aLabelledTrigger({ number: 7, label: "agent:implement", readded: true })]);
    const kitWord = [{ body: giveUpComment("agent:implement"), byApp: true }];
    expect(tickPlan).toMatchObject({ kind: "act", actions: expect.arrayContaining([{ kind: "remove-label", issue: 7, label: "agent:implement" }]) });

    const parked = aTicket({ number: 7, lastRunFailed: implementRunFailedIn(kitWord) });
    const plan = planFor({ kind: "dispatch-check" }, dispatchSnapshotOf([parked, next]), kitConfig({ maxInFlight: 1 }));

    expect(plan).toEqual({ kind: "act", actions: [{ kind: "add-labels", issue: 8, labels: ["agent:implement"] }] });
  });
});

